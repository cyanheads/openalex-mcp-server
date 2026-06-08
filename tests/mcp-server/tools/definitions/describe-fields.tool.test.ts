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

    it('resolves group_by context to the filter catalog (same valid set)', async () => {
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

      // group_by context resolves to the same pool as filter
      expect(groupByResult.total).toBe(filterResult.total);
      expect(groupByResult.fields).toEqual(filterResult.fields);
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
