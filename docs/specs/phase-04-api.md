# Phase 4 — Public API surfaces

**Goal:** Wrap the Phase 3 engine in the two ergonomic surfaces from `PLAN.md`:
the block API `useCassette` and the long-running-server API `createBobina`.

Read `PLAN.md` ("Public API" section) first.

## File: `src/bobina.ts`

```ts
interface BobinaConfig {
  cassetteDir: string;
  mode?: RecordMode;             // default 'once'
  hosts: string[];
  matchers?: MatcherKey[];
  customMatchers?: CustomMatcher[];
  filters?: Filter[];            // type defined in Phase 5; accept + thread through now
  now?: () => string;            // default () => new Date().toISOString()
  onUnmatched?: (req: RecordedRequest) => void;
}
interface Bobina {
  listen(): Promise<void>;
  close(): Promise<void>;
  useCassette(name: string): Promise<void>;
  eject(): Promise<void>;
  currentCassette(): string | null;
}
function createBobina(config: BobinaConfig): Bobina;
```

`createBobina` constructs a Phase 3 engine and exposes the lifecycle. `listen`
applies the interceptor, `close` disposes it, `useCassette` switches the active
cassette, `eject` flushes.

### globalThis singleton (gotcha #4)

`createBobina` must store its engine on
`globalThis.__bobina__` (typed via a module augmentation, no `any`). If
`createBobina` is called again in the same process with a compatible config,
reuse the existing instance instead of stacking interceptors. This is what makes
the Next.js instrumentation pattern survive bundle splits: the route handler
that calls `useCassette` and the instrumentation hook that called `listen` share
one engine. Provide a `resetBobinaSingleton()` test helper (also on the typed
global) so tests can isolate.

## File: `src/use-cassette.ts`

```ts
interface UseCassetteOptions extends Omit<BobinaConfig, never> {}
async function useCassette<T>(
  name: string,
  options: UseCassetteOptions,
  fn: () => Promise<T>,
): Promise<T>;
```

Block API: create a **local** engine (NOT the global singleton — block usage is
self-contained), `apply()`, `use(name)`, run `fn`, then `eject()` + `dispose()`
in a `finally`. Return `fn`'s result. This is the Vitest-friendly surface.

## `src/index.ts`

Export: `createBobina`, `useCassette`, `resetBobinaSingleton`, and all public
types (`RecordMode`, `MatcherKey`, `BobinaConfig`, `Bobina`, `Filter`,
`CustomMatcher`, cassette types). Remove the temporary `VERSION` export or keep
it alongside.

## Tests

- `use-cassette.test.ts`: against a local `node:http` server — `useCassette` in
  mode `all` records, a second `useCassette` in mode `none` (server stopped)
  replays. Assert isolation: a local engine does not leak onto the global
  singleton.
- `bobina.test.ts`: `createBobina` lifecycle (listen → use → fetch → eject →
  close); calling `createBobina` twice reuses the singleton (assert the same
  engine identity / no double interception); `resetBobinaSingleton` clears it.

## Validation (must pass)

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

## Done criteria

- Both surfaces exported and tested.
- Singleton reuse verified; block API proven isolated from the singleton.
- All validation green.
