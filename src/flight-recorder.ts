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

export type FlightRecorderOptions = {
    url: string;
    clientKey: string;
    fetch: typeof fetch;
    scheduler: Scheduler;
    batch?: {
        flushAt?: number;
        flushAfterMs?: number;
        maxBufferSize?: number;
    };
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
        this.onError = options.onError;
        const flushAfterMs = options.batch?.flushAfterMs;
        if (flushAfterMs !== undefined) {
            this.scheduler.runEvery(flushAfterMs, () => this.flush());
        }
    }

    record(event: ImpressionEvent | CustomEvent): void {
        if (this.status === 'closed') return;
        if (this.maxBufferSize !== undefined && this.buffer.length >= this.maxBufferSize) {
            this.onError?.({ reason: 'queueFull', droppedEventCount: 1 });
            return;
        }
        this.buffer.push(event);
        if (this.flushAt !== undefined && this.buffer.length >= this.flushAt) {
            void this.flush();
        }
    }

    async flush(options?: { keepalive?: boolean }): Promise<void> {
        if (this.status === 'closed') return;
        if (this.buffer.length === 0) return;
        const toSend = this.buffer.splice(0);
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
