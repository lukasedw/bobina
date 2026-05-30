import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBobina, resetBobinaSingleton } from '../src/bobina';
import { PAYLOAD, readCassette, startServer, type LocalServer } from './support';

describe('createBobina', () => {
  let dir: string;
  let server: LocalServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bobina-server-'));
    resetBobinaSingleton();
    server = await startServer();
  });

  afterEach(async () => {
    resetBobinaSingleton();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the full lifecycle: listen → use → fetch → eject → close', async () => {
    const bobina = createBobina({ cassetteDir: dir, mode: 'all', hosts: [server.host] });
    await bobina.listen();
    try {
      expect(bobina.currentCassette()).toBeNull();
      await bobina.useCassette('server');
      expect(bobina.currentCassette()).toBe('server');

      const res = await fetch(`${server.url}/json`);
      expect(await res.json()).toEqual(PAYLOAD);

      await bobina.eject();
      const cassette = await readCassette(dir, 'server');
      expect(cassette.httpInteractions).toHaveLength(1);
      expect(cassette.httpInteractions[0].request.uri).toBe(`${server.url}/json`);
    } finally {
      await bobina.close();
    }
  });

  it('reuses the singleton when called twice (one engine, no double interception)', async () => {
    const config = { cassetteDir: dir, mode: 'all' as const, hosts: [server.host] };
    const first = createBobina(config);
    const second = createBobina(config);

    // Same instance → the instrumentation hook and a route handler share one engine.
    expect(second).toBe(first);

    await first.listen();
    try {
      await first.useCassette('singleton');
      await second.listen(); // idempotent: the same applied engine
      const res = await fetch(`${server.url}/json`);
      expect(await res.json()).toEqual(PAYLOAD);
      await first.eject();

      // One engine means one recording and one real origin hit, not two.
      const cassette = await readCassette(dir, 'singleton');
      expect(cassette.httpInteractions).toHaveLength(1);
      expect(server.hits()).toBe(1);
    } finally {
      await first.close();
    }
  });

  it('throws when a second config is incompatible with the active singleton', () => {
    createBobina({ cassetteDir: dir, mode: 'all', hosts: [server.host] });
    expect(() => createBobina({ cassetteDir: dir, mode: 'none', hosts: [server.host] })).toThrow(
      /incompatible/,
    );
  });

  it('resetBobinaSingleton lets the next createBobina build a fresh instance', () => {
    const config = { cassetteDir: dir, mode: 'all' as const, hosts: [server.host] };
    const first = createBobina(config);
    resetBobinaSingleton();
    const second = createBobina(config);
    expect(second).not.toBe(first);
  });
});
