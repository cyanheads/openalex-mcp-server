/**
 * @fileoverview Unit tests for the group_by-target predicate. The describe-fields tool suite
 * covers the per-type group_by views it builds from this; these cases pin each exclusion rule at
 * its own seam, which the service's rejected-group_by suggestions read as well.
 * @module services/openalex/groupable-fields.test
 */

import { describe, expect, it } from 'vitest';
import { isGroupableField } from '@/services/openalex/groupable-fields.js';

describe('isGroupableField', () => {
  it.each([
    ['works', 'publication_year'],
    ['works', 'type'],
    ['works', 'cited_by_count'],
    ['works', 'concepts.id'],
    ['authors', 'last_known_institutions.country_code'],
    ['institutions', 'geo.city'],
    ['awards', 'funder.id'],
  ] as const)('keeps %s %s', (entityType, field) => {
    expect(isGroupableField(entityType, field)).toBe(true);
  });

  it.each([
    ['a .search operator', 'works', 'title.search'],
    ['a .search.exact operator', 'works', 'abstract.search.exact'],
    ['a from_ range modifier', 'works', 'from_publication_date'],
    ['a to_ range modifier', 'works', 'to_publication_date'],
    ['a raw date', 'works', 'publication_date'],
    ['a sweep rejection', 'works', 'fwci'],
    ['a field looked up from a related entity', 'works', 'funders.country_code'],
    ['a concept key on authors', 'authors', 'concepts.id'],
    ['a field upstream 500s on', 'sources', 'is_preprint_repository'],
  ] as const)('drops %s (%s %s)', (_label, entityType, field) => {
    expect(isGroupableField(entityType, field)).toBe(false);
  });
});
