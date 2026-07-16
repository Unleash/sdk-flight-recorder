import type { Clock } from './clock.js';
import { EventBuffer } from './event-buffer.js';
import { type HttpClient, HttpResponseError } from './http-client.js';
import { toNdjson } from './ndjson.js';
import type { Scheduler } from './scheduler.js';
import { semanticEventKey } from './semantic-event-key.js';

export type ImpressionEvent = {
  eventType: 'isEnabled' | 'getVariant';
  context: Record<string, unknown>;
  enabled: boolean;
  featureName: string;
  variant?: string;
  impressionData?: boolean;
};

export type CustomEvent = {
  eventType: 'custom';
  context: Record<string, unknown>;
  eventName: string;
  payload?: Record<string, unknown>;
};

export type AdminEvent = {
  eventType: 'admin';
  context: Record<string, unknown>;
  eventName: string;
  payload?: Record<string, unknown>;
};

// What the buffer holds and the wire carries: a recorded event that `record()`
// has stamped with `timestamp` and `occurrenceCount` (1 at first sight). The
// buffer folds duplicates' counts into the first-seen event in place, so the
// stored object is already the wire shape — no transform at drain.
export type WireEvent = (ImpressionEvent | CustomEvent | AdminEvent) & {
  timestamp: string;
  occurrenceCount: number;
};

export type ErrorInfo =
  | { reason: 'queueFull'; droppedEventCount: number }
  | { reason: 'clientError'; status: number; droppedEventCount: number }
  | { reason: 'deliveryFailed'; status?: number; error: unknown; requeuedEventCount: number };

type RecorderStatus = 'open' | 'closed';

export const DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER = 2;

const isClientError = (error: unknown): error is HttpResponseError =>
  error instanceof HttpResponseError && error.status >= 400 && error.status < 500;

export const createRecorderBuffer = (options: { maxSize: number }): EventBuffer<WireEvent> =>
  new EventBuffer<WireEvent>({ maxSize: options.maxSize, dedupKey: semanticEventKey });

export type BatchOptions = {
  /**
   * When the buffer reaches this many events, `record()` synchronously triggers a flush
   * (size-based auto-flush). Required — also serves as the base for `maxBufferSizeMultiplier`.
   */
  flushAt: number;
  /**
   * How many `flushAt`-worth of events the buffer can hold before `record()` starts
   * dropping new events. Effective cap = `flushAt * maxBufferSizeMultiplier`; once reached,
   * the incoming event is dropped and `onError({ reason: 'queueFull', droppedEventCount: 1 })`
   * fires. Must be >= 1 (a smaller value would put the cap below the trigger, silently
   * stalling the recorder). Defaults to 2x — one trigger-batch of headroom to absorb
   * records that arrive during an in-flight POST.
   */
  maxBufferSizeMultiplier?: number;
  /**
   * Periodic flush interval in milliseconds. The scheduler runs a flush every this-many
   * ms (time-based auto-flush). If omitted, flushes happen only on `flushAt` thresholds
   * or explicit `flush()` calls.
   */
  flushAfterMs?: number;
};

export type FlightRecorderDeps = {
  httpClient: HttpClient;
  buffer: EventBuffer<WireEvent>;
  scheduler: Scheduler;
  clock: Clock;
  flushAt: number;
  flushAfterMs?: number;
  onError?: (info: ErrorInfo) => void;
};

export class FlightRecorder {
  private readonly httpClient: HttpClient;
  private readonly scheduler: Scheduler;
  private readonly clock: Clock;
  private readonly flushAt: number;
  private readonly onError: ((info: ErrorInfo) => void) | undefined;
  private readonly buffer: EventBuffer<WireEvent>;
  private status: RecorderStatus = 'open';
  private sending: Promise<void> | undefined;

  constructor(deps: FlightRecorderDeps) {
    this.httpClient = deps.httpClient;
    this.scheduler = deps.scheduler;
    this.clock = deps.clock;
    this.flushAt = deps.flushAt;
    this.buffer = deps.buffer;
    this.onError = deps.onError;
    if (deps.flushAfterMs !== undefined) {
      this.scheduler.runEvery(deps.flushAfterMs, () => this.flush());
    }
  }

  record(event: ImpressionEvent | CustomEvent | AdminEvent): void {
    if (this.status === 'closed') return;
    const result = this.buffer.add({ ...event, timestamp: this.clock.now(), occurrenceCount: 1 });
    if (result === 'duplicate') return;
    if (result === 'overflow') {
      this.onError?.({ reason: 'queueFull', droppedEventCount: 1 });
      return;
    }
    if (this.buffer.size >= this.flushAt) {
      void this.flush();
    }
  }

  async flush(options?: { keepalive?: boolean }): Promise<void> {
    if (this.status === 'closed') return;
    if (this.sending) await this.sending;
    if (this.buffer.size === 0) return;
    const toSend = this.buffer.drain();
    this.sending = this.send(toSend, options).finally(() => {
      this.sending = undefined;
    });
    await this.sending;
  }

  private async send(toSend: WireEvent[], options?: { keepalive?: boolean }): Promise<void> {
    try {
      await this.httpClient.post(toNdjson(toSend), { keepalive: options?.keepalive });
    } catch (error) {
      if (isClientError(error)) {
        this.onError?.({
          reason: 'clientError',
          status: error.status,
          droppedEventCount: toSend.length,
        });
        return;
      }
      this.onError?.({
        reason: 'deliveryFailed',
        ...(error instanceof HttpResponseError ? { status: error.status } : {}),
        error,
        requeuedEventCount: toSend.length,
      });
      this.requeue(toSend);
    }
  }

  private requeue(events: WireEvent[]): void {
    let droppedEventCount = 0;
    for (const event of events) {
      if (this.buffer.add(event) === 'overflow') {
        droppedEventCount++;
      }
    }
    if (droppedEventCount > 0) {
      this.onError?.({ reason: 'queueFull', droppedEventCount });
    }
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    await this.scheduler.stop();
    await this.flush({ keepalive: true });
    this.status = 'closed';
  }
}
