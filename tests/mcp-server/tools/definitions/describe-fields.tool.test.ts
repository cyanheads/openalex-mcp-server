/**
 * @fileoverview Tests for openalex_describe_fields tool.
 * @module mcp-server/tools/definitions/describe-fields.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the service module so tests don't need a live OpenAlex connection.
// The describe-fields tool uses getFieldCatalog() from the service, so we
// forward the real field catalog from the JSON source file.
import fieldCatalog from '@/services/openalex/field-catalog.json' with { type: 'json' };

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getFieldCatalog: () => fieldCatalog,
}));

const { describeFieldsTool } = await import(
  '@/mcp-server/tools/definitions/describe-fields.tool.js'
);

describe('describeFieldsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('catalog lookup', () => {
    it('returns filter fields for works without a query', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.entity_type).toBe('works');
      expect(result.context).toBe('filter');
      expect(result.fields.length).toBeGreaterThan(0);
      expect(result.total).toBe(result.fields.length);
      // works filter pool is large (200+ fields)
      expect(result.total).toBeGreaterThan(100);
    });

    it('returns select fields for works without a query', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'select',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.context).toBe('select');
      expect(result.total).toBeGreaterThan(0);
      // works select pool (~58) is far smaller than the filter pool (206)
      expect(result.total).toBeLessThan(100);
      expect(result.fields).toContain('id');
      expect(result.fields).toContain('display_name');
    });

    it('excludes non-groupable fields from group_by — a strict subset of filter (gh #42)', async () => {
      const ctx = createMockContext();
      const filterInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
      });
      const groupByInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'group_by',
      });

      const filterResult = await describeFieldsTool.handler(filterInput, ctx);
      const groupByResult = await describeFieldsTool.handler(groupByInput, ctx);

      // group_by is a strict subset of filter — the non-groupable fields are pruned.
      expect(groupByResult.total).toBeLessThan(filterResult.total);
      expect(groupByResult.fields.length).toBeLessThan(filterResult.fields.length);
      for (const field of groupByResult.fields) {
        expect(filterResult.fields).toContain(field);
      }

      // Concrete traps removed: raw date fields, *.search operators, from_*/to_* range modifiers.
      for (const excluded of [
        'publication_date',
        'created_date',
        'updated_date',
        'default.search',
        'title.search',
        'abstract.search.exact',
        'from_publication_date',
        'to_publication_date',
        'to_updated_date',
      ]) {
        expect(filterResult.fields).toContain(excluded);
        expect(groupByResult.fields).not.toContain(excluded);
      }

      // Groupable fields kept: year, categorical, and integer-count fields.
      for (const kept of [
        'publication_year',
        'type',
        'oa_status',
        'cited_by_count',
        'awards.funder_id',
      ]) {
        expect(groupByResult.fields).toContain(kept);
      }
    });

    it('surfaces the recovered catalog fields in filter and select (gh #56)', async () => {
      const ctx = createMockContext();
      const sourcesFilter = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'sources', context: 'filter' }),
        ctx,
      );
      const sourcesSelect = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'sources', context: 'select' }),
        ctx,
      );
      const authorsFilter = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'authors', context: 'filter' }),
        ctx,
      );

      expect(sourcesFilter.fields).toContain('is_preprint_repository');
      expect(sourcesFilter.fields).toContain('text.search');
      expect(sourcesSelect.fields).toContain('is_preprint_repository');
      expect(authorsFilter.fields).toContain('last_known_authorships.institutions.lineage');
    });

    it('keeps is_preprint_repository out of group_by, where upstream 500s on it (gh #56)', async () => {
      // Valid as a filter and a select field, but grouping by it answers HTTP 500 — which
      // classifies as ServiceUnavailable and tells the caller to retry, forever.
      const ctx = createMockContext();
      const groupBy = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'sources', context: 'group_by' }),
        ctx,
      );

      expect(groupBy.fields).not.toContain('is_preprint_repository');
      // The sibling booleans still group fine and must stay.
      expect(groupBy.fields).toContain('is_oa');
    });

    it('does not surface publication_date when querying the group_by context (gh #42 repro)', async () => {
      const ctx = createMockContext();
      const groupByInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'group_by',
        query: 'publication_date',
      });
      const filterInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
        query: 'publication_date',
      });

      const groupByResult = await describeFieldsTool.handler(groupByInput, ctx);
      const filterResult = await describeFieldsTool.handler(filterInput, ctx);

      // The repro: publication_date must NOT appear in the group_by view (analyze_trends 400s on it)…
      expect(groupByResult.fields).not.toContain('publication_date');
      // …but publication_year, its groupable sibling, still ranks in.
      expect(groupByResult.fields).toContain('publication_year');
      // filter context legitimately still surfaces publication_date.
      expect(filterResult.fields).toContain('publication_date');
    });

    it('returns funders filter fields', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'funders',
        context: 'filter',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.total).toBeGreaterThan(0);
      expect(result.fields).toContain('display_name');
    });
  });

  describe('query ranking', () => {
    it('ranks awards.funder_id near the top for query "funder" on works/group_by', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'group_by',
        query: 'funder',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields.slice(0, 5)).toContain('awards.funder_id');
      // A query ranks the pool; it does not remove members of it.
      expect(result.fields.length).toBe(result.total);
    });

    /**
     * Was "returns fewer results when query is specific" — the cap it encoded is what hid
     * `summary_stats` from the caller looking for `h_index`. A query now reorders the same
     * pool, so the two calls return the same fields in a different order. (gh #63)
     */
    it('returns the same field set with or without a query — ranking, not filtering', async () => {
      const ctx = createMockContext();
      const allInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
      });
      const queriedInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
        query: 'funder',
      });

      const allResult = await describeFieldsTool.handler(allInput, ctx);
      const queriedResult = await describeFieldsTool.handler(queriedInput, ctx);

      expect(queriedResult.total).toBe(allResult.total);
      expect(queriedResult.fields.length).toBe(allResult.fields.length);
      expect(new Set(queriedResult.fields)).toEqual(new Set(allResult.fields));
      // …but ranked, so the query's best match moved to the front.
      expect(queriedResult.fields[0]).not.toBe(allResult.fields[0]);
    });

    /**
     * The reported repro: `h_index` is real author data living at `summary_stats.h_index`, and
     * asking where it lives returned every authors/select field except the one that holds it.
     */
    it('returns summary_stats for query "h_index" on authors/select (gh #63)', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'authors',
        context: 'select',
        query: 'h_index',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields).toContain('summary_stats');
      expect(result.fields.length).toBe(result.total);
    });

    it('returns id for query "summary_stats" on authors/select (gh #63)', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'authors',
        context: 'select',
        query: 'summary_stats',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields).toContain('id');
      expect(result.fields[0]).toBe('summary_stats');
      expect(result.fields.length).toBe(result.total);
    });

    it('withholds nothing from the 206-field works/filter pool (gh #63)', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
        query: 'funder',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.total).toBeGreaterThan(200);
      expect(result.fields.length).toBe(result.total);
    });

    it('leaves the no-query path unranked and complete', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'authors',
        context: 'select',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields.length).toBe(result.total);
      expect(result.fields).toContain('summary_stats');
    });
  });

  describe('format()', () => {
    it('renders a header with entity_type, context, and total count', () => {
      const content =
        describeFieldsTool.format?.({
          entity_type: 'works',
          context: 'filter',
          fields: ['publication_year', 'type', 'is_oa'],
          total: 206,
        }) ?? [];

      expect(content).toHaveLength(1);
      const text = content[0]?.type === 'text' ? content[0].text : '';
      expect(text).toContain('works');
      expect(text).toContain('filter');
      expect(text).toContain('206');
      expect(text).toContain('publication_year');
    });

    it('renders every ranked field with no truncation note (gh #63)', () => {
      const content =
        describeFieldsTool.format?.({
          entity_type: 'authors',
          context: 'select',
          fields: ['summary_stats', 'id', 'display_name'],
          total: 3,
        }) ?? [];

      const text = content[0]?.type === 'text' ? content[0].text : '';
      expect(text).toContain('summary_stats');
      expect(text).toContain('display_name');
      expect(text).not.toContain('showing top');
    });

    it('renders "No matches." when fields is empty', () => {
      const content =
        describeFieldsTool.format?.({
          entity_type: 'authors',
          context: 'select',
          fields: [],
          total: 21,
        }) ?? [];
      const text = content[0]?.type === 'text' ? content[0].text : '';
      expect(text).toContain('No matches.');
    });
  });
});
