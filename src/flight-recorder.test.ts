import { describe, it, expect } from 'vitest';
import type { Scheduler } from './scheduler.js';
import { FakeScheduler } from './fake-scheduler.js';
import {
    FlightRecorder,
    type FlightRecorderOptions,
    type ImpressionEvent,
    type CustomEvent,
} from './flight-recorder.js';

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
        type CapturedRequest = {
            url: string;
            method: string;
            headers: Record<string, string>;
            body: string;
        };
        const requests: CapturedRequest[] = [];
        const fakeFetch: typeof fetch = async (input, init) => {
            requests.push({
                url: String(input),
                method: init?.method ?? 'GET',
                headers: (init?.headers as Record<string, string>) ?? {},
                body: String(init?.body ?? ''),
            });
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

        expect(requests).toEqual([
            {
                url: 'https://configured.example/events',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/ndjson',
                    Authorization: 'default:development.real-key-shape',
                },
                body: `${JSON.stringify(event)}\n`,
            },
        ]);
    });

    it('an event recorded mid-flush is sent on the next flush', async () => {
        const sentBodies: string[] = [];
        let releaseFirstFetch!: () => void;
        const firstFetchInFlight = new Promise<void>((resolve) => {
            releaseFirstFetch = resolve;
        });
        let isFirstFetch = true;
        const fakeFetch: typeof fetch = async (_input, init) => {
            sentBodies.push(String(init?.body ?? ''));
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

        expect(sentBodies).toEqual([
            `${JSON.stringify(before)}\n`,
            `${JSON.stringify(during)}\n`,
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
        await Promise.resolve(
            'Force async tick to allow flush to run if it was triggered',
        );
        expect(fetchCalls).toBe(0);

        recorder.record({
            eventType: 'isEnabled',
            eventId: '11111111-1111-4111-8111-111111111111',
            context: {},
            enabled: true,
            featureName: 'demo.flag2',
        });
        await Promise.resolve(
            'Force async tick to allow flush to run if it was triggered',
        );
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
        await Promise.resolve(
            'let the fire-and-forget flush run after the interval fires',
        );

        expect(fetchCalls).toBe(1);
    });
});
