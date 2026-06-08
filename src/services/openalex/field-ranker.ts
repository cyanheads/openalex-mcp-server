/**
 * @fileoverview Field name ranking for ranked invalid-field suggestions.
 *
 * Blends token-set overlap (split on `.`/`_`) with Jaro-Winkler similarity.
 * Zero dependencies. Designed for short structured identifiers like OpenAlex
 * field names — not document-search use cases.
 *
 * @module services/openalex/field-ranker
 */

/** Split a field name into tokens on `.` and `_`. */
function tokenize(field: string): Set<string> {
  return new Set(field.toLowerCase().split(/[._]/));
}

/** Jaro similarity between two strings. Returns [0, 1]. */
function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
}

/** Jaro-Winkler similarity. Prefix bonus (p=0.1, max 4 chars) biases short tokens. */
function jaroWinkler(s1: string, s2: string): number {
  const j = jaro(s1, s2);
  if (j < 0.7) return j;

  let prefix = 0;
  const max = Math.min(4, Math.min(s1.length, s2.length));
  while (prefix < max && s1[prefix] === s2[prefix]) prefix++;

  return j + prefix * 0.1 * (1 - j);
}

/**
 * Score a candidate field name against a query.
 *
 * Uses token-set overlap (Jaccard on `.`/`_` tokens) blended with
 * Jaro-Winkler on the raw strings. Exact match scores 1.0.
 */
function score(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  if (q === c) return 1.0;

  const qTokens = tokenize(q);
  const cTokens = tokenize(c);

  const intersection = [...qTokens].filter((t) => cTokens.has(t)).length;
  const union = new Set([...qTokens, ...cTokens]).size;
  const tokenOverlap = union === 0 ? 0 : intersection / union;

  // Also check if query is a token subset (candidate extends it)
  const isSubset = [...qTokens].every((t) => cTokens.has(t));
  const subsetBonus = isSubset ? 0.2 : 0;

  const jw = jaroWinkler(q, c);

  return Math.min(1.0, 0.55 * tokenOverlap + 0.25 * jw + subsetBonus);
}

/**
 * Return the top-N candidate field names from `pool` ranked by similarity
 * to `query`. Results are ordered by score descending.
 *
 * @param query - The rejected field name submitted by the caller.
 * @param pool - All valid field names for this entity_type + context.
 * @param topN - Maximum number of suggestions to return. Default 5.
 */
export function rankFields(query: string, pool: string[], topN = 5): string[] {
  if (pool.length === 0) return [];

  return pool
    .map((candidate) => ({ candidate, s: score(query, candidate) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, topN)
    .map(({ candidate }) => candidate);
}
