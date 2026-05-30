import { describe, expect, it } from 'vitest';

import { DEFAULT_MATCHERS, findInteraction, matchRequest } from '../src/matcher';
import type { Cassette, CustomMatcher, RecordedRequest } from '../src/types';

const NOW = '2026-05-30T12:00:00.000Z';

function req(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    method: 'GET',
    uri: 'https://api.example.com/v1/items?a=1&b=2',
    headers: { 'content-type': 'application/json' },
    body: '',
    ...overrides,
  };
}

describe('matchRequest', () => {
  it('defaults to method + uri', () => {
    expect(DEFAULT_MATCHERS).toEqual(['method', 'uri']);
  });

  describe('method', () => {
    it('matches case-insensitively', () => {
      expect(matchRequest(req({ method: 'POST' }), req({ method: 'post' }), ['method'])).toBe(true);
    });
    it('fails on different methods', () => {
      expect(matchRequest(req({ method: 'GET' }), req({ method: 'POST' }), ['method'])).toBe(false);
    });
  });

  describe('uri', () => {
    it('matches identical full URLs', () => {
      expect(matchRequest(req(), req(), ['uri'])).toBe(true);
    });
    it('fails when any part of the URL differs', () => {
      const other = req({ uri: 'https://api.example.com/v1/items?a=1&b=3' });
      expect(matchRequest(req(), other, ['uri'])).toBe(false);
    });
  });

  describe('host', () => {
    it('matches the same host regardless of path/query', () => {
      const a = req({ uri: 'https://api.example.com/a' });
      const b = req({ uri: 'https://api.example.com/b?x=1' });
      expect(matchRequest(a, b, ['host'])).toBe(true);
    });
    it('fails on different hosts', () => {
      const a = req({ uri: 'https://api.example.com/a' });
      const b = req({ uri: 'https://other.example.com/a' });
      expect(matchRequest(a, b, ['host'])).toBe(false);
    });
  });

  describe('path', () => {
    it('matches the same pathname regardless of query', () => {
      const a = req({ uri: 'https://api.example.com/v1/items?a=1' });
      const b = req({ uri: 'https://api.example.com/v1/items?a=2' });
      expect(matchRequest(a, b, ['path'])).toBe(true);
    });
    it('fails on different paths', () => {
      const a = req({ uri: 'https://api.example.com/v1/items' });
      const b = req({ uri: 'https://api.example.com/v1/other' });
      expect(matchRequest(a, b, ['path'])).toBe(false);
    });
  });

  describe('query', () => {
    it('is order-independent', () => {
      const a = req({ uri: 'https://api.example.com/x?a=1&b=2' });
      const b = req({ uri: 'https://api.example.com/x?b=2&a=1' });
      expect(matchRequest(a, b, ['query'])).toBe(true);
    });
    it('fails on different query values', () => {
      const a = req({ uri: 'https://api.example.com/x?a=1' });
      const b = req({ uri: 'https://api.example.com/x?a=2' });
      expect(matchRequest(a, b, ['query'])).toBe(false);
    });
  });

  describe('body', () => {
    it('matches identical bodies', () => {
      expect(matchRequest(req({ body: '{"a":1}' }), req({ body: '{"a":1}' }), ['body'])).toBe(true);
    });
    it('fails on different bodies', () => {
      expect(matchRequest(req({ body: '{"a":1}' }), req({ body: '{"a":2}' }), ['body'])).toBe(
        false,
      );
    });
  });

  describe('headers', () => {
    it('matches when recorded headers are a subset of incoming', () => {
      const recorded = req({ headers: { 'content-type': 'application/json' } });
      const incoming = req({ headers: { 'content-type': 'application/json', 'x-trace': 'abc' } });
      expect(matchRequest(recorded, incoming, ['headers'])).toBe(true);
    });
    it('fails when a recorded header is missing from or differs in incoming', () => {
      const recorded = req({ headers: { 'content-type': 'application/json' } });
      expect(
        matchRequest(recorded, req({ headers: { 'content-type': 'text/plain' } }), ['headers']),
      ).toBe(false);
      expect(matchRequest(recorded, req({ headers: {} }), ['headers'])).toBe(false);
    });
  });

  it('requires every key to pass (AND semantics)', () => {
    const recorded = req({ method: 'GET', uri: 'https://api.example.com/a' });
    const incoming = req({ method: 'GET', uri: 'https://api.example.com/b' });
    // method matches but uri does not → overall false.
    expect(matchRequest(recorded, incoming, ['method', 'uri'])).toBe(false);
    // method alone → true.
    expect(matchRequest(recorded, incoming, ['method'])).toBe(true);
  });

  it('runs custom matchers in addition to keys (all must pass)', () => {
    const recorded = req({ uri: 'https://api.example.com/x?token=AAA' });
    const incoming = req({ uri: 'https://api.example.com/x?token=BBB' });

    // A custom matcher that ignores the volatile `token` query param.
    const samePath: CustomMatcher = (r, i) => new URL(r.uri).pathname === new URL(i.uri).pathname;
    expect(matchRequest(recorded, incoming, [], [samePath])).toBe(true);

    // Custom passes, but the `uri` key fails → overall false.
    expect(matchRequest(recorded, incoming, ['uri'], [samePath])).toBe(false);

    // Keys pass, but a rejecting custom matcher fails → overall false.
    const rejectAll: CustomMatcher = () => false;
    expect(matchRequest(recorded, recorded, ['uri'], [rejectAll])).toBe(false);
  });
});

describe('findInteraction', () => {
  const cassette: Cassette = {
    bobina: '1',
    name: 'fixture',
    recordedAt: NOW,
    httpInteractions: [
      {
        request: { method: 'GET', uri: 'https://api.example.com/a', headers: {}, body: '' },
        response: { status: 200, headers: {}, body: 'A', bodyEncoding: 'utf8' },
      },
      {
        request: { method: 'POST', uri: 'https://api.example.com/b', headers: {}, body: '{}' },
        response: { status: 201, headers: {}, body: 'B', bodyEncoding: 'utf8' },
      },
    ],
  };

  it('returns the first interaction whose request matches', () => {
    const found = findInteraction(
      cassette,
      { method: 'POST', uri: 'https://api.example.com/b', headers: {}, body: '{}' },
      DEFAULT_MATCHERS,
    );
    expect(found?.response.body).toBe('B');
  });

  it('returns null when nothing matches', () => {
    const found = findInteraction(
      cassette,
      { method: 'DELETE', uri: 'https://api.example.com/z', headers: {}, body: '' },
      DEFAULT_MATCHERS,
    );
    expect(found).toBeNull();
  });
});
