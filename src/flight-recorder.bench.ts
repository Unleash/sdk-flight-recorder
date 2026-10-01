import { bench, describe } from 'vitest';
import {
  type ContextEnricher,
  createRecorderBuffer,
  FlightRecorder,
  type ImpressionEvent,
} from './flight-recorder.js';

const makeEvent = (i: number): ImpressionEvent => ({
  eventType: 'isEnabled',
  context: {
    userId: `user-${i}`,
    sessionId: `session-${i % 500}`,
    appName: 'unleash-admin-ui',
    environment: 'production',
    properties: { plan: 'enterprise', region: 'eu' },
  },
  enabled: true,
  featureName: `feature-flag-${i % 50}`,
});

// One flush window's worth of distinct impression events, built once.
const distinct = Array.from({ length: 10_000 }, (_, i) => makeEvent(i));

// A re-render-style burst: the same 50 events repeated to 10k (95% duplicates).
const withDuplicates = Array.from(
  { length: 10_000 },
  (_, i) => distinct[i % 50] as ImpressionEvent,
);

// The admin UI's enricher shape: five fields nested under `properties`.
const browserDetails = {
  browser: 'Chrome',
  browserVersion: '141',
  os: 'macOS',
  deviceType: 'desktop',
};
const addBrowserContext: ContextEnricher = (context) => ({
  ...context,
  properties: {
    ...(context.properties as Record<string, unknown> | undefined),
    ...browserDetails,
    viewportWidth: 1400,
  },
});

// Buffer and flush threshold sit above the 10k events, so this measures record() alone.
const recordAll = (events: readonly ImpressionEvent[], enrichContext?: ContextEnricher): void => {
  const recorder = new FlightRecorder({
    httpClient: { post: async () => {} },
    buffer: createRecorderBuffer({ maxSize: 20_000 }),
    scheduler: { runEvery: () => {}, stop: async () => {}, getStatus: () => 'stopped' },
    clock: { now: () => '2026-01-01T00:00:00.000Z' },
    flushAt: 20_000,
    enrichContext,
  });
  for (const event of events) recorder.record(event);
};

const options = { time: 5_000, warmupTime: 1_000 };

describe('FlightRecorder.record — cost of enriching context', () => {
  bench('no enricher — 10k distinct', () => recordAll(distinct), options);
  bench('enricher — 10k distinct', () => recordAll(distinct, addBrowserContext), options);
  bench('no enricher — 10k, 95% duplicates', () => recordAll(withDuplicates), options);
  bench(
    'enricher — 10k, 95% duplicates',
    () => recordAll(withDuplicates, addBrowserContext),
    options,
  );
});
