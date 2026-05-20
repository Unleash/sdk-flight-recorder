import { NetworkError } from 'ky';
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.js';
import {
  type BatchOptions,
  type CustomEvent,
  type ErrorInfo,
  FlightRecorder,
  type FlightRecorderOptions,
  type ImpressionEvent,
} from './flight-recorder.js';
import type { Scheduler } from './scheduler.js';
import { createGate, createGatedFetch } from './test-gate.js';
import { ControllableTimer } from './timer.js';
import { TimerScheduler } from './timer-scheduler.js';

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

const ndjsonToArray = (body: string): unknown[] =>
  body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const recordedEvents = async (snapshots: Array<Promise<RequestSnapshot>>): Promise<unknown[]> => {
  const [snapshot, ...rest] = await Promise.all(snapshots);
  if (!snapshot) throw new Error('expected exactly one request, got none');
  if (rest.length > 0) throw new Error(`expected exactly one request, got ${snapshots.length}`);
  return ndjsonToArray(snapshot.body);
};

const defaultUrl = 'https://example/events';
const defaultFetch: typeof fetch = async () => new Response();
const defaultClientKey = 'default-client-key';
const defaultScheduler: Scheduler = {
  runEvery: () => {},
  stop: async () => {},
  getStatus: () => 'stopped',
};
const defaultClock: Clock = { now: () => '2026-01-01T00:00:00.000Z' };
const defaultBatch: BatchOptions = { flushAt: 100 };

type RecorderOverrides = Partial<Omit<FlightRecorderOptions, 'batch'>> & {
  batch?: Partial<BatchOptions>;
};

const createRecorder = (overrides: RecorderOverrides = {}) =>
  new FlightRecorder({
    url: defaultUrl,
    fetch: defaultFetch,
    clientKey: defaultClientKey,
    scheduler: defaultScheduler,
    clock: defaultClock,
    ...overrides,
    batch: { ...defaultBatch, ...overrides.batch },
  });

const makeImpressionEvent = (overrides: Partial<ImpressionEvent> = {}): ImpressionEvent => ({
  eventType: 'isEnabled',
  context: {},
  enabled: true,
  featureName: 'default-flag',
  ...overrides,
});

const makeCustomEvent = (overrides: Partial<CustomEvent> = {}): CustomEvent => ({
  eventType: 'custom',
  context: {},
  eventName: 'default-custom-event',
  ...overrides,
});

