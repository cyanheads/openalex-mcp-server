/**
 * @fileoverview Tests for the budget enrichment trailer renderer.
 * @module mcp-server/tools/render-budget.test
 */

import { describe, expect, it } from 'vitest';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';

describe('renderBudgetTrailer', () => {
  it('renders cost, remaining budget, and the reset countdown on one line', () => {
    expect(
      renderBudgetTrailer({ costUsd: 0.001, remainingUsd: 0.0689, resetsInSeconds: 5554 }),
    ).toBe('**Budget:** $0.0010 this call · $0.0689 left today (resets in 1h 33m)');
  });

  it('renders a zero cost as free — the signal that an ID lookup is unbilled', () => {
    expect(
      renderBudgetTrailer({ costUsd: 0, remainingUsd: 0.0699, resetsInSeconds: 5557 }),
    ).toContain('free this call');
  });

  it('keeps sub-cent costs out of exponent notation', () => {
    expect(
      renderBudgetTrailer({ costUsd: 0.0001, remainingUsd: 0.0688, resetsInSeconds: 60 }),
    ).toContain('$0.0001 this call');
  });

  it('renders short countdowns in minutes and seconds', () => {
    expect(
      renderBudgetTrailer({ costUsd: 0.0001, remainingUsd: 0.01, resetsInSeconds: 90 }),
    ).toContain('resets in 2m');
    expect(
      renderBudgetTrailer({ costUsd: 0.0001, remainingUsd: 0.01, resetsInSeconds: 30 }),
    ).toContain('resets in 30s');
  });

  it('renders nothing when no budget was captured', () => {
    expect(renderBudgetTrailer(undefined)).toBe('');
  });

  describe('prepaid balance (gh #60)', () => {
    it('adds the prepaid segment when the account carries one', () => {
      expect(
        renderBudgetTrailer({
          costUsd: 0.001,
          remainingUsd: 0,
          resetsInSeconds: 3600,
          prepaidRemainingUsd: 4.2,
        }),
      ).toBe(
        '**Budget:** $0.0010 this call · $0.0000 left today + $4.2000 prepaid (resets in 1h 0m)',
      );
    });

    it('omits the segment when there is no prepaid balance', () => {
      expect(
        renderBudgetTrailer({ costUsd: 0.001, remainingUsd: 0.0689, resetsInSeconds: 5554 }),
      ).not.toContain('prepaid');
    });

    it('keeps the daily figure honest — a spent day still reads $0.0000 left today', () => {
      // The prepaid pool is additional to the daily allowance, not a correction of it.
      expect(
        renderBudgetTrailer({
          costUsd: 0.001,
          remainingUsd: 0,
          resetsInSeconds: 3600,
          prepaidRemainingUsd: 4.2,
        }),
      ).toContain('$0.0000 left today');
    });
  });
});
