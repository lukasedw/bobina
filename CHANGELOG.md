# Changelog

All notable changes to bobina are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

Initial alpha release.

### Added

- **Record/replay engine** built on `@mswjs/interceptors`, driven by its
  request/response lifecycle events (no `globalThis.fetch` hand-patching of our
  own). Works against undici's global `fetch` and `node:http` on Node 20+.
- **Two API surfaces:**
  - `useCassette(name, options, fn)` — block API for in-process tests (Vitest);
    applies, loads, runs, flushes, and tears down in a `finally`.
  - `createBobina(config)` — long-running-server API with a `globalThis`
    singleton (`listen` / `useCassette` / `eject` / `close` / `currentCassette`),
    so the Next.js instrumentation hook and a route handler share one engine.
- **Four VCR-style record modes:** `once` (default), `new_episodes`, `none`,
  `all`.
- **Request matching** on a configurable subset of `method`, `uri`, `host`,
  `path`, `query`, `body`, `headers` (default `['method', 'uri']`), plus custom
  matcher functions. Query matching is order-insensitive; header matching is a
  subset check.
- **Sensitive-data filters** (`filters: [{ placeholder, value }]`, `value` may be
  a thunk resolved at record time) applied across request/response headers and
  bodies before persistence.
- **Header scoping:** a default denylist (`DEFAULT_HEADER_DENYLIST`) of
  credential-bearing headers, or an opt-in `headerAllowlist`. Sensitive headers
  stay usable for live matching but never land on disk.
- **Gotcha fixes baked in:** strips `content-encoding`/`content-length` from
  recorded responses; mandatory host scoping (off-host traffic passes through);
  base64 fallback for non-UTF-8 response bodies; null-body status handling.
- **JSON cassette format** (version `"1"`) with pretty-printed
  `httpInteractions`.
- **Next.js instrumentation recipe** under `examples/nextjs-instrumentation/`
  (instrumentation hook + cassette-switching route + Playwright wiring + the
  `next build && next start` caveat).
- Dual **ESM + CJS** build with type declarations (tsup) and an `exports` map.
  The built `dist/` is committed so `pnpm add github:lukasedw/bobina` installs
  with no build step (pnpm 10.26+ blocks git-dependency `prepare` scripts).

[0.1.0]: https://github.com/lukasedw/bobina/releases/tag/v0.1.0
