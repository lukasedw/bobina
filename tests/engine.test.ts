import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEngine } from '../src/engine';
import type { Cassette, RecordedRequest } from '../src/types';

const NOW = '2026-05-30T12:00:00.000Z';
const PAYLOAD = { message: 'pong', n: 42 };

interface LocalServer {
  url: string;
  host: string;
  hits: () => number;
  close: () => Promise<void>;
}

/** A deterministic origin: `/json` is plain, `/gzip` is gzip-encoded. */
function startServer(): Promise<LocalServer> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const json = JSON.stringify(PAYLOAD);
    if (req.url === '/gzip') {
      const gz = gzipSync(Buffer.from(json));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(gz.length),
      });
      res.end(gz);
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(json)),
    });
    res.end(json);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const host = `127.0.0.1:${port}`;
      resolve({
        url: `http://${host}`,
        host,
        hits: () => hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function readCassette(dir: string, name: string): Promise<Cassette> {
  const raw = await readFile(join(dir, `${name}.json`), 'utf8');
  return JSON.parse(raw) as Cassette;
}

describe('engine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bobina-engine-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records real traffic, then replays it with the origin down', async () => {
    const server = await startServer();

    const recorder = createEngine({
      cassetteDir: dir,
      mode: 'all',
      hosts: [server.host],
      now: () => NOW,
    });
    recorder.apply();
    try {
      await recorder.use('t');
      const res = await fetch(`${server.url}/json`);
      expect(await res.json()).toEqual(PAYLOAD);
      await recorder.eject();
    } finally {
      await recorder.dispose();
    }

    const cassette = await readCassette(dir, 't');
    expect(cassette.httpInteractions).toHaveLength(1);
    expect(cassette.httpInteractions[0].request.uri).toBe(`${server.url}/json`);

    // Origin goes away: replay must not touch the network.
    await server.close();

    const player = createEngine({
      cassetteDir: dir,
      mode: 'none',
      hosts: [server.host],
      now: () => NOW,
    });
    player.apply();
    try {
      await player.use('t');
      const replayed = await fetch(`${server.url}/json`);
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(PAYLOAD);
    } finally {
      await player.dispose();
    }
  });

  it('errors with 599 and calls onUnmatched on a miss in `none` mode', async () => {
    const server = await startServer();
    const unmatched: RecordedRequest[] = [];

    const player = createEngine({
      cassetteDir: dir,
      mode: 'none',
      hosts: [server.host],
      now: () => NOW,
      onUnmatched: (req) => unmatched.push(req),
    });
    player.apply();
    try {
      await player.use('empty');
      const res = await fetch(`${server.url}/json`);
      expect(res.status).toBe(599);
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0].uri).toBe(`${server.url}/json`);
      expect(server.hits()).toBe(0); // never hit the network
    } finally {
      await player.dispose();
      await server.close();
    }
  });

  it('passes through (and does not record) requests to non-listed hosts', async () => {
    const server = await startServer();

    // The server's host is NOT in `hosts`, so its traffic must pass through.
    const recorder = createEngine({
      cassetteDir: dir,
      mode: 'all',
      hosts: ['api.example.com'],
      now: () => NOW,
    });
    recorder.apply();
    try {
      await recorder.use('scoped');
      const res = await fetch(`${server.url}/json`);
      expect(await res.json()).toEqual(PAYLOAD);
      expect(server.hits()).toBe(1); // really reached the origin
      await recorder.eject();
    } finally {
      await recorder.dispose();
      await server.close();
    }

    // Nothing recorded: the cassette was never written (stayed clean).
    await expect(readCassette(dir, 'scoped')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('strips content-encoding/content-length and replays the decoded body', async () => {
    const server = await startServer();

    const recorder = createEngine({
      cassetteDir: dir,
      mode: 'all',
      hosts: [server.host],
      now: () => NOW,
    });
    recorder.apply();
    try {
      await recorder.use('gz');
      const res = await fetch(`${server.url}/gzip`);
      expect(await res.json()).toEqual(PAYLOAD); // consumer still gets decoded text
      await recorder.eject();
    } finally {
      await recorder.dispose();
    }

    const cassette = await readCassette(dir, 'gz');
    expect(cassette.httpInteractions).toHaveLength(1);
    const stored = cassette.httpInteractions[0].response;
    expect(stored.headers['content-encoding']).toBeUndefined();
    expect(stored.headers['content-length']).toBeUndefined();
    expect(stored.bodyEncoding).toBe('utf8');
    expect(JSON.parse(stored.body)).toEqual(PAYLOAD);

    // Replay with the origin down: a leaked `content-encoding: gzip` would make
    // the consumer try to gunzip plain text and fail.
    await server.close();

    const player = createEngine({
      cassetteDir: dir,
      mode: 'none',
      hosts: [server.host],
      now: () => NOW,
    });
    player.apply();
    try {
      await player.use('gz');
      const replayed = await fetch(`${server.url}/gzip`);
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toEqual(PAYLOAD);
    } finally {
      await player.dispose();
    }
  });
});
