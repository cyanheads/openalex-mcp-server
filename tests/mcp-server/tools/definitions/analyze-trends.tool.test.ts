/**
 * @fileoverview Tests for openalex_analyze_trends tool.
 * @module mcp-server/tools/definitions/analyze-trends.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeResult } from '@/services/openalex/types.js';

const mockAnalyze = vi.fn<() => Promise<AnalyzeResult>>();

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexService: () => ({ analyze: mockAnalyze }),
}));

const { analyzeTrendsTool } = await import('@/mcp-server/tools/definitions/analyze-trends.tool.js');

describe('analyzeTrendsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleResult: AnalyzeResult = {
    meta: { count: 50000, groups_count: 3, next_cursor: null },
    groups: [
      { key: '2024', key_display_name: '2024', count: 20000 },
      { key: '2023', key_display_name: '2023', count: 18000 },
      { key: '2022', key_display_name: '2022', count: 12000 },
    ],
  };

  it('calls analyze with correct params', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
    });

    const result = await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(
      {
        entityType: 'works',
        groupBy: 'publication_year',
        filters: undefined,
        includeUnknown: false,
        cursor: undefined,
      },
      ctx,
    );
    expect(result.groups).toHaveLength(3);
    expect(result.meta.count).toBe(50000);
  });

  it('passes filters and includeUnknown', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'oa_status',
      filters: { 'primary_topic.field.id': 'F12345' },
      include_unknown: true,
    });

    await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { 'primary_topic.field.id': 'F12345' },
        includeUnknown: true,
      }),
      ctx,
    );
  });

  it('passes cursor for pagination', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
      cursor: 'page2',
    });

    await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'page2' }), ctx);
  });

  it('defaults include_unknown to false', () => {
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
    });
    expect(input.include_unknown).toBe(false);
  });

  describe('format', () => {
    type ToolOutput = AnalyzeResult & { meta: AnalyzeResult['meta'] & { echo: string } };
    const text = (result: ToolOutput) => {
      const blocks = analyzeTrendsTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    const sampleWithEcho: ToolOutput = {
      meta: { ...sampleResult.meta, echo: 'entity_type=works | group_by=publication_year' },
      groups: sampleResult.groups,
    };

    it('formats groups with total count and echo', () => {
      const output = text(sampleWithEcho);
      expect(output).toContain('50000 total entities across 3 groups on this page');
      expect(output).toContain('entity_type=works | group_by=publication_year');
      expect(output).toContain('2024: 20000');
      expect(output).toContain('2023: 18000');
    });

    it('renders every group returned on the page', () => {
      const groups = Array.from({ length: 60 }, (_, index) => ({
        key: `group-${index + 1}`,
        key_display_name: `Group ${index + 1}`,
        count: 60 - index,
      }));
      const output = text({
        meta: {
          count: 600,
          groups_count: groups.length,
          next_cursor: null,
          echo: 'entity_type=works | group_by=type',
        },
        groups,
      });

      expect(output).toContain('Group 1 (group-1): 60');
      expect(output).toContain('Group 60 (group-60): 1');
    });

    it('returns "No groups" for empty results with echo and broadening hint', () => {
      const output = text({
        meta: {
          count: 0,
          groups_count: 0,
          next_cursor: null,
          echo: 'entity_type=works | group_by=type | filters={"x":"y"}',
        },
        groups: [],
      });
      expect(output).toContain('No groups found for entity_type=works | group_by=type');
      expect(output).toContain('count=0');
      expect(output).toContain('groups_count=0');
      expect(output).toContain('Try removing filters');
    });

    it('surfaces next_cursor when present', () => {
      const output = text({
        meta: {
          count: 500,
          groups_count: 200,
          next_cursor: 'nxt-abc',
          echo: 'entity_type=works | group_by=type',
        },
        groups: [{ key: 'k', key_display_name: 'K', count: 1 }],
      });
      expect(output).toContain('nxt-abc');
      expect(output).toContain('200 groups on this page');
    });
  });

  describe('handler echo', () => {
    it('wraps service result with a meta.echo derived from input', async () => {
      mockAnalyze.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'oa_status',
        filters: { 'authorships.institutions.country_code': 'us' },
        include_unknown: true,
      });

      const result = await analyzeTrendsTool.handler(input, ctx);

      expect(result.meta.echo).toContain('entity_type=works');
      expect(result.meta.echo).toContain('group_by=oa_status');
      expect(result.meta.echo).toContain('filters={"authorships.institutions.country_code":"us"}');
      expect(result.meta.echo).toContain('include_unknown=true');
    });
  });
});
