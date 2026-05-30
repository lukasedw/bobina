# Phase 3 — Record/replay engine

**Goal:** Wire `@mswjs/interceptors` to the cassette model. This is the heart of
bobina. After this phase, a low-level engine can record real HTTP and replay it.

Read `PLAN.md` ("Hard-won gotchas" + "Record modes") before writing anything.

## Background on `@mswjs/interceptors`

Use `BatchInterceptor` with the Node presets:

```ts
import { BatchInterceptor } from '@mswjs/interceptors';
import nodeInterceptors from '@mswjs/interceptors/presets/node';

const interceptor = new BatchInterceptor({ name: 'bobina', interceptors: nodeInterceptors });
interceptor.apply();
interceptor.on('request', ({ request, controller }) => { /* replay */ });
interceptor.on('response', ({ response, request, isMockedResponse }) => { /* record */ });
interceptor.dispose();
```

- The `request` listener may call `controller.respondWith(new Response(...))` to
  serve a mock (replay). If it does nothing, the request passes through to the
  real network.
- The `response` listener fires for **every** response, real or mocked.
  `isMockedResponse === false` means it was a real network response — that is
  what we persist when recording. **Never re-issue the request yourself**
  (gotcha #2 in PLAN.md).

> The exact event payload shape may differ slightly by `@mswjs/interceptors`
> version. Inspect `node_modules/@mswjs/interceptors/lib/**/*.d.ts` and adapt;
> do not guess. Keep the adaptation isolated in this module.

## File: `src/engine.ts`

Export `createEngine(opts)` returning a controllable engine:

```ts
interface EngineOptions {
  cassetteDir: string;
  mode: RecordMode;
  hosts: string[];               // only these hosts are intercepted
  matchers?: MatcherKey[];       // default DEFAULT_MATCHERS
  customMatchers?: CustomMatcher[];
  now: () => string;             // injected clock (ISO string)
  onUnmatched?: (req: RecordedRequest) => void;
}
interface Engine {
  apply(): void;
  dispose(): Promise<void>;      // flushes active cassette if dirty
  use(name: string): Promise<void>;   // load + set active cassette (flush previous)
  eject(): Promise<void>;        // flush active cassette to disk
  activeName(): string | null;
}
```

### Behavior

1. **Host scoping.** In the `request` listener, parse `request.url`; if the host
   is not in `hosts`, return immediately (passthrough). Same guard in
   `response`.
2. **Replay (`request` listener).** If mode allows replay (`once`/`new_episodes`/
   `none`), look up a matching interaction via `findInteraction`. If found,
   `controller.respondWith(new Response(body, { status, headers }))` decoding
   `bodyEncoding`. If not found:
   - `none`: respond with a 599 error Response whose body explains the miss, and
     call `onUnmatched` — never hit the network.
   - `once` with a non-empty pre-existing cassette: same as `none`.
   - `once` with empty/absent cassette, `new_episodes`, `all`: do nothing (let
     it pass through to be recorded by the `response` listener).
3. **Record (`response` listener).** When `isMockedResponse === false` and mode
   records (`once` first-capture / `new_episodes` / `all`), read the response
   body, build a `RecordedResponse`, and append `{ request, response }` to the
   active cassette (mark dirty). **Strip `content-encoding` and `content-length`
   headers** (gotcha #1). Detect binary bodies → `bodyEncoding: 'base64'`,
   else `'utf8'`.
   - `all` clears the cassette on first `use()` so it always re-records.
   - De-dupe: in `once`/`new_episodes`, don't append a second interaction that
     matches an existing one under the active matchers.
4. **Flush.** `eject()` and `dispose()` persist the active cassette via
   `saveCassette` only if dirty.
5. **Reading request/response bodies.** Clone before reading so you don't
   consume the stream the consumer needs. Capture the request body in the
   `request` phase if needed for matching/recording.

## Tests (`tests/engine.test.ts`)

Spin up a local `node:http` server returning a deterministic JSON body with a
`content-encoding`-free and a gzip variant.

- **record→replay:** mode `all`, `use('t')`, `fetch` the local server, `eject`.
  Assert the cassette file has one interaction. Then dispose, start a fresh
  engine in mode `none`, `use('t')`, **stop the local server**, `fetch` again,
  assert the replayed body matches and no connection error occurred.
- **none miss:** mode `none`, unknown request → 599 + `onUnmatched` called, no
  network.
- **host scoping:** a request to a non-listed host passes through (hit the local
  server on a host not in `hosts` and assert it was NOT recorded).
- **gzip header strip:** record a response sent with `content-encoding: gzip`;
  assert the stored interaction has no `content-encoding`/`content-length` and
  the replayed body is the decoded text.

## Validation (must pass)

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

## Done criteria

- `src/engine.ts` implements all four modes + host scoping + gzip strip.
- Integration test proves replay works with the origin server **down**.
- All validation green.
