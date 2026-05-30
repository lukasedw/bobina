import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { Cassette } from '../src/types';

/** Body every endpoint returns; tests assert the consumer sees this decoded. */
export const PAYLOAD = { message: 'pong', n: 42 };

export interface LocalServer {
  url: string;
  host: string;
  hits: () => number;
  close: () => Promise<void>;
}

/** Options for {@link startServer}. */
export interface ServerOptions {
  /** Extra response headers added to every reply (e.g. a `set-cookie`). */
  responseHeaders?: Record<string, string>;
}

/** A deterministic origin: `/json` is plain, `/gzip` is gzip-encoded. */
export function startServer(opts: ServerOptions = {}): Promise<LocalServer> {
  const extraHeaders = opts.responseHeaders ?? {};
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
        ...extraHeaders,
      });
      res.end(gz);
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(json)),
      ...extraHeaders,
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

/** Read and parse `<dir>/<name>.json`. */
export async function readCassette(dir: string, name: string): Promise<Cassette> {
  const raw = await readFile(join(dir, `${name}.json`), 'utf8');
  return JSON.parse(raw) as Cassette;
}
