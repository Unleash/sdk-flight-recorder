# Decisions

## Body gzip-compressed by default; `compress: false` to opt out

`createHttpClient` (and `createFlightRecorder`) ship an additional `compress` option defaulting to `true`. When enabled, the NDJSON body is gzipped via the standard `CompressionStream` Web API before being passed to `ky`, with `Content-Encoding: gzip` set so the server transparently decompresses. *Why:* event NDJSON compresses ~5–10× with gzip; cuts wire bytes, fits comfortably under the 64 KB browser keepalive limit on close, and matches what observability ingestion vendors (Datadog, Honeycomb) require. *Why default-on:* the savings are always positive for batch sizes the SDK actually produces (hundreds-to-thousands of events), and the API decompresses transparently — no consumer needs to opt in for the common case. *Why opt-out, not always-on:* leaves an escape hatch for wire-level debugging and proxies that strip `Content-Encoding`. *Why `CompressionStream` and not `node:zlib`:* the SDK targets both Node and browser (Unleash admin UI + Cloud BE); `CompressionStream` is a Web standard available in Node 18+ and all modern browsers, so the same code path runs in both. Pinned by `'compresses the body with gzip and sets content-encoding by default'` and `'sends the body verbatim when compress is false'` in `src/http-client.test.ts`.

## Tests colocated with source

`src/foo.ts` lives next to `src/foo.test.ts`; no separate `test/` tree. *Why:* keeps the unit under test and its test visually adjacent in the file tree and during edits.

## Pinned pnpm version

`package.json` `packageManager` pins pnpm to an exact version with a `sha512` integrity hash (resolved by corepack). *Why:* avoids the supply-chain risk of corepack/CI silently pulling a different pnpm build than what was vetted locally.

## TypeScript: NodeNext + strict, no DOM

`tsconfig.json` uses `module`/`moduleResolution: "NodeNext"`, omits `DOM` from `lib`, and turns on the cheap strict flags (`strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`, `isolatedModules`). *Why:* `NodeNext` models the actual Node ESM resolver (explicit `.js` extensions, real CJS/ESM interop), so import mistakes fail at compile time instead of runtime. The package has no DOM dependency — `fetch`/`Request`/`Response` come from Node's built-in types via `@types/node` — so including `DOM` would only enable accidental browser-only calls.

## Single `record(event)` entry point

The recorder exposes one public ingest method, `record(event)`, not per-type methods (`recordImpression`, `recordCustom`, …). *Why:* the same call site will handle both Unleash impression events (`isEnabled` / `getVariant`) and arbitrary custom events. One method keeps the public surface small and lets the integrator decide the event type at the call site rather than choosing a method name.

## Constructor options: explicit DI for `url` and `fetch`

`new FlightRecorder({ url, fetch })`. Both required, no defaults. *Why:* an optional `fetch` with a `?? globalThis.fetch` fallback is the *bastard injection* antipattern — it hides the dependency, makes the class's runtime requirements invisible from its signature, and creates a class of bugs where a test or environment accidentally relies on the global instead of the intended injection. Production callers pass `globalThis.fetch` (or whatever wrapper they have) explicitly; tests pass a fake. Same shape, no hidden ambient state.

## Wire format: POST + NDJSON, `Content-Type: application/ndjson`

`flush()` sends `POST <url>` with `Content-Type: application/ndjson` and a body of newline-delimited JSON — one event per line, trailing newline. *Why:* NDJSON lets the ingestion server stream-parse one line at a time instead of blocking the event loop on a single big `JSON.parse` of a batch, and it maps directly to ClickHouse's `JSONEachRow` input format. The header lets the server dispatch to the right parser without sniffing the body. We use `application/ndjson` (no `x-` prefix) per RFC 6648, which deprecated the `x-` convention for new media types; `application/x-ndjson` remains the de facto choice in the wild (Elasticsearch et al.) but neither is IANA-registered.

## Drain the buffer before awaiting the send

`flush()` calls `buffer.splice(0)` to take an atomic snapshot of pending events *before* awaiting `fetch`. *Why:* any `record(...)` call that happens during the in-flight `fetch` must not be cleared along with the events that were already in flight. Clearing the buffer *after* the await (`buffer.length = 0`) silently drops everything recorded during the network round-trip — confirmed by test `'events recorded during an in-flight flush survive the flush'`.

## Auth follows Unleash SDK convention

Constructor takes a required `clientKey: string`; `flush()` sends `Authorization: <clientKey>` (no `Bearer ` prefix, value sent verbatim). *Why:* match the Unleash frontend and Node SDKs so customers can paste their existing key into the flight recorder unchanged. The frontend SDK (`unleash-js-sdk`) takes the option as `clientKey` and writes it directly into the `Authorization` header; the Node SDK lets the caller put it in `customHeaders.Authorization`. Both expect the key as-is — no scheme prefix, no transformation. Mirroring the FE SDK's user-facing option name (`clientKey`) keeps the integration ergonomic.

## Test names describe observable behavior

