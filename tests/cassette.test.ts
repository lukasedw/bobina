import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyCassette, loadCassette, saveCassette } from '../src/cassette';

const NOW = '2026-05-30T12:00:00.000Z';

describe('cassette', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bobina-cassette-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a cassette through save then load', async () => {
    const cassette = emptyCassette('round-trip', NOW);
    cassette.httpInteractions.push({
      request: { method: 'POST', uri: 'https://example.com/v1/x', headers: { a: '1' }, body: '{}' },
      response: { status: 200, headers: { b: '2' }, body: 'ok', bodyEncoding: 'utf8' },
    });

    await saveCassette(dir, cassette);
    const loaded = await loadCassette(dir, 'round-trip', NOW);

    expect(loaded).toEqual(cassette);
  });

  it('returns an empty cassette when the file does not exist (ENOENT)', async () => {
    const loaded = await loadCassette(dir, 'missing', NOW);
    expect(loaded).toEqual(emptyCassette('missing', NOW));
    expect(loaded.httpInteractions).toEqual([]);
  });

  it('throws on a bobina version mismatch', async () => {
    await writeFile(
      join(dir, 'legacy.json'),
      JSON.stringify({ bobina: '0', name: 'legacy', recordedAt: NOW, httpInteractions: [] }),
      'utf8',
    );
    await expect(loadCassette(dir, 'legacy', NOW)).rejects.toThrow(/version/i);
  });

  it('rejects an invalid (path-unsafe) cassette name', async () => {
    await expect(loadCassette(dir, '../escape', NOW)).rejects.toThrow(/invalid cassette name/i);
    expect(() => emptyCassette('bad name', NOW)).toThrow(/invalid cassette name/i);
  });

  it('creates the cassette directory when saving', async () => {
    const nested = join(dir, 'nested', 'deeper');
    const cassette = emptyCassette('made', NOW);

    await saveCassette(nested, cassette);
    const loaded = await loadCassette(nested, 'made', NOW);

    expect(loaded).toEqual(cassette);
  });
});
