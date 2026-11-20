/**
 * @fileoverview Tests for the API key pool: parsing the configured keys, their order, and setting
 * a key aside until the midnight-UTC refill or for good.
 * @module services/openalex/key-pool.test
 */

import { describe, expect, it } from 'vitest';
import {
  ApiKeyPool,
  collectApiKeys,
  nextMidnightUtc,
  parseApiKeys,
} from '@/services/openalex/key-pool.js';

/** A settable clock for the pool. */
function clock(iso: string): { now: () => number; set: (next: string) => void } {
  let now = Date.parse(iso);
  return {
    now: () => now,
    set: (next) => {
      now = Date.parse(next);
    },
  };
}

describe('parseApiKeys', () => {
  it('splits on lines, commas, semicolons and blanks, and drops comments', () => {
    expect(
      parseApiKeys('alpha, beta;gamma delta\n# a comment\n\nepsilon # trailing\r\nzeta'),
    ).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
  });

  it.each(['', undefined, '  \n # only a comment'])('finds no key in %j', (raw) => {
    expect(parseApiKeys(raw)).toEqual([]);
  });
});

describe('collectApiKeys', () => {
  it('orders OPENALEX_API_KEY, then OPENALEX_API_KEYS, then the key file', () => {
    const read = (path: string) => (path === 'keys.txt' ? 'file-1\nfile-2\n' : '');
    expect(
      collectApiKeys({ apiKey: 'single', apiKeys: 'list-1,list-2', apiKeysFile: 'keys.txt' }, read),
    ).toEqual(['single', 'list-1', 'list-2', 'file-1', 'file-2']);
  });

  it('reads no file when none is configured', () => {
    const read = (): string => {
      throw new Error('no file should be read');
    };
    expect(collectApiKeys({ apiKey: 'single', apiKeys: '', apiKeysFile: '' }, read)).toEqual([
      'single',
    ]);
  });

  it('names the variable when the key file cannot be read', () => {
    expect(() => collectApiKeys({ apiKeysFile: 'C:/no/such/folder/openalex-keys.txt' })).toThrow(
      'OPENALEX_API_KEYS_FILE',
    );
  });
});

describe('nextMidnightUtc', () => {
  it.each([
    ['2026-11-10T23:59:59.000Z', '2026-11-11T00:00:00.000Z'],
    ['2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z'],
    ['2026-12-31T12:00:00.000Z', '2027-01-01T00:00:00.000Z'],
  ])('after %s is %s', (now, midnight) => {
    expect(new Date(nextMidnightUtc(Date.parse(now))).toISOString()).toBe(midnight);
  });
});

describe('ApiKeyPool', () => {
  it('hands out no key for anonymous access', () => {
    const pool = new ApiKeyPool([]);
    expect(pool.size).toBe(0);
    expect(pool.current()).toBeUndefined();
  });

  it('drops empty and repeated keys, keeping the first position', () => {
    const pool = new ApiKeyPool(['a', '', 'b', 'a']);
    expect(pool.size).toBe(2);
    expect(pool.current()).toEqual({ key: 'a', position: 1 });
  });

  it('moves to the next key when one is spent, and back to the first after midnight UTC', () => {
    const time = clock('2026-11-10T22:00:00Z');
    const pool = new ApiKeyPool(['a', 'b', 'c'], time.now);

    expect(pool.setAsideUntilReset('a')).toBe(true);
    expect(pool.current()).toEqual({ key: 'b', position: 2 });
    expect(pool.usable()).toBe(2);

    time.set('2026-11-10T23:59:59Z');
    expect(pool.current()?.key).toBe('b');
    time.set('2026-11-11T00:00:00Z');
    expect(pool.current()?.key).toBe('a');
    expect(pool.usable()).toBe(3);
  });

  it('never hands out a refused key again while another is usable', () => {
    const time = clock('2026-11-10T22:00:00Z');
    const pool = new ApiKeyPool(['a', 'b'], time.now);

    expect(pool.setAsideForGood('a')).toBe(true);
    time.set('2027-01-01T00:00:00Z');
    expect(pool.current()?.key).toBe('b');
  });

  it('says when no key is left, and then hands out the one that comes back first', () => {
    const time = clock('2026-11-10T22:00:00Z');
    const pool = new ApiKeyPool(['a', 'b'], time.now);

    expect(pool.setAsideForGood('a')).toBe(true);
    expect(pool.setAsideUntilReset('b')).toBe(false);
    expect(pool.usable()).toBe(0);
    expect(pool.current()?.key).toBe('b');
  });

  it('hands out the first key when OpenAlex refused every key', () => {
    const pool = new ApiKeyPool(['a', 'b']);
    pool.setAsideForGood('a');
    pool.setAsideForGood('b');
    expect(pool.current()?.key).toBe('a');
  });
});
