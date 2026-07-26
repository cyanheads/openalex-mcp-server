/**
 * @fileoverview Reads OpenAlex's per-request usage accounting off the `X-RateLimit-*`
 * response headers and accumulates it across the requests one tool call issues.
 * @module services/openalex/budget
 */

/**
 * What a tool call spent against the OpenAlex daily budget, and what is left.
 *
 * OpenAlex bills usage in dollars against a daily allowance (roughly $0.10/day anonymous,
 * $1/day with a free account key) that refills at midnight UTC. It reports the accounting
 * on every successful response's headers. `X-RateLimit-Remaining` is a *credit* count
 * against a separate 1000-credit ceiling — proportional to the dollar figure and therefore
 * redundant — so only the `-USD` headers are carried here. `X-RateLimit-Onetime-Remaining`
 * is excluded on the same grounds and one more: it carries no unit, and OpenAlex documents
 * neither the header nor any matching field on its `/rate-limit` endpoint, so there is no
 * way to say what a caller could spend it on.
 */
export interface UpstreamBudget {
  /** USD this call spent, summed over every upstream request it issued. */
  costUsd: number;
  /**
   * USD left in the prepaid balance — a separate pool OpenAlex draws on once the daily
   * allowance is spent, and which does not refill at the reset. Omitted when the account
   * holds none, which is every anonymous call.
   */
  prepaidRemainingUsd?: number;
  /** USD left in today's budget as of the most recent upstream response. */
  remainingUsd: number;
  /** Seconds until the daily budget refills. */
  resetsInSeconds: number;
}

function readNumericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Extract the budget accounting from a successful OpenAlex response.
 *
 * All three headers are emitted together on every 200 — a list, a group_by, an autocomplete,
 * and a singleton `/works/{id}` lookup alike. Singleton lookups are the reason this reads
 * headers rather than the parsed body: they carry no `meta` wrapper at all, so the body's
 * `cost_usd` (present and identical on the other shapes) is unavailable exactly where
 * `costUsd: 0` is the most interesting signal — fetching by ID is free.
 *
 * Returns `undefined` unless the full set parses. A partial read would report a cost with no
 * budget to weigh it against, which is worse than reporting nothing. The prepaid balance sits
 * outside that gate — it is an independent pool most accounts don't hold, so its absence says
 * nothing about whether the daily accounting is readable.
 */
export function parseUpstreamBudget(headers: Headers): UpstreamBudget | undefined {
  const costUsd = readNumericHeader(headers, 'x-ratelimit-cost-usd');
  const remainingUsd = readNumericHeader(headers, 'x-ratelimit-remaining-usd');
  const resetsInSeconds = readNumericHeader(headers, 'x-ratelimit-reset');

  if (costUsd === undefined || remainingUsd === undefined || resetsInSeconds === undefined) return;

  const prepaidRemainingUsd = readNumericHeader(headers, 'x-ratelimit-prepaid-remaining-usd');
  return {
    costUsd,
    remainingUsd,
    resetsInSeconds,
    // A zero reading is the no-prepaid-balance case, indistinguishable from an account that
    // has spent it — either way there is nothing extra to spend, so report nothing extra.
    ...(prepaidRemainingUsd !== undefined && prepaidRemainingUsd > 0 && { prepaidRemainingUsd }),
  };
}

/**
 * Fold one response's accounting into the running total for a tool call.
 *
 * Cost adds up — a single tool call can issue several billed requests (a sampled search pairs
 * the sample with a population count; the citation-graph walk gates on a seed lookup), and the
 * caller pays for each. The counters run *down*, so the smaller reading is the more recent
 * one; taking the minimum also stays deterministic when requests are issued in parallel and
 * resolve in arbitrary order. The prepaid balance follows the same rule with an absent side
 * read as zero — one request seeing the pool empty means it is empty — which lands back on
 * the omit-when-nothing-is-left convention `parseUpstreamBudget` sets.
 */
export function mergeUpstreamBudget(
  previous: UpstreamBudget | undefined,
  next: UpstreamBudget,
): UpstreamBudget {
  if (previous === undefined) return next;
  const prepaidRemainingUsd = Math.min(
    previous.prepaidRemainingUsd ?? 0,
    next.prepaidRemainingUsd ?? 0,
  );
  return {
    costUsd: previous.costUsd + next.costUsd,
    remainingUsd: Math.min(previous.remainingUsd, next.remainingUsd),
    resetsInSeconds: Math.min(previous.resetsInSeconds, next.resetsInSeconds),
    ...(prepaidRemainingUsd > 0 && { prepaidRemainingUsd }),
  };
}
