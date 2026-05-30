# bobina — execution plan

> **bobina** — HTTP cassettes for the modern Node `fetch` era. A VCR
> (record/replay) library built directly on `@mswjs/interceptors`, designed to
> work _exactly_ with the cocontinuity stack: Next.js 16 (App Router,
> instrumentation hook), React 19, undici-backed global `fetch`, Node 20+,
> Playwright E2E against a production build, pnpm.

This document is the source of truth for an **autonomous Midgal execution** (no
review gateways). Each phase has a dedicated spec under `docs/specs/`. Workers
must read the relevant spec before writing code and must leave every phase with
all validation commands green.

---

## Why bobina exists

The cocontinuity repo needed deterministic, offline E2E of its agent chat
streaming path. We tried, in order:

1. **Polly.js** — discontinued (Netflix archived it). Its fetch adapter spreads
   the caller's `AbortSignal` cross-realm and undici rejects it on Node 20+.
2. **nock v14** — alive, but forking it means inheriting a decade of XHR /
   Browserify legacy, and it shares the same architectural pitfall below.
3. **A hand-rolled VCR** in `cocontinuity/lib/testing/e2e-harness.ts` — works,
   but is bespoke and trapped in one repo.

**The architectural pitfall both Polly and nock hit:** they patch
`globalThis.fetch`. Next.js production builds wrap `globalThis.fetch` for their
caching layer at module-eval time. Whichever patches last wins, and ordering is
fragile. bobina sidesteps this by building on `@mswjs/interceptors`, whose
`BatchInterceptor` hooks the request lifecycle at a layer below the fetch
wrapper and fires a `response` event for **both** mocked and real responses —
the ideal seam for record/replay.

There is no canonical, maintained, Rails-VCR-style library for the modern Node
fetch era. bobina fills that gap, scoped (for now) to our stack.

---

## Design philosophy

- **Familiar to VCR (Ruby) users.** Cassettes are JSON files with
  `http_interactions`. Record modes mirror VCR: `once`, `new_episodes`, `none`,
  `all`. Request matching defaults to `method` + `uri`, with configurable
  matchers. Sensitive-data filtering mirrors `filter_sensitive_data`.
- **Two first-class surfaces.** (1) A block API `useCassette(name, opts, fn)`
  for in-process tests (Vitest). (2) A long-running-server API
  `createBobina(config)` for the Next.js instrumentation case, where the server
  process is separate from the test runner and the active cassette is switched
  by an external signal.
- **Built on `@mswjs/interceptors`, not msw.** msw deliberately rejects
  record/replay ("write handlers"). We want the interceptor primitive without
  the handler-authoring opinion.
- **Gotchas baked in.** The cocontinuity journey surfaced real traps; bobina
  encodes the fixes as defaults (see "Hard-won gotchas" below).
- **Zero ceremony to install from GitHub.** Until we publish to npm, bobina is
  consumed as a git dependency. The package must build on install via a
  `prepare` script and expose correct `exports`.

---

## Public API (target shape)

```ts
import { createBobina, useCassette } from 'bobina';

// --- Block API (Vitest, in-process) ---
await useCassette(
  'anthropic-pong',
  { cassetteDir: './tests/cassettes', mode: 'once', hosts: ['api.anthropic.com'] },
  async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });
    // first run records, subsequent runs replay
  },
);

// --- Server API (Next.js instrumentation, long-running) ---
const bobina = createBobina({
  cassetteDir: './tests/e2e/cassettes',
  mode: 'once',
  hosts: ['api.anthropic.com', 'openrouter.ai'],
  filters: [
    { placeholder: '<ANTHROPIC_KEY>', value: () => process.env.ANTHROPIC_API_KEY ?? '' },
  ],
});
await bobina.listen();              // activate the interceptor
bobina.useCassette('chat-happy');   // switch the active cassette (idempotent)
bobina.eject();                     // flush current cassette to disk
await bobina.close();               // teardown the interceptor
```

### Record modes (mirror VCR Ruby)

| mode           | replay matched? | record unmatched? | error on unmatched? |
| -------------- | --------------- | ----------------- | ------------------- |
| `once`         | yes (if file exists) | yes (only if file absent/empty) | yes (if file had data) |
| `new_episodes` | yes             | yes               | no                  |
| `none`         | yes             | no                | yes                 |
| `all`          | no              | yes (always)      | no                  |

The cocontinuity E2E flow uses `all` for first capture, then `none` for CI
replay. `once` is the friendly default for ad-hoc test authoring.

### Request matching

Default matcher: `['method', 'uri']`. Configurable subset of
`method | uri | host | path | query | body | headers`, plus custom matcher
functions `(recorded, incoming) => boolean`.

