import { EventBuffer } from './event-buffer.js';
import { createHttpClient, type HttpClient } from './http-client.js';
import { toNdjson } from './ndjson.js';
import type { Scheduler } from './scheduler.js';
import { semanticEventKey } from './semantic-event-key.js';

export type ImpressionEvent = {
  eventType: 'isEnabled' | 'getVariant';
  eventId: string;
  timestamp: string;
  context: Record<string, unknown>;
  enabled: boolean;
  featureName: string;
  variant?: string;
  impressionData?: boolean;
};

export type CustomEvent = {
  eventType: 'custom';
  eventId: string;
  timestamp: string;
  context: Record<string, unknown>;
  eventName: string;
  payload?: Record<string, unknown>;
};

export type ErrorInfo =
  | { reason: 'persistentFailure'; droppedEventCount: number; error: unknown }
  | { reason: 'queueFull'; droppedEventCount: number };

type RecorderStatus = 'open' | 'closed';

/**
 * Options for batching events. If `flushAt` is set, the recorder will flush when the buffer reaches that size.
 * If `flushAfterMs` is set, the recorder will flush after that amount of time has passed since the last flush.
 * If `maxBufferSize` is set, the recorder will drop new events and call `onError` when the buffer reaches that size.
 * `maxBufferSize` requires `flushAt` to be set.
 */
export type BatchOptions =
  | { flushAt: number; flushAfterMs?: number; maxBufferSize?: number }
  | { flushAt?: number; flushAfterMs?: number; maxBufferSize?: never };

export type FlightRecorderOptions = {
  url: string;
  clientKey: string;
  fetch: typeof fetch;
  scheduler: Scheduler;
  batch?: BatchOptions;
  retry?: {
    retries: number;
  };
  onError?: (info: ErrorInfo) => void;
};

export class FlightRecorder {
  private readonly httpClient: HttpClient;
  private readonly scheduler: Scheduler;
  private readonly flushAt: number | undefined;
  private readonly onError: ((info: ErrorInfo) => void) | undefined;
  private readonly buffer: EventBuffer<ImpressionEvent | CustomEvent>;
  private status: RecorderStatus = 'open';

  constructor(options: FlightRecorderOptions) {
    this.httpClient = createHttpClient({
      url: options.url,
      headers: {
        'content-type': 'application/ndjson',
        authorization: options.clientKey,
      },
      fetch: options.fetch,
      retries: options.retry?.retries ?? 0,
    });
    this.scheduler = options.scheduler;
    this.flushAt = options.batch?.flushAt;
    const maxBufferSize = options.batch?.maxBufferSize;
    if (maxBufferSize !== undefined && this.flushAt === undefined) {
      throw new Error('batch.flushAt is required when batch.maxBufferSize is set');
    }
    this.buffer = new EventBuffer({ maxSize: maxBufferSize, dedupKey: semanticEventKey });
    this.onError = options.onError;
    const flushAfterMs = options.batch?.flushAfterMs;
    if (flushAfterMs !== undefined) {
      this.scheduler.runEvery(flushAfterMs, () => this.flush());
    }
  }

  record(event: ImpressionEvent | CustomEvent): void {
    if (this.status === 'closed') return;
    const result = this.buffer.add(event);
    if (result === 'duplicate') return;
    if (result === 'overflow') {
      this.onError?.({ reason: 'queueFull', droppedEventCount: 1 });
      return;
    }
    if (this.flushAt !== undefined && this.buffer.size >= this.flushAt) {
      void this.flush();
    }
  }

  async flush(options?: { keepalive?: boolean }): Promise<void> {
    if (this.status === 'closed') return;
    if (this.buffer.size === 0) return;
    const toSend = this.buffer.drain();
    const body = toNdjson(toSend);
    try {
      await this.httpClient.post(body, { keepalive: options?.keepalive });
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
