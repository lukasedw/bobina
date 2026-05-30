# bobina

> HTTP cassettes (record/replay) for the modern Node `fetch` era.

bobina records real HTTP traffic to JSON "cassettes" and replays it later, so
your tests run fast, offline, and deterministically. It's a
[VCR](https://github.com/vcr/vcr)-style library built directly on
[`@mswjs/interceptors`](https://github.com/mswjs/interceptors) and aimed at the
modern stack: **Node 20+, undici-backed global `fetch`, and the Next.js App
Router** (instrumentation hook).

> **Status: alpha, stack-scoped.** bobina is built for one stack (Next.js +
> undici + Playwright) and proven there. The API may change before v1.0. It
> works on plain Node `fetch` too, but the edges outside that stack are not yet
> battle-tested.

## Why bobina exists

We needed deterministic, offline E2E for an agent chat-streaming path. The
existing options didn't fit the modern fetch stack:

- **Polly.js** is archived, and its `fetch` adapter spreads the caller's
  `AbortSignal` cross-realm — undici rejects that on Node 20+.
- **nock** is alive but carries a decade of XHR/Browserify legacy.
- A **hand-rolled VCR** worked but was bespoke and trapped in one repo.

Polly and nock both monkey-patch `globalThis.fetch` with their own adapters.
bobina instead builds on `@mswjs/interceptors` — a maintained primitive whose
`BatchInterceptor` models the request lifecycle and fires a `response` event for
**both** mocked and real responses. That event is the ideal seam for
record/replay, and it handles undici correctly. (It's the same interception core
`msw` uses — bobina just adds the record/replay layer `msw` deliberately omits.)

There's no canonical, maintained, Rails-VCR-style library for this stack. bobina
fills that gap.

## Install

Until bobina is published to npm, install it straight from GitHub:

```sh
pnpm add github:lukasedw/bobina
```

A `prepare` script builds the package on install, so consumers get a compiled
`dist/` (ESM + CJS + type declarations) automatically — no extra build step.

## Two API surfaces

### Block API — `useCassette` (in-process tests, e.g. Vitest)

Wrap a function; bobina applies the interceptor, loads the cassette, runs your
code, then flushes and tears down — even if the function throws.

```ts
import { useCassette } from 'bobina';

const data = await useCassette(
  'anthropic-pong',
  { cassetteDir: './tests/cassettes', mode: 'once', hosts: ['api.anthropic.com'] },
  async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }),
    });
    return res.json();
  },
);
// First run records to ./tests/cassettes/anthropic-pong.json.
// Every later run replays from it — no network.
```

### Server API — `createBobina` (long-running servers, e.g. Next.js)

When the server process is separate from the test runner, build a bobina once
and switch cassettes by an external signal. The instance lives on `globalThis`,
so the Next.js instrumentation hook and a route handler share one engine.

```ts
import { createBobina } from 'bobina';

const bobina = createBobina({
  cassetteDir: './tests/e2e/cassettes',
  mode: 'once',
  hosts: ['api.anthropic.com', 'openrouter.ai'],
  filters: [{ placeholder: '<ANTHROPIC_KEY>', value: () => process.env.ANTHROPIC_API_KEY ?? '' }],
});

await bobina.listen(); // activate the interceptor
await bobina.useCassette('chat-happy'); // load/switch the active cassette
// ... drive traffic ...
await bobina.eject(); // flush the active cassette to disk
await bobina.close(); // flush if dirty, then tear the interceptor down
```

For the full Next.js + Playwright wiring, see the
**[Next.js instrumentation recipe](./examples/nextjs-instrumentation/)**.

## Record modes

Mirrors VCR (Ruby). Default is `once`.

| mode           | replay matched?      | record unmatched?               | error on unmatched?    |
| -------------- | -------------------- | ------------------------------- | ---------------------- |
| `once`         | yes (if file exists) | yes (only if file absent/empty) | yes (if file had data) |
| `new_episodes` | yes                  | yes                             | no                     |
| `none`         | yes                  | no                              | yes                    |
| `all`          | no                   | yes (always)                    | no                     |

The E2E flow uses `all` for first capture, then `none` for CI replay. `once` is
the friendly default for ad-hoc test authoring.

## Request matching

bobina pairs an incoming request with a recorded one using matcher **keys**,
AND-ed together. The default is `['method', 'uri']`.

```ts
import { useCassette } from 'bobina';

await useCassette(
  'search',
  {
    cassetteDir: './tests/cassettes',
    hosts: ['api.example.com'],
    matchers: ['method', 'path', 'query'], // ignore host/protocol differences
    customMatchers: [
      // AND-ed with the keys above; return true when the two should match.
      (recorded, incoming) => recorded.headers['x-tenant'] === incoming.headers['x-tenant'],
    ],
  },
  async () => {
    /* ... */
  },
);
```

Available keys: `method`, `uri`, `host`, `path`, `query`, `body`, `headers`.
(`query` is order-insensitive; `headers` matches when the recorded headers are a
subset of the incoming ones.)

## Filtering sensitive data

Secrets must never land on disk. `filters` replace every occurrence of a value
with a placeholder **before** a cassette is written. `value` can be a function,
resolved at record time:

```ts
filters: [
  { placeholder: '<ANTHROPIC_KEY>', value: () => process.env.ANTHROPIC_API_KEY ?? '' },
  { placeholder: '<SESSION>', value: () => process.env.SESSION_TOKEN ?? '' },
];
```

Replacement runs across request headers, request body, response headers, and
response body. A filter whose value resolves to an empty string is skipped.

### Header scoping

Independently of value filters, bobina controls which **headers** are stored:

- **Default** — a denylist of credential-bearing headers
  (`DEFAULT_HEADER_DENYLIST`: `authorization`, `cookie`, `set-cookie`,
  `x-api-key`, and the interceptor's internal request-id header) is dropped.
- **`headerAllowlist`** — when set, _only_ the named headers are stored; a
  denylisted header survives only if you allowlist it explicitly.

```ts
createBobina({
  cassetteDir: './cassettes',
  hosts: ['api.example.com'],
  headerAllowlist: ['content-type', 'accept'], // store just these
});
```

Sensitive headers are still used for **live** matching during a session — they
just never get persisted.

## Cassette format

```jsonc
{
  "bobina": "1", // format version
  "name": "chat-happy",
  "recordedAt": "2026-05-30T12:00:00.000Z",
  "httpInteractions": [
    {
      "request": {
        "method": "POST",
        "uri": "https://api.anthropic.com/v1/messages",
        "headers": {
          /* filtered */
        },
        "body": "...",
      },
      "response": {
        "status": 200,
        "headers": {
          /* encoding stripped */
        },
        "body": "...",
        "bodyEncoding": "utf8",
      },
    },
  ],
}
```

## Gotchas (encoded as defaults)

- **`content-encoding` / `content-length` are stripped from recorded responses.**
  The body is stored already-decoded, so replaying it with the original
  `content-encoding` would make the consumer try to gunzip plain text. bobina
  drops both.
- **Host scoping is mandatory.** Only configured `hosts` are intercepted;
  everything else (localhost, your DB, telemetry) passes through untouched.
  Accidentally recording unrelated traffic is treated as a bug, not a feature.
- **Server state lives on `globalThis`.** Next.js production splits server
  modules across chunks, so a module-scoped `let` would become a per-chunk copy.
  `createBobina` keeps its singleton on `globalThis` so every chunk shares one
  engine.
- **Run Next.js E2E against `next build && next start`, never `next dev`.** React
  19 dev-mode hydration races break headless Playwright. See the recipe.

## Advanced exports

Beyond `createBobina` / `useCassette`, the package also exports the lower-level
`createEngine`, the cassette store (`loadCassette`, `saveCassette`,
`emptyCassette`), the matchers (`matchRequest`, `findInteraction`,
`DEFAULT_MATCHERS`), and the filter utilities (`applyFiltersOnRecord`,
`applyFiltersOnReplay`, `DEFAULT_HEADER_DENYLIST`) — plus all public types.

## License

[MIT](./LICENSE) © Lucas Guedes
