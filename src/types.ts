/** VCR-style record modes. See PLAN.md for the replay/record/error matrix. */
export type RecordMode = 'once' | 'new_episodes' | 'none' | 'all';

/** Built-in request-matching dimensions. */
export type MatcherKey = 'method' | 'uri' | 'host' | 'path' | 'query' | 'body' | 'headers';

/** A request as persisted in a cassette. */
export interface RecordedRequest {
  method: string;
  uri: string;
  headers: Record<string, string>;
  body: string;
}

/** A response as persisted in a cassette. */
export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
}

/** A single recorded request/response pair. */
export interface HttpInteraction {
  request: RecordedRequest;
  response: RecordedResponse;
}

/** The on-disk cassette document. `bobina` is the format version. */
export interface Cassette {
  bobina: '1';
  name: string;
  recordedAt: string;
  httpInteractions: HttpInteraction[];
}

/** A user-supplied matcher: return `true` when the two requests should match. */
export type CustomMatcher = (recorded: RecordedRequest, incoming: RecordedRequest) => boolean;

/**
 * A sensitive-data filter: every occurrence of the resolved `value` is replaced
 * with `placeholder` before a cassette is persisted. `value` may be a function
 * resolved at record time (e.g. reading `process.env`). Accepted across the API
 * now; the recorder consumes it in Phase 5 (`src/filters.ts`).
 */
export interface Filter {
  placeholder: string;
  value: string | (() => string);
}
