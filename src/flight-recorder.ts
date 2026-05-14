import ky from 'ky';
import type { Scheduler } from './scheduler.js';
import { toNdjson } from './ndjson.js';

export type ImpressionEvent = {
    eventType: 'isEnabled' | 'getVariant';
    eventId: string;
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

export type ErrorInfo = {
    reason: 'persistentFailure';
    droppedEventCount: number;
    error: unknown;
};

export type FlightRecorderOptions = {
    url: string;
    clientKey: string;
    fetch: typeof fetch;
    scheduler: Scheduler;
    batch?: {
        flushAt?: number;
        flushAfterMs?: number;
    };
    retry?: {
        retries: number;
    };
    onError?: (info: ErrorInfo) => void;
};

export class FlightRecorder {
    private readonly url: string;
    private readonly clientKey: string;
    private readonly fetch: typeof fetch;
    private readonly scheduler: Scheduler;
    private readonly flushAt: number | undefined;
    private readonly flushAfterMs: number | undefined;
    private readonly retries: number;
    private readonly onError: ((info: ErrorInfo) => void) | undefined;
    private readonly buffer: Array<ImpressionEvent | CustomEvent> = [];

    constructor(options: FlightRecorderOptions) {
        this.url = options.url;
        this.clientKey = options.clientKey;
        this.fetch = options.fetch;
        this.scheduler = options.scheduler;
        this.flushAt = options.batch?.flushAt;
        this.flushAfterMs = options.batch?.flushAfterMs;
        this.retries = options.retry?.retries ?? 0;
        this.onError = options.onError;
        if (this.flushAfterMs !== undefined) {
            this.scheduler.runEvery(this.flushAfterMs, () => {
                void this.flush();
            });
        }
    }

    record(event: ImpressionEvent | CustomEvent): void {
        this.buffer.push(event);
        if (this.flushAt !== undefined && this.buffer.length >= this.flushAt) {
            void this.flush();
        }
    }

    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;
        const toSend = this.buffer.splice(0);
        const body = toNdjson(toSend);

        const client = ky.create({
            fetch: this.fetch,
            retry: {
                limit: this.retries,
                methods: ['post'],
            },
            headers: {
                'content-type': 'application/ndjson',
                authorization: this.clientKey,
            },
            body,
        });

        try {
            await client.post(this.url);
        } catch (err) {
            this.onError?.({
                reason: 'persistentFailure',
                droppedEventCount: toSend.length,
                error: err,
            });
        }
    }
}
