/**
 * @fileoverview Markdown rendering for the `budget` enrichment field — shared by the
 * `enrichmentTrailer` of every tool that calls the OpenAlex API. Collapses the three
 * numeric fields to one trailer line; `structuredContent` keeps the numbers.
 * @module mcp-server/tools/render-budget
 */

import type { UpstreamBudget } from '@/services/openalex/budget.js';

/** OpenAlex prices calls in fractions of a cent — four places keeps them out of exponent form. */
const USD_DECIMALS = 4;

function formatUsd(value: number): string {
  return `$${value.toFixed(USD_DECIMALS)}`;
}

function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One-line budget trailer. `costUsd: 0` renders as "free" rather than `$0.0000` because it
 * carries real signal — it means the call was a singleton ID lookup, which OpenAlex does not
 * bill, so batching by ID beats paging a filtered list. The prepaid segment appears only for
 * an account holding that balance: without it, "left today" is the whole spendable figure;
 * with it, the daily line alone reads as broke on an account that keeps serving.
 */
export function renderBudgetTrailer(budget: UpstreamBudget | undefined): string {
  if (!budget) return '';
  const cost = budget.costUsd === 0 ? 'free' : formatUsd(budget.costUsd);
  const prepaid =
    budget.prepaidRemainingUsd === undefined
      ? ''
      : ` + ${formatUsd(budget.prepaidRemainingUsd)} prepaid`;
  return `**Budget:** ${cost} this call · ${formatUsd(budget.remainingUsd)} left today${prepaid} (resets in ${formatCountdown(budget.resetsInSeconds)})`;
}
