# Decisions

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

## Retry on fetch failure via `retry.attempts`

Opt-in via `retry: { attempts: number }`; `attempts` is total attempts (1 initial + N−1 retries), matching `ky.retry.limit`. `flush()` loops up to `attempts` times on fetch rejection. Default (no `retry`) = 1 attempt = no-retry behavior. *Why:* opt-in keeps callers who want no retry from paying for it implicitly, and reusing the reference's `attempts`-as-total convention avoids an off-by-one trap when readers move between the two codebases.

## Losses surface via `onError`, not thrown from `flush()`

`flush()` never rejects; exhausted retries fire an injected `onError(info)` callback with a discriminated reason union (initially `{ reason: 'persistentFailure', droppedEventCount, attempts, error }`; `queueFull`, `malformed`, etc. will join later). *Why:* auto-flush is fire-and-forget (`void this.flush()`), so a thrown error becomes an unhandled rejection with no info on which events were lost. A callback unifies all loss reasons through one observability hook the integrator wires once. If `onError` is unset, the error is silently swallowed — explicit opt-in to observability matches our DI discipline.

## `onError` carries `droppedEventCount`, not the events themselves

The `persistentFailure` payload exposes `droppedEventCount: number`, not the full `events: Event[]` array (which the reference design includes). *Why:* the buffer can hold thousands of events; passing them to a user-supplied callback retains the whole batch in memory until the callback returns and risks long-lived references in observability code. A count is enough for the dominant use case (metrics, alerting). Callers who need event-level forensics can capture the events themselves via a custom `fetch` wrapper that logs request bodies — that's the right seam.
