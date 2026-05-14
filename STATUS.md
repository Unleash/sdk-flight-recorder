# Current status

Snapshot of where the port stands. **This file goes stale fast** — update it each TDD step or treat it as a handoff snapshot only.

Last updated: 2026-05-14

## What's built

`src/flight-recorder.ts`
- `FlightRecorder` with explicit DI: `{ url, clientKey, fetch, scheduler, batch?, retry?, onError? }`. Collaborators required (no defaults); `batch`, `retry?: { retries }`, `onError` opt-in. Only retry knob is `retries` — backoff/cap/status-codes/timeout all use ky's defaults.
- Constructor builds an `HttpClient` once and schedules `scheduler.runEvery(flushAfterMs, () => this.flush())` when `flushAfterMs` is set. The scheduler is contractually required to await the handler before the next tick — so periodic flushes naturally serialize.
- `record(event)` — pushes to buffer (no-op if closed); fires `void this.flush()` when `buffer.length >= batch.flushAt`.
- `flush()` — no-op if closed or empty; otherwise splices the buffer, posts via `httpClient`, calls `onError` on persistent failure.
- `close()` — stops the scheduler, runs a final `flush()`, then marks status closed (status flip after the flush so its own guard doesn't skip the drain).
- **No in-flight tracking.** Concurrent flushes can race; `close()` does not await earlier in-flight HTTPs. Acceptable for dogfooding scope; revisit if a real test demands it.
- Types: `ImpressionEvent` (discriminated by `eventType: 'isEnabled' | 'getVariant'`, now includes required `timestamp: string` matching the Unleash JS SDK emit shape), `CustomEvent` (`eventType: 'custom'`), `ErrorInfo` (currently single variant), `FlightRecorderOptions` (nested `batch?: { flushAt?, flushAfterMs? }`, `retry?: { retries }`).

`src/http-client.ts`
- `createHttpClient({ url, headers, fetch, retries }): HttpClient`. Single method: `post(body: string): Promise<void>`. Wraps ky (retry/methods/headers/fetch). The only module that imports `ky`.

`src/scheduler.ts`
- `Scheduler = { runEvery(ms, handler: () => Promise<void>): void; stop(): void; getStatus(): SchedulerStatus }` where `SchedulerStatus = 'active' | 'stopped'`. The handler is async; the scheduler must await it before scheduling the next tick (self-chained-setTimeout pattern, matching `unleash-client-node`). No production impl yet.

`src/fake-scheduler.ts`
- `FakeScheduler implements Scheduler` for tests. One-interval-only: a second call to `runEvery` throws. `advance(ms): Promise<void>` is async — awaits the handler between iterations. Tests use `await scheduler.advance(...)`. Reports `'active'`/`'stopped'` via `getStatus()`. Non-cumulative across `advance` calls.

`src/ndjson.ts`
- `toNdjson(items: ReadonlyArray<unknown>): string` — generic NDJSON serializer. One JSON object per line, trailing `\n`. Returns `''` for empty input (the recorder's `flush` already guards against calling it that way, but the function handles it safely).

## Tests (13 passing, ~28ms total)

`src/flight-recorder.test.ts` (11 tests, ~16ms — no ky backoff at this seam)
1. `'records an impression'` — `record()` accepts an `ImpressionEvent`
2. `'records a custom event'` — `record()` accepts a `CustomEvent`
3. `'can flush with no events'` — empty-buffer guard
4. `'ships recorded events to the configured url on flush'` — happy path: captures the outgoing `Request`'s url/method/content-type/authorization/body inside the fake and asserts the whole shape via one `toMatchObject`
5. `'preserves the timestamp from a recorded impression on the wire'` — type alignment: asserts `timestamp` passes through verbatim. Pinned after aligning `ImpressionEvent` with the Unleash JS SDK's emit shape.
6. `'an event recorded mid-flush is sent on the next flush'` — atomicity: events recorded during an in-flight `fetch` are preserved for the next flush
7. `'flushes automatically when the buffer reaches the configured size'` — size-based auto-flush via `batch.flushAt`. Counts `fetch` calls before/after threshold
8. `'flushes automatically after the configured time elapses'` — time-based auto-flush via periodic `scheduler.runEvery(flushAfterMs, ...)`. Counts `fetch` calls before/after `scheduler.advance(flushAfterMs)`
9. `'invokes onError when the transport fails'` — `fakeFetch` throws once, `retry: { retries: 0 }`, asserts `onError` called with `{ reason: 'persistentFailure', droppedEventCount: 1 }` and that an `error` is attached. Does not assert error type — that's ky's concern.
10. `'flushes pending events and stops the periodic flush on close'` — records an event, calls `close()`. One assertion checks the event was flushed (`fetchCalls === 1`); another checks `scheduler.getStatus() === 'stopped'`.
11. `'ignores record and flush calls after close'` — calls `close()` on an empty recorder, then `record(event)` (which would normally trigger a size-flush at `flushAt: 1`), then explicit `flush()`. After settling microtasks via `setImmediate`, asserts `fetchCalls === 0` — neither the size-trigger nor the manual flush hit the network.

`src/http-client.test.ts` (1 test, ~10ms — backoff bypassed via `retryDelay: () => 0`)
12. `'retries POST requests when retries is configured'` — verifies our two retry choices flow through to ky: `limit: options.retries` and `methods: ['post']` (POST is excluded from ky's default retry list). Fake fetch throws once, then succeeds; asserts fetch called twice.

`src/ndjson.test.ts` (1 test)
13. `'emits one JSON object per line with a trailing newline'`

Test conveniences in `flight-recorder.test.ts`:
- Module-level `defaultUrl`, `defaultFetch`, `defaultClientKey`, `defaultTimestamp`, and a `createRecorder(overrides?)` factory plus `defaultImpressionEvent`. Tests that don't exercise a particular input rely on these defaults; tests that do override with values visibly different from defaults.

## What's deliberately NOT yet built

Each line is a future TDD step:

- **`CustomEvent` type realignment.** SDK emits `eventName: string` (not `name`) and includes `timestamp`. Our `CustomEvent` type has `name: string` — a rename is needed before SDK custom events can be wired without casting. Separate step.
- **Concurrency guard.** Auto-flush fires `void this.flush()` even if a previous flush is still in flight; `close()` does not await earlier in-flight HTTPs. Parked (microtask ordering complexity — see "No in-flight tracking" note above).
- ~~**Wire envelope stamping.**~~ **Not needed** — the Unleash JS SDK already emits `timestamp`, `appName` (in `context`), and `environment` (in `context`). The recorder passes events through verbatim. `schemaVersion` and `source` explicitly dropped.
- **`keepalive: true`** option on `flush()` / `close()` for browser unload.
- **Buffer cap / `onError({ reason: 'queueFull' })`** — buffer is unbounded; memory leak risk under backend outage.
- **Dedup of identical buffered events.**

## Next test candidates

- **`CustomEvent` realignment** — rename `name` → `eventName`, add `timestamp: string`. Mirrors what we just did for `ImpressionEvent`. Small cascade fix.
- **`keepalive` on `close()`** — admin UI page navigation is the dominant data-loss path; plumb `keepalive: true` through `flush` → `httpClient.post` → `fetch`.
- **Buffer cap** — add `maxBufferSize` option; on overflow, drop oldest and fire `onError({ reason: 'queueFull', droppedEventCount })`.
