# Current status

Snapshot of where the port stands. **This file goes stale fast** — update it each TDD step or treat it as a handoff snapshot only.

Last updated: 2026-05-14

## What's built

`src/flight-recorder.ts`
- `FlightRecorder` with explicit DI: `{ url, clientKey, fetch, scheduler, batch? }`. Collaborators required (no defaults); `batch.flushAt` and `batch.flushAfterMs` opt-in.
- Constructor schedules a periodic flush via `scheduler.runEvery(flushAfterMs, flushCb)` when `flushAfterMs` is set. Single loop, not per-batch timer (diverges from reference design — see memory).
- `record(event: ImpressionEvent | CustomEvent)` — pushes to internal buffer; fires `void this.flush()` when `buffer.length >= batch.flushAt` (if configured).
- `async flush()` — early-return on empty buffer; atomic snapshot via `buffer.splice(0)`; serializes via `toNdjson`; `POST` to `url` with `Content-Type: application/ndjson` and `Authorization: <clientKey>`.
- Types: `ImpressionEvent` (discriminated by `eventType: 'isEnabled' | 'getVariant'`), `CustomEvent` (`eventType: 'custom'`), `FlightRecorderOptions` (nested `batch?: { flushAt?, flushAfterMs? }`).

`src/scheduler.ts`
- `Scheduler = { runEvery(ms, handler): void }`. Single periodic-tick abstraction; no `now`/`setTimeout`/`clearTimeout`. No production impl yet — production callers must provide one.

`src/fake-scheduler.ts`
- `FakeScheduler implements Scheduler` for tests. `advance(ms)` fires each registered interval `Math.floor(ms / interval.ms)` times. Non-cumulative across `advance` calls.

`src/ndjson.ts`
- `toNdjson(items: ReadonlyArray<unknown>): string` — generic NDJSON serializer. One JSON object per line, trailing `\n`. Returns `''` for empty input (the recorder's `flush` already guards against calling it that way, but the function handles it safely).

## Tests (8 passing)

`src/flight-recorder.test.ts`
1. `'records an impression'` — `record()` accepts an `ImpressionEvent`
2. `'records a custom event'` — `record()` accepts a `CustomEvent`
3. `'can flush with no events'` — empty-buffer guard
4. `'ships recorded events to the configured url on flush'` — happy path: asserts URL, method, headers (`Content-Type`, `Authorization`), and body in a single `expect`
5. `'an event recorded mid-flush is sent on the next flush'` — atomicity: events recorded during an in-flight `fetch` are preserved for the next flush
6. `'flushes automatically when the buffer reaches the configured size'` — size-based auto-flush via `batch.flushAt`. Counts `fetch` calls before/after threshold
7. `'flushes automatically after the configured time elapses'` — time-based auto-flush via periodic `scheduler.every(flushAfterMs, ...)`. Counts `fetch` calls before/after `scheduler.advance(flushAfterMs)`

`src/ndjson.test.ts`
8. `'emits one JSON object per line with a trailing newline'`

Test conveniences in `flight-recorder.test.ts`:
- Module-level `defaultUrl`, `defaultFetch`, `defaultClientKey`, and a `createRecorder(overrides?)` factory. Tests that don't exercise a particular constructor input rely on the factory; tests that do override (with values different from defaults) to make the data flow visible.

## What's deliberately NOT yet built

Each line is a future TDD step:

- **Transport failure handling.** If `fetch` rejects, the spliced events vanish. No test pins down the desired behavior.
- **5xx response handling.** `fetch` doesn't reject on a non-2xx status; we'd need `response.ok` and re-queue. Not handled.
- **Concurrency guard.** Auto-flush fires `void this.flush()` even if a previous flush is still in flight. Reference design says one-in-flight only — no test pins this down yet.
- **Wire envelope.** Shipped events currently lack `schemaVersion`, `timestamp`, `source`, `appName`, `environment` (per reference design). No test pins this down.
- **Periodic flush cannot be stopped.** `Clock.every` returns `void`; no way to cancel the loop yet. Needs a `close()` test to drive a stop mechanism.
- **`close()` method.** Graceful shutdown (final flush + stop accepting events).
- **`keepalive: true`** option on `flush()` for browser unload.
- **Dedup of identical buffered events.**
- **Custom event end-to-end test.** Type accepts `CustomEvent`, but no test asserts it actually reaches the wire.
- ~~**Batching coverage test.**~~ Done (test 5).

## Next test candidates

- **Transport failure handling** — `fetch` rejects → re-queue at front + rethrow. Requires impl change (`try/catch` + `buffer.unshift(...toSend)`).
- **5xx response handling** — `fetch` resolves with non-2xx → re-queue. Adjacent to transport failure but different impl path (`response.ok` check).
