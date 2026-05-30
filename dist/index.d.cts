/** VCR-style record modes. See PLAN.md for the replay/record/error matrix. */
type RecordMode = 'once' | 'new_episodes' | 'none' | 'all';
/** Built-in request-matching dimensions. */
type MatcherKey = 'method' | 'uri' | 'host' | 'path' | 'query' | 'body' | 'headers';
/** A request as persisted in a cassette. */
interface RecordedRequest {
    method: string;
    uri: string;
    headers: Record<string, string>;
    body: string;
}
/** A response as persisted in a cassette. */
interface RecordedResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
    bodyEncoding: 'utf8' | 'base64';
}
/** A single recorded request/response pair. */
interface HttpInteraction {
    request: RecordedRequest;
    response: RecordedResponse;
}
/** The on-disk cassette document. `bobina` is the format version. */
interface Cassette {
    bobina: '1';
    name: string;
    recordedAt: string;
    httpInteractions: HttpInteraction[];
}
/** A user-supplied matcher: return `true` when the two requests should match. */
type CustomMatcher = (recorded: RecordedRequest, incoming: RecordedRequest) => boolean;
/**
 * A sensitive-data filter: every occurrence of the resolved `value` is replaced
 * with `placeholder` before a cassette is persisted. `value` may be a function
 * resolved at record time (e.g. reading `process.env`). Accepted across the API
 * now; the recorder consumes it in Phase 5 (`src/filters.ts`).
 */
interface Filter {
    placeholder: string;
    value: string | (() => string);
}

/** Options for {@link createEngine}. */
interface EngineOptions {
    /** Directory cassette files are read from / written to. */
    cassetteDir: string;
    /** VCR record mode governing replay/record/error behaviour. */
    mode: RecordMode;
    /** Only requests to these hosts are intercepted; everything else passes through. */
    hosts: string[];
    /** Matcher keys used to pair incoming requests with recorded ones. */
    matchers?: MatcherKey[];
    /** Extra user matchers, AND-ed with the built-in `matchers`. */
    customMatchers?: CustomMatcher[];
    /** Sensitive-data filters applied to interactions before they are persisted. */
    filters?: Filter[];
    /**
     * If set, only these (lowercased) request/response headers are stored. When
     * absent, a default denylist (`authorization`, `cookie`, `set-cookie`,
     * `x-api-key`, …) is dropped instead. See {@link DEFAULT_HEADER_DENYLIST}.
     */
    headerAllowlist?: string[];
    /** Injected clock returning an ISO timestamp; keeps the engine pure/testable. */
    now: () => string;
    /** Called with the incoming request whenever a replay miss errors out. */
    onUnmatched?: (req: RecordedRequest) => void;
}
/** A controllable record/replay engine over `@mswjs/interceptors`. */
interface Engine {
    /** Activate the interceptor (start observing HTTP traffic). */
    apply(): void;
    /** Flush the active cassette if dirty, then tear the interceptor down. */
    dispose(): Promise<void>;
    /** Flush the previous cassette, then load + activate cassette `name`. */
    use(name: string): Promise<void>;
    /** Persist the active cassette to disk if it has unsaved changes. */
    eject(): Promise<void>;
    /** Name of the active cassette, or `null` if none is loaded. */
    activeName(): string | null;
}
/**
 * Create a record/replay engine. Wires a `BatchInterceptor` (Node presets) to
 * the cassette model: the `request` event drives replay, the `response` event
 * drives recording. The engine is host-scoped — out-of-scope traffic passes
 * through untouched (gotcha #3).
 */
declare function createEngine(opts: EngineOptions): Engine;

/**
 * Configuration for {@link createBobina} (and, via {@link UseCassetteOptions},
 * the block API {@link useCassette}).
 */
