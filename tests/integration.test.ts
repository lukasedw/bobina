import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Import through the public barrel — this exercises the package's real entry
// surface, not the internal modules.
import { createBobina, resetBobinaSingleton } from '../src/index';
import { PAYLOAD, readCassette, startServer } from './support';

/** Inspect the process-wide singleton without importing bobina's internals. */
function singleton(): unknown {
  return (globalThis as { __bobina__?: unknown }).__bobina__;
}

describe('integration: public API over undici global fetch', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bobina-int-'));
    resetBobinaSingleton();
  });

  afterEach(async () => {
    resetBobinaSingleton();
    await rm(dir, { recursive: true, force: true });
  });

  it('records via global fetch, then replays with the origin stopped', async () => {
    const server = await startServer();

    // --- Record: createBobina({ mode: 'all' }) against the real origin ---
    const recorder = createBobina({ cassetteDir: dir, mode: 'all', hosts: [server.host] });
    expect(singleton()).toBeDefined(); // installed on globalThis

    // Called again with the same fingerprint → the SAME singleton instance.
    const reused = createBobina({ cassetteDir: dir, mode: 'all', hosts: [server.host] });
    expect(reused).toBe(recorder);

    await recorder.listen();

    try {
      await recorder.useCassette('integration');
      // This is undici's global `fetch` on Node — not node:http.
      const res = await fetch(`${server.url}/json`);
      expect(await res.json()).toEqual(PAYLOAD);
      expect(server.hits()).toBe(1); // really reached the origin while recording
      await recorder.eject();
    } finally {
      await recorder.close();
    }

    const cassette = await readCassette(dir, 'integration');
    expect(cassette.httpInteractions).toHaveLength(1);
    expect(cassette.httpInteractions[0].request.uri).toBe(`${server.url}/json`);

    // --- Replay: a fresh bobina in `none` mode, with the origin gone ---
    await server.close();
    resetBobinaSingleton(); // mode changed → fingerprint differs; replace cleanly

    const player = createBobina({ cassetteDir: dir, mode: 'none', hosts: [server.host] });
    await player.listen();
    try {
      await player.useCassette('integration');
      const replayed = await fetch(`${server.url}/json`);
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(PAYLOAD); // served from disk, not network
    } finally {
      await player.close();
    }
  });

  it('scopes interception to configured hosts — off-host traffic passes through', async () => {
    const server = await startServer();

    // The local server's host is deliberately NOT listed, so its traffic must
    // pass straight through to the real origin and never be recorded (gotcha #3).
    const bobina = createBobina({ cassetteDir: dir, mode: 'all', hosts: ['api.anthropic.com'] });
    await bobina.listen();
    try {
      await bobina.useCassette('scoping');
      const res = await fetch(`${server.url}/json`);
      expect(await res.json()).toEqual(PAYLOAD);
      expect(server.hits()).toBe(1); // reached the real origin
      await bobina.eject();
    } finally {
      await bobina.close();
      await server.close();
    }

    // Out-of-scope traffic was never recorded → no cassette file was written.
    await expect(readCassette(dir, 'scoping')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
