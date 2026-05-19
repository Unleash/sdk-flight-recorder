import { bench, describe } from 'vitest';
import type { ImpressionEvent } from './flight-recorder.js';
import { toNdjson } from './ndjson.js';

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

// Flush batches of two realistic sizes, built once. toNdjson runs once per
// flush, so this is the per-flush serialization cost — the CPU the buffer
// bench does not cover.
const smallBatch = Array.from({ length: 1_000 }, (_, i) => makeEvent(i));
const largeBatch = Array.from({ length: 10_000 }, (_, i) => makeEvent(i));

const options = { time: 5_000, warmupTime: 1_000 };

describe('toNdjson — flush-path serialization', () => {
  bench(
    'serialize a 1k-event flush batch',
    () => {
      toNdjson(smallBatch);
    },
    options,
  );

  bench(
    'serialize a 10k-event flush batch',
    () => {
      toNdjson(largeBatch);
    },
    options,
  );
});
