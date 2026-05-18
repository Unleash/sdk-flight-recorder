# Current status

Snapshot of where the port stands. **This file goes stale fast** — update it each TDD step or treat it as a handoff snapshot only.

Last updated: 2026-05-18 (`CustomEvent` aligned with `ImpressionEvent`; wire passthrough, dedup, and mixed-batch paths pinned by tests; redundant tests pruned)

## What's built

`src/event-buffer.ts`
- `EventBuffer<T>` — generic class for buffering, dedup, and cap. `add(event): AddResult` returns `'added' | 'duplicate' | 'overflow'`. `drain(): T[]` splices and clears the seen set atomically. `size` getter. `maxSize` cap optional (drop new events on overflow). Dedup via `JSON.stringify` key, first-seen-wins, cleared on drain.

`src/flight-recorder.ts`
- `FlightRecorder` with explicit DI: `{ url, clientKey, fetch, scheduler, batch?, retry?, onError? }`. Collaborators required (no defaults); `batch`, `retry?: { retries }`, `onError` opt-in. Only retry knob is `retries` — backoff/cap/status-codes/timeout all use ky's defaults.
- Constructor builds an `HttpClient` once and schedules `scheduler.runEvery(flushAfterMs, () => this.flush())` when `flushAfterMs` is set. The scheduler is contractually required to await the handler before the next tick — so periodic flushes naturally serialize.
- `record(event)` — delegates to `this.buffer.add()`; responds to `AddResult`: duplicate → silent return, overflow → `onError('queueFull')`, added → check `flushAt` trigger. No-op if closed.
- `flush()` — no-op if closed or `buffer.size === 0`; otherwise drains via `buffer.drain()`, posts via `httpClient`, calls `onError` on persistent failure.
- `close()` — `await scheduler.stop()` (resolves after any in-flight periodic handler settles), runs a final `flush({ keepalive: true })`, then marks status closed (status flip after the flush so its own guard doesn't skip the drain).
- **No recorder-side in-flight tracking.** The scheduler tracks the periodic handler so `await scheduler.stop()` covers the periodic-flush case. The size-trigger (`void this.flush()` in `record`) and manual `flush()` calls can still race; acceptable for dogfooding.
- Types: `ImpressionEvent` (discriminated by `eventType: 'isEnabled' | 'getVariant'`, includes required `timestamp: string` matching the Unleash JS SDK emit shape), `CustomEvent` (`eventType: 'custom'`, `eventId`, `timestamp`, `context`, `eventName: string`, `payload?: Record<string, unknown>` — mirrors `ImpressionEvent` prefix + field naming), `ErrorInfo` (currently single variant), `FlightRecorderOptions` (nested `batch?: { flushAt?, flushAfterMs? }`, `retry?: { retries }`).

`src/http-client.ts`
- `createHttpClient({ url, headers, fetch, retries }): HttpClient`. Single method: `post(body: string): Promise<void>`. Wraps ky (retry/methods/headers/fetch). The only module that imports `ky`.

`src/scheduler.ts`
- `Scheduler = { runEvery(ms, handler: () => Promise<void>): void; stop(): Promise<void>; getStatus(): SchedulerStatus }` where `SchedulerStatus = 'active' | 'stopped'`. The handler is async; the scheduler must await it before scheduling the next tick (self-chained-setTimeout pattern, matching `unleash-client-node`). `stop()` is async and resolves only after any in-flight handler invocation has settled.

`src/timer.ts`
- `Timer` — the injected seam: `schedule(ms, callback) => cancel`, a one-shot delayed callback. Two impls: `systemTimer` (production, `setTimeout`/`clearTimeout`) and `ControllableTimer` (tests, in-memory with one `pending` slot; `advance(ms)` fires due callbacks, awaiting each).

`src/timer-scheduler.ts`
- `TimerScheduler implements Scheduler` — the *only* scheduler. Takes a required `Timer` in the constructor. Self-chains via `timer.schedule` (`scheduleNext`); the timer callback returns the in-flight handler promise so `ControllableTimer` can await it. Tracks `inFlight` so `stop()` awaits a running handler, and cancels the pending tick. One-interval-only (second `runEvery` throws). Tests that drive time use `new TimerScheduler(new ControllableTimer())` and advance the timer directly — there is no `FakeScheduler`.

`src/ndjson.ts`
- `toNdjson(items: ReadonlyArray<unknown>): string` — generic NDJSON serializer. One JSON object per line, trailing `\n`. Returns `''` for empty input (the recorder's `flush` already guards against calling it that way, but the function handles it safely).

## Tests (24 passing, ~30ms total)

`src/flight-recorder.test.ts` (14 tests, ~17ms — no ky backoff at this seam)
1. `'throws when maxBufferSize is set without flushAt'` — runtime guard.
2. `'can flush with no events'` — empty-buffer guard.
3. `'ships recorded events to the configured url on flush'` — happy path: captures the outgoing `Request`'s url/method/content-type/authorization/body inside the fake and asserts the whole shape via one `toMatchObject`. Impression event; full `JSON.stringify(event)` body match implicitly covers `timestamp` passthrough.
4. `'an event recorded mid-flush is sent on the next flush'` — atomicity: events recorded during an in-flight `fetch` are preserved for the next flush.
5. `'flushes automatically when the buffer reaches the configured size'` — size-based auto-flush via `batch.flushAt`.
6. `'flushes automatically after the configured time elapses'` — time-based auto-flush via periodic `scheduler.runEvery(flushAfterMs, ...)` on a `TimerScheduler` + `ControllableTimer`.
7. `'a full buffer drops the event and reports queueFull through onError'` — `maxBufferSize` overflow path.
8. `'ships both impression and custom events in one batch'` — heterogeneous NDJSON body; pins custom-event wire shape including `eventName`, explicit `timestamp`, and a nested `payload` (object + array + nested metadata) flowing through verbatim.
9. `'sends custom events with the same eventName but different payloads separately'` — dedup distinguishes by `eventName` + `payload`; asserts both lines on the wire with their distinct `plan` values.
10. `'duplicate events recorded within one flush window reach the wire only once'` — covers both impressions and custom events: 2 identical impressions + 2 identical custom events collapse to 2 lines.
11. `'invokes onError when the transport fails'` — `fakeFetch` throws once, `retry: { retries: 0 }`, asserts `onError` called with `{ reason: 'persistentFailure', droppedEventCount: 1 }` plus an error.
12. `'ignores record and flush calls after close'` — neither the size-trigger nor the manual flush hit the network after `close()`.
13. `'sends remaining events with keepalive on close'` — `close()` flushes pending with `keepalive: true`.
14. `'flushes pending events and stops the periodic flush on close'` — `close()` flushes pending + transitions scheduler to `'stopped'`.

`src/http-client.test.ts` (2 tests, ~10ms — backoff bypassed via `retryDelay: () => 0`)
15-16. POST happy-path + retries-when-configured (covers ky `limit: options.retries` + `methods: ['post']`).

`src/event-buffer.test.ts` (2 tests)
17-18. Buffer add/duplicate/overflow + drain/clear behavior in isolation.

`src/ndjson.test.ts` (1 test)
19. `'emits one JSON object per line with a trailing newline'`

`src/timer-scheduler.test.ts` (5 tests — plain flat `describe`, no fake timers; each test builds `new TimerScheduler(new ControllableTimer())` and drives `timer.advance(ms)`)
20-24. Runs-per-tick, runEvery-twice-throws, status lifecycle, no-run-after-stop, stop-awaits-in-flight.

Test conveniences in `flight-recorder.test.ts`:
- Module-level `defaultUrl`, `defaultFetch`, `defaultClientKey`, and a `createRecorder(overrides?)` factory. `makeImpressionEvent(overrides?)` and `makeCustomEvent(overrides?)` factories with sensible defaults — tests override only the field under assertion with a value visibly different from the default.

## What's deliberately NOT yet built

Each line is a future TDD step:

- **Transport failure handling.** If `fetch` rejects, the spliced events vanish. No test pins down the desired behavior.
- **5xx response handling.** `fetch` doesn't reject on a non-2xx status; we'd need `response.ok` and re-queue. Not handled.
- **Manual `flush()` and size-trigger `void this.flush()` can still race** with the periodic — matches the trade-off `unleash-client-node` makes. (`close()` *does* await the periodic handler now via async `scheduler.stop()` — pinned by the contract test's `'stop awaits an in-flight handler'`.) If a real test demands stricter guarantees for the non-periodic paths, drive them in then.
- ~~**`CustomEvent` type realignment.**~~ Done — `name` → `eventName`, `timestamp: string` added, `payload` narrowed to `Record<string, unknown>`. Mirrors `ImpressionEvent` prefix; wire passthrough + dedup + mixed batch pinned by tests.
- ~~**`close()` does not block further `record()` calls.**~~ Done — `record()` and `flush()` early-return after close.
- ~~**Wire envelope stamping.**~~ **Not needed** — the Unleash JS SDK already emits `timestamp`, `appName` (in `context`), and `environment` (in `context`). The recorder passes events through verbatim. `schemaVersion` and `source` explicitly dropped.
- ~~**`keepalive: true`** option on `flush()` / `close()` for browser unload.~~ Done — `close()` flushes with `keepalive: true`; `flush(options?)` accepts it on demand.
- ~~**Buffer cap / `onError({ reason: 'queueFull' })`**~~ Done — `batch.maxBufferSize` drops new events and fires `onError({ reason: 'queueFull', droppedEventCount: 1 })`.
- ~~**Dedup of identical buffered events.**~~ Done — `JSON.stringify` key, "first seen wins" per flush window, seen set cleared on splice.

## Next test candidates

- **Production Scheduler** — chained `setTimeout` impl of the `Scheduler` interface.
- **Public entry point + CI** — `src/index.ts` re-exports, `.github/workflows/ci.yml`.
