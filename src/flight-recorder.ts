import { createHttpClient, type HttpClient } from './http-client.js';
import type { Scheduler } from './scheduler.js';
import { toNdjson } from './ndjson.js';

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
    context: Record<string, unknown>;
    name: string;
    payload?: unknown;
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
    private readonly maxBufferSize: number | undefined;
    private readonly onError: ((info: ErrorInfo) => void) | undefined;
    private readonly buffer: Array<ImpressionEvent | CustomEvent> = [];
    private readonly seen = new Set<string>();
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
        this.maxBufferSize = options.batch?.maxBufferSize;
        if (this.maxBufferSize !== undefined && this.flushAt === undefined) {
            throw new Error(
                'batch.flushAt is required when batch.maxBufferSize is set',
            );
        }
        this.onError = options.onError;
        const flushAfterMs = options.batch?.flushAfterMs;
        if (flushAfterMs !== undefined) {
            this.scheduler.runEvery(flushAfterMs, () => this.flush());
        }
    }

    record(event: ImpressionEvent | CustomEvent): void {
        if (this.status === 'closed') return;
        const key = JSON.stringify(event);
        if (this.seen.has(key)) return;
        if (
            this.maxBufferSize !== undefined &&
            this.buffer.length >= this.maxBufferSize
        ) {
            this.onError?.({ reason: 'queueFull', droppedEventCount: 1 });
            return;
        }
        this.seen.add(key);
        this.buffer.push(event);
        if (this.flushAt !== undefined && this.buffer.length >= this.flushAt) {
            void this.flush();
        }
    }

    async flush(options?: { keepalive?: boolean }): Promise<void> {
        if (this.status === 'closed') return;
        if (this.buffer.length === 0) return;
        const toSend = this.buffer.splice(0);
        this.seen.clear();
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
