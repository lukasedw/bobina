# Phase 2 — Core: cassette model + request matcher

**Goal:** Pure, dependency-free building blocks: the cassette data model with
JSON persistence, and the request matcher. No interceptor wiring yet (Phase 3).

Read `PLAN.md` (cassette format + request matching sections) first.

## Files to create

### `src/types.ts`
Exported types:
- `RecordMode = 'once' | 'new_episodes' | 'none' | 'all'`.
- `MatcherKey = 'method' | 'uri' | 'host' | 'path' | 'query' | 'body' | 'headers'`.
- `RecordedRequest = { method: string; uri: string; headers: Record<string,string>; body: string }`.
- `RecordedResponse = { status: number; headers: Record<string,string>; body: string; bodyEncoding: 'utf8' | 'base64' }`.
- `HttpInteraction = { request: RecordedRequest; response: RecordedResponse }`.
- `Cassette = { bobina: '1'; name: string; recordedAt: string; httpInteractions: HttpInteraction[] }`.
- `CustomMatcher = (recorded: RecordedRequest, incoming: RecordedRequest) => boolean`.

### `src/cassette.ts`
- `emptyCassette(name: string, now: string): Cassette`.
- `async loadCassette(dir: string, name: string, now: string): Promise<Cassette>`
  — read `<dir>/<name>.json`; on `ENOENT` return `emptyCassette`; validate the
  `bobina` version field and throw a clear error on mismatch.
- `async saveCassette(dir: string, cassette: Cassette): Promise<void>` —
  `mkdir -p` the dir, write pretty JSON (2-space).
- Cassette names must match `^[a-z0-9-]+$/i`; reject otherwise (path-safety).
- `now` is injected (string ISO timestamp) — **do not** call `new Date()`
  internally, so the module stays pure/testable.

### `src/matcher.ts`
- `DEFAULT_MATCHERS: MatcherKey[] = ['method', 'uri']`.
- `matchRequest(recorded, incoming, keys: MatcherKey[], custom?: CustomMatcher[]): boolean`.
  - `method`: case-insensitive equality.
  - `uri`: full URL string equality.
  - `host` / `path` / `query`: parse both URIs with `new URL(...)` and compare
    the relevant part (`query` compares sorted search params).
  - `body`: exact string equality.
  - `headers`: every recorded header key/value present in incoming (subset).
  - All `keys` must pass (AND). All `custom` matchers must also pass.
- `findInteraction(cassette, incoming, keys, custom?): HttpInteraction | null` —
  first matching interaction.

## Tests (`tests/`)

- `cassette.test.ts`: round-trip save→load; ENOENT returns empty; version
  mismatch throws; invalid name rejected.
- `matcher.test.ts`: each matcher key in isolation; AND semantics; query order
  independence; header subset; a custom matcher.

Use a temp dir (`node:os` tmpdir + `node:fs`) for cassette I/O tests; clean up.

## Validation (must pass)

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

## Done criteria

- `src/types.ts`, `src/cassette.ts`, `src/matcher.ts` implemented and exported
  from `src/index.ts`.
- Matcher + cassette unit tests cover every matcher key and every cassette
  branch. All validation green.
