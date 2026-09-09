/**
 * @fileoverview Unit tests for the field-name ranking helper.
 * @module services/openalex/field-ranker.test
 */

import { describe, expect, it } from 'vitest';
import fieldCatalog from '@/services/openalex/field-catalog.json' with { type: 'json' };
import { rankAllFields, rankFields } from '@/services/openalex/field-ranker.js';

const catalog = fieldCatalog as Record<string, { filter: string[]; select: string[] }>;
const worksFilterPool = catalog.works!.filter;
const authorsSelectPool = catalog.authors!.select;

describe('rankFields', () => {
  it('returns empty array for an empty pool', () => {
    expect(rankFields('funder', [], 5)).toEqual([]);
  });

  it('returns at most topN results', () => {
    const results = rankFields('funder', worksFilterPool, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('ranks awards.funder_id at the top for query "funder" against works filter pool', () => {
    const results = rankFields('funder', worksFilterPool, 5);
    expect(results.slice(0, 3)).toContain('awards.funder_id');
  });

  it('scores an exact match highest', () => {
    const pool = ['publication_year', 'type', 'is_oa', 'cited_by_count'];
    const results = rankFields('publication_year', pool, 4);
    expect(results[0]).toBe('publication_year');
  });

  it('token-overlap surfaces a close match across the works filter pool', () => {
    // "funder_id" tokens: funder, id — awards.funder_id shares both
    const results = rankFields('funder_id', worksFilterPool, 5);
    expect(results[0]).toBe('awards.funder_id');
  });

  it('handles single-character query without throwing', () => {
    expect(() => rankFields('x', worksFilterPool, 5)).not.toThrow();
  });

  it('defaults topN to 5 when not provided', () => {
    const results = rankFields('funder', worksFilterPool);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  /**
   * The "did you mean" path is the one caller that still wants a filter: a candidate sharing
   * nothing with the rejected name is noise in a three-item suggestion list.
   */
  it('keeps suggestions positive-scoring only', () => {
    const results = rankFields('h_index', ['summary_stats', 'works_count'], 5);
    expect(results).not.toContain('summary_stats');
  });
});

describe('rankAllFields', () => {
  it('returns empty array for an empty pool', () => {
    expect(rankAllFields('funder', [])).toEqual([]);
  });

  /**
   * A lexical scorer cannot rank a nested leaf against its parent — `h_index` and
   * `summary_stats` share no token and no character inside the Jaro match window. Dropping the
   * zero removes the answer; ranking it last only deprioritizes it. (gh #63)
   */
  it('retains a zero-scoring candidate and sorts it last', () => {
    const results = rankAllFields('h_index', authorsSelectPool);
    expect(results).toContain('summary_stats');
    expect(results.at(-1)).toBe('summary_stats');
  });

  it('returns the whole pool exactly once, in ranked order', () => {
    const results = rankAllFields('h_index', authorsSelectPool);
    expect(results).toHaveLength(authorsSelectPool.length);
    expect(new Set(results)).toEqual(new Set(authorsSelectPool));
  });

  it('preserves the rank order rankFields produces for genuine lexical matches', () => {
    expect(rankAllFields('funder', worksFilterPool).slice(0, 5)).toEqual(
      rankFields('funder', worksFilterPool, 5),
    );
    expect(rankAllFields('funder_id', worksFilterPool)[0]).toBe('awards.funder_id');
  });

  it('scores an exact match highest', () => {
    const pool = ['publication_year', 'type', 'is_oa', 'cited_by_count'];
    expect(rankAllFields('publication_year', pool)[0]).toBe('publication_year');
  });

  it('handles a single-character query without throwing', () => {
    expect(() => rankAllFields('x', worksFilterPool)).not.toThrow();
  });
});
