import type {
  Cassette,
  CustomMatcher,
  HttpInteraction,
  MatcherKey,
  RecordedRequest,
} from './types.js';

/** VCR-style default: match on HTTP method and the full request URI. */
export const DEFAULT_MATCHERS: MatcherKey[] = ['method', 'uri'];

/**
 * Returns `true` when `incoming` matches `recorded` on every key (AND) and
 * passes every custom matcher.
 */
export function matchRequest(
  recorded: RecordedRequest,
  incoming: RecordedRequest,
  keys: MatcherKey[],
  custom?: CustomMatcher[],
): boolean {
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

/** First interaction in `cassette` whose request matches `incoming`, else `null`. */
export function findInteraction(
  cassette: Cassette,
  incoming: RecordedRequest,
  keys: MatcherKey[],
  custom?: CustomMatcher[],
): HttpInteraction | null {
  for (const interaction of cassette.httpInteractions) {
    if (matchRequest(interaction.request, incoming, keys, custom)) {
      return interaction;
    }
  }
  return null;
}

function matchKey(key: MatcherKey, recorded: RecordedRequest, incoming: RecordedRequest): boolean {
  switch (key) {
    case 'method':
      return recorded.method.toLowerCase() === incoming.method.toLowerCase();
    case 'uri':
      return recorded.uri === incoming.uri;
    case 'host':
      return new URL(recorded.uri).host === new URL(incoming.uri).host;
    case 'path':
      return new URL(recorded.uri).pathname === new URL(incoming.uri).pathname;
    case 'query':
      return sortedQuery(recorded.uri) === sortedQuery(incoming.uri);
    case 'body':
      return recorded.body === incoming.body;
    case 'headers':
      return isHeaderSubset(recorded.headers, incoming.headers);
  }
}

/** Normalize a URI's query string by sorting params, so order doesn't matter. */
function sortedQuery(uri: string): string {
  const params = new URL(uri).searchParams;
  params.sort();
  return params.toString();
}

/** Every recorded header key/value must be present in `incoming` (subset). */
function isHeaderSubset(
  recorded: Record<string, string>,
  incoming: Record<string, string>,
): boolean {
  for (const [name, value] of Object.entries(recorded)) {
    if (incoming[name] !== value) {
      return false;
    }
  }
  return true;
}
