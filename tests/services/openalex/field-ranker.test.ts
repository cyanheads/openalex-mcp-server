/**
 * @fileoverview Unit tests for the field-name ranking helper.
 * @module services/openalex/field-ranker.test
 */

import { describe, expect, it } from 'vitest';
import fieldCatalog from '@/services/openalex/field-catalog.json' with { type: 'json' };
import { rankFields } from '@/services/openalex/field-ranker.js';

const worksFilterPool = (fieldCatalog as Record<string, { filter: string[]; select: string[] }>)
  .works!.filter;

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
});
