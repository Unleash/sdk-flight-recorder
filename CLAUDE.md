# Working in this repo

This file captures *how* to work in this repo — conventions, TDD discipline, and naming rules that have evolved through the porting process. For *what has been built and why*, read `DECISIONS.md`. For *where we currently are*, read `STATUS.md`.

This is a small, TDD-driven port of the SDK event listener for the Unleash flight recorder. Dogfooding scope only — Unleash's own admin UI (FE) and Unleash Cloud BE. The reference impl in `../flight_recorder/sdk-listener-reference/` is a design-only sizing artifact, **not** canonical code to port from.

## TDD discipline — strict

- Red → Green → Refactor. No production code without a failing test first.
- One observable behavior per test. If a test name needs "and," split it.
- **Watch the test fail before implementing.** If you can't explain *why* it failed, you didn't drive the behavior.
- Add `DECISIONS.md` entries the same step you land the code — never pre-populate from the reference impl, and never log a decision before the code exists.

## Test naming — by behavior

Name tests by the user-facing capability, not by the assertion mechanics or return value.

- **Good:** `'can flush with no events'`, `'an event recorded mid-flush is sent on the next flush'`, `'ships recorded events to the configured url on flush'`.
- **Bad:** `'flush resolves on an empty recorder'`, `'returns Promise<void>'`, `'sets buffer length to 0'`.

Words like "resolves," "returns," "throws," "is instance of" are mechanics — they belong in the test body, not in the `it(...)` string. Exception: when the contract *is* throwing, e.g., `'throws when url is missing'`.

## Test data minimalism — factory with defaults

A test body should only mention data that participates in the assertion. Constructor inputs the test doesn't care about belong in a factory with defaults.

```ts
const defaultUrl = 'https://example/events';
const defaultFetch: typeof fetch = async () => new Response();
const defaultClientKey = 'default-client-key';

const createRecorder = (overrides: Partial<FlightRecorderOptions> = {}) =>
  new FlightRecorder({
    url: defaultUrl,
    fetch: defaultFetch,
    clientKey: defaultClientKey,
    ...overrides,
  });
```

- Tests that don't care about constructor inputs: `createRecorder()` — no setup ceremony.
- Tests that *do* care: override the relevant field with a value visibly **different from the default** so the assertion shows the value flowing from constructor → output, not a tautology.
- Call the defaults `defaultX`, never `unusedX`. They *are* used (the constructor requires them); they're just defaults the test isn't overriding.

## Dependency injection — explicit, never bastard

Every collaborator (`fetch`, clock, logger, …) is **required** in `FlightRecorderOptions` and assigned without fallback in the constructor.

```ts
// ❌ Don't:
this.fetch = options.fetch ?? globalThis.fetch;

// ✅ Do:
this.fetch = options.fetch;
```

Hiding a dependency with `?? globalThis.x` (bastard injection) makes runtime requirements invisible and lets tests silently rely on ambient state. Production callers pass `globalThis.fetch` explicitly; tests inject fakes via the factory.

## Framing — don't call missing features "bugs"

Until a test or written spec defines the desired behavior, the code is **incomplete**, not **broken**. Reserve "bug" / "broken" / "defect" for code that violates an *existing* test or contract. Otherwise say "not handled yet," "no test pins this down," "the next test would drive…"

## Code style

- TypeScript `strict` plus `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`. `module`/`moduleResolution: NodeNext`.
- Relative imports always end in `.js` (matches the actual Node ESM resolver).
- Tests colocated with source: `src/foo.ts` next to `src/foo.test.ts`.
- Use `import type` for type-only imports (or `import { type X }` mixed).
- Default to no comments. Only add one when *why* is non-obvious — never *what*.

## Commands

- `pnpm test` — vitest, one shot
- `pnpm test:watch` — vitest watch
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm install` (only if you change deps)

## When you don't know the next TDD step

Ask: "what's the smallest *observable* behavior that no existing test pins down?" If the only candidates are shape (method exists, returns a Promise), see if they can fold into a test that drives real behavior. If they can't, a shape test is fine — just don't let one stand alone for long.

Don't drive in features no test demands. If you're tempted to add an option, a field, or a branch, write a failing test first that requires it.
