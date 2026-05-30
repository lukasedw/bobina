// src/engine.ts
import { Buffer } from "buffer";
import { BatchInterceptor } from "@mswjs/interceptors";
import nodeInterceptors from "@mswjs/interceptors/presets/node";

// src/cassette.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
var CASSETTE_VERSION = "1";
var VALID_NAME = /^[a-z0-9-]+$/i;
function assertValidName(name) {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid cassette name ${JSON.stringify(name)}: names must match ${String(VALID_NAME)}.`
    );
  }
}
function cassettePath(dir, name) {
  assertValidName(name);
  return join(dir, `${name}.json`);
}
function isEnoent(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}
function emptyCassette(name, now) {
  assertValidName(name);
  return {
    bobina: CASSETTE_VERSION,
    name,
    recordedAt: now,
    httpInteractions: []
  };
}
async function loadCassette(dir, name, now) {
  const file = cassettePath(dir, name);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return emptyCassette(name, now);
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  const version = String(parsed.bobina);
  if (version !== CASSETTE_VERSION) {
    throw new Error(
      `Cassette file "${file}" has bobina version ${JSON.stringify(version)}, but this build expects "${CASSETTE_VERSION}".`
    );
  }
  return parsed;
}
async function saveCassette(dir, cassette) {
  const file = cassettePath(dir, cassette.name);
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(cassette, null, 2)}
`, "utf8");
}

// src/filters.ts
var DEFAULT_HEADER_DENYLIST = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-interceptors-internal-request-id"
];
function resolveFilters(filters) {
  const resolved = [];
  for (const filter of filters) {
    const value = typeof filter.value === "function" ? filter.value() : filter.value;
    if (value) {
      resolved.push({ value, placeholder: filter.placeholder });
    }
  }
  return resolved;
}
function replaceAll(input, from, to) {
  return input.split(from).join(to);
}
function mapHeaderValues(headers, transform) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = transform(value);
  }
  return result;
}
function applyFiltersOnRecord(interaction, filters) {
  const resolved = resolveFilters(filters);
  if (resolved.length === 0) return interaction;
  const redact = (text) => {
    let out = text;
    for (const { value, placeholder } of resolved) {
      out = replaceAll(out, value, placeholder);
    }
    return out;
  };
  return {
    request: {
      ...interaction.request,
      headers: mapHeaderValues(interaction.request.headers, redact),
      body: redact(interaction.request.body)
    },
    response: {
      ...interaction.response,
      headers: mapHeaderValues(interaction.response.headers, redact),
      body: redact(interaction.response.body)
    }
  };
}
function applyFiltersOnReplay(interaction, filters) {
  const resolved = resolveFilters(filters);
  if (resolved.length === 0) return interaction;
  const restore = (text) => {
    let out = text;
    for (const { value, placeholder } of resolved) {
      out = replaceAll(out, placeholder, value);
    }
    return out;
  };
  return {
    request: {
      ...interaction.request,
      headers: mapHeaderValues(interaction.request.headers, restore),
      body: restore(interaction.request.body)
    },
    response: interaction.response
  };
}
function scopeHeaders(headers, allowlist) {
  const allow = allowlist?.map((name) => name.toLowerCase());
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const keep = allow ? allow.includes(lower) : !DEFAULT_HEADER_DENYLIST.includes(lower);
    if (keep) {
      result[name] = value;
    }
  }
  return result;
}
function applyHeaderScoping(interaction, allowlist) {
  return {
    request: {
      ...interaction.request,
      headers: scopeHeaders(interaction.request.headers, allowlist)
    },
    response: {
      ...interaction.response,
      headers: scopeHeaders(interaction.response.headers, allowlist)
    }
  };
}