---

## Cassette format

```jsonc
{
  "bobina": "1",                       // format version
  "name": "chat-happy",
  "recordedAt": "2026-05-30T12:00:00.000Z",
  "httpInteractions": [
    {
      "request":  { "method": "POST", "uri": "https://api.anthropic.com/v1/messages",
                    "headers": { /* filtered */ }, "body": "..." },
      "response": { "status": 200, "headers": { /* encoding stripped */ },
                    "body": "...", "bodyEncoding": "utf8" }
    }
  ]
}
```

---

## Hard-won gotchas (encode as defaults / tests)

1. **Strip `content-encoding` and `content-length` from recorded responses.**
   When we read a real response with `.text()`/`.arrayBuffer()`, the body is
   already decompressed; replaying it with the original `content-encoding: gzip`
   header makes the consumer try to gunzip plain text and fail. bobina must drop
   these two headers on record. (Covered in Phase 3 + a regression test.)
2. **No recording recursion.** When recording, the real outbound request must
   not re-enter the interceptor. With `@mswjs/interceptors` this is handled by
   the `response` event (`isMockedResponse === false` ⇒ it's a real response we
   only observe), so we never re-issue the request manually. Do **not** port
   msw's `bypass()` dance — that was a workaround for a different layer.
3. **Host scoping is mandatory.** Only intercept configured `hosts`; everything
   else (localhost, Supabase, telemetry) passes through untouched. A test that
   accidentally records Supabase traffic is a bug.
4. **Module state must survive bundle splits.** Next.js production splits server
   modules across chunks; a module-scoped `let` becomes a per-chunk copy. The
   server-mode singleton state must live on `globalThis` so the instrumentation
   hook and any route handler that switches cassettes share one instance.
5. **Run E2E against `next build && next start`, never `next dev`.** React 19
   dev-mode hydration races break headless Playwright. This is a consumer
   concern, but the example recipe and README must call it out.

---

## Toolchain & constraints

- **Package manager:** pnpm only.
- **Language/build:** TypeScript (strict), `module: NodeNext`, target ES2022.
  Build with **tsup** → dual ESM + CJS + `.d.ts`. `exports` map with
  `import`/`require`/`types`.
- **Runtime target:** Node 20+. `@mswjs/interceptors` is a regular dependency
  (not peer) so consumers get it transitively.
- **Tests:** Vitest. Unit tests + an integration test that hits a local
  `node:http` server to prove record→replay with a deliberately-broken network
  on replay.
- **Lint/format:** ESLint (flat config, `@typescript-eslint`, no `any`,
  no `@ts-ignore`) + Prettier.
- **License:** MIT. Author: Lucas Guedes.
- **GitHub:** repo `lukasedw/bobina`, public, SSH remote. Git-installable via
  `prepare` build script.
- **Not private.** `package.json` must drop `"private": true`.

---

## Phases (autonomous, no review gateways)

| # | Name | Spec | Outcome |
| - | ---- | ---- | ------- |
| 1 | Scaffold & toolchain | `docs/specs/phase-01-scaffold.md` | pnpm + tsup + vitest + eslint + tsconfig + CI + LICENSE + README skeleton; builds green |
| 2 | Core: cassette + matcher | `docs/specs/phase-02-core.md` | cassette type, JSON store, request matcher; unit-tested |
| 3 | Record/replay engine | `docs/specs/phase-03-engine.md` | interceptor wiring, 4 modes, gzip/header fixes; integration-tested |
| 4 | Public API surfaces | `docs/specs/phase-04-api.md` | `useCassette` + `createBobina` (globalThis singleton); tested |
| 5 | Filters & host scoping | `docs/specs/phase-05-filters.md` | sensitive-data filtering, header allow/deny, host passthrough; tested |
| 6 | Integration proof, docs, GitHub | `docs/specs/phase-06-release.md` | Next.js recipe + README + CHANGELOG; repo created & pushed; v0.1.0 tag |

**Out of scope of this execution (follow-up in the cocontinuity repo):** swapping
`cocontinuity/lib/testing/e2e-harness.ts` to consume `bobina` via the GitHub git
dependency. Tracked separately; see Phase 6 spec "Follow-up" section.

---

## Definition of done (whole execution)

- `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm exec tsc --noEmit`
  all pass from a clean clone.
- A consumer can `pnpm add github:lukasedw/bobina` and import `createBobina` /
  `useCassette` with types.
- The Next.js instrumentation recipe in `examples/` documents the exact
  cocontinuity pattern (host scoping + globalThis singleton + external cassette
  switch + prod-build caveat).
- Repo `lukasedw/bobina` exists on GitHub, public, with CI green on push.
