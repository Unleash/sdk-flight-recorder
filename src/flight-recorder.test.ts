import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NetworkError } from 'ky';
import type { Scheduler } from './scheduler.js';
import { ControllableTimer } from './timer.js';
import { TimerScheduler } from './fake-scheduler.js';
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
    keepalive: boolean;
};

const snapshotRequest = async (req: Request): Promise<RequestSnapshot> => {
    const cloned = req.clone();
    return {
        url: cloned.url,
        method: cloned.method,
        headers: Object.fromEntries(cloned.headers),
        body: await cloned.text(),
        keepalive: req.keepalive,
    };
};

const defaultUrl = 'https://example/events';
const defaultFetch: typeof fetch = async () => new Response();
const defaultClientKey = 'default-client-key';
const defaultScheduler: Scheduler = {
    runEvery: () => {},
    stop: async () => {},
    getStatus: () => 'stopped',
};

const createRecorder = (overrides: Partial<FlightRecorderOptions> = {}) =>
    new FlightRecorder({
        url: defaultUrl,
        fetch: defaultFetch,
        clientKey: defaultClientKey,
        scheduler: defaultScheduler,
        ...overrides,
    });

const makeImpressionEvent = (overrides: Partial<ImpressionEvent> = {}): ImpressionEvent => ({
    eventType: 'isEnabled',
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    context: {},
    enabled: true,
    featureName: 'default-flag',
    ...overrides,
});

describe('FlightRecorder', () => {
    it('records an impression', () => {
        const recorder = createRecorder();
        const event: ImpressionEvent = {
            eventType: 'isEnabled',
            eventId: randomUUID(),
            timestamp: new Date().toISOString(),
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
            eventId: randomUUID(),
            context: { userId: 'u-42' },
            name: 'signup',
            payload: { plan: 'pro' },
        };
        recorder.record(event);
    });

    it('throws when maxBufferSize is set without flushAt', () => {
        expect(() =>
            createRecorder({
                // @ts-expect-error -- intentionally bypassing type guard to verify runtime check
                batch: { maxBufferSize: 100 },
            }),
        ).toThrow('batch.flushAt is required when batch.maxBufferSize is set');
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
            timestamp: '2026-05-14 10:00:00.000',
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

    it('preserves the timestamp from a recorded impression on the wire', async () => {
        const snapshots: Array<Promise<RequestSnapshot>> = [];
        const fakeFetch: typeof fetch = async (input) => {
            snapshots.push(snapshotRequest(input as Request));
            return new Response();
        };

        const recorder = createRecorder({ fetch: fakeFetch });
        const event: ImpressionEvent = {
            eventType: 'isEnabled',
            eventId: '11111111-1111-4111-8111-111111111111',
            timestamp: '2026-05-14 12:00:00.000',
            context: {},
            enabled: true,
            featureName: 'demo.flag',
        };
        recorder.record(event);
        await recorder.flush();

        const [request] = await Promise.all(snapshots);
        expect(JSON.parse(request!.body.trim())).toMatchObject({
            timestamp: '2026-05-14 12:00:00.000',
        });
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
        const before = makeImpressionEvent({ featureName: 'before' });
        const during = makeImpressionEvent({ featureName: 'during' });

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

        recorder.record(makeImpressionEvent({ featureName: 'flag-1' }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fetchCalls).toBe(0);

        recorder.record(makeImpressionEvent({ featureName: 'flag-2' }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fetchCalls).toBe(1);
    });

    it('flushes automatically after the configured time elapses', async () => {
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls++;
            return new Response();
        };
        const timer = new ControllableTimer();
        const recorder = createRecorder({
            fetch: fakeFetch,
            scheduler: new TimerScheduler(timer),
            batch: { flushAfterMs: 2000, flushAt: 2 },
        });

        recorder.record(makeImpressionEvent());
        expect(fetchCalls).toBe(0);

        await timer.advance(2000);

        expect(fetchCalls).toBe(1);
    });

    it('a full buffer drops the event and reports queueFull through onError', () => {
        const errors: ErrorInfo[] = [];
        const recorder = createRecorder({
            batch: { flushAt: 5, maxBufferSize: 2 },
            onError: (info) => errors.push(info),
        });

        recorder.record(makeImpressionEvent({ featureName: 'flag-1' }));
        recorder.record(makeImpressionEvent({ featureName: 'flag-2' }));
        recorder.record(makeImpressionEvent({ featureName: 'flag-3' }));

        expect(errors).toMatchObject([{ reason: 'queueFull', droppedEventCount: 1 }]);
    });

    it('a duplicate event recorded within one flush window reaches the wire only once', async () => {
        const snapshots: Array<Promise<RequestSnapshot>> = [];
        const fakeFetch: typeof fetch = async (input) => {
            snapshots.push(snapshotRequest(input as Request));
            return new Response();
        };

        const recorder = createRecorder({ fetch: fakeFetch });
        recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
        recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
        await recorder.flush();

        const [snapshot] = await Promise.all(snapshots);
        expect(snapshot!.body.trim().split('\n')).toHaveLength(1);
    });

    it('invokes onError when the transport fails', async () => {
        const fakeFetch: typeof fetch = async () => {
            throw new TypeError('Failed to fetch');
        };
        const errors: ErrorInfo[] = [];

        const recorder = createRecorder({
            fetch: fakeFetch,
            onError: (info) => errors.push(info),
        });
        recorder.record(makeImpressionEvent());
        await recorder.flush();

        expect(errors).toMatchObject([
            {
                reason: 'persistentFailure',
                droppedEventCount: 1,
                error: expect.any(NetworkError),
            },
        ]);
    });

    it('ignores record and flush calls after close', async () => {
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls++;
            return new Response();
        };
        const recorder = createRecorder({
            fetch: fakeFetch,
            batch: { flushAt: 1 },
        });

        await recorder.close();
        recorder.record(makeImpressionEvent());
        await recorder.flush();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(fetchCalls).toBe(0);
    });

    it('sends remaining events with keepalive on close', async () => {
        const snapshots: Array<Promise<RequestSnapshot>> = [];
        const fakeFetch: typeof fetch = async (input) => {
            snapshots.push(snapshotRequest(input as Request));
            return new Response();
        };
        const recorder = createRecorder({ fetch: fakeFetch });

        const event = makeImpressionEvent();
        recorder.record(event);
        await recorder.close();

        const [snapshot] = await Promise.all(snapshots);
        expect(snapshot).toMatchObject({
            body: `${JSON.stringify(event)}\n`,
            keepalive: true,
        });
    });

    it('flushes pending events and stops the periodic flush on close', async () => {
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls++;
            return new Response();
        };
        const scheduler = new TimerScheduler(new ControllableTimer());
        const recorder = createRecorder({
            fetch: fakeFetch,
            scheduler,
            batch: { flushAfterMs: 2000 },
        });

        recorder.record(makeImpressionEvent());
        await recorder.close();

        expect(fetchCalls).toBe(1);
        expect(scheduler.getStatus()).toBe('stopped');
    });
});
