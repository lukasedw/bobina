/** Package version. */
export const VERSION = '0.1.0';

// --- Public API surfaces ---
export { createBobina, resetBobinaSingleton } from './bobina.js';
export type { Bobina, BobinaConfig } from './bobina.js';
export { useCassette } from './use-cassette.js';
export type { UseCassetteOptions } from './use-cassette.js';

// --- Lower-level engine (advanced / custom lifecycles) ---
export { createEngine } from './engine.js';
export type { Engine, EngineOptions } from './engine.js';

// --- Cassette store + matchers ---
export { emptyCassette, loadCassette, saveCassette } from './cassette.js';
export { DEFAULT_MATCHERS, findInteraction, matchRequest } from './matcher.js';

// --- Sensitive-data filters + header scoping ---
export { applyFiltersOnRecord, applyFiltersOnReplay, DEFAULT_HEADER_DENYLIST } from './filters.js';

// --- Public types ---
export type {
  Cassette,
  CustomMatcher,
  Filter,
  HttpInteraction,
  MatcherKey,
  RecordMode,
  RecordedRequest,
  RecordedResponse,
} from './types.js';
