import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBobina, resetBobinaSingleton } from '../src/bobina';
import { applyFiltersOnRecord, applyFiltersOnReplay, scopeHeaders } from '../src/filters';
import type { HttpInteraction } from '../src/types';
import { useCassette } from '../src/use-cassette';
import { PAYLOAD, readCassette, startServer, type LocalServer } from './support';

const SECRET = 'sk-ant-supersecret-0123456789';
const PLACEHOLDER = '<ANTHROPIC_KEY>';

describe('filters & header scoping (engine integration)', () => {
  let dir: string;
  let server: LocalServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bobina-filters-'));
    resetBobinaSingleton();
    server = undefined;
  });

  afterEach(async () => {
    resetBobinaSingleton();
    // close() is idempotent here (the wrapper ignores a double-close error).
    if (server) await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces a secret in the request header and body with its placeholder', async () => {
    server = await startServer();
    await useCassette(
      'secret-req',
      {
        cassetteDir: dir,
        mode: 'all',
        hosts: [server.host],
        filters: [{ placeholder: PLACEHOLDER, value: SECRET }],
      },
      async () => {
        await fetch(`${server!.url}/json`, {
          method: 'POST',
          headers: { 'x-secret-token': SECRET, 'content-type': 'application/json' },
          body: JSON.stringify({ token: SECRET }),
        });
      },
    );

    // The raw secret must be absent from the whole serialized cassette.
    const raw = JSON.stringify(await readCassette(dir, 'secret-req'));
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain(PLACEHOLDER);

    const { request } = (await readCassette(dir, 'secret-req')).httpInteractions[0];
    expect(request.headers['x-secret-token']).toBe(PLACEHOLDER);
    expect(request.body).toContain(PLACEHOLDER);
    expect(request.body).not.toContain(SECRET);
  });

  it('resolves a function `value` at record time', async () => {
    server = await startServer();
    let resolved = 0;

    await useCassette(
      'secret-fn',
      {
        cassetteDir: dir,
        mode: 'all',
        hosts: [server.host],
        filters: [
          {
            placeholder: PLACEHOLDER,
            value: () => {
              resolved += 1;
              return SECRET;
            },
          },
        ],
      },
      async () => {
        await fetch(`${server!.url}/json`, {
          method: 'POST',
          headers: { 'x-secret-token': SECRET },
          body: JSON.stringify({ token: SECRET }),
        });
      },
    );

    expect(resolved).toBeGreaterThan(0); // the thunk was invoked while recording
    const raw = JSON.stringify(await readCassette(dir, 'secret-fn'));
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain(PLACEHOLDER);
  });

  it('drops denylisted headers (authorization, x-api-key, set-cookie) from the cassette', async () => {
    server = await startServer({ responseHeaders: { 'set-cookie': 'session=abc; HttpOnly' } });

    await useCassette(
      'denylist',
      { cassetteDir: dir, mode: 'all', hosts: [server.host] },
      async () => {
        await fetch(`${server!.url}/json`, {
          headers: { authorization: 'Bearer super-secret', 'x-api-key': 'key-123' },
        });
      },
    );

    const { request, response } = (await readCassette(dir, 'denylist')).httpInteractions[0];
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    // A non-sensitive header is still stored, proving we don't drop everything.
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('stores only allowlisted headers when `headerAllowlist` is set', async () => {
    server = await startServer({ responseHeaders: { 'set-cookie': 'session=abc' } });

    await useCassette(
      'allowlist',
      { cassetteDir: dir, mode: 'all', hosts: [server.host], headerAllowlist: ['content-type'] },
      async () => {
        await fetch(`${server!.url}/json`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-trace': 'abc',
            authorization: 'Bearer x',
          },
          body: '{}',
        });
      },
    );

    const { request, response } = (await readCassette(dir, 'allowlist')).httpInteractions[0];
    expect(Object.keys(request.headers)).toEqual(['content-type']);
    expect(Object.keys(response.headers)).toEqual(['content-type']);
  });

  it('round-trips: record redacts, replay serves, inspection restores a usable request', async () => {
    server = await startServer();
    const filters = [{ placeholder: PLACEHOLDER, value: SECRET }];

    const recorded = await useCassette(
      'roundtrip',
      { cassetteDir: dir, mode: 'all', hosts: [server.host], filters },
      async () => {
        const res = await fetch(`${server!.url}/json`, {
          method: 'POST',
          headers: { 'x-secret-token': SECRET },
          body: JSON.stringify({ token: SECRET }),
        });
        return res.json() as Promise<typeof PAYLOAD>;
      },
    );
    expect(recorded).toEqual(PAYLOAD);

    // On disk: placeholder only, never the raw secret.
    const stored = JSON.stringify(await readCassette(dir, 'roundtrip'));
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain(PLACEHOLDER);

    // Origin down: replay must serve the recorded response without the network.
    await server.close();
    const replayed = await useCassette(
      'roundtrip',
      { cassetteDir: dir, mode: 'none', hosts: [server.host], filters },
      async () => {
        const res = await fetch(`${server!.url}/json`, {
          method: 'POST',
          headers: { 'x-secret-token': SECRET },
          body: JSON.stringify({ token: SECRET }),
        });
        expect(res.status).toBe(200);
        return res.json() as Promise<typeof PAYLOAD>;
      },
    );
    expect(replayed).toEqual(PAYLOAD);

    // Inspecting the matched interaction restores the live token, even though the
    // cassette on disk stays redacted.
    const cassette = await readCassette(dir, 'roundtrip');
    const restored = applyFiltersOnReplay(cassette.httpInteractions[0], filters);
    expect(restored.request.headers['x-secret-token']).toBe(SECRET);
    expect(restored.request.body).toContain(SECRET);
  });

  it('threads filters + headerAllowlist through createBobina (server surface)', async () => {
    server = await startServer({ responseHeaders: { 'set-cookie': 'x=y' } });

    const bobina = createBobina({
      cassetteDir: dir,
      mode: 'all',
      hosts: [server.host],
      filters: [{ placeholder: PLACEHOLDER, value: SECRET }],
      headerAllowlist: ['content-type'],
    });
    await bobina.listen();
    try {
      await bobina.useCassette('server-filters');
      await fetch(`${server.url}/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body: JSON.stringify({ token: SECRET }),
      });
      await bobina.eject();
    } finally {
      await bobina.close();
    }

    const cassette = await readCassette(dir, 'server-filters');
    const raw = JSON.stringify(cassette);
    expect(raw).not.toContain(SECRET); // filter applied
    expect(raw).toContain(PLACEHOLDER);

    const { request, response } = cassette.httpInteractions[0];
    expect(Object.keys(request.headers)).toEqual(['content-type']); // allowlist applied
    expect(Object.keys(response.headers)).toEqual(['content-type']);
    expect(request.headers.authorization).toBeUndefined();
  });
});

describe('filter functions (unit)', () => {
  it('applyFiltersOnReplay restores the live value on the request side only', () => {
    const interaction: HttpInteraction = {
      request: {
        method: 'POST',
        uri: 'https://api.example.com/v1',
        headers: { 'x-secret-token': PLACEHOLDER },
        body: `{"token":"${PLACEHOLDER}"}`,
      },
      response: {
        status: 200,
        headers: {},
        body: `{"echo":"${PLACEHOLDER}"}`,
        bodyEncoding: 'utf8',
      },
    };
    const filters = [{ placeholder: PLACEHOLDER, value: SECRET }];

    const restored = applyFiltersOnReplay(interaction, filters);
    expect(restored.request.headers['x-secret-token']).toBe(SECRET);
    expect(restored.request.body).toContain(SECRET);
    // Response-side placeholders stay as-is by default.
    expect(restored.response.body).toContain(PLACEHOLDER);
    expect(restored.response.body).not.toContain(SECRET);
  });

  it('applyFiltersOnRecord is deterministic and idempotent', () => {
    const interaction: HttpInteraction = {
      request: {
        method: 'GET',
        uri: 'https://x.test/',
        headers: { 'x-token': SECRET },
        body: SECRET,
      },
      response: { status: 200, headers: {}, body: SECRET, bodyEncoding: 'utf8' },
    };
    const filters = [{ placeholder: PLACEHOLDER, value: SECRET }];

    const once = applyFiltersOnRecord(interaction, filters);
    const twice = applyFiltersOnRecord(once, filters);
    expect(twice).toEqual(once); // re-running over redacted content is a no-op
    expect(JSON.stringify(once)).not.toContain(SECRET);
  });

  it('skips filters whose resolved value is empty (no ""→placeholder splicing)', () => {
    const interaction: HttpInteraction = {
      request: { method: 'GET', uri: 'https://x.test/', headers: {}, body: 'hello' },
      response: { status: 200, headers: {}, body: 'world', bodyEncoding: 'utf8' },
    };
    const result = applyFiltersOnRecord(interaction, [
      { placeholder: PLACEHOLDER, value: '' },
      { placeholder: '<EMPTY>', value: () => '' },
    ]);
    expect(result.request.body).toBe('hello');
    expect(result.response.body).toBe('world');
  });

  it('scopeHeaders drops the default denylist when no allowlist is given', () => {
    const scoped = scopeHeaders({
      'content-type': 'application/json',
      authorization: 'Bearer x',
      cookie: 'a=b',
      'set-cookie': 'a=b',
      'x-api-key': 'k',
    });
    expect(scoped).toEqual({ 'content-type': 'application/json' });
  });

  it('scopeHeaders keeps only allowlisted headers, even denylisted ones', () => {
    const scoped = scopeHeaders(
      { 'content-type': 'application/json', authorization: 'Bearer x', 'x-trace': 't' },
      ['content-type', 'authorization'],
    );
    expect(scoped).toEqual({ 'content-type': 'application/json', authorization: 'Bearer x' });
  });
});
