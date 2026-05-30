# Next.js instrumentation recipe

How to wire **bobina** into a Next.js (App Router) project so Playwright E2E runs
deterministically offline — the exact pattern the cocontinuity stack uses.

This is a **recipe**, not a runnable app: copy these files into your own Next.js
project and adapt the cassette dir, hosts, and filters. The imports of `bobina`
and `@playwright/test` resolve once you install them in that project.

## The shape of it

```
your-next-app/
├─ instrumentation.ts            # starts bobina at server boot (Node runtime only)
├─ playwright.config.ts          # webServer runs the PROD build; sets E2E_MODE
├─ lib/
│  └─ bobina-e2e.ts              # the one shared bobina config (→ one singleton)
├─ app/
│  └─ api/cassette/route.ts      # control-plane: POST { name } to switch cassette
└─ tests/
   ├─ chat.spec.ts               # beforeEach/afterEach POST the cassette name
   └─ e2e/cassettes/*.json       # recorded fixtures (commit these)
```

## How it works

1. **`instrumentation.ts`** runs once at server startup. Next calls `register()`
   in every runtime, so it bails out unless `E2E_MODE` is set **and**
   `NEXT_RUNTIME === 'nodejs'` (never Edge). It dynamically imports bobina — so
   the library stays out of your normal server bundle — and calls
   `createBobina(...).listen()` to attach the interceptor before any route runs.

2. **`lib/bobina-e2e.ts`** is the single config literal. `createBobina()` keys its
   `globalThis` singleton on `cassetteDir` + `mode` + `hosts`; importing the same
   literal from both the instrumentation hook and the route guarantees they
   resolve to **one** engine even after Next splits the server into chunks
   (PLAN gotcha #4). Don't inline two copies — if they drift, you get two
   interceptors.

3. **`app/api/cassette/route.ts`** is a test-only endpoint. Because it calls
   `createBobina(bobinaConfig)` with that same config, it gets the existing
   singleton back and just calls `.useCassette(name)` to swap the active tape. It
   404s unless `E2E_MODE` is set, so it can't leak into production.

4. **`tests/chat.spec.ts`** POSTs the cassette name in `beforeEach`. The Playwright
   runner is a separate process from the Next server, so it steers recording via
   that HTTP call rather than touching bobina directly.

## ⚠️ Run E2E against `next build && next start` — never `next dev`

React 19's dev-mode hydration races make headless Playwright flaky and
non-deterministic (PLAN gotcha #5). `playwright.config.ts` enforces this by
setting `webServer.command` to `pnpm build && pnpm start`. Do not point it at
`next dev`.

## The record → replay loop

`E2E_MODE` drives everything (read once at server boot):

| `E2E_MODE`        | bobina mode | behaviour                                            |
| ----------------- | ----------- | ---------------------------------------------------- |
| _unset_           | _(off)_     | bobina never loads; real network                     |
| `record`          | `all`       | capture live traffic, overwriting the cassette       |
| `replay` / `none` | `none`      | replay only; a request with no match errors (no net) |

**First capture** (real API keys in env, real network):

```sh
E2E_MODE=record pnpm exec playwright test
```

Commit the JSON files written under `tests/e2e/cassettes/`. Secrets are redacted
on the way to disk by the `filters` in `lib/bobina-e2e.ts`, so the fixtures are
safe to commit and CI needs no API keys.

**CI / everyday replay** (offline, deterministic):

```sh
E2E_MODE=replay pnpm exec playwright test
```

## Files in this recipe

- [`instrumentation.ts`](./instrumentation.ts)
- [`lib/bobina-e2e.ts`](./lib/bobina-e2e.ts)
- [`app/api/cassette/route.ts`](./app/api/cassette/route.ts)
- [`tests/chat.spec.ts`](./tests/chat.spec.ts)
- [`playwright.config.ts`](./playwright.config.ts)
