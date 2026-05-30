# Phase 5 — Filters, sensitive data & header scoping

**Goal:** Make cassettes safe to commit. Redact secrets before persistence and
restore (or keep redacted) on replay; control which headers are stored/matched.

Read `PLAN.md` (gotcha #3, filters in API) first.

## File: `src/filters.ts`

```ts
interface Filter {
  placeholder: string;                 // e.g. '<ANTHROPIC_KEY>'
  value: string | (() => string);      // the secret to replace on record
}
```

- `applyFiltersOnRecord(interaction, filters): HttpInteraction` — before saving,
  replace every occurrence of each resolved `value` with its `placeholder`
  across request headers, request body, response headers, and response body.
  Skip empty/undefined resolved values (don't replace ''→placeholder).
- `applyFiltersOnReplay(interaction, filters): HttpInteraction` — optional
  inverse: replace `placeholder` back with the live value when serving a replay
  (so a replayed request still carries a usable token if the consumer inspects
  it). Response-side placeholders stay as-is by default.
- Filtering must be deterministic and idempotent.

### Header scoping

Add to `EngineOptions` / `BobinaConfig` (thread through):
- `headerAllowlist?: string[]` — if set, only these (lowercased) request/response
  headers are stored in the cassette. Default sensible denylist always applied:
  drop `set-cookie`, `authorization`, `x-api-key`, `cookie` from **stored**
  headers unless explicitly allowlisted. (They can still be matched live if a
  matcher needs them, but must never land on disk unfiltered.)
- Always strip `content-encoding` + `content-length` (already in Phase 3; keep).

## Wiring

- Phase 3 engine: on record, run `applyFiltersOnRecord` + header scoping before
  appending to the cassette.
- Phase 4 `createBobina` / `useCassette`: pass `filters` + `headerAllowlist`
  into the engine.

## Tests (`tests/filters.test.ts`)

- A secret in a request header + body is replaced by its placeholder in the
  persisted cassette (read the file, assert the raw secret is absent and the
  placeholder present).
- `value` as a function is resolved at record time.
- Denylisted headers (`authorization`, `set-cookie`) never appear in the stored
  cassette.
- `headerAllowlist` restricts stored headers to the listed set.
- Replay with `applyFiltersOnReplay` restores the live value for request
  inspection.
- Round-trip: record with filters → replay → consumer sees a working request.

## Validation (must pass)

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

## Done criteria

- No raw secret can land in a committed cassette under default settings.
- Filters + header scoping wired into both API surfaces and tested.
- All validation green.
