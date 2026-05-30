import type { BobinaConfig } from './bobina.js';
import { createEngine } from './engine.js';

/**
 * Options for {@link useCassette} — identical to {@link BobinaConfig}. The block
 * API takes the same configuration as the server API; only the lifecycle differs.
 */
export type UseCassetteOptions = BobinaConfig;

/**
 * Block API (Vitest-friendly): run `fn` with a **local** record/replay engine.
 *
 * Unlike {@link createBobina}, this never touches the `globalThis` singleton —
 * each call is fully self-contained. The engine is applied, the named cassette
 * loaded, `fn` is run, and then the cassette is flushed and the interceptor torn
 * down in a `finally` (so a throwing `fn` still cleans up). Returns `fn`'s value.
 */
export async function useCassette<T>(
  name: string,
  options: UseCassetteOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const engine = createEngine({
    cassetteDir: options.cassetteDir,
    mode: options.mode ?? 'once',
    hosts: options.hosts,
    matchers: options.matchers,
    customMatchers: options.customMatchers,
    filters: options.filters,
    headerAllowlist: options.headerAllowlist,
    now: options.now ?? (() => new Date().toISOString()),
    onUnmatched: options.onUnmatched,
  });

  engine.apply();
  try {
    await engine.use(name);
    return await fn();
  } finally {
    await engine.eject();
    await engine.dispose();
  }
}
