# Phase 6 — Integration proof, docs & GitHub release

**Goal:** Prove bobina works with the real cocontinuity pattern, document it,
and publish the repo to GitHub so cocontinuity can consume it as a git
dependency.

Read `PLAN.md` (gotcha #5, "Definition of done") first.

## 1. Next.js instrumentation recipe — `examples/nextjs-instrumentation/`

A documented, copy-pasteable recipe (markdown + code files, **not** a full
runnable Next app) showing the exact cocontinuity E2E pattern:

- `instrumentation.ts` snippet: in `register()`, gated on `process.env.E2E_MODE`
  and `process.env.NEXT_RUNTIME === 'nodejs'`, dynamically import bobina and call
  `createBobina({...}).listen()` with `hosts: ['api.anthropic.com', 'openrouter.ai']`.
- A route handler snippet (`app/api/cassette/route.ts`) that calls
  `createBobina(...).useCassette(name)` — reusing the globalThis singleton — to
  switch cassettes between Playwright tests.
- A Playwright `beforeEach`/`afterEach` snippet that POSTs the cassette name.
- A prominent note: **run E2E against `next build && next start`, never
  `next dev`** (React 19 hydration race), and `E2E_MODE=record` for first
  capture then `E2E_MODE=replay`/`none` for CI.
- `README.md` in the example folder tying it together.

## 2. Integration test — `tests/integration.test.ts`

Prove the public API against undici's global `fetch` on Node (not just
`node:http`): start a local server, `createBobina({ mode: 'all', hosts:[...] })`,
`listen`, `use`, `fetch` via global `fetch`, `eject`, `close`; then a fresh
`createBobina({ mode: 'none' })` with the **server stopped** replays
successfully. Assert the singleton + host scoping behave.

## 3. Docs

- **`README.md`** (root) — full rewrite: pitch, why-it-exists (the Polly/nock
  story, condensed), install-from-GitHub, both API surfaces with runnable
  snippets, the record-modes table, request-matching + filters sections, the
  Next.js recipe link, gotchas, "Status: alpha / stack-scoped" note, MIT.
- **`CHANGELOG.md`** — `## 0.1.0` with the initial feature list.
- Ensure `LICENSE` (MIT, Lucas Guedes) is present.

## 4. GitHub publish

The repo is already a local git repo with one commit. Finalize and publish:

```bash
# stage everything produced by the execution
git add -A
git commit -m "feat: bobina v0.1.0 — HTTP cassettes for the modern Node fetch era"
# create the public repo on GitHub (gh is authed as lukasedw, SSH) and push.
# If the repo already exists, fall back to adding the remote + pushing.
gh repo create lukasedw/bobina --public --source=. --remote=origin --push \
  --description "HTTP cassettes (record/replay) for the modern Node fetch era" \
  || (git remote add origin git@github.com:lukasedw/bobina.git 2>/dev/null; \
      git push -u origin HEAD)
git tag v0.1.0
git push origin v0.1.0
```

Then verify install-from-GitHub resolves the build:
```bash
# in a scratch temp dir, NOT inside the repo
cd "$(mktemp -d)" && pnpm init -y >/dev/null && \
  pnpm add github:lukasedw/bobina && \
  node -e "import('bobina').then(m => { if(!m.createBobina||!m.useCassette) process.exit(1); console.log('ok'); })"
```
The `prepare` script must build bobina during this install. If it doesn't
resolve, fix `prepare`/`files`/`exports` until the scratch import succeeds.

## 5. Follow-up (NOT part of this execution — document only)

Add a short `docs/cocontinuity-integration.md` describing the manual swap done
later in the **cocontinuity** repo:
- `pnpm add github:lukasedw/bobina` there.
- Replace `lib/testing/e2e-harness.ts` internals with `createBobina(...)`,
  keeping the `/api/e2e-cassette` route + `instrumentation.ts` wiring.
- Re-record the existing fixture, run `E2E_MODE=replay pnpm test:e2e`.

## Validation (must pass)

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```
Plus: the scratch-dir `pnpm add github:lukasedw/bobina` import smoke test
prints `ok`, and `gh repo view lukasedw/bobina` succeeds.

## Done criteria

- Integration test green against global `fetch`.
- README + CHANGELOG + example recipe complete.
- `lukasedw/bobina` public on GitHub, `v0.1.0` tagged, CI workflow present.
- Install-from-GitHub smoke test passes.
