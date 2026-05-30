import { createEngine } from './engine.js';
import type { Engine } from './engine.js';
import type { CustomMatcher, Filter, MatcherKey, RecordMode, RecordedRequest } from './types.js';

/**
 * Configuration for {@link createBobina} (and, via {@link UseCassetteOptions},
 * the block API {@link useCassette}).
 */
export interface BobinaConfig {
  /** Directory cassette files are read from / written to. */
  cassetteDir: string;
  /** VCR record mode governing replay/record/error behaviour. Defaults to `'once'`. */
  mode?: RecordMode;
  /** Only requests to these hosts are intercepted; everything else passes through. */
  hosts: string[];
  /** Matcher keys used to pair incoming requests with recorded ones. */
  matchers?: MatcherKey[];
  /** Extra user matchers, AND-ed with `matchers`. */
  customMatchers?: CustomMatcher[];
  /** Sensitive-data filters applied to interactions before they are persisted. */
  filters?: Filter[];
  /**
   * If set, only these (lowercased) request/response headers are stored in the
   * cassette. When absent, a default denylist (`authorization`, `cookie`,
   * `set-cookie`, `x-api-key`, …) is dropped from stored headers instead.
   */
  headerAllowlist?: string[];
  /** Injected clock returning an ISO timestamp. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Called with the incoming request whenever a replay miss errors out. */
  onUnmatched?: (req: RecordedRequest) => void;
}

/**
 * The long-running-server surface (the Next.js instrumentation case). The
 * server process is separate from the test runner, and the active cassette is
 * switched by an external signal calling {@link Bobina.useCassette}.
 */
export interface Bobina {
  /** Activate the interceptor (start observing HTTP traffic). Idempotent. */
  listen(): Promise<void>;
  /** Flush the active cassette if dirty, then tear the interceptor down. */
  close(): Promise<void>;
  /** Flush the previous cassette, then load + activate cassette `name`. */
  useCassette(name: string): Promise<void>;
  /** Persist the active cassette to disk if it has unsaved changes. */
  eject(): Promise<void>;
  /** Name of the active cassette, or `null` if none is loaded. */
  currentCassette(): string | null;
}

/** What we stash on `globalThis` so one engine survives Next.js bundle splits. */
interface BobinaSingleton {
  engine: Engine;
  bobina: Bobina;
  /** Fingerprint of the interception-relevant config, for compatibility checks. */
  fingerprint: string;
}

declare global {
  // `var` is required for the property to land on the `globalThis` *type*;
  // `let`/`const` in `declare global` do not augment it. (gotcha #4)
  var __bobina__: BobinaSingleton | undefined;
}

/** Resolve a `now` thunk, defaulting to the real wall clock. */
function resolveNow(now: BobinaConfig['now']): () => string {
  return now ?? (() => new Date().toISOString());
}

/**
 * A stable signature of the fields that define *how* traffic is intercepted.
 * Functions (`now`, matchers, `onUnmatched`) are intentionally excluded — they
 * cannot be compared by value and do not change interception identity.
 */
function fingerprintConfig(config: BobinaConfig): string {
  return JSON.stringify({
    cassetteDir: config.cassetteDir,
    mode: config.mode ?? 'once',
    hosts: [...config.hosts].sort(),
  });
}

function buildBobina(config: BobinaConfig): { engine: Engine; bobina: Bobina } {
  const engine = createEngine({
    cassetteDir: config.cassetteDir,
    mode: config.mode ?? 'once',
    hosts: config.hosts,
    matchers: config.matchers,
    customMatchers: config.customMatchers,
    filters: config.filters,
    headerAllowlist: config.headerAllowlist,
    now: resolveNow(config.now),
    onUnmatched: config.onUnmatched,
  });

  const bobina: Bobina = {
    listen() {
      engine.apply();
      return Promise.resolve();
    },
    close() {
      return engine.dispose();
    },
    useCassette(name) {
      return engine.use(name);
    },
    eject() {
      return engine.eject();
    },
    currentCassette() {
      return engine.activeName();
    },
  };

  return { engine, bobina };
}

/**
 * Construct a long-running bobina and stash it on `globalThis.__bobina__`. When
 * called again in the same process with a compatible config (same cassetteDir,
 * mode and hosts), the existing instance is reused instead of stacking a second
 * interceptor — this is what lets the Next.js instrumentation hook and a route
 * handler share one engine across bundle chunks (gotcha #4). A genuinely
 * different config throws; call {@link resetBobinaSingleton} first to replace it.
 */
export function createBobina(config: BobinaConfig): Bobina {
  const fingerprint = fingerprintConfig(config);
  const existing = globalThis.__bobina__;

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error(
        'bobina: createBobina() was called with a config incompatible with the active ' +
          'singleton (cassetteDir/mode/hosts differ). Call resetBobinaSingleton() first.',
      );
    }
    return existing.bobina;
  }

  const { engine, bobina } = buildBobina(config);
  globalThis.__bobina__ = { engine, bobina, fingerprint };
  return bobina;
}

/**
 * Forget the process-wide bobina singleton so the next {@link createBobina}
 * builds a fresh instance. A test helper for isolation — it does not tear the
 * interceptor down, so a test that called `listen()` must still `close()`.
 */
export function resetBobinaSingleton(): void {
  globalThis.__bobina__ = undefined;
}
