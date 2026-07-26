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
});