// src/matcher.ts
var DEFAULT_MATCHERS = ["method", "uri"];
function matchRequest(recorded, incoming, keys, custom) {
  for (const key of keys) {
    if (!matchKey(key, recorded, incoming)) {
      return false;
    }
  }
  for (const matcher of custom ?? []) {
    if (!matcher(recorded, incoming)) {
      return false;
    }
  }
  return true;
}
function findInteraction(cassette, incoming, keys, custom) {
  for (const interaction of cassette.httpInteractions) {
    if (matchRequest(interaction.request, incoming, keys, custom)) {
      return interaction;
    }
  }
  return null;
}
function matchKey(key, recorded, incoming) {
  switch (key) {
    case "method":
      return recorded.method.toLowerCase() === incoming.method.toLowerCase();
    case "uri":
      return recorded.uri === incoming.uri;
    case "host":
      return new URL(recorded.uri).host === new URL(incoming.uri).host;
    case "path":
      return new URL(recorded.uri).pathname === new URL(incoming.uri).pathname;
    case "query":
      return sortedQuery(recorded.uri) === sortedQuery(incoming.uri);
    case "body":
      return recorded.body === incoming.body;
    case "headers":
      return isHeaderSubset(recorded.headers, incoming.headers);
  }
}
function sortedQuery(uri) {
  const params = new URL(uri).searchParams;
  params.sort();
  return params.toString();
}
function isHeaderSubset(recorded, incoming) {
  for (const [name, value] of Object.entries(recorded)) {
    if (incoming[name] !== value) {
      return false;
    }
  }
  return true;
}

