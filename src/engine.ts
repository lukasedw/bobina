import { Buffer } from 'node:buffer';

import { BatchInterceptor } from '@mswjs/interceptors';
import type { HttpRequestEventMap } from '@mswjs/interceptors';
import nodeInterceptors from '@mswjs/interceptors/presets/node';

import { loadCassette, saveCassette } from './cassette.js';
import { applyFiltersOnRecord, applyHeaderScoping } from './filters.js';
import { DEFAULT_MATCHERS, findInteraction } from './matcher.js';
import type {
  Cassette,
  CustomMatcher,
  Filter,
  HttpInteraction,
  MatcherKey,
  RecordMode,
  RecordedRequest,
  RecordedResponse,
} from './types.js';

/** Options for {@link createEngine}. */
export interface EngineOptions {
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
export interface Engine {
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

/** Per-mode replay/record/error flags resolved when a cassette is loaded. */
interface ActiveState {
  cassette: Cassette;
  recordEnabled: boolean;
  replayEnabled: boolean;
  errorOnUnmatched: boolean;
}

/** HTTP statuses whose responses must not carry a body (RFC 9110 / Fetch). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Status used for a replay miss in error modes. 599 is the top of the valid range. */
const UNMATCHED_STATUS = 599;

/**
 * Resolve the replay/record/error policy for `mode` against the just-loaded
 * cassette, plus whether the cassette starts dirty (needs a flush even if no
 * new interaction is recorded). See PLAN.md "Record modes" for the matrix.
 */
function deriveState(mode: RecordMode, loaded: Cassette): { state: ActiveState; dirty: boolean } {
  switch (mode) {
    case 'all':
      // `all` always re-records: drop existing interactions and never replay.
      // If the file had data, mark dirty so the cleared cassette is persisted
      // even when this session records nothing.
      return {
        state: {
          cassette: { ...loaded, httpInteractions: [] },
          recordEnabled: true,
          replayEnabled: false,
          errorOnUnmatched: false,
        },
        dirty: loaded.httpInteractions.length > 0,
      };
    case 'new_episodes':
      return {
        state: {
          cassette: loaded,
          recordEnabled: true,
          replayEnabled: true,
          errorOnUnmatched: false,
        },
        dirty: false,
      };
    case 'none':
      return {
        state: {
          cassette: loaded,
          recordEnabled: false,
          replayEnabled: true,
          errorOnUnmatched: true,
        },
        dirty: false,
      };
    case 'once': {
      // First capture only when the cassette is empty/absent; otherwise this is
      // a replay-only run that errors on an unmatched request.
      const hadData = loaded.httpInteractions.length > 0;
      return {
        state: {
          cassette: loaded,
          recordEnabled: !hadData,
          replayEnabled: true,
          errorOnUnmatched: hadData,
        },
        dirty: false,
      };
    }
  }
}

/** Snapshot a `Headers` instance into a plain (lowercased-key) object. */
function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Drop `content-encoding` and `content-length` from a recorded response
 * (gotcha #1): the body we store is already decoded, so replaying it with the
 * original `content-encoding` makes the consumer try to gunzip plain text.
 */
function stripVolatileHeaders(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers };
  delete result['content-encoding'];
  delete result['content-length'];
  return result;
}

/** Store text bodies verbatim; fall back to base64 for non-UTF-8 (binary) bodies. */
function encodeBody(bytes: Buffer): Pick<RecordedResponse, 'body' | 'bodyEncoding'> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { body: text, bodyEncoding: 'utf8' };
  } catch {
    return { body: bytes.toString('base64'), bodyEncoding: 'base64' };
  }
}

/** Clone before reading so the consumer's request stream stays intact. */
async function toRecordedRequest(request: Request): Promise<RecordedRequest> {
  const body = await request.clone().text();
  return {
    method: request.method,
    uri: request.url,
    headers: headersToObject(request.headers),
    body,
  };
}

/** Clone before reading so the consumer's response stream stays intact. */
async function toRecordedResponse(response: Response): Promise<RecordedResponse> {
  const bytes = Buffer.from(await response.clone().arrayBuffer());
  return {
    status: response.status,
    headers: stripVolatileHeaders(headersToObject(response.headers)),
    ...encodeBody(bytes),
  };
}

/** Reconstruct a live `Response` from a recorded one, decoding the stored body. */
function buildResponse(recorded: RecordedResponse): Response {
  const body = NULL_BODY_STATUSES.has(recorded.status)
    ? null
    : recorded.bodyEncoding === 'base64'
      ? Buffer.from(recorded.body, 'base64')
      : recorded.body;
  return new Response(body, { status: recorded.status, headers: recorded.headers });
}

