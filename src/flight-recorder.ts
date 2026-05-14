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

export type FlightRecorderOptions = {
    url: string;
    clientKey: string;
    fetch: typeof fetch;
    batch?: {
        flushAt?: number;
    };
};

export class FlightRecorder {
    private readonly url: string;
    private readonly clientKey: string;
    private readonly fetch: typeof fetch;
    private readonly flushAt: number | undefined;
    private readonly buffer: Array<ImpressionEvent | CustomEvent> = [];

    constructor(options: FlightRecorderOptions) {
        this.url = options.url;
        this.clientKey = options.clientKey;
        this.fetch = options.fetch;
        this.flushAt = options.batch?.flushAt;
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
        await this.fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/ndjson',
                Authorization: this.clientKey,
            },
            body,
        });
    }
}