// src/engine.ts
var NULL_BODY_STATUSES = /* @__PURE__ */ new Set([101, 103, 204, 205, 304]);
var UNMATCHED_STATUS = 599;
function deriveState(mode, loaded) {
  switch (mode) {
    case "all":
      return {
        state: {
          cassette: { ...loaded, httpInteractions: [] },
          recordEnabled: true,
          replayEnabled: false,
          errorOnUnmatched: false
        },
        dirty: loaded.httpInteractions.length > 0
      };
    case "new_episodes":
      return {
        state: {
          cassette: loaded,
          recordEnabled: true,
          replayEnabled: true,
          errorOnUnmatched: false
        },
        dirty: false
      };
    case "none":
      return {
        state: {
          cassette: loaded,
          recordEnabled: false,
          replayEnabled: true,
          errorOnUnmatched: true
        },
        dirty: false
      };
    case "once": {
      const hadData = loaded.httpInteractions.length > 0;
      return {
        state: {
          cassette: loaded,
          recordEnabled: !hadData,
          replayEnabled: true,
          errorOnUnmatched: hadData
        },
        dirty: false
      };
    }
  }
}
function headersToObject(headers) {
  const result = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
function stripVolatileHeaders(headers) {
  const result = { ...headers };
  delete result["content-encoding"];
  delete result["content-length"];
  return result;
}
function encodeBody(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { body: text, bodyEncoding: "utf8" };
  } catch {
    return { body: bytes.toString("base64"), bodyEncoding: "base64" };
  }
}
async function toRecordedRequest(request) {
  const body = await request.clone().text();
  return {
    method: request.method,
    uri: request.url,
    headers: headersToObject(request.headers),
    body
  };
}
async function toRecordedResponse(response) {
  const bytes = Buffer.from(await response.clone().arrayBuffer());
  return {
    status: response.status,
    headers: stripVolatileHeaders(headersToObject(response.headers)),
    ...encodeBody(bytes)
  };
}
function buildResponse(recorded) {
  const body = NULL_BODY_STATUSES.has(recorded.status) ? null : recorded.bodyEncoding === "base64" ? Buffer.from(recorded.body, "base64") : recorded.body;
  return new Response(body, { status: recorded.status, headers: recorded.headers });
}
function missResponse(req) {
  return new Response(`bobina: no recorded interaction matches ${req.method} ${req.uri}
`, {
    status: UNMATCHED_STATUS,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
function createEngine(opts) {
  const { cassetteDir, mode, hosts, now } = opts;
  const matchers = opts.matchers ?? DEFAULT_MATCHERS;
  const customMatchers = opts.customMatchers ?? [];
  const onUnmatched = opts.onUnmatched;
  const filters = opts.filters ?? [];
  const headerAllowlist = opts.headerAllowlist;
  const interceptor = new BatchInterceptor({ name: "bobina", interceptors: nodeInterceptors });
  let current = null;
  let dirty = false;
  const pending = /* @__PURE__ */ new Map();
  function hostInScope(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    return hosts.includes(url.host) || hosts.includes(url.hostname);
  }
  async function flush() {
    if (current && dirty) {
      await saveCassette(cassetteDir, current.cassette);
      dirty = false;
    }
  }
  async function handleRequestEvent(args) {
    const { request, requestId, controller } = args;
    if (!hostInScope(request.url)) return;
    const state = current;
    if (!state) return;
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
      controller.respondWith(missResponse(incoming));
      return;
    }
  }
  async function handleResponseEvent(args) {
    const { request, requestId, response, isMockedResponse } = args;
    const incoming = pending.get(requestId);
    pending.delete(requestId);
    if (!hostInScope(request.url)) return;
    if (isMockedResponse) return;
    const state = current;
    if (!state || !state.recordEnabled || !incoming) return;
    if (mode === "once" || mode === "new_episodes") {
      if (findInteraction(state.cassette, incoming, matchers, customMatchers)) return;
    }
    const recorded = await toRecordedResponse(response);
    let interaction = { request: incoming, response: recorded };
    interaction = applyFiltersOnRecord(interaction, filters);
    interaction = applyHeaderScoping(interaction, headerAllowlist);
    state.cassette.httpInteractions.push(interaction);
    dirty = true;
  }
  let applied = false;
  return {
    apply() {
      if (applied) return;
      interceptor.apply();
      interceptor.on("request", handleRequestEvent);
      interceptor.on("response", handleResponseEvent);
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
    }
  };
}

// src/bobina.ts
function resolveNow(now) {
  return now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
}
function fingerprintConfig(config) {
  return JSON.stringify({
    cassetteDir: config.cassetteDir,
    mode: config.mode ?? "once",
    hosts: [...config.hosts].sort()
  });
}
function buildBobina(config) {
  const engine = createEngine({
    cassetteDir: config.cassetteDir,
    mode: config.mode ?? "once",
    hosts: config.hosts,
    matchers: config.matchers,
    customMatchers: config.customMatchers,
    filters: config.filters,
    headerAllowlist: config.headerAllowlist,
    now: resolveNow(config.now),
    onUnmatched: config.onUnmatched
  });
  const bobina = {
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
    }
  };
  return { engine, bobina };
}
function createBobina(config) {
  const fingerprint = fingerprintConfig(config);
  const existing = globalThis.__bobina__;
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error(
        "bobina: createBobina() was called with a config incompatible with the active singleton (cassetteDir/mode/hosts differ). Call resetBobinaSingleton() first."
      );
    }
    return existing.bobina;
  }
  const { engine, bobina } = buildBobina(config);
  globalThis.__bobina__ = { engine, bobina, fingerprint };
  return bobina;
}
function resetBobinaSingleton() {
  globalThis.__bobina__ = void 0;
}

// src/use-cassette.ts
async function useCassette(name, options, fn) {
  const engine = createEngine({
    cassetteDir: options.cassetteDir,
    mode: options.mode ?? "once",
    hosts: options.hosts,
    matchers: options.matchers,
    customMatchers: options.customMatchers,
    filters: options.filters,
    headerAllowlist: options.headerAllowlist,
    now: options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()),
    onUnmatched: options.onUnmatched
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

// src/index.ts
var VERSION = "0.1.0";
export {
  DEFAULT_HEADER_DENYLIST,
  DEFAULT_MATCHERS,
  VERSION,
  applyFiltersOnRecord,
  applyFiltersOnReplay,
  createBobina,
  createEngine,
  emptyCassette,
  findInteraction,
  loadCassette,
  matchRequest,
  resetBobinaSingleton,
  saveCassette,
  useCassette
};
//# sourceMappingURL=index.js.map