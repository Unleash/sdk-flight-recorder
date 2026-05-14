import { describe, it, expect } from 'vitest';
import { NetworkError } from 'ky';
import type { Scheduler } from './scheduler.js';
import { FakeScheduler } from './fake-scheduler.js';
import {
    FlightRecorder,
    type ErrorInfo,
    type FlightRecorderOptions,
    type ImpressionEvent,
    type CustomEvent,
} from './flight-recorder.js';

type RequestSnapshot = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
};

const snapshotRequest = async (req: Request): Promise<RequestSnapshot> => {
    const cloned = req.clone();
    return {
        url: cloned.url,
        method: cloned.method,
        headers: Object.fromEntries(cloned.headers),
        body: await cloned.text(),
    };
};

const defaultUrl = 'https://example/events';
const defaultFetch: typeof fetch = async () => new Response();
const defaultClientKey = 'default-client-key';
const defaultScheduler: Scheduler = {
    runEvery: () => {},
};

const createRecorder = (overrides: Partial<FlightRecorderOptions> = {}) =>
    new FlightRecorder({
        url: defaultUrl,
        fetch: defaultFetch,
        clientKey: defaultClientKey,
        scheduler: defaultScheduler,
        ...overrides,
    });

describe('FlightRecorder', () => {
    it('records an impression', () => {
        const recorder = createRecorder();
        const event: ImpressionEvent = {
            eventType: 'isEnabled',
            eventId: '11111111-1111-4111-8111-111111111111',
            context: { userId: 'u-42', sessionId: 's-7' },
            enabled: true,
            featureName: 'demo.flag',
        };
        recorder.record(event);
    });

    it('records a custom event', () => {
        const recorder = createRecorder();
        const event: CustomEvent = {
            eventType: 'custom',
            eventId: '22222222-2222-4222-8222-222222222222',
            context: { userId: 'u-42' },
            name: 'signup',
            payload: { plan: 'pro' },
        };
        recorder.record(event);
    });

    it('can flush with no events', async () => {
        const recorder = createRecorder();
        await recorder.flush();
    });

    it('ships recorded events to the configured url on flush', async () => {
        const snapshots: Array<Promise<RequestSnapshot>> = [];
        const fakeFetch: typeof fetch = async (input) => {
            snapshots.push(snapshotRequest(input as Request));
            return new Response();
        };

        const recorder = createRecorder({
            url: 'https://configured.example/events',
            clientKey: 'default:development.real-key-shape',
            fetch: fakeFetch,
        });
        const event: ImpressionEvent = {
            eventType: 'isEnabled',
            eventId: '11111111-1111-4111-8111-111111111111',
            context: {},
            enabled: true,
            featureName: 'demo.flag',
        };
        recorder.record(event);
        await recorder.flush();

        expect(await Promise.all(snapshots)).toMatchObject([
            {
                url: 'https://configured.example/events',
                method: 'POST',
                headers: {
                    'content-type': 'application/ndjson',
                    authorization: 'default:development.real-key-shape',
                },
                body: `${JSON.stringify(event)}\n`,
            },
        ]);
    });

    it('an event recorded mid-flush is sent on the next flush', async () => {
        const snapshots: Array<Promise<RequestSnapshot>> = [];
        let releaseFirstFetch!: () => void;
        const firstFetchInFlight = new Promise<void>((resolve) => {
            releaseFirstFetch = resolve;
        });
        let isFirstFetch = true;
        const fakeFetch: typeof fetch = async (input) => {
            snapshots.push(snapshotRequest(input as Request));
            if (isFirstFetch) {
                isFirstFetch = false;
                await firstFetchInFlight;
            }
            return new Response();
        };

        const recorder = createRecorder({ fetch: fakeFetch });
        const before: ImpressionEvent = {
            eventType: 'isEnabled',
            eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            context: {},
            enabled: true,
            featureName: 'before',
        };
        const during: ImpressionEvent = {
            eventType: 'isEnabled',
            eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            context: {},
            enabled: true,
            featureName: 'during',
        };

        recorder.record(before);
        const flushInFlight = recorder.flush();
        recorder.record(during);
        releaseFirstFetch();
        await flushInFlight;

        await recorder.flush();

        expect(await Promise.all(snapshots)).toMatchObject([
            { body: `${JSON.stringify(before)}\n` },
            { body: `${JSON.stringify(during)}\n` },
        ]);
    });

    it('flushes automatically when the buffer reaches the configured size', async () => {
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls++;
            return new Response();
        };
        const recorder = createRecorder({
            fetch: fakeFetch,
            batch: { flushAt: 2 },
        });

        recorder.record({
            eventType: 'isEnabled',
            eventId: '11111111-1111-4111-8111-111111111111',
            context: {},
            enabled: true,
            featureName: 'demo.flag1',
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fetchCalls).toBe(0);

        recorder.record({
            eventType: 'isEnabled',
            eventId: '11111111-1111-4111-8111-111111111111',
            context: {},
            enabled: true,
            featureName: 'demo.flag2',
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fetchCalls).toBe(1);
    });

    it('flushes automatically after the configured time elapses', async () => {
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls++;
            return new Response();
        };
        const scheduler = new FakeScheduler();
        const recorder = createRecorder({
            fetch: fakeFetch,
            scheduler,
            batch: { flushAfterMs: 2000, flushAt: 2 },
        });

        recorder.record({
            eventType: 'isEnabled',
            eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            context: {},
            enabled: true,
            featureName: 'flag-time',
        });
        expect(fetchCalls).toBe(0);

        scheduler.advance(2000);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(fetchCalls).toBe(1);
    });

    it('retries the failed fetch after one attempt and then succeeds', async () => {
        let attemptCount = 0;
        const fakeFetch: typeof fetch = async () => {
            attemptCount++;
            if (attemptCount === 1) throw new TypeError('Failed to fetch');
            return new Response();
        };
        const errors: ErrorInfo[] = [];

        const recorder = createRecorder({
            fetch: fakeFetch,
            retry: { retries: 1 },
            onError: (info) => errors.push(info),
        });
        recorder.record({
            eventType: 'isEnabled',
            eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            context: {},
            enabled: true,
            featureName: 'retry-test',
        });
        await recorder.flush();

        expect(attemptCount).toBe(2);
        expect(errors).toEqual([]);
    });

    it('invokes onError when all retry attempts fail', async () => {
        const fakeFetch: typeof fetch = async () => {
            throw new TypeError('Failed to fetch');
        };
        const errors: ErrorInfo[] = [];

        const recorder = createRecorder({
            fetch: fakeFetch,
            retry: { retries: 1 },
            onError: (info) => errors.push(info),
        });
        const event: ImpressionEvent = {
            eventType: 'isEnabled',
            eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            context: {},
            enabled: true,
            featureName: 'failing-flag',
        };
        recorder.record(event);
        await recorder.flush();

        expect(errors).toMatchObject([
            {
                reason: 'persistentFailure',
                droppedEventCount: 1,
                error: expect.any(NetworkError),
            },
        ]);
    });
});