Test names state the user-facing behavior, not the return-value or assertion mechanics. Good: `'can flush with no events'`. Bad: `'flush resolves on an empty recorder'`. *Why:* a test name should read like a feature description so failure listings communicate intent at a glance; mechanics (promise resolution, no-throw, return shape) belong inside the test body, not in its name.

## Decline esbuild's postinstall build

`pnpm-workspace.yaml` sets `allowBuilds.esbuild: false`. *Why:* pnpm 9+ refuses to run dependency lifecycle scripts unless explicitly approved (supply-chain protection). esbuild's `postinstall` downloads a native binary that vitest doesn't actually need — modern esbuild also ships per-platform binaries via separate npm packages (`@esbuild/darwin-arm64` etc.). Declining the build keeps third-party code from running at install time without losing any functionality.

## Size-based auto-flush via `batch.flushAt`

Opt-in via `batch.flushAt`; when set, `record()` triggers `void this.flush()` at the threshold. Nested under `batch` to match the reference's grouping. *Why:* manual `flush()` shouldn't be the primary trigger, but a default threshold would ship a guess; leaving it off by default keeps the API silent until the caller chooses one.

## `Scheduler` collaborator with `runEvery`, not `Clock`

Time-based auto-flush takes a required `Scheduler = { runEvery(ms, handler): void }`. The constructor schedules a single periodic flush via `scheduler.runEvery(batch.flushAfterMs, ...)` when `flushAfterMs` is set. *Why:* the abstraction's job is "schedule recurring work," not "expose time" — `Clock` (with `now()`/`setTimeout`) was both wider than needed and misnamed. One periodic loop (vs. the reference's one-shot timer per batch) keeps the API and the test fake small; idle ticks short-circuit cheaply on the empty-buffer guard in `flush()`.

## Transport via `ky`, fetch still injected

The transport is `ky` (v2.x) underneath; production callers still inject `fetch` via `FlightRecorderOptions.fetch`, which we pass through to `ky.create({ fetch })`. *Why:* implementing retries, exponential backoff, status-code filtering, and per-request timeout correctly is a known-hard problem with edge cases (Retry-After parsing, jitter, network-error detection); ky has solved this well. Keeping `fetch` injected preserves the existing DI seam — production passes `globalThis.fetch`, tests pass fakes that receive ky's `Request` objects.

## Retry config: only `retry.retries`; everything else uses ky defaults

The only retry knob is `retry: { retries: number }` (opt-in; default 0 = no retry). Backoff curve, max delay cap, retriable status codes, jitter — all left to ky's built-ins. POST is force-enabled via `methods: ['post']` since ky's default excludes it. *Why:* hand-rolling delay-clamp / status-code list duplicates work ky already does well; surfacing them as options pre-emptively was scope creep with no test to justify it. If a real integration ever needs a different curve or a tighter cap, add the option then with the test that demands it.

## Losses surface via `onError`, not thrown from `flush()`

`flush()` never rejects; exhausted retries fire an injected `onError(info)` callback with a discriminated reason union (initially `{ reason: 'persistentFailure', droppedEventCount, attempts, error }`; `queueFull`, `malformed`, etc. will join later). *Why:* auto-flush is fire-and-forget (`void this.flush()`), so a thrown error becomes an unhandled rejection with no info on which events were lost. A callback unifies all loss reasons through one observability hook the integrator wires once. If `onError` is unset, the error is silently swallowed — explicit opt-in to observability matches our DI discipline.

## `onError` carries `droppedEventCount`, not the events themselves

The `persistentFailure` payload exposes `droppedEventCount: number`, not the full `events: Event[]` array (which the reference design includes). *Why:* the buffer can hold thousands of events; passing them to a user-supplied callback retains the whole batch in memory until the callback returns and risks long-lived references in observability code. A count is enough for the dominant use case (metrics, alerting). Callers who need event-level forensics can capture the events themselves via a custom `fetch` wrapper that logs request bodies — that's the right seam.

## Failed sends drop the batch — no re-queue into the buffer

When `httpClient.post` rejects (network error, exhausted ky retries, etc.), the drained batch is **discarded**. `onError({ reason: 'persistentFailure', droppedEventCount, error })` fires so the integrator can observe the loss, but the events never re-enter `this.buffer`. Pinned by `'invokes onError when the transport fails'` (callback shape) and `'only events recorded after a failed flush reach the wire'` (no re-queue).

*Why drop, not re-queue:*

- **Ordering** — `record()` calls during the in-flight POST already filled the buffer with newer events. Prepending the failed batch reverses chronological order on the wire; appending mixes failed + new mid-stream. Either choice surprises the integrator. Just drop.
- **Amplification** — if the server is failing because of overload, re-queueing the batch puts it right back in line to be sent again, doubling load when the server can least handle it. ky already retries with exponential backoff and Retry-After; only persistent failure reaches this catch.
- **Bounded memory** — re-add must respect `maxBufferSize` (cap = `flushAt × multiplier`). A failed batch the size of `flushAt` re-queued into a buffer that already grew during the failed send would push past the cap and trip `queueFull` on the re-added events — same drop, different reason code, more code to get there.
- **Dedup window already cleared** — `drain()` clears the seen set atomically. Re-adding bypasses dedup against any new arrivals; preserving dedup would require carrying the keys through the failed send, which couples the buffer's invariant to the transport's retry policy.
- **Scope** — these are observability signals (impressions, custom events), not transactional records. Acceptable loss profile.

