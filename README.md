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
(Compression helps here: gzipped batches typically fit even at higher event
counts.)

## Batching model

The recorder accumulates events in memory and flushes them as one POST per
batch. Per-event HTTP would cost orders of magnitude more in network overhead
and would defeat the server's batched ingest path.

**What the recorder does:**

- In-memory buffer with bounded size; overflow surfaces via
  `onError({ reason: 'queueFull' })` rather than throwing
- Periodic flush + size-based flush, whichever fires first
- Single POST per flush; body is the full batch as NDJSON
- gzip on the body by default (cuts wire bytes ~5–10× on JSON)
- Retry transient failures (network errors, 5xx) by re-queuing the batch for the
  next flush; drop a batch the server rejects with a 4xx and surface it via
  `onError({ reason: 'clientError' })` — no on-disk persistence, no infinite
  retry queue
- `record()` never throws

**Default batch size is large by design.** `flushAt: 10_000` trades higher
peak SDK memory for fewer HTTP requests per second, which the server-side
ingest path is optimised for: fewer larger batches put less pressure on the
backend than many small ones.

The trade-off is higher peak memory per SDK instance — up to ~7 MB at the
default 20k cap (`flushAt × maxBufferSizeMultiplier`), or ~400 KB after gzip.
If you're embedding in a memory-constrained runtime (edge worker, IoT,
mobile), lower `flushAt` — `flushAt: 100` drops peak memory roughly 100×.

## Error handling

`record()` and `flush()` never throw — the recorder is best-effort, and a flush
failure must not break the code path that produced the event. Failures are
reported through the optional `onError` callback, which receives an `ErrorInfo`
discriminated on `reason` (both variants carry `droppedEventCount`):

| `reason`      | When                                                                           | Extra fields          |
| ------------- | ------------------------------------------------------------------------------ | --------------------- |
| `queueFull`   | The buffer is at capacity, so a new (or re-queued) event is dropped.           | —                     |
| `clientError` | The server rejected a batch with a 4xx; resending can't help, so it's dropped. | `status`              |

Transient failures (network errors, 5xx) are **not** surfaced: the batch is
re-queued and retried on the next flush, so a brief outage is invisible; only a
sustained one fills the buffer and surfaces as `queueFull`.

```ts
createFlightRecorder({
  url: 'https://ingest.example.com/events',
  clientKey: 'your-ingestion-token',
  onError: (info) => {
    switch (info.reason) {
      case 'queueFull':
        console.warn(`flight recorder buffer full, dropped ${info.droppedEventCount} events`);
        break;
      case 'clientError':
        console.warn(
          `flight recorder batch rejected (${info.status}), dropped ${info.droppedEventCount} events`,
        );
        break;
    }
  },
});
```

Dropped events are gone — the buffer holds them only until the cap and does not
survive a restart. Telemetry loss is acceptable by design; `onError` is for
surfacing it to your metrics or logs, not for recovery.

## API

- `createFlightRecorder(options)` → `FlightRecorder`
- `FlightRecorder.record(event)` — buffer an event
- `FlightRecorder.flush()` — send the buffer now
- `FlightRecorder.close()` — final flush, then stop accepting events
- `onError(info)` — failure callback; see [Error handling](#error-handling)
