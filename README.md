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

## Defaults


| Option  | Default                                | Meaning                                                            |
| ------- | -------------------------------------- | ------------------------------------------------------------------ |
| `batch` | `{ flushAt: 10_000, flushAfterMs: 10_000 }` | Flush every 10s; force a flush if the buffer reaches 10k events. |
| `retry` | `{ retries: 2 }`                       | Retry a failed POST twice with exponential backoff.                |

A browser caller that bursts past ~180 events between flushes should lower
`batch.flushAt` — a large keepalive flush on `close()` exceeds the 64 KB limit.

## API

- `createFlightRecorder(options)` → `FlightRecorder`
- `FlightRecorder.record(event)` — buffer an event
- `FlightRecorder.flush()` — send the buffer now
- `FlightRecorder.close()` — final flush, then stop accepting events
- `onError(info)` — notified on `persistentFailure` (POST failed after retries)
  or `queueFull` (buffer cap reached); both carry `droppedEventCount`
