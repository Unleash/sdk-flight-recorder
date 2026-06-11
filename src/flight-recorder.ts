import type { Clock } from './clock.js';
import { type DrainedEvent, EventBuffer } from './event-buffer.js';
import type { HttpClient } from './http-client.js';
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

// What the buffer holds: a recorded event plus the `timestamp` that `record()` stamps on it.
export type StampedEvent = (ImpressionEvent | CustomEvent) & { timestamp: string };

// What the wire carries: a StampedEvent enriched at drain time with its occurrenceCount.
export type WireEvent = DrainedEvent<StampedEvent>;

export type ErrorInfo =
  | { reason: 'persistentFailure'; droppedEventCount: number; error: unknown }
  | { reason: 'queueFull'; droppedEventCount: number };

type RecorderStatus = 'open' | 'closed';

export const DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER = 2;

export const createRecorderBuffer = (options: { maxSize: number }): EventBuffer<StampedEvent> =>
  new EventBuffer<StampedEvent>({ maxSize: options.maxSize, dedupKey: semanticEventKey });

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
  buffer: EventBuffer<StampedEvent>;
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
  private readonly buffer: EventBuffer<StampedEvent>;
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

  record(event: ImpressionEvent | CustomEvent): void {
    if (this.status === 'closed') return;
    const result = this.buffer.add({ ...event, timestamp: this.clock.now() });
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
    } catch (err) {
      this.onError?.({
        reason: 'persistentFailure',
        droppedEventCount: toSend.length,
        error: err,
      });
    }
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    await this.scheduler.stop();
    await this.flush({ keepalive: true });
    this.status = 'closed';
  }
}
