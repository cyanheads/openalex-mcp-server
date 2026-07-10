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

  describe('query filtering', () => {
    it('ranks awards.funder_id near the top for query "funder" on works/filter', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'group_by',
        query: 'funder',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields.length).toBeGreaterThan(0);
      // total is the full pool size, fields is the ranked subset
      expect(result.total).toBeGreaterThan(result.fields.length);
      expect(result.fields.slice(0, 5)).toContain('awards.funder_id');
    });

    it('returns fewer results when query is specific', async () => {
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

      expect(queriedResult.fields.length).toBeLessThan(allResult.fields.length);
      expect(queriedResult.total).toBe(allResult.total);
    });
  });

  describe('format()', () => {
    it('renders a header with entity_type, context, and total count', () => {
      const content = describeFieldsTool.format({
        entity_type: 'works',
        context: 'filter',
        fields: ['publication_year', 'type', 'is_oa'],
        total: 206,
      });

      expect(content).toHaveLength(1);
      const text = content[0]!.text;
      expect(text).toContain('works');
      expect(text).toContain('filter');
      expect(text).toContain('206');
      expect(text).toContain('publication_year');
    });

    it('renders "No matches." when fields is empty', () => {
      const content = describeFieldsTool.format({
        entity_type: 'authors',
        context: 'select',
        fields: [],
        total: 21,
      });
      expect(content[0]!.text).toContain('No matches.');
    });
  });
});