*If guaranteed delivery is later wanted:* the right seam is a custom `fetch` wrapper that persists request bodies to disk (or to another transport) before forwarding — same pattern as event-forensics in the "droppedEventCount, not the events" decision above. The recorder stays simple; durability is a separable concern.

## HTTP transport extracted to `src/http-client.ts`

`createHttpClient({ url, headers, fetch, retries }): HttpClient` lives in its own module; `HttpClient` exposes a single `post(body: string): Promise<void>`. `FlightRecorder` no longer touches `ky` directly — it builds the client once in its constructor and calls `httpClient.post(body)` from `flush()`. *Why:* the recorder's job is buffering, serialization, and observability; the HTTP transport (ky config, retry knobs, header set, fetch DI) is a separable concern. Bonus: the ky instance is built once at construction instead of being re-created on every `flush()`. The recorder's public options (`url`, `clientKey`, `fetch`, `retry`) are unchanged — the recorder still owns the option surface; only the *internal* coupling to ky moved.

## Tests live at the seam they exercise

Retry / backoff / ky-specific behavior is tested in `src/http-client.test.ts`. `src/flight-recorder.test.ts` only tests recorder-level behavior (buffering, auto-flush, mid-flush atomicity, `onError` firing on transport failure) using a `fakeFetch` that does whatever the test needs in a single call. *Why:* before this split, `flight-recorder.test.ts` ran in ~614ms because two retry tests paid ky's ~300ms backoff each. After moving the retry test to `http-client.test.ts` and rewriting the `onError` test to use `retries: 0` (one throw, no backoff), the recorder suite runs in ~14ms. The slow test still exists — but it lives at the level where retry *is* the contract being tested, not where it's an implementation detail leaking through a stacked integration.

## Periodic flushes serialize via the scheduler awaiting its handler

`Scheduler.runEvery` takes a `handler: () => Promise<void>` and the scheduler is contractually required to await it before scheduling the next tick. The recorder passes `() => this.flush()` — and that's the entirety of "one periodic flush at a time." No in-flight tracking on the recorder side.

```ts
// Today:
this.scheduler.runEvery(flushAfterMs, () => this.flush());
```

In a production scheduler this maps to self-chained `setTimeout`: `setTimeout(() => handler().then(scheduleNext))`. The next tick is scheduled *after* the handler's promise resolves. No `setInterval` — `setInterval` doesn't naturally serialize.

`ControllableTimer.advance(ms)` is async and awaits the handler between ticks — so tests can `await timer.advance(2000)` and skip the trailing `await yieldEventLoop()` they used to need.

*Why this works (and why we chose it):* this is the pattern Unleash's own Node SDK (`unleash-client-node`) uses for its metrics flushing — chained `setTimeout` with `await` between ticks, no explicit mutex. The pattern is production-proven there. It addresses the most common "in-flight at shutdown" case (a periodic that's mid-HTTP when something else triggers close). The size-trigger path (`void this.flush()` inside `record`) and any manual `flush()` calls used to also race; that's now closed by the `this.sending` gate (see next entry).

## At most one POST in flight via a `this.sending` gate in `flush()`

