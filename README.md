# @unleash/sdk-flight-recorder

Batches Unleash SDK impression and custom events in memory and ships them as
NDJSON to an ingestion endpoint. Runs in Node (≥20) and the browser.

## Install

```sh
pnpm add @unleash/sdk-flight-recorder
```

## Usage

```ts
import { initialize } from 'unleash-client';
import { createFlightRecorder } from '@unleash/sdk-flight-recorder';

const recorder = createFlightRecorder({
  url: 'https://ingest.example.com/events',
  clientKey: 'your-ingestion-token',
  onError: (info) => console.warn('flight recorder:', info),
});

const unleash = initialize({
  url: 'https://your-unleash-instance/api/',
  appName: 'my-app',
  customHeaders: { Authorization: process.env.UNLEASH_API_TOKEN! },
});

// The Unleash Node SDK emits `impression` for every evaluation of a flag that
// has impression data enabled — forward those straight into record().
unleash.on('impression', (event) => recorder.record(event));

// Custom events are caller-originated.
recorder.record({
  eventType: 'custom',
  context: { userId: 'user-1' },
  eventName: 'checkout-completed',
  payload: { plan: 'enterprise', amount: 99 },
});

// On process shutdown — flushes what's buffered, then stops.
await recorder.close();
```

`record(event)` accepts an `ImpressionEvent` or a `CustomEvent`; duplicates
within a flush window are dropped. The recorder stamps each event with a
`timestamp` on `record()` — events carry no timestamp on the way in. Events
are sent automatically per the batching policy below — `flush()` is available
for a manual send.

## Configuration

`createFlightRecorder` accepts the following options (only `url` and `clientKey` are required):

**`batch`** — object, default `{ flushAt: 10_000, flushAfterMs: 10_000 }`.
Merges with defaults; you only need to override fields you want to change.

| Field                     | Default | Meaning                                                                                    |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `flushAt`                 | `10000` | Flush once the buffer reaches this many events (size-based auto-flush). Required field.    |
| `flushAfterMs`            | `10000` | Flush at this interval in milliseconds (time-based auto-flush). Omit to disable.           |
| `maxBufferSizeMultiplier` | `2`     | Maximum buffer capacity = `flushAt × multiplier`. Must be ≥ 1. Defaults to 2x headroom.   |

**`retry`** — object, default `{ retries: 2 }`. Retries a failed flush POST
with exponential backoff.

**`onError`** — function. Failure callback; see [Error handling](#error-handling).

**`fetch`** — function. Custom fetch implementation (defaults to `globalThis.fetch`).

A browser caller that bursts past ~180 events between flushes should lower
`batch.flushAt` — a large keepalive flush on `close()` exceeds the 64 KB limit.

## Error handling

`record()` and `flush()` never throw — the recorder is best-effort, and a flush
failure must not break the code path that produced the event. Failures are
reported through the optional `onError` callback.

It receives an `ErrorInfo` with `reason: 'persistentFailure'` when a flush POST
fails after all retries and the batch is dropped — carrying `droppedEventCount`
and the underlying `error`:

```ts
createFlightRecorder({
  url: 'https://ingest.example.com/events',
  clientKey: 'your-ingestion-token',
  onError: (info) => {
    if (info.reason === 'persistentFailure') {
      console.warn(`flight recorder dropped ${info.droppedEventCount} events`, info.error);
    }
  },
});
```

Dropped events are gone: the recorder does not retry beyond `retry.retries`, and
the buffer does not survive a restart. Telemetry loss is acceptable by design;
`onError` is for surfacing it to your metrics or logs, not for recovery.

## API

- `createFlightRecorder(options)` → `FlightRecorder`
- `FlightRecorder.record(event)` — buffer an event
- `FlightRecorder.flush()` — send the buffer now
- `FlightRecorder.close()` — final flush, then stop accepting events
- `onError(info)` — failure callback; see [Error handling](#error-handling)