interface BobinaConfig {
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
interface Bobina {
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
    var __bobina__: BobinaSingleton | undefined;
}
/**
 * Construct a long-running bobina and stash it on `globalThis.__bobina__`. When
 * called again in the same process with a compatible config (same cassetteDir,
 * mode and hosts), the existing instance is reused instead of stacking a second
 * interceptor — this is what lets the Next.js instrumentation hook and a route
 * handler share one engine across bundle chunks (gotcha #4). A genuinely
 * different config throws; call {@link resetBobinaSingleton} first to replace it.
 */
declare function createBobina(config: BobinaConfig): Bobina;
/**
 * Forget the process-wide bobina singleton so the next {@link createBobina}
 * builds a fresh instance. A test helper for isolation — it does not tear the
 * interceptor down, so a test that called `listen()` must still `close()`.
 */
declare function resetBobinaSingleton(): void;

/**
 * Options for {@link useCassette} — identical to {@link BobinaConfig}. The block
 * API takes the same configuration as the server API; only the lifecycle differs.
 */
type UseCassetteOptions = BobinaConfig;
/**
 * Block API (Vitest-friendly): run `fn` with a **local** record/replay engine.
 *
 * Unlike {@link createBobina}, this never touches the `globalThis` singleton —
 * each call is fully self-contained. The engine is applied, the named cassette
 * loaded, `fn` is run, and then the cassette is flushed and the interceptor torn
 * down in a `finally` (so a throwing `fn` still cleans up). Returns `fn`'s value.
 */
declare function useCassette<T>(name: string, options: UseCassetteOptions, fn: () => Promise<T>): Promise<T>;

/** A fresh, empty cassette. `now` is injected so this module stays pure. */
declare function emptyCassette(name: string, now: string): Cassette;
/**
 * Read `<dir>/<name>.json`. Returns an empty cassette when the file is absent
 * (`ENOENT`); throws on an unsupported `bobina` format version.
 */
declare function loadCassette(dir: string, name: string, now: string): Promise<Cassette>;
/** Write `cassette` as pretty (2-space) JSON to `<dir>/<cassette.name>.json`. */
declare function saveCassette(dir: string, cassette: Cassette): Promise<void>;

/** VCR-style default: match on HTTP method and the full request URI. */
declare const DEFAULT_MATCHERS: MatcherKey[];
/**
 * Returns `true` when `incoming` matches `recorded` on every key (AND) and
 * passes every custom matcher.
 */
declare function matchRequest(recorded: RecordedRequest, incoming: RecordedRequest, keys: MatcherKey[], custom?: CustomMatcher[]): boolean;
/** First interaction in `cassette` whose request matches `incoming`, else `null`. */
declare function findInteraction(cassette: Cassette, incoming: RecordedRequest, keys: MatcherKey[], custom?: CustomMatcher[]): HttpInteraction | null;

/**
 * Request/response header names (lowercased) dropped from a stored cassette by
 * default. These routinely carry credentials or session state and must never
 * land on disk unfiltered. A header listed here is kept only when it is also
 * explicitly named in a `headerAllowlist`.
 *
 * `x-interceptors-internal-request-id` is injected by `@mswjs/interceptors` for
 * request correlation; it is internal plumbing and never belongs in a cassette.
 */
declare const DEFAULT_HEADER_DENYLIST: readonly string[];
/**
 * Redact secrets before persistence: replace every occurrence of each resolved
 * `value` with its `placeholder` across request headers, request body, response
 * headers, and response body. Returns a new interaction (does not mutate input).
 *
 * Deterministic and idempotent — re-running over already-redacted content is a
 * no-op because the raw values are gone. Filters resolving to '' are skipped.
 */
declare function applyFiltersOnRecord(interaction: HttpInteraction, filters: Filter[]): HttpInteraction;
/**
 * Inverse of {@link applyFiltersOnRecord}, request-side only: swap each
 * `placeholder` back to its live `value` so a replayed request still carries a
 * usable token when a consumer inspects it. Response-side placeholders are left
 * untouched by default — a recorded response body should stay redacted. Returns
 * a new interaction; pure and deterministic.
 */
declare function applyFiltersOnReplay(interaction: HttpInteraction, filters: Filter[]): HttpInteraction;

/** Package version. */
declare const VERSION = "0.1.0";

export { type Bobina, type BobinaConfig, type Cassette, type CustomMatcher, DEFAULT_HEADER_DENYLIST, DEFAULT_MATCHERS, type Engine, type EngineOptions, type Filter, type HttpInteraction, type MatcherKey, type RecordMode, type RecordedRequest, type RecordedResponse, type UseCassetteOptions, VERSION, applyFiltersOnRecord, applyFiltersOnReplay, createBobina, createEngine, emptyCassette, findInteraction, loadCassette, matchRequest, resetBobinaSingleton, saveCassette, useCassette };
