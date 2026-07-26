/**
 * @fileoverview Tests for openalex_get_citation_graph tool.
 * @module mcp-server/tools/definitions/citation-graph.tool.test
 */

import { invalidParams, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/services/openalex/types.js';

const mockSearch = vi.fn<() => Promise<SearchResult>>();

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexService: () => ({ search: mockSearch }),
}));

const { getCitationGraphTool } = await import(
  '@/mcp-server/tools/definitions/citation-graph.tool.js'
);

/**
 * Seed-lookup response factory — every handler call now starts with a `/works/{id}`
 * singleton lookup before walking the graph, so each test queues one resolved
 * lookup response per seed before the actual graph search response.
 */
function lookupResponse(workId: string): SearchResult {
  return {
    meta: { count: 1, per_page: 1, next_cursor: null },
    results: [{ id: `https://openalex.org/${workId}`, display_name: '' }],
  };
}

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
    mockSearch
      .mockResolvedValueOnce(lookupResponse('W2741809807'))
      .mockResolvedValueOnce(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W2741809807',
      direction: 'cites',
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenNthCalledWith(
      2,
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
      .mockResolvedValueOnce(lookupResponse('W2741809807'))
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

  it('validates the seed even when seed_id is already a W-ID (gh #20)', async () => {
    mockSearch
      .mockResolvedValueOnce(lookupResponse('W2741809807'))
      .mockResolvedValueOnce(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W2741809807',
      direction: 'cites',
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockSearch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ entityType: 'works', id: 'W2741809807', select: ['id'] }),
      ctx,
    );
  });

  it('propagates NotFound when the seed does not exist (gh #20)', async () => {
    const notFoundError = new McpError(JsonRpcErrorCode.NotFound, 'Entity not found at /works/W9', {
      reason: 'entity_not_found',
    });
    mockSearch.mockRejectedValueOnce(notFoundError);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W9999999999999',
      direction: 'cites',
    });

    await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'entity_not_found' },
    });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('fails with entity_not_found when the seed lookup returns no usable record', async () => {
    mockSearch.mockResolvedValueOnce({
      meta: { count: 0, per_page: 1, next_cursor: null },
      results: [],
    });
    const ctx = createMockContext({ errors: getCitationGraphTool.errors });
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W9999999999999',
      direction: 'cites',
    });

    await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'entity_not_found', recovery: expect.anything() },
    });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('strips the URL prefix when seed_id is a full OpenAlex work URL', async () => {
    mockSearch
      .mockResolvedValueOnce(lookupResponse('W2741809807'))
      .mockResolvedValueOnce(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'https://openalex.org/W2741809807',
      direction: 'cites',
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ filters: { cites: 'W2741809807' } }),
      ctx,
    );
  });

  it('preserves caller filters alongside the direction filter', async () => {
    mockSearch
      .mockResolvedValueOnce(lookupResponse('W2741809807'))
      .mockResolvedValueOnce(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({
      seed_id: 'W2741809807',
      direction: 'related_to',
      filters: { publication_year: '>2020', is_oa: 'true' },
    });

    await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenNthCalledWith(
      2,
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

  describe('enrichment', () => {
    it('populates echo and totalCount on success', async () => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(sampleResult);
      const ctx = createMockContext();
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
      });

      await getCitationGraphTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(3);
      expect(enrichment.echo).toContain('seed_id=W2741809807');
      expect(enrichment.echo).toContain('direction=cites');
      expect(enrichment.notice).toBeUndefined();
    });

    it('sets notice when no edges are returned', async () => {
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockResolvedValueOnce({
        meta: { count: 0, per_page: 25, next_cursor: null },
        results: [],
      });
      const ctx = createMockContext();
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'related_to',
      });

      await getCitationGraphTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(0);
      expect(enrichment.notice).toMatch(/No edges/i);
    });

    it('does not set notice when edges are present', async () => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(sampleResult);
      const ctx = createMockContext();
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
      });

      await getCitationGraphTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  describe('reserved filter keys (gh #21)', () => {
    for (const reservedKey of ['cites', 'cited_by', 'related_to'] as const) {
      it(`rejects ${reservedKey} in filters with ValidationError before hitting upstream`, async () => {
        const ctx = createMockContext({ errors: getCitationGraphTool.errors });
        const input = getCitationGraphTool.input.parse({
          seed_id: 'W2741809807',
          direction: 'cites',
          filters: { [reservedKey]: 'W12345' },
        });

        await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'reserved_filter_key', reservedKey, direction: 'cites' },
        });
        expect(mockSearch).not.toHaveBeenCalled();
      });
    }

    it('still allows non-reserved filter keys alongside direction', async () => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(sampleResult);
      const ctx = createMockContext({ errors: getCitationGraphTool.errors });
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
        filters: { publication_year: '>2020' },
      });

      await expect(getCitationGraphTool.handler(input, ctx)).resolves.toBeDefined();
    });
  });

  describe('upstream 400 recovery (gh #43)', () => {
    it('carries the sort-requires-search reason and recovery from the service', async () => {
      const ctx = createMockContext({ errors: getCitationGraphTool.errors });
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockRejectedValueOnce(
        invalidParams('Must include a search query in order to sort by relevance_score.', {
          reason: 'upstream_sort_requires_search',
          ...ctx.recoveryFor('upstream_sort_requires_search'),
        }),
      );
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
        sort: '-relevance_score',
      });

      await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'upstream_sort_requires_search',
          recovery: { hint: expect.stringMatching(/active search/i) },
        },
      });
    });

    it('carries the neutral other-400 reason and recovery from the service', async () => {
      const ctx = createMockContext({ errors: getCitationGraphTool.errors });
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockRejectedValueOnce(
        invalidParams('Invalid cursor value provided.', {
          reason: 'upstream_invalid_params_other',
          ...ctx.recoveryFor('upstream_invalid_params_other'),
        }),
      );
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
      });

      await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'upstream_invalid_params_other',
          recovery: { hint: expect.stringMatching(/upstream message/i) },
        },
      });
    });

    it('points an invalid-ID-value 400 at openalex_resolve_name (gh #49)', async () => {
      const ctx = createMockContext({ errors: getCitationGraphTool.errors });
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockRejectedValueOnce(
        invalidParams("'Albert' is not a valid OpenAlex ID.", {
          reason: 'upstream_invalid_id_value',
          ...ctx.recoveryFor('upstream_invalid_id_value'),
        }),
      );
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
        filters: { 'authorships.author.id': 'Albert Einstein' },
      });

      await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'upstream_invalid_id_value',
          recovery: { hint: expect.stringMatching(/openalex_resolve_name/) },
        },
      });
    });

    /**
     * The 400 family is thrown through the `invalidParams` factory, so a contract entry
     * declaring `ValidationError` advertises a code the caller never receives.
     */
    it('declares InvalidParams for every reason the 400 family delivers (gh #53)', () => {
      const upstream400Reasons = [
        'comma_in_filter_value',
        'upstream_invalid_params',
        'upstream_invalid_id_value',
        'upstream_sort_requires_search',
        'upstream_invalid_params_other',
      ];
      for (const reason of upstream400Reasons) {
        const entry = getCitationGraphTool.errors?.find((e) => e.reason === reason);
        expect(entry, `${reason} missing from the contract`).toBeDefined();
        expect(entry?.code, `${reason} declares the wrong code`).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
      }
    });

    it('declares the budget entry non-retryable and the throttle entry retryable (gh #54)', () => {
      const budget = getCitationGraphTool.errors?.find(
        (e) => e.reason === 'upstream_budget_exhausted',
      );
      const throttle = getCitationGraphTool.errors?.find((e) => e.reason === 'rate_limited');
      expect(budget?.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(budget?.retryable).toBe(false);
      expect(throttle?.retryable).toBe(true);
    });
  });

  describe('untitled records (gh #51)', () => {
    const untitledPage: SearchResult = {
      meta: { count: 2, per_page: 25, next_cursor: null },
      results: [
        { id: 'W4235673932', display_name: null },
        { id: 'W2741809807', display_name: 'A Titled Paper' },
      ],
    };

    it('accepts a null display_name through output validation, keeping the whole page', async () => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(untitledPage);
      const ctx = createMockContext();
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
      });

      const parsed = getCitationGraphTool.output.parse(
        await getCitationGraphTool.handler(input, ctx),
      );

      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0]).toMatchObject({ id: 'W4235673932', display_name: null });
    });

    it('renders an untitled record under its ID', () => {
      const blocks = getCitationGraphTool.format?.(untitledPage) ?? [];
      const output = (blocks[0] as { type: 'text'; text: string }).text;
      expect(output).toContain('### W4235673932');
      expect(output).toContain('### A Titled Paper');
    });
  });

  describe('multi-key sort (gh #52)', () => {
    it('forwards a comma-separated sort to the service verbatim', async () => {
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockResolvedValueOnce({
        meta: { count: 0, per_page: 25, next_cursor: null },
        results: [],
      });
      const ctx = createMockContext();
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
        sort: '-publication_year,cited_by_count',
      });

      await getCitationGraphTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: '-publication_year,cited_by_count' }),
        ctx,
      );
    });

    it('documents per-key descending prefixes on the sort parameter', () => {
      const description = getCitationGraphTool.input.shape.sort.description ?? '';
      expect(description).toMatch(/comma-separate/i);
      expect(description).toContain('-publication_year,cited_by_count');
    });
  });

  describe('format', () => {
    const text = (result: Awaited<ReturnType<typeof getCitationGraphTool.handler>>): string => {
      const blocks = getCitationGraphTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    it('renders results with id and display_name', () => {
      const output = text({
        meta: { ...sampleResult.meta },
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
        },
        results: sampleResult.results,
      });
      expect(output).toContain('next-page-cursor');
    });

    it('returns count header when results are empty', () => {
      const output = text({
        meta: {
          count: 0,
          per_page: 25,
          next_cursor: null,
        },
        results: [],
      });
      expect(output).toContain('0 edge(s) — 25 per page');
    });
  });
});
