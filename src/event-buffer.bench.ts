import { bench, describe } from 'vitest';
import { EventBuffer } from './event-buffer.js';
import { semanticEventKey } from './semantic-event-key.js';
import type { ImpressionEvent } from './flight-recorder.js';

// The pre-optimization dedup key, kept here as the benchmark baseline so the
// speedup of the current semanticEventKey stays measurable. Not production
// code — it lives in this bench file, not in src/semantic-event-key.ts. A
// function replacer forces V8 off its fast-path serializer and is invoked
// once per property of the whole event graph; that is what this measures.
const replacerSemanticEventKey = (event: ImpressionEvent): string =>
    JSON.stringify(event, (k, v) =>
        k === 'eventId' || k === 'timestamp' ? undefined : v,
    );

const makeEvent = (i: number): ImpressionEvent => ({
    eventType: 'isEnabled',
    eventId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    timestamp: '2026-01-01 00:00:00.000',
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

const runBufferCycle = (
    dedupKey: (event: ImpressionEvent) => string,
    events: readonly ImpressionEvent[],
): void => {
    const buffer = new EventBuffer<ImpressionEvent>({ dedupKey });
    for (const event of events) {
        buffer.add(event);
    }
    buffer.drain();
};

const options = { time: 5_000, warmupTime: 1_000 };

describe('EventBuffer.add + drain — dedup key comparison', () => {
    bench(
        'cheap key — 10k distinct',
        () => runBufferCycle(semanticEventKey, distinct),
        options,
    );
    bench(
        'replacer key — 10k distinct',
        () => runBufferCycle(replacerSemanticEventKey, distinct),
        options,
    );
    bench(
        'cheap key — 10k, 95% duplicates',
        () => runBufferCycle(semanticEventKey, withDuplicates),
        options,
    );
    bench(
        'replacer key — 10k, 95% duplicates',
        () => runBufferCycle(replacerSemanticEventKey, withDuplicates),
        options,
    );
});
