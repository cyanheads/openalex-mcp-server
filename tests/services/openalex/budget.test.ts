/**
 * @fileoverview Tests for the OpenAlex budget-header parser and accumulator.
 * @module services/openalex/budget.test
 */

import { describe, expect, it } from 'vitest';
import { mergeUpstreamBudget, parseUpstreamBudget } from '@/services/openalex/budget.js';

/** Header sets copied from live OpenAlex responses (anonymous access). */
const SINGLETON_HEADERS = {
  'x-ratelimit-cost-usd': '0',
  'x-ratelimit-credits-used': '0',
  'x-ratelimit-limit': '1000',
  'x-ratelimit-limit-usd': '0.1',
  'x-ratelimit-onetime-remaining': '0',
  'x-ratelimit-prepaid-remaining-usd': '0',
  'x-ratelimit-remaining': '699',
  'x-ratelimit-remaining-usd': '0.0699',
  'x-ratelimit-reset': '5557',
};

describe('parseUpstreamBudget', () => {
  it('reads the USD figures and the reset countdown', () => {
    expect(parseUpstreamBudget(new Headers(SINGLETON_HEADERS))).toEqual({
      costUsd: 0,
      remainingUsd: 0.0699,
      resetsInSeconds: 5557,
    });
  });

  it('ignores the credit-denominated headers', () => {
    // `x-ratelimit-remaining` is a count against a separate 1000-credit ceiling, not dollars.
    const budget = parseUpstreamBudget(new Headers(SINGLETON_HEADERS));
    expect(budget?.remainingUsd).not.toBe(699);
  });

  it('returns undefined when a header is missing', () => {
    const { 'x-ratelimit-remaining-usd': _omitted, ...partial } = SINGLETON_HEADERS;
    expect(parseUpstreamBudget(new Headers(partial))).toBeUndefined();
  });

  it('returns undefined when a header is not a number', () => {
    expect(
      parseUpstreamBudget(new Headers({ ...SINGLETON_HEADERS, 'x-ratelimit-reset': 'soon' })),
    ).toBeUndefined();
  });

  it('returns undefined on a response with no rate-limit headers', () => {
    expect(parseUpstreamBudget(new Headers())).toBeUndefined();
  });

  describe('prepaid balance (gh #60)', () => {
    it('carries a non-zero prepaid balance alongside the daily figure', () => {
      const budget = parseUpstreamBudget(
        new Headers({ ...SINGLETON_HEADERS, 'x-ratelimit-prepaid-remaining-usd': '4.2' }),
      );
      expect(budget).toEqual({
        costUsd: 0,
        remainingUsd: 0.0699,
        resetsInSeconds: 5557,
        prepaidRemainingUsd: 4.2,
      });
    });

    it('omits the field when the account holds no prepaid balance', () => {
      // The live anonymous header set reads `0` — reporting it would claim spendable
      // balance that does not exist.
      expect(parseUpstreamBudget(new Headers(SINGLETON_HEADERS))).not.toHaveProperty(
        'prepaidRemainingUsd',
      );
    });

    it('omits the field when the header is absent entirely', () => {
      const { 'x-ratelimit-prepaid-remaining-usd': _omitted, ...withoutPrepaid } =
        SINGLETON_HEADERS;
      expect(parseUpstreamBudget(new Headers(withoutPrepaid))).not.toHaveProperty(
        'prepaidRemainingUsd',
      );
    });

    it('still reads the daily figures when only the prepaid header is unparseable', () => {
      // The prepaid balance sits outside the all-or-nothing gate — it is an independent
      // pool, so its absence says nothing about the daily accounting.
      const budget = parseUpstreamBudget(
        new Headers({ ...SINGLETON_HEADERS, 'x-ratelimit-prepaid-remaining-usd': 'plenty' }),
      );
      expect(budget?.remainingUsd).toBe(0.0699);
      expect(budget).not.toHaveProperty('prepaidRemainingUsd');
    });

    it('ignores the unit-less one-time counter', () => {
      // `x-ratelimit-onetime-remaining` is not USD-denominated and OpenAlex documents no
      // meaning for it, so there is nothing truthful to report.
      const budget = parseUpstreamBudget(
        new Headers({ ...SINGLETON_HEADERS, 'x-ratelimit-onetime-remaining': '25' }),
      );
      expect(JSON.stringify(budget)).not.toContain('25');
    });
  });
});

describe('mergeUpstreamBudget', () => {
  const first = { costUsd: 0.001, remainingUsd: 0.069, resetsInSeconds: 5560 };
  const second = { costUsd: 0.0005, remainingUsd: 0.0685, resetsInSeconds: 5558 };

  it('returns the first reading unchanged', () => {
    expect(mergeUpstreamBudget(undefined, first)).toEqual(first);
  });

  it('sums cost and keeps the lower reading of each countdown', () => {
    expect(mergeUpstreamBudget(first, second)).toEqual({
      costUsd: 0.0015,
      remainingUsd: 0.0685,
      resetsInSeconds: 5558,
    });
  });

  it('is order-independent, since parallel requests resolve arbitrarily', () => {
    expect(mergeUpstreamBudget(first, second)).toEqual(mergeUpstreamBudget(second, first));
  });

  describe('prepaid balance (gh #60)', () => {
    it('keeps the lower prepaid reading when both requests report one', () => {
      const merged = mergeUpstreamBudget(
        { ...first, prepaidRemainingUsd: 4.2 },
        { ...second, prepaidRemainingUsd: 4.1 },
      );
      expect(merged.prepaidRemainingUsd).toBe(4.1);
    });

    it('drops the balance when one request saw the pool empty', () => {
      // An absent reading means nothing left to spend, and the lower reading is the
      // more recent one.
      expect(
        mergeUpstreamBudget({ ...first, prepaidRemainingUsd: 4.2 }, second),
      ).not.toHaveProperty('prepaidRemainingUsd');
    });

    it('stays order-independent with a prepaid balance in play', () => {
      const a = { ...first, prepaidRemainingUsd: 4.2 };
      const b = { ...second, prepaidRemainingUsd: 4.1 };
      expect(mergeUpstreamBudget(a, b)).toEqual(mergeUpstreamBudget(b, a));
    });
  });
});
