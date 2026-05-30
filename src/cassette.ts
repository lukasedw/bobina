import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Cassette } from './types.js';

/** On-disk cassette format version. Bumped only on a breaking format change. */
const CASSETTE_VERSION = '1';

/** Cassette names become file names, so constrain them for path-safety. */
const VALID_NAME = /^[a-z0-9-]+$/i;

function assertValidName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid cassette name ${JSON.stringify(name)}: names must match ${String(VALID_NAME)}.`,
    );
  }
}

function cassettePath(dir: string, name: string): string {
  assertValidName(name);
  return join(dir, `${name}.json`);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** A fresh, empty cassette. `now` is injected so this module stays pure. */
export function emptyCassette(name: string, now: string): Cassette {
  assertValidName(name);
  return {
    bobina: CASSETTE_VERSION,
    name,
    recordedAt: now,
    httpInteractions: [],
  };
}

/**
 * Read `<dir>/<name>.json`. Returns an empty cassette when the file is absent
 * (`ENOENT`); throws on an unsupported `bobina` format version.
 */
export async function loadCassette(dir: string, name: string, now: string): Promise<Cassette> {
  const file = cassettePath(dir, name);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return emptyCassette(name, now);
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Cassette;
  const version = String(parsed.bobina);
  if (version !== CASSETTE_VERSION) {
    throw new Error(
      `Cassette file "${file}" has bobina version ${JSON.stringify(version)}, ` +
        `but this build expects "${CASSETTE_VERSION}".`,
    );
  }
  return parsed;
}

/** Write `cassette` as pretty (2-space) JSON to `<dir>/<cassette.name>.json`. */
export async function saveCassette(dir: string, cassette: Cassette): Promise<void> {
  const file = cassettePath(dir, cassette.name);
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
}
