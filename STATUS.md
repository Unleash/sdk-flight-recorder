# Current status

Snapshot of where the port stands. **This file goes stale fast** — update it each TDD step or treat it as a handoff snapshot only.

Last updated: 2026-05-14

## What's built

`src/flight-recorder.ts`
- `FlightRecorder` with explicit DI: `{ url, clientKey, fetch, scheduler, batch?, retry?, onError? }`. Collaborators required (no defaults); `batch`, `retry?: { retries }`, `onError` opt-in. Only retry knob is `retries` — backoff/cap/status-codes/timeout all use ky's defaults.
- Constructor builds an `HttpClient` once (via `createHttpClient` from `http-client.ts`) and schedules a periodic flush via `scheduler.runEvery(flushAfterMs, flushCb)` when `flushAfterMs` is set.
- `record(event: ImpressionEvent | CustomEvent)` — pushes to internal buffer; fires `void this.flush()` when `buffer.length >= batch.flushAt` (if configured).
- `async flush()` — early-return on empty buffer; atomic snapshot via `buffer.splice(0)`; serializes via `toNdjson`; sends via `httpClient.post(body)`. Exhausted retries fire `onError({ reason: 'persistentFailure', droppedEventCount, error: NetworkError | HTTPError })`; `flush()` never rejects.
- Types: `ImpressionEvent` (discriminated by `eventType: 'isEnabled' | 'getVariant'`), `CustomEvent` (`eventType: 'custom'`), `ErrorInfo` (currently single variant), `FlightRecorderOptions` (nested `batch?: { flushAt?, flushAfterMs? }`, `retry?: { retries }`).

`src/http-client.ts`
- `createHttpClient({ url, headers, fetch, retries }): HttpClient`. Single method: `post(body: string): Promise<void>`. Wraps ky (retry/methods/headers/fetch). The only module that imports `ky`.

`src/scheduler.ts`
- `Scheduler = { runEvery(ms, handler): void; stop(): void; getStatus(): SchedulerStatus }` where `SchedulerStatus = 'active' | 'stopped'`. Single periodic-tick abstraction; no `now`/`setTimeout`/`clearTimeout`. No production impl yet — production callers must provide one.

`src/fake-scheduler.ts`
- `FakeScheduler implements Scheduler` for tests. One-interval-only: a second call to `runEvery` throws. `advance(ms)` fires the registered handler `Math.floor(ms / interval.ms)` times (skips if stopped). Reports `'active'`/`'stopped'` via `getStatus()`. Non-cumulative across `advance` calls.

`src/ndjson.ts`
- `toNdjson(items: ReadonlyArray<unknown>): string` — generic NDJSON serializer. One JSON object per line, trailing `\n`. Returns `''` for empty input (the recorder's `flush` already guards against calling it that way, but the function handles it safely).

## Tests (12 passing, ~28ms total)

`src/flight-recorder.test.ts` (10 tests, ~16ms — no ky backoff at this seam)
1. `'records an impression'` — `record()` accepts an `ImpressionEvent`
2. `'records a custom event'` — `record()` accepts a `CustomEvent`
3. `'can flush with no events'` — empty-buffer guard
4. `'ships recorded events to the configured url on flush'` — happy path: captures the outgoing `Request`'s url/method/content-type/authorization/body inside the fake and asserts the whole shape via one `toMatchObject`
5. `'an event recorded mid-flush is sent on the next flush'` — atomicity: events recorded during an in-flight `fetch` are preserved for the next flush
6. `'flushes automatically when the buffer reaches the configured size'` — size-based auto-flush via `batch.flushAt`. Counts `fetch` calls before/after threshold
7. `'flushes automatically after the configured time elapses'` — time-based auto-flush via periodic `scheduler.runEvery(flushAfterMs, ...)`. Counts `fetch` calls before/after `scheduler.advance(flushAfterMs)`
8. `'invokes onError when the transport fails'` — `fakeFetch` throws once, `retry: { retries: 0 }`, asserts `onError` called with `{ reason: 'persistentFailure', droppedEventCount: 1 }` and that an `error` is attached. Does not assert error type — that's ky's concern.
9. `'flushes pending events and stops the periodic flush on close'` — records an event, calls `close()`. One assertion checks the event was flushed (`fetchCalls === 1`); another checks `scheduler.getStatus() === 'stopped'`.
10. `'ignores record and flush calls after close'` — calls `close()` on an empty recorder, then `record(event)` (which would normally trigger a size-flush at `flushAt: 1`), then explicit `flush()`. After settling microtasks via `setImmediate`, asserts `fetchCalls === 0` — neither the size-trigger nor the manual flush hit the network.

`src/http-client.test.ts` (1 test, ~10ms — backoff bypassed via `retryDelay: () => 0`)
9. `'retries POST requests when retries is configured'` — verifies our two retry choices flow through to ky: `limit: options.retries` and `methods: ['post']` (POST is excluded from ky's default retry list). Fake fetch throws once, then succeeds; asserts fetch called twice.

`src/ndjson.test.ts` (1 test)
10. `'emits one JSON object per line with a trailing newline'`

Test conveniences in `flight-recorder.test.ts`:
- Module-level `defaultUrl`, `defaultFetch`, `defaultClientKey`, and a `createRecorder(overrides?)` factory. Tests that don't exercise a particular constructor input rely on the factory; tests that do override (with values different from defaults) to make the data flow visible.

## What's deliberately NOT yet built

Each line is a future TDD step:

- **Transport failure handling.** If `fetch` rejects, the spliced events vanish. No test pins down the desired behavior.
- **5xx response handling.** `fetch` doesn't reject on a non-2xx status; we'd need `response.ok` and re-queue. Not handled.
- **Concurrency guard.** Auto-flush fires `void this.flush()` even if a previous flush is still in flight. Reference design says one-in-flight only — no test pins this down yet.
- **Wire envelope.** Shipped events currently lack `schemaVersion`, `timestamp`, `source`, `appName`, `environment` (per reference design). No test pins this down.
- ~~**`close()` does not block further `record()` calls.**~~ Done — `record()` and `flush()` early-return after close (test 10).
- **`keepalive: true`** option on `flush()` for browser unload.
- **Dedup of identical buffered events.**
- **Custom event end-to-end test.** Type accepts `CustomEvent`, but no test asserts it actually reaches the wire.
- ~~**Batching coverage test.**~~ Done (test 5).

## Next test candidates

- **Transport failure handling** — `fetch` rejects → re-queue at front + rethrow. Requires impl change (`try/catch` + `buffer.unshift(...toSend)`).
- **5xx response handling** — `fetch` resolves with non-2xx → re-queue. Adjacent to transport failure but different impl path (`response.ok` check).
