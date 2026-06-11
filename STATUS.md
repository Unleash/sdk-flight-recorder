# Current status

Snapshot of where the port stands. **This file goes stale fast** — update it each TDD step or treat it as a handoff snapshot only.

Last updated: 2026-06-11 (`AdminEvent` added — same shape as `CustomEvent`, `eventType: 'admin'`; flows through `record()`, dedup key, and heterogeneous batches; exported from `index.ts`)

## What's built

`src/event-buffer.ts`
- `EventBuffer<T>` — generic class for buffering, dedup, and cap. `add(event): AddResult` returns `'added' | 'duplicate' | 'overflow'`. `drain(): T[]` splices the array and clears the seen set atomically. `size` getter. `maxSize` cap optional (drop new events on overflow). Dedup via injected key fn, first-seen-wins, fully cleared on drain.

`src/flight-recorder.ts`
- `FlightRecorder` with explicit DI: `{ url, clientKey, fetch, scheduler, clock, batch, retry?, onError? }`. Collaborators required (no defaults); `batch` is required but only its `flushAt` is required-within (`maxBufferSizeMultiplier` defaults to `DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER` = 2, `flushAfterMs` optional — JSDoc on each); `retry?: { retries }` and `onError` opt-in. Only retry knob is `retries` — backoff/cap/status-codes/timeout all use ky's defaults.
- Constructor builds an `HttpClient` once and schedules `scheduler.runEvery(flushAfterMs, () => this.flush())` when `flushAfterMs` is set. The scheduler is contractually required to await the handler before the next tick — so periodic flushes naturally serialize.
- `record(event)` — delegates to `this.buffer.add()`; responds to `AddResult`: duplicate → silent return, overflow → `onError('queueFull')`, added → check `flushAt` trigger. No-op if closed.
- `flush()` — no-op if closed; `if (this.sending) await this.sending;` gate; then drains the whole buffer, posts via `httpClient`, stores the send in `this.sending` (cleared in `.finally`). The post body work lives in a small private `send(toSend, options)` method so `flush()` stays gate/drain shaped. `onError` fires on persistent failure.
- `close()` — `await scheduler.stop()` (resolves after any in-flight periodic handler settles), runs a final `flush({ keepalive: true })`, then marks status closed (status flip after the flush so its own guard doesn't skip the drain).
- **`this.sending` gate** — `private sending: Promise<void> | undefined`. Every `flush()` (manual, periodic, size-trigger) awaits it once, so at most one POST is on the wire at any time. A plain `if` is enough because the drain is atomic — concurrent callers wake to an empty buffer (or only what `record()` added during the send) and either return or start one new send.
- Types: `ImpressionEvent` (discriminated by `eventType: 'isEnabled' | 'getVariant'`), `CustomEvent` (`eventType: 'custom'`, `context`, `eventName: string`, `payload?: Record<string, unknown>`), `AdminEvent` (same shape as `CustomEvent`, `eventType: 'admin'`). The recorder stamps `timestamp` internally via the injected `Clock`. `ErrorInfo` is a discriminated union of `persistentFailure` and `queueFull`. `BatchOptions` is `{ flushAt: number; maxBufferSizeMultiplier?: number; flushAfterMs?: number }` — `DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER` (= 2) is exported alongside the type.

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

## Tests (42 passing)

`src/flight-recorder.test.ts` (15 tests — no ky backoff at this seam)
- `'throws when batch.flushAt is not provided'` — runtime guard for JS callers; type already requires it.
- `'throws when batch.maxBufferSizeMultiplier is less than 1'` — runtime guard; types can't constrain `number >= 1`.
- `'can flush with no events'` — empty-buffer guard.
- `'ships recorded events to the configured url on flush'` — happy path; asserts the whole outgoing `Request` shape via one `toMatchObject`.
- `'flushes automatically when the buffer reaches the configured size'` — size-based auto-flush via `batch.flushAt`.
- `'flushes automatically after the configured time elapses'` — time-based auto-flush via periodic `scheduler.runEvery(flushAfterMs, ...)` on a `TimerScheduler` + `ControllableTimer`.
- `'a full buffer drops the event and reports queueFull through onError'` — `maxBufferSize` overflow path.
- `'concurrent flushes ship events sequentially in record order'` — gating: two overlapping `flush()` calls share a fake fetch tracking concurrent in-flight count. Asserts `maxConcurrent === 1` and bodies are `[before, during]` in record order. Pins the `this.sending` gate.
- `'ships impression, custom, and admin events in one batch'` — heterogeneous NDJSON body; pins custom- and admin-event wire shapes.
- `'sends custom events with the same eventName but different payloads separately'` — dedup distinguishes by `eventName` + `payload`.
- `'duplicate events recorded within one flush window reach the wire only once'` — both impressions and custom events.
- `'invokes onError when the transport fails'` — `retry: { retries: 0 }`, asserts persistentFailure shape.
- `'only events recorded after a failed flush reach the wire'` — pins drop-no-requeue: fetch fails on the first POST, succeeds on the second; later flush ships only the post-failure event.
- `'ignores record and flush calls after close'` — neither path hits the network after `close()`.
- `'sends remaining events with keepalive on close'` — `close()` flushes pending with `keepalive: true`.
- `'flushes pending events and stops the periodic flush on close'` — `close()` flushes pending + transitions scheduler to `'stopped'`.

`src/http-client.test.ts` (3 tests — backoff bypassed via `retryDelay: () => 0`)
- Keepalive forwarding, gzip + content-encoding by default, retries-when-configured (covers ky `limit: options.retries` + `methods: ['post']`).

`src/event-buffer.test.ts` (3 tests)
- Buffer add/duplicate/overflow + drain-resets-window behavior in isolation.
- Per-event `occurrenceCount` over the flush window.
- Dedup-by-injected-key (not by event identity).

`src/gzip.test.ts` (2 tests)
- Compress/decompress round-trip, including multi-byte UTF-8.

`src/semantic-event-key.test.ts` (13 tests) — covers the dedup key builder (`eventType` + identifying fields, `JSON.stringify(context)`/`payload` subtrees), excludes `timestamp`, handles impression, custom, and admin shapes (admin keys carry `eventName` and never collide with same-name custom events).

`src/ndjson.test.ts` (1 test)
- `'emits one JSON object per line with a trailing newline'`

`src/timer-scheduler.test.ts` (5 tests — plain flat `describe`, no fake timers; each test builds `new TimerScheduler(new ControllableTimer())` and drives `timer.advance(ms)`)
- Runs-per-tick, runEvery-twice-throws, status lifecycle, no-run-after-stop, stop-awaits-in-flight.

Test conveniences in `flight-recorder.test.ts`:
- Module-level `defaultUrl`, `defaultFetch`, `defaultClientKey`, and a `createRecorder(overrides?)` factory. `makeImpressionEvent(overrides?)`, `makeCustomEvent(overrides?)`, and `makeAdminEvent(overrides?)` factories with sensible defaults — tests override only the field under assertion with a value visibly different from the default.

## What's deliberately NOT yet built

Each line is a future TDD step:

- **Transport failure handling.** If `fetch` rejects, the spliced events vanish. No test pins down the desired behavior.
- **5xx response handling.** `fetch` doesn't reject on a non-2xx status; we'd need `response.ok` and re-queue. Not handled.
- ~~**Manual `flush()` and size-trigger `void this.flush()` can still race**~~ Done — `this.sending` gate serializes all flush paths (manual, periodic, size-trigger); pinned by `'concurrent flushes ship events sequentially in record order'`.
- ~~**`CustomEvent` type realignment.**~~ Done — `name` → `eventName`, `timestamp: string` added, `payload` narrowed to `Record<string, unknown>`. Mirrors `ImpressionEvent` prefix; wire passthrough + dedup + mixed batch pinned by tests.
- ~~**`close()` does not block further `record()` calls.**~~ Done — `record()` and `flush()` early-return after close.
- ~~**Wire envelope stamping.**~~ **Not needed** — the Unleash JS SDK already emits `timestamp`, `appName` (in `context`), and `environment` (in `context`). The recorder passes events through verbatim. `schemaVersion` and `source` explicitly dropped.
- ~~**`keepalive: true`** option on `flush()` / `close()` for browser unload.~~ Done — `close()` flushes with `keepalive: true`; `flush(options?)` accepts it on demand.
- ~~**Buffer cap / `onError({ reason: 'queueFull' })`**~~ Done — `batch.maxBufferSize` drops new events and fires `onError({ reason: 'queueFull', droppedEventCount: 1 })`.
- ~~**Dedup of identical buffered events.**~~ Done — `JSON.stringify` key, "first seen wins" per flush window, seen set cleared on splice.

## Next test candidates

- **Production Scheduler** — chained `setTimeout` impl of the `Scheduler` interface.
- **Public entry point + CI** — `src/index.ts` re-exports, `.github/workflows/ci.yml`.