/** A 599 response served (instead of a network call) when a replay misses. */
function missResponse(req: RecordedRequest): Response {
  return new Response(`bobina: no recorded interaction matches ${req.method} ${req.uri}\n`, {
    status: UNMATCHED_STATUS,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Create a record/replay engine. Wires a `BatchInterceptor` (Node presets) to
 * the cassette model: the `request` event drives replay, the `response` event
 * drives recording. The engine is host-scoped — out-of-scope traffic passes
 * through untouched (gotcha #3).
 */
export function createEngine(opts: EngineOptions): Engine {
  const { cassetteDir, mode, hosts, now } = opts;
  const matchers = opts.matchers ?? DEFAULT_MATCHERS;
  const customMatchers = opts.customMatchers ?? [];
  const onUnmatched = opts.onUnmatched;
  const filters = opts.filters ?? [];
  const headerAllowlist = opts.headerAllowlist;

  const interceptor = new BatchInterceptor({ name: 'bobina', interceptors: nodeInterceptors });

  let current: ActiveState | null = null;
  let dirty = false;
  /** Incoming requests captured in the `request` phase, keyed by requestId. */
  const pending = new Map<string, RecordedRequest>();

  function hostInScope(rawUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    // Accept either an exact host:port or a bare hostname (any port).
    return hosts.includes(url.host) || hosts.includes(url.hostname);
  }

  async function flush(): Promise<void> {
    if (current && dirty) {
      await saveCassette(cassetteDir, current.cassette);
      dirty = false;
    }
  }

  async function handleRequestEvent(args: HttpRequestEventMap['request'][0]): Promise<void> {
    const { request, requestId, controller } = args;
    if (!hostInScope(request.url)) return; // passthrough untouched
    const state = current;
    if (!state) return; // no active cassette → passthrough

    const incoming = await toRecordedRequest(request);
    pending.set(requestId, incoming);

    if (state.replayEnabled) {
      const found = findInteraction(state.cassette, incoming, matchers, customMatchers);
      if (found) {
        controller.respondWith(buildResponse(found.response));
        return;
      }
    }

    if (state.errorOnUnmatched) {
      onUnmatched?.(incoming);
      controller.respondWith(missResponse(incoming)); // never hit the network
      return;
    }
    // Otherwise let the request pass through; the `response` listener records it.
  }

  async function handleResponseEvent(args: HttpRequestEventMap['response'][0]): Promise<void> {
    const { request, requestId, response, isMockedResponse } = args;
    const incoming = pending.get(requestId);
    pending.delete(requestId);

    if (!hostInScope(request.url)) return;
    if (isMockedResponse) return; // we served this from a cassette; nothing to record

    const state = current;
    if (!state || !state.recordEnabled || !incoming) return;

    // De-dupe: don't append a second interaction matching an existing one.
    if (mode === 'once' || mode === 'new_episodes') {
      if (findInteraction(state.cassette, incoming, matchers, customMatchers)) return;
    }

    // Match against the live (unfiltered) `incoming`, but persist a sanitized
    // copy: redact secrets, then drop out-of-scope headers (Phase 5). Sensitive
    // headers stay available for live matching yet never land on disk.
    const recorded = await toRecordedResponse(response);
    let interaction: HttpInteraction = { request: incoming, response: recorded };
    interaction = applyFiltersOnRecord(interaction, filters);
    interaction = applyHeaderScoping(interaction, headerAllowlist);
    state.cassette.httpInteractions.push(interaction);
    dirty = true;
  }

  let applied = false;

  return {
    apply() {
      if (applied) return;
      // Apply BEFORE registering listeners. The Node preset's interceptor
      // instances are shared module-level singletons; a previous engine's
      // dispose() leaves them in a DISPOSED state where `.on()` silently drops
      // listeners. `apply()` re-activates them first so ours actually attach.
      interceptor.apply();
      // `@mswjs/interceptors` awaits listener return values (`emitAsync`), so
      // these listeners are intentionally async; the void-returning `Listener`
      // type can't express that, hence the targeted disables.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      interceptor.on('request', handleRequestEvent);
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      interceptor.on('response', handleResponseEvent);
      applied = true;
    },
    async dispose() {
      await flush();
      interceptor.dispose();
      applied = false;
    },
    async use(name) {
      await flush();
      const loaded = await loadCassette(cassetteDir, name, now());
      const derived = deriveState(mode, loaded);
      current = derived.state;
      dirty = derived.dirty;
    },
    async eject() {
      await flush();
    },
    activeName() {
      return current?.cassette.name ?? null;
    },
  };
}
