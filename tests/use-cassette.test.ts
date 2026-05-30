import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetBobinaSingleton } from '../src/bobina';
import { useCassette } from '../src/use-cassette';
import { PAYLOAD, readCassette, startServer } from './support';

/** Read the (untyped) process-wide singleton without importing its internals. */
function singleton(): unknown {
  return (globalThis as { __bobina__?: unknown }).__bobina__;
}

describe('useCassette', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bobina-use-'));
    resetBobinaSingleton();
  });

  afterEach(async () => {
    resetBobinaSingleton();
    await rm(dir, { recursive: true, force: true });
  });

  it('records in `all`, then replays in `none` with the origin down', async () => {
    const server = await startServer();

    const recorded = await useCassette(
      'block',
      { cassetteDir: dir, mode: 'all', hosts: [server.host] },
      async () => {
        const res = await fetch(`${server.url}/json`);
        return res.json() as Promise<typeof PAYLOAD>;
      },
    );
    expect(recorded).toEqual(PAYLOAD);

    // Isolation: the block API uses a local engine and must never touch the global.
    expect(singleton()).toBeUndefined();

    const cassette = await readCassette(dir, 'block');
    expect(cassette.httpInteractions).toHaveLength(1);

    // Origin goes away: replay must not touch the network.
    await server.close();

    const replayed = await useCassette(
      'block',
      { cassetteDir: dir, mode: 'none', hosts: [server.host] },
      async () => {
        const res = await fetch(`${server.url}/json`);
        expect(res.status).toBe(200);
        return res.json() as Promise<typeof PAYLOAD>;
      },
    );
    expect(replayed).toEqual(PAYLOAD);

    // Still no leak after a second self-contained run.
    expect(singleton()).toBeUndefined();
  });

  it('tears the interceptor down even when `fn` throws', async () => {
    const server = await startServer();
    const boom = new Error('boom');

    await expect(
      useCassette('thrower', { cassetteDir: dir, mode: 'all', hosts: [server.host] }, async () => {
        await fetch(`${server.url}/json`);
        throw boom;
      }),
    ).rejects.toBe(boom);

    await server.close();

    // The interceptor was disposed in `finally`, so a later fetch hits the real
    // (now-closed) origin and fails — proving nothing leaked onto global fetch.
    await expect(fetch(`${server.url}/json`)).rejects.toThrow();
    expect(singleton()).toBeUndefined();
  });
});
