import type { Filter, HttpInteraction } from './types.js';

/**
 * Request/response header names (lowercased) dropped from a stored cassette by
 * default. These routinely carry credentials or session state and must never
 * land on disk unfiltered. A header listed here is kept only when it is also
 * explicitly named in a `headerAllowlist`.
 *
 * `x-interceptors-internal-request-id` is injected by `@mswjs/interceptors` for
 * request correlation; it is internal plumbing and never belongs in a cassette.
 */
export const DEFAULT_HEADER_DENYLIST: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-interceptors-internal-request-id',
];

/** A {@link Filter} whose `value` has been resolved to a present, non-empty string. */
interface ResolvedFilter {
  value: string;
  placeholder: string;
}

/**
 * Resolve each filter's `value` (invoking it when it is a thunk) and drop any
 * that resolve to an empty/absent string. Replacing '' would splice the
 * placeholder between every character, so those filters are skipped entirely.
 */
function resolveFilters(filters: Filter[]): ResolvedFilter[] {
  const resolved: ResolvedFilter[] = [];
  for (const filter of filters) {
    const value = typeof filter.value === 'function' ? filter.value() : filter.value;
    if (value) {
      resolved.push({ value, placeholder: filter.placeholder });
    }
  }
  return resolved;
}

/** Replace every literal occurrence of `from` with `to` (no regex semantics). */
function replaceAll(input: string, from: string, to: string): string {
  return input.split(from).join(to);
}

/** Apply `transform` to every header value, returning a fresh object. */
function mapHeaderValues(
  headers: Record<string, string>,
  transform: (value: string) => string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = transform(value);
  }
  return result;
}

/**
 * Redact secrets before persistence: replace every occurrence of each resolved
 * `value` with its `placeholder` across request headers, request body, response
 * headers, and response body. Returns a new interaction (does not mutate input).
 *
 * Deterministic and idempotent — re-running over already-redacted content is a
 * no-op because the raw values are gone. Filters resolving to '' are skipped.
 */
export function applyFiltersOnRecord(
  interaction: HttpInteraction,
  filters: Filter[],
): HttpInteraction {
  const resolved = resolveFilters(filters);
  if (resolved.length === 0) return interaction;

  const redact = (text: string): string => {
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
      body: redact(interaction.request.body),
    },
    response: {
      ...interaction.response,
      headers: mapHeaderValues(interaction.response.headers, redact),
      body: redact(interaction.response.body),
    },
  };
}

/**
 * Inverse of {@link applyFiltersOnRecord}, request-side only: swap each
 * `placeholder` back to its live `value` so a replayed request still carries a
 * usable token when a consumer inspects it. Response-side placeholders are left
 * untouched by default — a recorded response body should stay redacted. Returns
 * a new interaction; pure and deterministic.
 */
export function applyFiltersOnReplay(
  interaction: HttpInteraction,
  filters: Filter[],
): HttpInteraction {
  const resolved = resolveFilters(filters);
  if (resolved.length === 0) return interaction;

  const restore = (text: string): string => {
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
      body: restore(interaction.request.body),
    },
    response: interaction.response,
  };
}

/**
 * Restrict which headers are stored. With an `allowlist`, only those
 * (case-insensitively matched) header names survive. Without one, the
 * {@link DEFAULT_HEADER_DENYLIST} is dropped. Either way, a denylisted header is
 * kept only when it is explicitly allowlisted. Pure; does not mutate `headers`.
 */
export function scopeHeaders(
  headers: Record<string, string>,
  allowlist?: string[],
): Record<string, string> {
  const allow = allowlist?.map((name) => name.toLowerCase());
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const keep = allow ? allow.includes(lower) : !DEFAULT_HEADER_DENYLIST.includes(lower);
    if (keep) {
      result[name] = value;
    }
  }
  return result;
}

/** Apply {@link scopeHeaders} to both sides of an interaction. */
export function applyHeaderScoping(
  interaction: HttpInteraction,
  allowlist?: string[],
): HttpInteraction {
  return {
    request: {
      ...interaction.request,
      headers: scopeHeaders(interaction.request.headers, allowlist),
    },
    response: {
      ...interaction.response,
      headers: scopeHeaders(interaction.response.headers, allowlist),
    },
  };
}