`FlightRecorder` holds `private sending: Promise<void> | undefined`. `flush()` opens with `if (this.sending) await this.sending;`, drains the whole buffer atomically, and stores the in-flight send in `this.sending` (cleared via `.finally`, so a rejected fetch doesn't strand the gate). The send itself is a small private `send(toSend, options)` method — keeps `flush()` to the gate/drain shape. Covers manual, periodic, and size-trigger callers uniformly because they all funnel through `flush()`.

*Why `if`, not `while`:* the drain is atomic and empties the buffer. Any caller waiting on `this.sending` wakes to an empty buffer (or only what `record()` added during the send) — the `if (this.buffer.size === 0) return;` guard handles the empty case, and the single sender pattern means no two callers race on a partial drain.

*Why one drain per send (no per-POST cap):* an earlier version capped each POST at `flushAt` events so a slow send + record burst couldn't ship one huge body. That cost a `while`-loop gate (multiple waiters racing on residuals), a parallel `keys: string[]` in `EventBuffer`, and partial-drain seen-key bookkeeping. `maxBufferSize` already bounds the buffer (and therefore the worst-case POST body); the cap was a second line of defense paying real complexity for a marginal benefit at dogfooding scope. Dropped.

*Why one in flight at all:* parallel POSTs may arrive out of order and offer no backpressure when the server is slow. One in flight ⇒ slow send grows the buffer ⇒ `maxBufferSize` trips `queueFull`. Each `flush()` ships at most one batch and resolves after either its POST completes or it observes an empty buffer (someone else drained). `close()` + keepalive caveat: a size-trigger firing in the close window may ship without keepalive — concurrent record during close is already user error.

## `Scheduler.stop()` is async and awaits the in-flight handler

`stop(): Promise<void>` — not `void`. A `Scheduler` tracks the currently running handler invocation and `stop()` awaits it before resolving. *Why:* callers (notably `FlightRecorder.close()`) want a single await-point that means "no more handler invocations are running or will start." Without it, `close()` could cancel the next tick but the current tick's `flush()` would still be racing against `close()`'s own final flush. With async stop, `await this.scheduler.stop()` in `close()` resolves only when any periodic flush has fully settled — then `close()` runs its own final flush. No overlap. Pinned by `timer-scheduler.test.ts > 'stop awaits an in-flight handler before resolving'`.

## One scheduler; the `Timer` is the injected seam

There is exactly one `Scheduler` implementation — `TimerScheduler`. It takes a required `Timer` collaborator (`src/timer.ts`): `schedule(ms, callback) => cancel`, a one-shot delayed callback. Production wires `systemTimer` (`setTimeout`/`clearTimeout`); tests wire a `ControllableTimer` whose pending callback fires only on `advance(ms)`. There is no `FakeScheduler` — a test that needs to drive time builds `new TimerScheduler(new ControllableTimer())` and advances the timer directly. The scheduler *algorithm* (once-guard, status, self-chaining, in-flight tracking) exists once; "fake" vs "real" is purely which `Timer` is injected.

*Why this over a shared base / core:* an earlier `SchedulerCore` extraction was reverted as too much indirection. The seam that actually differs between test and production is not "half of a scheduler" — it is *the timer itself*. Injecting `Timer` removes the duplication by deleting the second scheduler outright, rather than by factoring a shared fragment out of two. A `FakeScheduler` wrapper (bundling scheduler + timer into one object) was also tried and dropped — it just added a delegation hop; `timer.advance(ms)` is both less code and more honest than `scheduler.advance(ms)` (a scheduler doesn't advance itself, time does).

The one subtlety: `TimerScheduler`'s timer callback **returns** its in-flight handler promise. `systemTimer` drops that return (`setTimeout` is fire-and-forget — correct for production). `ControllableTimer.advance` instead `await`s it, so the scheduler has re-armed the next tick before `advance` loops — no microtask-flushing guesswork. A gated handler simply parks `advance` until the gate opens. `Timer` is required, not defaulted (no bastard injection — the app wires `new TimerScheduler(systemTimer)` explicitly).

## `TimerScheduler` is tested with `ControllableTimer` — no fake timers

`timer-scheduler.test.ts` is a plain, flat `describe` of five `it`s — no `describe.each`, no harness, no `vi.useFakeTimers()`. Each test builds `new TimerScheduler(new ControllableTimer())` and drives time with `timer.advance(ms)`. Behaviours pinned: runs-per-tick, `runEvery`-twice throws, status lifecycle, no-run-after-stop, stop-awaits-in-flight.

*Why no `vi.useFakeTimers()`:* `ControllableTimer` already *is* a deterministic, in-memory clock — mocking the global timer on top of it would be redundant and makes tests harder to read. `vi.useFakeTimers()` only earns its keep when testing `systemTimer` (real `setTimeout`) directly; we don't — `systemTimer` is six lines of glue over `setTimeout`/`clearTimeout`, exercised in real use, not worth a fake-timer unit test. The whole `Scheduler` algorithm is covered through `ControllableTimer`, which faithfully drives it.

The in-flight test needs no `handlerStarted` signal: `timer.advance(ms)` runs synchronously into the handler (parking at the gate) before returning, so the scheduler's `inFlight` is already set when the next line calls `stop()`.

## Shape: plain `flush()` + `close()`, no in-flight tracking

```ts
async flush() {
  if (this.status === 'closed') return;
  if (this.buffer.length === 0) return;
  const toSend = this.buffer.splice(0);
  try { await this.httpClient.post(toNdjson(toSend)); }
  catch (err) { this.onError?.({ reason: 'persistentFailure', droppedEventCount: toSend.length, error: err }); }
}

async close() {
  if (this.status === 'closed') return;
  await this.scheduler.stop();   // resolves after any in-flight periodic handler settles
  await this.flush();
  this.status = 'closed';        // set AFTER flush, so flush()'s own status guard doesn't early-return
}
```

State is just: `buffer`, `status: 'open' | 'closed'`. No `flushInFlight`, no worker, no `kickWorker`.

*Why this shape:* an earlier worker-loop design with `kickWorker` / `workInProgress` was too clever for the small number of guarantees we actually wanted. The simple version is direct: `flush()` splices and posts; `close()` stops the scheduler, runs a final `flush()`, then marks closed. The ordering in `close()` is deliberate — `status = 'closed'` happens *after* the drain so `flush()`'s own status guard doesn't skip the final send.

*What this gives up:* the size-trigger path (`void this.flush()` from `record`) and any manual `flush()` calls are not tracked, so they can still race with `close()`'s final flush. The *periodic* handler is awaited via `scheduler.stop()` — that was the most common in-flight-at-shutdown case. For dogfooding scope this is acceptable; if a real test ever needs stricter guarantees on the non-periodic paths, drive it in then.

The scheduler stays narrow: `{ runEvery, stop, getStatus }`. `getStatus()` returns `'active' | 'stopped'` (union, not boolean). `stop()` returns `Promise<void>`.

## `RecorderStatus = 'open' | 'closed'`; everything is a no-op after close

`FlightRecorder` tracks its lifecycle as a private `status: 'open' | 'closed'` union (not a boolean — same reason `SchedulerStatus` is a union). Once `close()` finishes, `record()` and `flush()` early-return immediately, so further calls don't buffer or POST. `close()` is idempotent (calling it twice is a no-op).

`close()` sets `status = 'closed'` *after* its final `flush()` — otherwise the final flush would early-return on its own guard. This means: between `close()` being invoked and its final flush settling, any `record()` calls still buffer (and may even trigger a size-flush). That's intentional — the contract is "after `close()` *returns*, the recorder is dead." Concurrent `record()` during the close window is user error; we don't try to recover from it.

The status is not exposed publicly. If a caller ever needs to ask "is this closed?", we'll add a getter then.

## `ImpressionEvent.timestamp` required; envelope stamping dropped

`ImpressionEvent` now requires `timestamp: string`. The field is not generated by the recorder — it is passed through verbatim from the caller (the Unleash JS SDK already produces it via `events-handler.ts:47`). *Why:* every impression the SDK emits carries a pre-formatted `timestamp` (`YYYY-MM-DD HH:mm:ss.SSS`) in the event object passed to `emit('impression', e)`. Our type needed to accept that shape without requiring callers to cast. The recorder's job is to buffer and ship, not enrich.

The reference design's envelope (`schemaVersion`, `source`, `appName`, `environment` stamped at serialize time) was designed under the assumption that the recorder enriches bare events. For our dogfooding flow — Unleash admin UI FE and Unleash Cloud BE, both wired to the Unleash JS SDK — those fields are already in the event or in `event.context`. Stamping them would duplicate data. `schemaVersion` and `source` were explicitly dropped; `appName` and `environment` live in `event.context`; `timestamp` is now typed at the top level to match what the SDK emits.

## `keepalive: true` on `close()` flush; `flush(options?)` accepts it on demand

`close()` calls `this.flush({ keepalive: true })` so the browser holds the outgoing request open during page navigation. `flush` accepts an optional `{ keepalive?: boolean }` that threads through to `httpClient.post` and then to ky's request init. The default (no option or `keepalive: undefined`) lets ky send a normal request — no change for periodic or size-triggered flushes.

*Why:* the dominant data-loss path for the Unleash admin UI FE is `beforeunload`/`pagehide` — the browser cancels in-flight `fetch` requests that weren't started with `keepalive: true`. Wiring `keepalive` at `close()` rather than everywhere keeps normal flushes unaffected. `HttpClient.post` accepts `options?: { keepalive?: boolean }` inline (no separate named type) to keep the surface minimal; the factory parameters were destructured in `createHttpClient` to avoid the inner `options` parameter shadowing the outer factory `options`.

## In-batch dedup via injected `dedupKey`; seen set resets on flush

`record()` calls `buffer.add(event)`, which invokes the injected `dedupKey(event)` function to derive a string key and checks it against a `Set<string>`. Duplicates within the current flush window are silently dropped — "first seen wins." The set is cleared atomically alongside `buffer.splice(0)` at the start of `flush()`, so the same event can be recorded again after a flush.

`EventBuffer<T>` takes a required `dedupKey: (event: T) => string` at construction. The buffer is generic and shape-agnostic; the caller owns the identity definition. `FlightRecorder` passes a function that spreads the event, deletes `eventId` and `timestamp`, and stringifies the rest. *Why exclude those two fields:* the Unleash JS SDK stamps a fresh UUID (`eventId`) and `timestamp` on every impression evaluation. Two evaluations of the same flag with the same context are semantically identical but arrive with different UUIDs and timestamps — full-event stringify never collides in practice, so the dedup pathway never fired. Stripping the SDK-stamped identity fields leaves the semantic identity (`eventType`, `featureName`, `context`, `enabled`/`variant`, `name`/`payload`). The previous assumption — "same call site, same inputs → identical stringify" — was invalidated as soon as those fields were typed at the top level. A test confirmed the failure; the injected key is the fix.

*Why a `JSON.stringify` replacer, not spread+delete:* `{ ...event }` allocates a new object on every `record()` call, and `delete` forces V8 to transition the object's hidden class (a known deoptimization path). The replacer walks the existing structure and omits the two keys while building the output string directly — no intermediate allocation, no mutation. Trade-off: the replacer also strips any key named `eventId` or `timestamp` that appears inside nested objects (e.g., inside `context`). This is accepted: SDK context objects don't carry fields with those exact names, and a false omission would only weaken the dedup key (causing a missed dedup), not produce a false positive.

*Why clear on splice, not on send success:* the splice and the clear are both the "drain" step — if we waited for the send to succeed before clearing, a failed flush would leave the seen set stale (events would never be re-recordable). Clearing on splice keeps the seen set aligned with the buffer state at all times.

*Why dedup before the buffer cap check:* a duplicate that would exceed the cap shouldn't fire `onError({ reason: 'queueFull' })` — it's not a capacity problem, it's a repeat. Checking `seen` first keeps cap errors meaningful.

## Buffer cap is a multiplier of `flushAt`, not an absolute number

`BatchOptions` requires `flushAt: number` and accepts an optional `maxBufferSizeMultiplier?: number` (default `DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER` = 2, exported from `src/flight-recorder.ts`). Effective cap = `flushAt × multiplier`; when `record()` is called with the buffer at that cap, the incoming event is dropped and `onError({ reason: 'queueFull', droppedEventCount: 1 })` fires. `ErrorInfo` is a discriminated union — `'persistentFailure'` carries `error: unknown`, `'queueFull'` does not.

*Why a multiplier, not an absolute cap:* the relationship between trigger and cap is what matters for safety. A multiplier expresses that relationship directly: "1× = cap at the trigger, 2× = one trigger-batch of headroom, 5× = generous slack." An absolute number opens the door to inversions (cap < trigger) and forces the integrator to reason about two unrelated numbers; the multiplier collapses that into one ratio. The library validates `multiplier >= 1` so the cap can never be below the trigger.

*Why `flushAt` is required but the multiplier isn't:* the multiplier needs a base to multiply, so `flushAt` is the load-bearing required value (and mandating it also kills the no-trigger-no-cap mode that used to be expressible). The multiplier itself has a safe, opinionated default — 2× covers the realistic burst-during-in-flight-POST case — so it is optional. Callers naming a different ratio is a deliberate budget choice, not a configuration burden.

*Why default `2`, not `1` or `5`:* with the atomic drain, multiplier `1` only drops when records arrive during an in-flight POST; that's the dominant case we want to absorb. `2×` gives one full trigger-batch of headroom without bloating memory. `5–10×` is a budget choice for the integrator (~17–35 MB at 350 B/event with `flushAt = 10_000`), not a library default. The number lives in `DEFAULT_MAX_BUFFER_SIZE_MULTIPLIER` so callers can read it programmatically.

*Why `multiplier >= 1`, not `> 1`:* multiplier `= 1` is legitimate when the integrator wants a tight cap (cap == trigger). Some integrators (constrained memory, latency-tolerant) want exactly that.

*Why drop new instead of oldest:* oldest events are closest to being shipped on the next flush; dropping them would throw away work that's already been buffered. Dropping new is also O(1) — no splice needed.

*Why `droppedEventCount: 1` per call:* each `record()` call is one event; batching the count across multiple drops would require extra state and makes the callback harder to reason about. Callers who want a running total can accumulate in their `onError` handler.

*Browser keepalive constraint:* at ~300–400 bytes per event, 64 KB fits roughly 150–200 events. The integrator should keep `flushAt × multiplier` well below that for browser callers using `close()` on unload.

*Composition root:* `createFlightRecorder` (`src/index.ts`) wires `DEFAULT_BATCH = { flushAt: 10_000, flushAfterMs: 10_000 }`. Multiplier is intentionally omitted — the library-side default is the single source of truth, so the effective cap is `10_000 × 2 = 20_000` events (~7 MB at 350 B/event). Partial `batch` from the caller merges with the default (`{ ...DEFAULT_BATCH, ...options.batch }`) so callers can tweak one field without re-specifying the others.

*What used to live here:* an earlier design used `maxBufferSize: number` (absolute, optional), then `maxBufferSize: number` (required) with a `maxBufferSize >= flushAt` validation. Both leaked the cap-vs-trigger relationship to the caller as two free numbers and a constraint. The multiplier expresses the constraint in the type, so the "throws when maxBufferSize is less than flushAt" runtime check (and its test) became unnecessary — that inversion is now unrepresentable.

## `EventBuffer<T>` extracted from `FlightRecorder`

Buffer state (array, dedup set, cap rule) was inlined in `FlightRecorder`. Extracted into `EventBuffer<T>` in `src/event-buffer.ts`. `add(event): AddResult` returns a discriminated `'added' | 'duplicate' | 'overflow'` signal; the recorder reads the result and decides what observability / flush actions to take. `drain(): T[]` splices the array and clears the seen set atomically. Generic over `T` — the buffer doesn't inspect event shape; it stringifies opaquely.

*Why this split:* the recorder's concerns are lifecycle/status, batching policy, and HTTP transport. Buffer state (how many events are pending, are any duplicates, is the cap exceeded) is a distinct invariant. Extracting it makes the invariant independently testable (step 2 will add `src/event-buffer.test.ts`) and shrinks `record()` and `flush()` to policy logic only.

*Why the recorder still owns `flushAt` / `onError`:* `flushAt` is a policy decision about when to trigger a network send — it belongs next to the HTTP client logic, not inside the buffer. `onError` is an observability surface; `EventBuffer` returning `'overflow'` instead of calling a callback keeps the buffer decoupled from the recorder's observability contract.

## `CustomEvent` shape mirrors `ImpressionEvent`

`CustomEvent` is defined with the same `eventType / eventId / timestamp / context` prefix as `ImpressionEvent`, plus `eventName: string` (parallels `featureName`) and `payload?: Record<string, unknown>` for structured custom data. *Why:* symmetric shapes make call sites readable and let ClickHouse's wide-table model query both event types with the same column conventions. No upstream SDK shape was treated as canonical — we own this type. `payload` is narrowed to `Record<string, unknown>` (not bare `unknown`) to push callers toward ClickHouse-queryable objects while still accepting arbitrary nested data inside.

## Custom events dedup via the same `semanticEventKey` as impressions

`eventName + context + payload` form the semantic identity for custom events — the same `semanticEventKey` function (strips `eventId`/`timestamp`, JSON-stringifies the rest) handles both event types. *Why:* React-render-style identical re-emits are the dominant duplicate source for both types; uniform treatment keeps `EventBuffer`'s `dedupKey` injection point single-purpose. Tradeoff accepted: rapid identical user actions within one flush window collapse to one event on the wire — acceptable at dogfooding scope. Pinned by `'sends custom events with the same eventName but different payloads separately'`.

## Heterogeneous batches: impressions and custom events in one NDJSON body

The recorder ships heterogeneous batches — `ImpressionEvent` and `CustomEvent` objects flow through one `EventBuffer<ImpressionEvent | CustomEvent>` and serialize into a single NDJSON body per flush. *Why:* one HTTP round-trip per flush window regardless of event-type mix; the ingestion side discriminates by `eventType`. Pinned by `'ships both impression and custom events in one batch'`.

## `CustomEvent.payload` ships verbatim — no validation or coercion

`payload?: Record<string, unknown>` is serialized as-is via `JSON.stringify`; nothing inside is inspected, coerced, or re-parsed. *Why:* structured arbitrary application signal is the entire point of custom events; the `Record` constraint pushes callers toward ClickHouse-queryable shapes, but everything inside (nested objects, arrays, scalar values) stays untouched. Pinned by `'preserves nested payload data on the wire'`.

## `retryDelay` option on `HttpClient` — test escape hatch, ky default in production

`HttpClientOptions.retryDelay?: (attemptCount: number) => number` is an optional pass-through to ky's `retry.delay`. When unset (production default), ky's exponential backoff applies. Tests pass `retryDelay: () => 0` so the retry-coverage test runs in ~10ms instead of ~310ms. *Why:* the HttpClient retry test covers a real choice we make (opting POST into ky's retry list via `methods: ['post']`), and renaming it from `'retries the failed fetch after one attempt and then succeeds'` to `'retries POST requests when retries is configured'` makes that value visible. But paying ~300ms per CI run for that single assertion is wasteful — the delay is incidental to what the test asserts. Exposing `retryDelay` lets the test override it without changing production behavior. The option is not surfaced on `FlightRecorderOptions` yet; if a production caller ever needs a custom curve, add it then with the test that demands it (per [[feedback-design-taste]]).

## NDJSON request body is sent buffered, not streamed

`flush()` builds the whole batch as one in-memory string — `toNdjson` returns a `string` — and hands it to `httpClient.post(body: string)`, which passes it to `ky` → `fetch` as `{ body }`. A string body is a fully-buffered request: `fetch` sets `Content-Length` up front and sends one complete entity. The request body is never a `ReadableStream`; nothing is streamed on the client side. (Events are still *batched* in `EventBuffer` between flushes — that is application-level buffering; it is separate from how a single batch is transmitted, which is buffered too.)

*Why the format is still NDJSON if the client doesn't stream:* NDJSON's streamability is a *server-side* benefit — the ingestion server can stream-parse the received body line-by-line off the socket and pipe it into ClickHouse's `JSONEachRow` — and that holds regardless of how the client sent the bytes. The format choice pays off on ingestion; it does not require the client to stream.

*Why not stream the request body:* client-side request streaming would mean rearchitecting `toNdjson` from a `string`-returning function into a stream / async-iterable, changing `HttpClient.post`'s signature, and depending on browser `fetch` streaming-request-body support (needs HTTP/2 + `duplex: 'half'`, patchy across browsers). At realistic batch sizes a 10k-event flush is only ~3–4 MB — `fetch` handles a multi-MB string body trivially. Buffered keeps the transport simple at no measurable cost. If batches ever grow large enough that holding the whole string in memory hurts, revisit then.

*Interaction with `keepalive`:* a buffered body is what makes the browser ~64 KB `keepalive` cap relevant on the `close()`/unload path — see the keepalive note in the buffer-cap decision. Streaming the body would not lift that cap; it applies to total keepalive request size, not to whether the body streams.

## Dedup key built from identifying fields, not a `JSON.stringify` replacer

`semanticEventKey` (`src/semantic-event-key.ts`) builds the dedup key by joining the event's identifying fields (`eventType`, `featureName`, `variant`, `enabled` for impressions; `'custom'`, `eventName`, `payload` for custom events) with `U+001F`, and calls `JSON.stringify` only on `context`/`payload`. It does **not** use `JSON.stringify(event, replacer)` with a function replacer. This supersedes the replacer implementation described in the "In-batch dedup via injected `dedupKey`" entry above — the `*Why a JSON.stringify replacer, not spread+delete*` reasoning there is now historical.

*Why:* a *function* replacer disables V8's fast-path serializer and is invoked once per property of the entire event graph — every top-level field, every `context` key, every nested `properties` key. Building the key directly reads the scalar identifying fields with no serialization at all and runs `JSON.stringify` — on the fast path, no replacer — only on the open-ended `context`/`payload` subtrees.

*Measured:* ~2× faster on the `EventBuffer.add` hot path. `npm run bench` (`src/event-buffer.bench.ts`) benchmarks both keys against each other — the old replacer key is kept there as a local `replacerSemanticEventKey` baseline so the speedup stays measurable. Controlled comparison (same workload, key implementation varied), single core, measured on an Apple Silicon Mac:

| Workload (add 10k events + drain) | Replacer key | Field-list key | Speedup |
|---|---|---|---|
| 10k distinct events | ~0.72M events/sec | ~1.45M events/sec | 2.02× |
| 10k events, 95% duplicates | ~0.80M events/sec | ~1.56M events/sec | 1.93× |

Absolute throughput is machine-specific and will drift; the ~2× ratio is the durable claim — re-measure with `npm run bench`. *Scope:* this is the in-memory per-event CPU cost only; it does not change end-to-end recorder throughput, which is bounded by the HTTP flush.

## `eventId` dropped from `ImpressionEvent` and `CustomEvent`

Neither event type carries an `eventId` field. `record()` accepts events without one; nothing generates or forwards an id. *Why:* it was a passthrough field used by nothing. Client-side dedup (`semanticEventKey`) deliberately excludes it. It is not a retry-idempotency key either — `ky` retries resend the *identical* drained batch, and events never cross batch boundaries (`drain()` removes them), so retry-dedup is a per-*batch* concern, not per-event; a per-event id could not serve that role. And it carries no correlation value: the Unleash **Node** SDK emits no id on its impression event (`{ eventType, context, enabled, featureName, variant? }`), so an `eventId` would have been a freshly minted UUID correlating to nothing upstream.

This reverses the earlier "keep SDK-provided UUIDv4 IDs for correlation" rationale, which assumed the SDK stamps an `eventId` on every evaluation — true of the *frontend* SDK, not the *Node* SDK we target. The stale "SDK stamps a fresh UUID (`eventId`)" claim in the "In-batch dedup via injected `dedupKey`" entry above is superseded here.

*If retry-idempotent ingestion is later wanted:* add a per-batch `Idempotency-Key` header on the flush POST, reused across that batch's retries — not a per-event id.

`timestamp` is kept: it is genuine event data for time-series queries in ClickHouse. It has the same "Node SDK does not emit it" gap — integrators currently supply it in the `on('impression', ...)` handler; making it recorder-generated is a separate open question.

## `Clock` collaborator; recorder owns `timestamp`

`ImpressionEvent`/`CustomEvent` — the `record()` input types — carry no `timestamp`. `record()` stamps every event via an injected `Clock` (`{ now(): string }`, `src/clock.ts`); the buffered and wire shape is the internal `StampedEvent = (ImpressionEvent | CustomEvent) & { timestamp: string }`. *Why:* the Unleash **Node** SDK emits no timestamp on impression events (`{ eventType, context, enabled, featureName, variant? }`), so requiring one pushed a mechanical `new Date().toISOString()` onto every integration handler — the same boilerplate the dropped `eventId` was (see the entry above). `record()` runs synchronously right after the event occurs, so record-time *is* the event time.

*Why the recorder owns it outright, not an optional caller value:* a caller-supplied `timestamp` was briefly allowed and then removed. Typed as a bare `string` it is unvalidated — a malformed value (`'yesterday'`, a stray epoch) flows into the NDJSON batch and fails the ClickHouse insert for the whole block. No real integration path supplies a timestamp anyway (neither the Node SDK nor the frontend SDK emits one on the shape we consume); the only genuine use — historical backfill/replay — is not a live-recorder concern. Making the recorder the sole authority removes the footgun by construction: callers cannot get the format wrong because they cannot set it.

*Why a separate `Clock`, not `now()` on `Timer`/`Scheduler`:* this honours the "`Scheduler` collaborator with `runEvery`, not `Clock`" decision above — scheduling recurring work and reading the current instant are distinct concerns. `Timer`/`Scheduler` keep their scheduling-only surface; `Clock` is read-only time. That earlier decision rejected a `Clock` that *bundled* `now()` with `setTimeout`; a `now()`-only `Clock` alongside the scheduler keeps each abstraction single-purpose.

`Clock` is required DI on `FlightRecorderOptions` (no bastard injection). The composition root (`createFlightRecorder`) wires `systemClock` (`() => new Date().toISOString()`); tests inject a fixed-value clock. `semanticEventKey` excludes `timestamp` from the dedup key, so two duplicate `record()` calls stamped at different instants still collapse.
