import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index';

describe('bobina', () => {
  it('exposes a version string', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
