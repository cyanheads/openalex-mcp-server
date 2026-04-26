/**
 * @fileoverview Tests for openalex_search_entities tool.
 * @module mcp-server/tools/definitions/search-entities.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/services/openalex/types.js';

const mockSearch = vi.fn<() => Promise<SearchResult>>();

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexService: () => ({ search: mockSearch }),
}));

const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);

describe('searchEntitiesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleResult: SearchResult = {
    meta: { count: 2, per_page: 25, next_cursor: null },
    results: [
      { id: 'W001', display_name: 'Paper Alpha' },
      { id: 'W002', display_name: 'Paper Beta' },
    ],
  };

  it('searches with query and returns results', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({
      entity_type: 'works',
      query: 'machine learning',
    });

    const result = await searchEntitiesTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'works',
        query: 'machine learning',
        searchMode: 'keyword',
        perPage: 25,
      }),
      ctx,
    );
    expect(result.results).toHaveLength(2);
    expect(result.meta.count).toBe(2);
  });

  it('retrieves a single entity by ID', async () => {
    const single: SearchResult = {
      meta: { count: 1, per_page: 1, next_cursor: null },
      results: [{ id: 'W001', display_name: 'Specific Paper' }],
    };
    mockSearch.mockResolvedValue(single);
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({
      entity_type: 'works',
      id: 'W001',
    });

    const result = await searchEntitiesTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'works', id: 'W001' }),
      ctx,
    );
    expect(result.results).toHaveLength(1);
  });

  it('passes all optional params through', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({
      entity_type: 'authors',
      query: 'smith',
      search_mode: 'semantic',
      filters: { has_orcid: 'true' },
      sort: '-cited_by_count',
      select: ['id', 'display_name'],
      per_page: 10,
      cursor: 'abc123',
    });

    await searchEntitiesTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledWith(
      {
        entityType: 'authors',
        query: 'smith',
        searchMode: 'semantic',
        filters: { has_orcid: 'true' },
        sort: '-cited_by_count',
        select: ['id', 'display_name'],
        perPage: 10,
        cursor: 'abc123',
        id: undefined,
      },
      ctx,
    );
  });

  it('applies default per_page and search_mode', () => {
    const input = searchEntitiesTool.input.parse({
      entity_type: 'works',
      query: 'test',
    });
    expect(input.per_page).toBe(25);
    expect(input.search_mode).toBe('keyword');
  });

  it('rejects per_page > 50 with semantic search before calling upstream', async () => {
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({
      entity_type: 'works',
      query: 'climate',
      search_mode: 'semantic',
      per_page: 100,
    });

    await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringMatching(/at most 50/i),
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('allows per_page ≤ 50 with semantic search', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({
      entity_type: 'works',
      query: 'climate',
      search_mode: 'semantic',
      per_page: 50,
    });

    await searchEntitiesTool.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalled();
  });

  describe('format', () => {
    type ToolOutput = SearchResult & { meta: SearchResult['meta'] & { echo: string } };
    const text = (result: ToolOutput) => {
      const blocks = searchEntitiesTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    const sampleWithEcho: ToolOutput = {
      meta: { ...sampleResult.meta, echo: 'entity_type=works | query="ml"' },
      results: sampleResult.results,
    };

    it('renders a count header and per-result sections', () => {
      const output = text(sampleWithEcho);
      expect(output).toContain('**2 result(s) — 25 per page**');
      expect(output).toContain('### Paper Alpha');
      expect(output).toContain('### Paper Beta');
      expect(output).toContain('**ID:** W001');
      expect(output).toContain('**ID:** W002');
      expect(output).toContain('entity_type=works | query="ml"');
    });

    it('renders scalar fields with humanized labels', () => {
      const output = text({
        meta: { count: 1, per_page: 1, next_cursor: null, echo: 'entity_type=works' },
        results: [
          {
            id: 'W001',
            display_name: 'Paper Alpha',
            publication_year: 2023,
            cited_by_count: 1234,
            is_retracted: false,
          },
        ],
      });
      expect(output).toContain('**Publication Year:** 2023');
      expect(output).toContain('**Cited By Count:** 1234');
      expect(output).toContain('**Is Retracted:** false');
    });

    it('joins arrays of scalars and renders arrays of objects with one item per line', () => {
      const output = text({
        meta: { count: 1, per_page: 1, next_cursor: null, echo: 'entity_type=works' },
        results: [
          {
            id: 'W001',
            display_name: 'Paper Alpha',
            country_codes: ['us', 'gb'],
            authorships: [
              { author: { display_name: 'Alice', orcid: '0000-0001' } },
              { author: { display_name: 'Bob', orcid: null } },
            ],
          },
        ],
      });
      expect(output).toContain('**Country Codes:** us, gb');
      expect(output).toContain(
        '**Authorships:**\n- [0] author.display_name: Alice, author.orcid: 0000-0001',
      );
      expect(output).toContain('- [1] author.display_name: Bob, author.orcid: —');
    });

    it('flattens nested objects to dot-notation key:value pairs', () => {
      const output = text({
        meta: { count: 1, per_page: 1, next_cursor: null, echo: 'entity_type=works' },
        results: [
          {
            id: 'W001',
            display_name: 'Paper Alpha',
            ids: { openalex: 'https://openalex.org/W001', pmid: '12345678' },
            primary_topic: {
              id: 'T1',
              display_name: 'Climate',
              subfield: { id: 'S1', display_name: 'Atm Sci' },
            },
          },
        ],
      });
      expect(output).toContain('**Ids:** openalex: https://openalex.org/W001, pmid: 12345678');
      expect(output).toContain(
        '**Primary Topic:** id: T1, display_name: Climate, subfield.id: S1, subfield.display_name: Atm Sci',
      );
    });

    it('surfaces next_cursor in the header when present', () => {
      const output = text({
        meta: {
          count: 100,
          per_page: 25,
          next_cursor: 'next123',
          echo: 'entity_type=works | query="x"',
        },
        results: [{ id: 'W001', display_name: 'Paper' }],
      });
      expect(output).toContain('next cursor: `next123`');
      expect(output).toContain('entity_type=works | query="x"');
    });

    it('renders empty responses with the echo and a broadening hint', () => {
      const output = text({
        meta: {
          count: 0,
          per_page: 25,
          next_cursor: null,
          echo: 'entity_type=works | query="xyz_no_match"',
        },
        results: [],
      });
      expect(output).toContain('**0 result(s) — 25 per page**');
      expect(output).toContain('No matches for entity_type=works | query="xyz_no_match"');
      expect(output).toContain('Try broadening the query');
    });
  });

  describe('handler echo', () => {
    it('wraps service result with a meta.echo derived from input', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'climate',
        filters: { is_oa: 'true' },
        sort: '-cited_by_count',
        search_mode: 'semantic',
      });

      const result = await searchEntitiesTool.handler(input, ctx);

      expect(result.meta.echo).toContain('entity_type=works');
      expect(result.meta.echo).toContain('query="climate"');
      expect(result.meta.echo).toContain('filters={"is_oa":"true"}');
      expect(result.meta.echo).toContain('sort=-cited_by_count');
      expect(result.meta.echo).toContain('search_mode=semantic');
    });

    it('omits search_mode from echo when keyword (default)', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', query: 'x' });
      const result = await searchEntitiesTool.handler(input, ctx);
      expect(result.meta.echo).not.toContain('search_mode');
    });
  });
});
