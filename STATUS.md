# Current status

Snapshot of where the port stands. **This file goes stale fast** — update it each TDD step or treat it as a handoff snapshot only.

Last updated: 2026-05-14

## What's built

`src/flight-recorder.ts`
- `FlightRecorder` with explicit DI: `{ url, clientKey, fetch }` — all required, no defaults.
- `record(event: ImpressionEvent | CustomEvent)` — pushes to internal buffer.
- `async flush()` — early-return on empty buffer; atomic snapshot via `buffer.splice(0)`; serializes via `toNdjson`; `POST` to `url` with `Content-Type: application/ndjson` and `Authorization: <clientKey>`.
- Types: `ImpressionEvent` (discriminated by `eventType: 'isEnabled' | 'getVariant'`), `CustomEvent` (`eventType: 'custom'`), `FlightRecorderOptions`.

`src/ndjson.ts`
- `toNdjson(items: ReadonlyArray<unknown>): string` — generic NDJSON serializer. One JSON object per line, trailing `\n`. Returns `''` for empty input (the recorder's `flush` already guards against calling it that way, but the function handles it safely).

## Tests (6 passing)

`src/flight-recorder.test.ts`
1. `'records an impression'` — `record()` accepts an `ImpressionEvent`
2. `'records a custom event'` — `record()` accepts a `CustomEvent`
3. `'can flush with no events'` — empty-buffer guard
4. `'ships recorded events to the configured url on flush'` — happy path: asserts URL, method, headers (`Content-Type`, `Authorization`), and body in a single `expect`
5. `'an event recorded mid-flush is sent on the next flush'` — atomicity: events recorded during an in-flight `fetch` are preserved for the next flush

`src/ndjson.test.ts`
6. `'emits one JSON object per line with a trailing newline'`

Test conveniences in `flight-recorder.test.ts`:
- Module-level `defaultUrl`, `defaultFetch`, `defaultClientKey`, and a `createRecorder(overrides?)` factory. Tests that don't exercise a particular constructor input rely on the factory; tests that do override (with values different from defaults) to make the data flow visible.

## What's deliberately NOT yet built

Each line is a future TDD step:

- **Transport failure handling.** If `fetch` rejects, the spliced events vanish. No test pins down the desired behavior. *(This is the next test on deck — see below.)*
- **5xx response handling.** `fetch` doesn't reject on a non-2xx status; we'd need `response.ok` and re-queue. Not handled.
- **Auto-flush triggers.** No size threshold, no timer. `flush()` is manual.
- **`close()` method.** Graceful shutdown (final flush + stop accepting events).
- **`keepalive: true`** option on `flush()` for browser unload.
- **Dedup of identical buffered events.**
- **Custom event end-to-end test.** Type accepts `CustomEvent`, but no test asserts it actually reaches the wire.
- **Batching coverage test.** Impl supports multi-event batches, but no test pins the wire shape of a batch.

## Next test on deck

**`'keeps events in the buffer when the transport fails'`**

Design baked into the test:

- **Re-queue at the front** (`buffer.unshift(...toSend)`) so events recorded *during* the failed fetch stay chronologically after the failed batch.
- **Rethrow** so the caller knows transport failed (the test's `.catch(() => {})` acknowledges this).

Sketch:

```ts
it('keeps events in the buffer when the transport fails', async () => {
  let firstAttempt = true;
  const sentBodies: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    sentBodies.push(String(init?.body ?? ''));
    if (firstAttempt) {
      firstAttempt = false;
      throw new Error('network down');
    }
    return new Response();
  };

  const recorder = createRecorder({ fetch: fakeFetch });
  const event: ImpressionEvent = { /* ... */ };

  recorder.record(event);
  await recorder.flush().catch(() => {});  // first attempt rejects
  await recorder.flush();                   // second succeeds

  expect(sentBodies).toEqual([
    JSON.stringify(event) + '\n',
    JSON.stringify(event) + '\n',
  ]);
});
```

Impl change:

```ts
try {
  await this.fetch(this.url, { method: 'POST', headers, body });
} catch (err) {
  this.buffer.unshift(...toSend);
  throw err;
}
```

If a different direction feels more useful first, alternatives discussed (no impl change for the regression-guard ones):

- **5xx status handling** — adjacent concept, different impl path.
- **Batching coverage test** — record N, flush once, assert single POST with all N events on N lines.
- **Custom event end-to-end** — `CustomEvent` through `record + flush`, asserting wire body.
