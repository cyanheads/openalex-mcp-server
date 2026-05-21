/**
 * @fileoverview Tests for openalex_get_citation_graph tool.
 * @module mcp-server/tools/definitions/citation-graph.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/services/openalex/types.js';

const mockSearch = vi.fn<() => Promise<SearchResult>>();

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexService: () => ({ search: mockSearch }),
  normalizeId: (id: string) => {
    if (id.startsWith('10.')) return `doi:${id}`;
    if (id.startsWith('https://doi.org/')) return `doi:${id.replace('https://doi.org/', '')}`;
    return id;
  },
}));

const { getCitationGraphTool } = await import(
  '@/mcp-server/tools/definitions/citation-graph.tool.js'
);

describe('getCitationGraphTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleResult: SearchResult = {
    meta: { count: 3, per_page: 25, next_cursor: null },
    results: [
      {
        id: 'https://openalex.org/W1',
        display_name: 'First citing work',
        publication_year: 2024,
        cited_by_count: 5,
      },
      {
        id: 'https://openalex.org/W2',
        display_name: 'Second citing work',
        publication_year: 2023,
        cited_by_count: 12,
      },
      {
        id: 'https://openalex.org/W3',
        display_name: 'Third citing work',
        publication_year: 2022,
        cited_by_count: 1,
      },
    ],
  };

  it('merges direction into filters and searches works', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W2741809807',
      direction: 'cites',
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'works',
        filters: { cites: 'W2741809807' },
        perPage: 25,
      }),
      ctx,
    );
  });

  it('resolves a DOI seed_id to a W-ID via a singleton lookup before filtering', async () => {
    const ctx = createMockContext();
    mockSearch
      .mockResolvedValueOnce({
        meta: { count: 1, per_page: 1, next_cursor: null },
        results: [{ id: 'https://openalex.org/W2741809807', display_name: '' }],
      })
      .mockResolvedValueOnce(sampleResult);

    const input = getCitationGraphTool.input.parse({
      seed_id: '10.1038/nature12373',
      direction: 'cited_by',
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockSearch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ entityType: 'works', id: '10.1038/nature12373', select: ['id'] }),
      ctx,
    );
    expect(mockSearch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ filters: { cited_by: 'W2741809807' } }),
      ctx,
    );
  });

  it('skips the lookup when seed_id is already a W-ID', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W2741809807',
      direction: 'cites',
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { cites: 'W2741809807' } }),
      ctx,
    );
  });

  it('strips the URL prefix when seed_id is a full OpenAlex work URL', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'https://openalex.org/W2741809807',
      direction: 'cites',
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { cites: 'W2741809807' } }),
      ctx,
    );
  });

  it('preserves caller filters alongside the direction filter', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W2741809807',
      direction: 'related_to',
      filters: { publication_year: '>2020', is_oa: 'true' },
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          publication_year: '>2020',
          is_oa: 'true',
          related_to: 'W2741809807',
        },
      }),
      ctx,
    );
  });

  it('echoes seed_id and direction in result meta', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W2741809807',
      direction: 'cites',
    });

    const result = await getCitationGraphTool.handler(input, ctx);

    expect(result.meta.echo).toContain('seed_id=W2741809807');
    expect(result.meta.echo).toContain('direction=cites');
  });

  describe('format', () => {
    const text = (result: Awaited<ReturnType<typeof getCitationGraphTool.handler>>): string => {
      const blocks = getCitationGraphTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    it('renders results with id and display_name', () => {
      const output = text({
        meta: { ...sampleResult.meta, echo: 'seed_id=W1 | direction=cites' },
        results: sampleResult.results,
      });
      expect(output).toContain('First citing work');
      expect(output).toContain('https://openalex.org/W1');
      expect(output).toContain('3 edge(s) — 25 per page');
    });

    it('surfaces next_cursor when present', () => {
      const output = text({
        meta: {
          count: 100,
          per_page: 25,
          next_cursor: 'next-page-cursor',
          echo: 'seed_id=W1 | direction=cites',
        },
        results: sampleResult.results,
      });
      expect(output).toContain('next-page-cursor');
    });

    it('returns empty-edges message when results are empty', () => {
      const output = text({
        meta: {
          count: 0,
          per_page: 25,
          next_cursor: null,
          echo: 'seed_id=W1 | direction=related_to',
        },
        results: [],
      });
      expect(output).toContain('No edges for seed_id=W1 | direction=related_to');
      expect(output).toContain('openalex_resolve_name');
    });
  });
});