describe('FlightRecorder', () => {
  it('throws when batch.maxBufferSizeMultiplier is less than 1', () => {
    expect(() => createRecorder({ batch: { flushAt: 100, maxBufferSizeMultiplier: 0.5 } })).toThrow(
      'batch.maxBufferSizeMultiplier must be >= 1',
    );
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
        body: `${JSON.stringify({ ...event, timestamp: defaultClock.now() })}\n`,
      },
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

  it('a full buffer drops the event and reports queueFull through onError', async () => {
    const fetchGate = createGatedFetch();
    const errors: ErrorInfo[] = [];
    const recorder = createRecorder({
      fetch: fetchGate,
      batch: { flushAt: 2 },
      onError: (info) => errors.push(info),
    });

    // flushAt 2 + default multiplier 2 = cap 4. #1-2 trigger a flush that
    // drains synchronously into the gated POST; #3,4,5,6 refill the buffer to the
    // cap of 4; #7 overflows.
    for (let i = 1; i <= 7; i++) {
      recorder.record(makeImpressionEvent({ featureName: `flag-${i}` }));
    }

    expect(errors).toMatchObject([{ reason: 'queueFull', droppedEventCount: 1 }]);

    // Release the held POST so close() can flush the residual and return.
    fetchGate.release();
    await recorder.close();
  });

  it('concurrent flushes ship events sequentially in record order', async () => {
    const firstFetchGate = createGate();
    const snapshots: Array<Promise<RequestSnapshot>> = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    let isFirstFetch = true;
    const fakeFetch: typeof fetch = async (input) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      snapshots.push(snapshotRequest(input as Request));
      try {
        if (isFirstFetch) {
          isFirstFetch = false;
          await firstFetchGate.opened;
        }
        return new Response();
      } finally {
        concurrent--;
      }
    };
    const recorder = createRecorder({ fetch: fakeFetch });
    const before = makeImpressionEvent({ featureName: 'before' });
    const during = makeImpressionEvent({ featureName: 'during' });

    recorder.record(before);
    const flush1 = recorder.flush();
    recorder.record(during);
    const flush2 = recorder.flush();
    firstFetchGate.open();
    await Promise.all([flush1, flush2]);

    expect(maxConcurrent).toBe(1);
    expect(await Promise.all(snapshots)).toMatchObject([
      { body: `${JSON.stringify({ ...before, timestamp: defaultClock.now() })}\n` },
      { body: `${JSON.stringify({ ...during, timestamp: defaultClock.now() })}\n` },
    ]);
  });

  it('ships both impression and custom events in one batch', async () => {
    const snapshots: Array<Promise<RequestSnapshot>> = [];
    const fakeFetch: typeof fetch = async (input) => {
      snapshots.push(snapshotRequest(input as Request));
      return new Response();
    };
    const payload = {
      plan: 'pro',
      features: ['analytics', 'sso'],
      metadata: { tier: 1, trial: false },
    };
    const impression = makeImpressionEvent({ featureName: 'feature-x' });
    const custom = makeCustomEvent({
      eventName: 'purchase',
      payload,
    });
    const recorder = createRecorder({ fetch: fakeFetch });

    recorder.record(impression);
    recorder.record(custom);
    await recorder.flush();

    const events = await recordedEvents(snapshots);
    expect(events).toMatchObject([
      { eventType: 'isEnabled', featureName: 'feature-x' },
      {
        eventType: 'custom',
        eventName: 'purchase',
        payload,
      },
    ]);
  });

  it('sends custom events with the same eventName but different payloads separately', async () => {
    const snapshots: Array<Promise<RequestSnapshot>> = [];
    const fakeFetch: typeof fetch = async (input) => {
      snapshots.push(snapshotRequest(input as Request));
      return new Response();
    };
    const recorder = createRecorder({ fetch: fakeFetch });

    recorder.record(makeCustomEvent({ eventName: 'signup', payload: { plan: 'pro' } }));
    recorder.record(makeCustomEvent({ eventName: 'signup', payload: { plan: 'free' } }));
    await recorder.flush();

    const events = await recordedEvents(snapshots);
    expect(events).toMatchObject([
      { eventName: 'signup', payload: { plan: 'pro' } },
      { eventName: 'signup', payload: { plan: 'free' } },
    ]);
  });

  it('duplicate events recorded within one flush window reach the wire only once', async () => {
    const snapshots: Array<Promise<RequestSnapshot>> = [];
    const fakeFetch: typeof fetch = async (input) => {
      snapshots.push(snapshotRequest(input as Request));
      return new Response();
    };
    const recorder = createRecorder({ fetch: fakeFetch });

    recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
    recorder.record(makeImpressionEvent({ featureName: 'demo.flag' }));
    recorder.record(makeCustomEvent({ eventName: 'signup', payload: { plan: 'pro' } }));
    recorder.record(makeCustomEvent({ eventName: 'signup', payload: { plan: 'pro' } }));
    await recorder.flush();

    const events = await recordedEvents(snapshots);
    expect(events).toMatchObject([
      { eventType: 'isEnabled', featureName: 'demo.flag' },
      {
        eventType: 'custom',
        eventName: 'signup',
        payload: { plan: 'pro' },
      },
    ]);
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

  it('only events recorded after a failed flush reach the wire', async () => {
    const snapshots: Array<Promise<RequestSnapshot>> = [];
    let isFirstFetch = true;
    const fakeFetch: typeof fetch = async (input) => {
      if (isFirstFetch) {
        isFirstFetch = false;
        throw new TypeError('Failed to fetch');
      }
      snapshots.push(snapshotRequest(input as Request));
      return new Response();
    };
    const recorder = createRecorder({ fetch: fakeFetch });
    const failed = makeImpressionEvent({ featureName: 'failed' });
    const next = makeImpressionEvent({ featureName: 'next' });

    recorder.record(failed);
    await recorder.flush();
    recorder.record(next);
    await recorder.flush();

    const events = await recordedEvents(snapshots);
    expect(events).toMatchObject([{ featureName: 'next' }]);
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
      body: `${JSON.stringify({ ...event, timestamp: defaultClock.now() })}\n`,
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
