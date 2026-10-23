/**
 * @fileoverview Tests for openalex_get_citation_graph tool.
 * @module mcp-server/tools/definitions/citation-graph.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createCoreMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';
import type { EntityRecord, SearchParams, SearchResult } from '@/services/openalex/types.js';
import {
  contentTextBytes,
  defaultWork,
  slimAuthorship,
  utf8Bytes,
  workWithAuthorships,
} from '../../../helpers/openalex-records.js';

const mockSearch = vi.fn<() => Promise<SearchResult>>();

/**
 * Only the service accessor is faked. `normalizeId` stays real, so the seed cases can check
 * the path segment the seed lookup will actually request.
 */
vi.mock('@/services/openalex/openalex-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/openalex/openalex-service.js')>();
  return {
    ...actual,
    getOpenAlexService: () => ({ search: mockSearch }),
  };
});

const { normalizeId, PMCID_NOT_INDEXED_HINT } = await import(
  '@/services/openalex/openalex-service.js'
);

const { getCitationGraphTool } = await import(
  '@/mcp-server/tools/definitions/citation-graph.tool.js'
);

const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);

const createMockContext = (options?: Parameters<typeof createCoreMockContext>[0]) =>
  createCoreMockContext({ ...options, errors: getCitationGraphTool.errors });

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
  it('clamps an oversized page and joins the empty-result notice on both surfaces', async () => {
    mockSearch
      .mockResolvedValueOnce(lookupResponse('W1'))
      .mockResolvedValueOnce({ meta: { count: 0, per_page: 100, next_cursor: null }, results: [] });
    const result = await runToolContract(getCitationGraphTool, {
      seed_id: 'W1',
      direction: 'cites',
      per_page: 150,
    });
    expect(result.isError).toBeFalsy();
    expect(mockSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ perPage: 100 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining(
        'per_page 150 exceeds the maximum of 100; using per_page 100.',
      ),
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('per_page 150 exceeds the maximum of 100; using per_page 100.');
    expect(text).toContain('No edges');
  });

  beforeEach(() => {
    // Reset, not clear: a test that rejects before the service drops once-values it queued.
    vi.resetAllMocks();
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

  /**
   * The seed lookup runs `seed_id` through the same service path a direct `id` lookup uses,
   * so an uppercase scheme or a PubMed URL used to 404 here and surface as `entity_not_found`.
   */
  it.each([
    ['an uppercase scheme', 'PMID:16344476', 'pmid:16344476'],
    ['a PubMed URL', 'https://pubmed.ncbi.nlm.nih.gov/16344476', 'pmid:16344476'],
  ])('resolves a seed_id carrying %s (gh #66)', async (_label, seedId, normalized) => {
    mockSearch
      .mockResolvedValueOnce(lookupResponse('W2041112550'))
      .mockResolvedValueOnce(sampleResult);
    const ctx = createMockContext();
    const input = getCitationGraphTool.input.parse({ seed_id: seedId, direction: 'cited_by' });

    const result = await getCitationGraphTool.handler(input, ctx);

    expect(mockSearch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ entityType: 'works', id: seedId, select: ['id'] }),
      ctx,
    );
    expect(normalizeId(seedId)).toBe(normalized);
    expect(mockSearch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ filters: { cited_by: 'W2041112550' } }),
      ctx,
    );
    expect(result.results).toHaveLength(3);
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
    const result = await runToolContract(getCitationGraphTool, {
      seed_id: 'W9999999999999',
      direction: 'cites',
    });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'entity_not_found', recovery: expect.anything() },
      },
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
      expect(enrichment.echo).toContain('seed_id="W2741809807"');
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

    it('carries the budget reading the service writes through to structuredContent', () => {
      // A graph walk bills two upstream requests (the seed lookup and the page); the service
      // sums them into one reading. structuredContent is output.extend(enrichment), which
      // silently strips any field the tool did not declare.
      const budget = { costUsd: 0.001, remainingUsd: 0.0685, resetsInSeconds: 5558 };
      const structured = getCitationGraphTool.output
        .extend(getCitationGraphTool.enrichment!)
        .parse({ ...sampleResult, echo: 'seed_id=W2741809807', totalCount: 3, budget });

      expect(structured.budget).toEqual(budget);
      expect(getCitationGraphTool.enrichmentTrailer?.budget?.render?.(budget)).toContain(
        '$0.0685 left today',
      );
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

    /**
     * The guard read the raw key, so `cited_works` passed it, aliased to `cites` in the service,
     * collided with the direction's own value, and lost — the caller's filter vanished instead
     * of being rejected the way a literal `cites` key already was. (gh #70)
     */
    it.each(['cites', 'cited_by', 'related_to'] as const)(
      'rejects cited_works, which aliases onto a reserved key, with direction %s (gh #70)',
      async (direction) => {
        const ctx = createMockContext({ errors: getCitationGraphTool.errors });
        const input = getCitationGraphTool.input.parse({
          seed_id: 'W2741809807',
          direction,
          filters: { cited_works: 'W12345' },
        });

        await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'reserved_filter_key', reservedKey: 'cited_works', direction },
        });
        expect(mockSearch).not.toHaveBeenCalled();
      },
    );

    it('names the upstream key the alias resolves to in the rejection (gh #70)', async () => {
      const ctx = createMockContext({ errors: getCitationGraphTool.errors });
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
        filters: { cited_works: 'W12345' },
      });

      await expect(getCitationGraphTool.handler(input, ctx)).rejects.toMatchObject({
        message: expect.stringContaining('cites'),
      });
    });

    it('leaves an alias that resolves to a non-reserved key alone (gh #70)', async () => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(sampleResult);
      const ctx = createMockContext({ errors: getCitationGraphTool.errors });
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
        filters: { year: '2020' },
      });

      await getCitationGraphTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ filters: { year: '2020', cites: 'W2741809807' } }),
        ctx,
      );
    });

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
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockRejectedValueOnce(
        invalidParams('Must include a search query in order to sort by relevance_score.', {
          reason: 'upstream_sort_requires_search',
        }),
      );

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W2741809807',
        direction: 'cites',
        sort: '-relevance_score',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'upstream_sort_requires_search',
            recovery: { hint: expect.stringMatching(/active search/i) },
          },
        },
      });
    });

    it('carries the neutral other-400 reason and recovery from the service', async () => {
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockRejectedValueOnce(
        invalidParams('Invalid cursor value provided.', {
          reason: 'upstream_invalid_params_other',
        }),
      );

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W2741809807',
        direction: 'cites',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'upstream_invalid_params_other',
            recovery: { hint: expect.stringMatching(/upstream message/i) },
          },
        },
      });
    });

    /**
     * `select` reaches OpenAlex as written, so a misspelled field is a rejected field name too.
     * The real service reads OpenAlex's own 400 body, so the reason the recovery is keyed on is
     * the one a real rejection classifies to.
     */
    it('points a rejected select field at the select field list', async () => {
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        if (url.hostname !== 'api.openalex.org') {
          return Promise.reject(new Error(`unmocked fetch: ${url.href}`));
        }
        if (url.pathname === '/works/W2741809807') {
          return Promise.resolve(
            Response.json({ id: 'https://openalex.org/W2741809807', display_name: 'Seed' }),
          );
        }
        return Promise.resolve(
          Response.json(
            {
              error: 'Invalid query parameters error.',
              message:
                'totally_made_up_field is not a valid select field. Valid fields for select are: id, doi, title, display_name.',
            },
            { status: 400, statusText: 'Bad Request' },
          ),
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockSearch.mockImplementation((...args: unknown[]) =>
        service.search(...(args as [SearchParams, Context])),
      );

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W2741809807',
        direction: 'cites',
        select: ['totally_made_up_field'],
      }).finally(() => vi.unstubAllGlobals());

      const graphUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
      expect(graphUrl.pathname).toBe('/works');
      expect(graphUrl.searchParams.get('select')).toBe('id,display_name,totally_made_up_field');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'upstream_invalid_params',
            recovery: {
              hint: expect.stringContaining('openalex_describe_fields("works", "select")'),
            },
          },
        },
      });
      const entry = getCitationGraphTool.errors?.find(
        (e) => e.reason === 'upstream_invalid_params',
      );
      expect(entry?.when).toMatch(/\bselect\b/);
    });

    it('points an invalid-ID-value 400 at openalex_resolve_name (gh #49)', async () => {
      mockSearch.mockResolvedValueOnce(lookupResponse('W2741809807')).mockRejectedValueOnce(
        invalidParams("'Albert' is not a valid OpenAlex ID.", {
          reason: 'upstream_invalid_id_value',
        }),
      );

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W2741809807',
        direction: 'cites',
        filters: { 'authorships.author.id': 'Albert Einstein' },
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'upstream_invalid_id_value',
            recovery: { hint: expect.stringMatching(/openalex_resolve_name/) },
          },
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

  /**
   * Identifier and URL fields skip provider-text normalization and come back byte-identical to
   * upstream, so the `results` description cannot call every text value decoded. (gh #94)
   */
  it('describes identifier and URL fields as returned exactly as OpenAlex stores them', () => {
    expect(getCitationGraphTool.output.shape.results.description ?? '').toMatch(
      /identifier and URL fields[^.]*exactly as OpenAlex stores them/,
    );
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

  /**
   * The seed lookup is a `/works/{id}` singleton call, so a PMCID seed reaches the same 404 the
   * other two tools do. The service substitutes the conversion recovery for the contract's
   * generic one, and it has to survive onto both client surfaces here too.
   */
  describe('PMCID seeds (gh #67)', () => {
    const pmcSeeds: [label: string, seedId: string][] = [
      ['a bare PMCID', 'PMC3084216'],
      ['a PMC URL', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/'],
      ['a legacy PMC URL', 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/'],
    ];

    it.each(pmcSeeds)('forwards %s to the seed lookup as pmcid:PMC…', async (_label, seedId) => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2041112550'))
        .mockResolvedValueOnce(sampleResult);
      const ctx = createMockContext();
      const input = getCitationGraphTool.input.parse({ seed_id: seedId, direction: 'cited_by' });

      await getCitationGraphTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ entityType: 'works', id: seedId, select: ['id'] }),
        ctx,
      );
      expect(normalizeId(seedId)).toBe('pmcid:PMC3084216');
    });

    it.each(pmcSeeds)(
      'carries the conversion hint on both client surfaces for %s',
      async (_label, seedId) => {
        mockSearch.mockRejectedValue(
          notFound('Entity not found at /works/pmcid:PMC3084216', {
            reason: 'entity_not_found',
            path: '/works/pmcid:PMC3084216',
            recovery: { hint: PMCID_NOT_INDEXED_HINT },
          }),
        );

        const result = await runToolContract(getCitationGraphTool, {
          seed_id: seedId,
          direction: 'cited_by',
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: {
              reason: 'entity_not_found',
              recovery: { hint: expect.stringContaining('OpenAlex indexes no PMCIDs') },
            },
          },
        });
        const rendered = (result.content ?? [])
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n');
        expect(rendered).toContain('OpenAlex indexes no PMCIDs');
        expect(rendered).toContain('https://www.ncbi.nlm.nih.gov/pmc/tools/idconv/');
      },
    );

    it('no longer lists PMCID as a working seed_id form', () => {
      const contractRecovery =
        getCitationGraphTool.errors?.find((entry) => entry.reason === 'entity_not_found')
          ?.recovery ?? '';
      expect(contractRecovery).toMatch(/OpenAlex indexes no PMCIDs/i);
      expect(contractRecovery).not.toMatch(/DOI, PMID, or PMCID/i);

      const description = getCitationGraphTool.input.shape.seed_id.description ?? '';
      expect(description).toMatch(/OpenAlex indexes no PMCIDs/i);
      expect(description).toMatch(/PMID or DOI/i);
    });
  });

  /**
   * These run the real service against a routed `fetch`, so the URL parse, the type check, and
   * the `id` filter rewrite are the ones that ship; only `api.openalex.org` paths a case lists
   * answer. (gh #99)
   */
  describe('OpenAlex URL seeds and cross-type seeds (gh #99)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const seedRecord = { id: 'https://openalex.org/W3002222772', display_name: 'Seed' };
    const edgePage = {
      meta: { count: 1, per_page: 25, next_cursor: null },
      results: [{ id: 'https://openalex.org/W1', display_name: 'An Edge' }],
    };

    /** Route `mockSearch` to the real service; `fetch` answers only the listed paths. */
    async function useRealService(routes: Record<string, unknown>) {
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        const body = url.hostname === 'api.openalex.org' ? routes[url.pathname] : undefined;
        return body === undefined
          ? Promise.reject(new Error(`unmocked fetch: ${url.pathname}`))
          : Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      });
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockSearch.mockImplementation((...args: unknown[]) =>
        service.search(...(args as [SearchParams, Context])),
      );
      return fetchMock;
    }

    const graphFilter = (fetchMock: { mock: { calls: unknown[][] } }) =>
      new URL(String(fetchMock.mock.calls.at(-1)?.[0])).searchParams.get('filter');

    it('walks from a record-page seed URL as its bare work ID', async () => {
      const fetchMock = await useRealService({
        '/works/W3002222772': seedRecord,
        '/works': edgePage,
      });

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'https://openalex.org/works/W3002222772',
        direction: 'cited_by',
      });

      expect(result.isError).toBeFalsy();
      expect(graphFilter(fetchMock)).toBe('cited_by:W3002222772');
      expect(result.structuredContent).toMatchObject({
        results: [{ id: 'https://openalex.org/W1', display_name: 'An Edge' }],
      });
    });

    it('rewrites an id filter of mixed ID spellings to openalex, value unchanged', async () => {
      const fetchMock = await useRealService({
        '/works/W3002222772': seedRecord,
        '/works': edgePage,
      });
      const ids = 'W2741809807|https://api.openalex.org/works/W3002222772';

      await runToolContract(getCitationGraphTool, {
        seed_id: 'W3002222772',
        direction: 'cites',
        filters: { id: ids },
      });

      expect(graphFilter(fetchMock)).toBe(`openalex:${ids},cites:W3002222772`);
    });

    it('fails an author URL seed as id_type_mismatch before any request', async () => {
      const fetchMock = await useRealService({});

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'https://openalex.org/authors/A5023888391',
        direction: 'cited_by',
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'id_type_mismatch',
            recovery: { hint: expect.stringContaining('seed_id') },
          },
        },
      });
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('author ID');
      expect(text).toContain('id_type_mismatch');
    });

    it('fails a seed with a .. segment as id_dot_segment before any request (gh #109)', async () => {
      const fetchMock = await useRealService({});

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: '../authors/A5023888391',
        direction: 'cited_by',
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'id_dot_segment',
            recovery: { hint: expect.stringContaining('relative path segments') },
          },
        },
      });
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('id_dot_segment');
    });

    it('declares id_type_mismatch as a service-thrown ValidationError', () => {
      const entry = getCitationGraphTool.errors?.find((e) => e.reason === 'id_type_mismatch');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });

    it('documents the OpenAlex URL forms seed_id accepts', () => {
      const description = getCitationGraphTool.input.shape.seed_id.description ?? '';
      expect(description).toContain('https://openalex.org/works/W2741809807');
    });

    /**
     * `author_list` is derived in the service the graph page shares with the search tool, so the
     * graph returns it the same way: in place of `authorships`, with a 100-entry list flagged as
     * possibly capped and continued by a slice on `author_list`. (gh #102)
     */
    it('returns author_list in place of authorships on both surfaces (gh #102)', async () => {
      const capped = workWithAuthorships(1, 100, slimAuthorship);
      const fetchMock = await useRealService({
        '/works/W3002222772': seedRecord,
        '/works': {
          meta: { count: 2, per_page: 25, next_cursor: null },
          results: [capped, workWithAuthorships(2, 2, slimAuthorship)],
        },
      });

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W3002222772',
        direction: 'cites',
        select: ['author_list'],
      });

      expect(result.isError).toBeFalsy();
      const graphUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
      expect(graphUrl.searchParams.get('select')).toBe('id,display_name,authorships');
      const structured = result.structuredContent as {
        results: EntityRecord[];
        windows?: { field: string; possibly_capped: boolean; next: unknown }[];
      };
      expect(structured.results.map((r) => Object.keys(r))).toEqual([
        ['id', 'display_name', 'author_list'],
        ['id', 'display_name', 'author_list'],
      ]);
      expect(structured.results[1]?.author_list).toEqual([
        { id: 'https://openalex.org/A9000000', display_name: 'Author 0', orcid: null },
        { id: 'https://openalex.org/A9000001', display_name: 'Author 1', orcid: null },
      ]);
      expect(structured.windows).toEqual([
        expect.objectContaining({
          field: 'author_list',
          possibly_capped: true,
          next: {
            tool: 'openalex_search_entities',
            arguments: {
              entity_type: 'works',
              id: 'W3000000001',
              slice: { field: 'author_list', offset: 100 },
            },
          },
        }),
      ]);
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('**Author List:**');
      expect(text).toContain(
        '- [1] id: https://openalex.org/A9000001, display_name: Author 1, orcid: —',
      );
      expect(text).toContain('**Window:** W3000000001 `author_list`');
      expect(text).not.toContain('Authorships');
      expect(getCitationGraphTool.input.shape.select.description).toContain(
        '`author_list` returns each author',
      );
    });
  });

  /**
   * The filter path is shared by every filter-taking tool; this proves the tool reaches it with
   * the caller's filters and that the graph request carries what the service built, as sent. The
   * value table itself lives in the service suite.
   */
  describe('filters on the wire through the real service (gh #107, #101)', () => {
    it.each(['title.search', 'abstract.search.exact', 'type'])(
      'rejects an unmatched quote on %s before the seed lookup',
      async (key) => {
        const { result, fetchMock } = await run({ [key]: 'graph "neural' });
        expect(result.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'unmatched_quote_in_filter_value',
              recovery: { hint: expect.stringContaining('Pair') },
            },
          },
        });
        expect(textOf(result)).toContain('unmatched_quote_in_filter_value');
        expect(textOf(result)).toContain('Pair');
      },
    );
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const textOf = (result: { content?: { type: string; text?: string }[] }) =>
      (result.content ?? []).map((block) => block.text ?? '').join('\n');

    async function run(filters: Record<string, string>) {
      const routes: Record<string, unknown> = {
        '/works/W3002222772': { id: 'https://openalex.org/W3002222772', display_name: 'Seed' },
        '/works': { meta: { count: 0, per_page: 25, next_cursor: null }, results: [] },
      };
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        const body = url.hostname === 'api.openalex.org' ? routes[url.pathname] : undefined;
        return body === undefined
          ? Promise.reject(new Error(`unmocked fetch: ${url.href}`))
          : Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      });
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockSearch.mockImplementation((...args: unknown[]) =>
        service.search(...(args as [SearchParams, Context])),
      );

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W3002222772',
        direction: 'cites',
        filters,
      });
      const sentFilter = () =>
        new URL(String(fetchMock.mock.calls.at(-1)?.[0])).search
          .slice(1)
          .split('&')
          .find((pair) => pair.startsWith('filter='));
      return { fetchMock, result, sentFilter };
    }

    it('sends a "+" AND as a raw "+"', async () => {
      const { result, sentFilter } = await run({
        'authorships.institutions.country_code': 'DE+US',
      });
      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=authorships.institutions.country_code%3ADE+US%2Ccites%3AW3002222772',
      );
    });

    it('sends a comma in a .search.exact value quoted rather than refusing it (gh #113)', async () => {
      const { result, sentFilter } = await run({ 'title.search.exact': 'cats, dogs' });
      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=title.search.exact%3A%22cats%2C+dogs%22%2Ccites%3AW3002222772',
      );
    });

    it('sends a comma in a raw_affiliation_strings value quoted rather than refusing it (gh #115)', async () => {
      const { result, sentFilter } = await run({
        raw_affiliation_strings: 'University of California, Berkeley',
      });
      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=raw_affiliation_strings%3A%22University+of+California%2C+Berkeley%22%2Ccites%3AW3002222772',
      );
    });

    it('sends a multi-word name on an exact-match key as one quoted phrase (gh #115)', async () => {
      const { result, sentFilter } = await run({
        'awards.funder_display_name': 'National Science Foundation',
      });
      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=awards.funder_display_name%3A%22National+Science+Foundation%22%2Ccites%3AW3002222772',
      );
    });

    it('sends converted country and language values, echoing the caller spelling', async () => {
      const filters = { 'authorships.institutions.country_code': 'DEU+FRA', language: 'English' };
      const { result, sentFilter } = await run(filters);

      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=authorships.institutions.country_code%3ADE+FR%2Clanguage%3Aen%2Ccites%3AW3002222772',
      );
      const { echo } = result.structuredContent as { echo: string };
      expect(echo).toContain(JSON.stringify(filters));
      expect(textOf(result)).toContain(JSON.stringify(filters));
    });

    it('sends an OR of multi-word country and language names as codes', async () => {
      const { result, sentFilter } = await run({
        'authorships.institutions.country_code': 'South Korea|Japan',
        language: 'Scottish Gaelic|English',
      });

      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=authorships.institutions.country_code%3AKR%7CJP%2Clanguage%3Agd%7Cen%2Ccites%3AW3002222772',
      );
    });

    /** Before the seed lookup too: the graph search would refuse the value, so nothing is spent. */
    it('fails a country that cannot be a code as invalid_country_code before any request', async () => {
      const { fetchMock, result } = await run({
        'authorships.institutions.country_code': 'Narnia',
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_country_code',
            recovery: { hint: expect.stringContaining('ISO 3166-1 alpha-2') },
          },
        },
      });
      expect(textOf(result)).toContain('"Narnia" is not a country code');
      expect(textOf(result)).toContain('invalid_country_code');
    });

    it('fails a comma in a filter value before the seed lookup as well', async () => {
      const { fetchMock, result } = await run({ publication_year: '2020,2021' });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'comma_in_filter_value',
            recovery: {
              hint: expect.stringContaining('move a phrase that contains commas into a free-text'),
            },
          },
        },
      });
    });

    it('declares invalid_country_code as a service-thrown ValidationError', () => {
      const entry = getCitationGraphTool.errors?.find((e) => e.reason === 'invalid_country_code');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });

    /** Before the seed lookup too, as the country check is. (gh #107) */
    it('fails a value mixing "|" with an AND "+" before any request (gh #107)', async () => {
      const { fetchMock, result } = await run({
        'authorships.institutions.country_code': 'DE|FR+US',
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'mixed_and_or_in_filter_value',
            recovery: { hint: expect.stringContaining('"institutions.country_code": "US"') },
          },
        },
      });
      expect(textOf(result)).toContain('mixes "|" (OR) with an AND operator');
      expect(textOf(result)).toContain('mixed_and_or_in_filter_value');
    });

    it('declares mixed_and_or_in_filter_value as a service-thrown ValidationError', () => {
      const entry = getCitationGraphTool.errors?.find(
        (e) => e.reason === 'mixed_and_or_in_filter_value',
      );
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });

    /**
     * `direction` owns `cites`/`cited_by`/`related_to`, and the reserved-key guard reads the
     * filters object's keys. A filter whose value is sent as a quoted phrase and carries a double
     * quote of its own would otherwise reach the wire quoted, where OpenAlex ends the phrase at the
     * inner quote and reads the text after it as further clauses — a key the guard never saw. The
     * value is refused before any request, so no such clause reaches OpenAlex.
     */
    it('refuses a quoted-phrase filter value carrying a stray double quote before any request', async () => {
      const { fetchMock, result } = await run({
        'title.search.exact': 'cats", cites:W1, title.search:"dogs',
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'quote_in_filter_value' },
        },
      });
      expect(textOf(result)).toContain('quote_in_filter_value');
    });

    it('declares quote_in_filter_value as a service-thrown ValidationError', () => {
      const entry = getCitationGraphTool.errors?.find((e) => e.reason === 'quote_in_filter_value');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });
  });

  /**
   * A zero-edge page on a cursor continuation is a finished traversal, not a seed with no
   * neighbours — the verify-the-seed advice there points at a walk that already returned
   * every edge it had. (gh #74)
   */
  describe('exhausted pages (gh #74)', () => {
    const renderedText = (blocks: { type: string; text?: string }[] | undefined) =>
      (blocks ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

    /** Terminal cursor page: nonzero edge count, empty results, null cursor. */
    const terminalCursorPage: SearchResult = {
      meta: { count: 3, per_page: 2, next_cursor: null },
      results: [],
    };

    it('replaces the broadening advice on a cursor continuation, on both surfaces', async () => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(terminalCursorPage);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W2741809807',
        direction: 'cites',
        per_page: 2,
        cursor: 'second-page',
      });

      expect(result.isError).toBeFalsy();
      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain('Pagination exhausted');
      expect(notice).not.toContain('No edges for');
      const rendered = renderedText(result.content);
      expect(rendered).toContain('Pagination exhausted');
      expect(rendered).not.toContain('No edges for');
    });

    it('leaves echo, totalCount, and meta.count untouched on the exhausted branch', async () => {
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(terminalCursorPage);
      const ctx = createMockContext();
      const input = getCitationGraphTool.input.parse({
        seed_id: 'W2741809807',
        direction: 'cites',
        per_page: 2,
        cursor: 'second-page',
      });

      const output = await getCitationGraphTool.handler(input, ctx);

      expect(output.meta.count).toBe(3);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(3);
      expect(enrichment.echo).toContain('seed_id="W2741809807"');
    });

    it('keeps the broadening advice on a first call with no cursor', async () => {
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

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('No edges for');
      expect(notice).not.toContain('Pagination exhausted');
    });

    it('describes meta.per_page as the requested page size, not the record count', () => {
      const description = getCitationGraphTool.output.shape.meta.shape.per_page.description ?? '';
      expect(description).toMatch(/request/i);
      expect(description).not.toBe('Records on this page.');
    });
  });

  /**
   * A supplied-but-blank `cursor` used to reach upstream as `cursor=`, which OpenAlex answers
   * with the first page — restarting the walk — while the tool read the parameter's presence as
   * a continuation and reported a seed with no edges as an exhausted traversal. (gh #80)
   */
  describe('blank cursor (gh #80)', () => {
    it('rejects a blank cursor on the error envelope before the seed lookup', async () => {
      // The resolved values are what make `not.toHaveBeenCalled()` load-bearing: without them a
      // forwarded call would still fail, just for a different reason.
      mockSearch
        .mockResolvedValueOnce(lookupResponse('W2741809807'))
        .mockResolvedValueOnce(sampleResult);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W2741809807',
        direction: 'cites',
        per_page: 2,
        cursor: '',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('documents that a blank cursor is rejected rather than read as the first page', () => {
      expect(getCitationGraphTool.input.shape.cursor.description ?? '').toMatch(/empty string/i);
    });

    it('leaves no response queued for a later test', async () => {
      // The rejection above never reaches the service, so both of its queued responses go unused.
      expect(await mockSearch()).toBeUndefined();
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

  /**
   * Characterization: graph pages that already fit the 64,000-byte budget come back exactly as
   * they did before the budget existed — same records, same text, no disclosure fields.
   */
  describe('response budget — pages that fit stay unchanged (gh #72, #73)', () => {
    it('returns a 25-record default page byte-for-byte as rendered today', async () => {
      const page: SearchResult = {
        meta: { count: 500, per_page: 25, next_cursor: 'cursor-2' },
        results: Array.from({ length: 25 }, (_, n) => defaultWork(n)),
      };
      mockSearch.mockResolvedValueOnce(lookupResponse('W1858542512')).mockResolvedValueOnce(page);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W1858542512',
        direction: 'cites',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.results).toEqual(page.results);
      expect(structured.notice).toBeUndefined();
      for (const key of ['omitted', 'windows', 'over_budget']) {
        expect(structured).not.toHaveProperty(key);
      }
      const expected = [
        '**500 edge(s) — 25 per page** — next cursor: `cursor-2`',
        ...page.results.flatMap((record) => renderEntityRecord(record)),
      ].join('\n');
      expect(result.content[0]).toEqual({ type: 'text', text: expected });
      expect(utf8Bytes(JSON.stringify(structured))).toBeLessThan(64_000);
      expect(contentTextBytes(result.content)).toBeLessThan(64_000);
    });

    it('returns a list record with 99 authorships whole and unflagged', async () => {
      const record = workWithAuthorships(1, 99, slimAuthorship);
      mockSearch.mockResolvedValueOnce(lookupResponse('W1858542512')).mockResolvedValueOnce({
        meta: { count: 1, per_page: 25, next_cursor: null },
        results: [record],
      });

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W1858542512',
        direction: 'cites',
        select: ['authorships'],
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.results).toEqual([record]);
      expect(structured.notice).toBeUndefined();
      for (const key of ['omitted', 'windows', 'over_budget']) {
        expect(structured).not.toHaveProperty(key);
      }
    });

    it('keeps the empty-page notice as the only notice on a page with no edges', async () => {
      mockSearch.mockResolvedValueOnce(lookupResponse('W1858542512')).mockResolvedValueOnce({
        meta: { count: 0, per_page: 25, next_cursor: null },
        results: [],
      });

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: 'W1858542512',
        direction: 'related_to',
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.notice).toBe(
        'No edges for seed_id="W1858542512" | direction=related_to. Verify the seed_id with openalex_resolve_name, broaden filters, or try a different direction.',
      );
      expect(result.content[0]).toEqual({ type: 'text', text: '**0 edge(s) — 25 per page**' });
    });
  });

  /**
   * The budget (gh #72) and the 100-authorship cap disclosure (gh #73) on graph pages. Size
   * assertions read the assembled `CallToolResult` from `runToolContract`, enrichment trailer
   * included, and the service fake writes the `budget` enrichment the real service writes.
   */
  describe('response budget (gh #72, #73)', () => {
    const BUDGET = 64_000;
    const SEED = 'W1858542512';
    const SPEND = {
      costUsd: 0.30000000000000004,
      remainingUsd: 12345.678901234567,
      resetsInSeconds: 86399.99999999999,
      prepaidRemainingUsd: 98765.43210987654,
    };
    const bare = (id: string) => id.replace('https://openalex.org/', '');
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');

    type Call = { tool: string; arguments: Record<string, unknown> };
    type Structured = {
      meta: { count: number; per_page: number; next_cursor: string | null };
      results: EntityRecord[];
      notice?: string;
      omitted?: { ids: string[]; next: Call };
      windows?: {
        id: string;
        field: string;
        offset: number;
        shown: number;
        total: number;
        possibly_capped: boolean;
        next: Call | null;
      }[];
      over_budget?: boolean;
    };

    function expectWithinBudget(result: {
      structuredContent?: unknown;
      content: { type: string; text?: string }[];
    }) {
      expect(utf8Bytes(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(BUDGET);
      expect(contentTextBytes(result.content)).toBeLessThanOrEqual(BUDGET);
    }

    /**
     * Fake service: the seed lookup resolves `SEED`, an `openalex` ID filter returns exactly those
     * records in reverse page order (OpenAlex returns an ID set in its own order), and a graph
     * filter returns the first `per_page` records plus a next cursor. Writes the budget
     * enrichment the way the real service does.
     */
    function serve(records: EntityRecord[], nextCursor: string | null = 'cursor-2') {
      mockSearch.mockImplementation(async (...args: unknown[]) => {
        const [params, ctx] = args as [SearchParams, Context];
        ctx.enrich({ budget: SPEND });
        if (params.id) return lookupResponse(SEED);
        const wanted = params.filters?.openalex?.split('|');
        const perPage = params.perPage ?? 25;
        const results = wanted
          ? records.filter((r) => wanted.includes(bare(r.id))).reverse()
          : records.slice(0, perPage);
        return {
          meta: {
            count: records.length,
            per_page: perPage,
            next_cursor: wanted ? null : nextCursor,
          },
          results,
        };
      });
    }

    it('cuts an overflowing graph page to whole records and names every omitted ID', async () => {
      const records = Array.from({ length: 25 }, (_, n) => workWithAuthorships(n, 8));
      serve(records);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: SEED,
        direction: 'cites',
        select: ['authorships'],
      });

      expect(result.isError).toBeFalsy();
      expectWithinBudget(result);
      const structured = result.structuredContent as Structured;
      const kept = structured.results.length;
      expect(kept).toBeGreaterThan(1);
      expect(kept).toBeLessThan(25);
      expect(structured.results).toEqual(records.slice(0, kept));
      expect(structured.meta).toEqual({ count: 25, per_page: 25, next_cursor: 'cursor-2' });
      const omittedIds = records.slice(kept).map((r) => bare(r.id));
      expect(structured.omitted).toEqual({
        ids: omittedIds,
        next: {
          tool: 'openalex_search_entities',
          arguments: {
            entity_type: 'works',
            filters: { openalex: omittedIds.join('|') },
            per_page: omittedIds.length,
            select: ['authorships'],
          },
        },
      });
      expect(structured.windows).toBeUndefined();
      expect(structured.notice).toMatch(/64,000-byte/);
      expect(structured.notice).toContain('openalex_search_entities');
      const text = textOf(result);
      for (const omittedId of omittedIds) expect(text).toContain(omittedId);
      expect(text).toContain(JSON.stringify(structured.omitted?.next.arguments));
    });

    it('returns exactly the omitted records from the continuation it names', async () => {
      // ~12 KB records: the graph page keeps about five, and the continuation is cut again.
      const records = Array.from({ length: 25 }, (_, n) => workWithAuthorships(n, 20));
      serve(records);

      const first = await runToolContract(getCitationGraphTool, {
        seed_id: SEED,
        direction: 'cites',
        select: ['authorships'],
      });
      const firstPage = first.structuredContent as Structured;
      const seen = firstPage.results.map((r) => bare(r.id));
      expect(firstPage.omitted?.next.tool).toBe('openalex_search_entities');

      type SearchArgs = Parameters<typeof runToolContract<typeof searchEntitiesTool>>[1];
      let args = firstPage.omitted?.next.arguments as SearchArgs | undefined;
      let calls = 0;
      while (args && calls < 25) {
        const result = await runToolContract(searchEntitiesTool, args);
        calls++;
        expect(result.isError).toBeFalsy();
        expectWithinBudget(result);
        const page = result.structuredContent as Structured;
        seen.push(...page.results.map((r) => bare(r.id)));
        args = page.omitted?.next.arguments as SearchArgs | undefined;
      }

      // The continuation returns the omitted records as a set, in OpenAlex's order.
      expect(calls).toBeGreaterThan(1);
      expect(seen).toHaveLength(records.length);
      expect(new Set(seen)).toEqual(new Set(records.map((r) => bare(r.id))));
    });

    it('leaves `select` out of the continuation when the graph call set none', async () => {
      const records = Array.from({ length: 25 }, (_, n) => ({
        ...defaultWork(n),
        abstract: 'measurement '.repeat(400),
      }));
      serve(records);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: SEED,
        direction: 'cited_by',
      });

      expectWithinBudget(result);
      const structured = result.structuredContent as Structured;
      expect(structured.omitted?.next.arguments).not.toHaveProperty('select');
      expect(structured.omitted?.next.arguments).toMatchObject({ entity_type: 'works' });
    });

    it('windows an oversized first graph record and omits the rest', async () => {
      const records = [
        workWithAuthorships(1, 2932),
        workWithAuthorships(2, 3),
        workWithAuthorships(3, 3),
      ];
      serve(records);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: SEED,
        direction: 'cites',
        select: ['authorships'],
      });

      expectWithinBudget(result);
      const structured = result.structuredContent as Structured;
      expect(structured.results).toHaveLength(1);
      const window = structured.windows?.[0];
      expect(window).toMatchObject({
        id: bare(records[0]!.id),
        field: 'authorships',
        offset: 0,
        total: 2932,
        possibly_capped: false,
      });
      expect(window?.next).toEqual({
        tool: 'openalex_search_entities',
        arguments: {
          entity_type: 'works',
          id: bare(records[0]!.id),
          slice: { field: 'authorships', offset: window?.shown },
        },
      });
      expect(structured.omitted?.ids).toEqual([bare(records[1]!.id), bare(records[2]!.id)]);
      expect(textOf(result)).toContain(`**Window:** ${bare(records[0]!.id)} \`authorships\``);
    });

    /**
     * A first work whose non-array fields alone exceed the budget runs the page over it; the
     * `notice` description has to name that case, as `openalex_search_entities`' does.
     */
    it('flags a graph page whose first work alone runs over, a case the notice description names', async () => {
      serve([{ ...workWithAuthorships(1, 3), abstract: 'lorem ipsum '.repeat(6000) }], null);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: SEED,
        direction: 'cites',
        select: ['abstract', 'authorships'],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Structured;
      expect(structured.over_budget).toBe(true);
      expect(structured.notice).toMatch(/runs over/);
      const RAN_OVER = /response budget cut [^.]*ran over/;
      expect(getCitationGraphTool.enrichment?.notice.description ?? '').toMatch(RAN_OVER);
      expect(searchEntitiesTool.enrichment?.notice.description ?? '').toMatch(RAN_OVER);
    });

    it('flags a graph record with exactly 100 authorships on both surfaces, not one with 99', async () => {
      const capped = workWithAuthorships(1, 100, slimAuthorship);
      const complete = workWithAuthorships(2, 99, slimAuthorship);
      serve([capped, complete], null);

      const result = await runToolContract(getCitationGraphTool, {
        seed_id: SEED,
        direction: 'cites',
        select: ['authorships'],
      });

      expectWithinBudget(result);
      const structured = result.structuredContent as Structured;
      expect(structured.results).toEqual([capped, complete]);
      expect(structured.omitted).toBeUndefined();
      expect(structured.windows).toEqual([
        {
          id: bare(capped.id),
          field: 'authorships',
          offset: 0,
          shown: 100,
          total: 100,
          possibly_capped: true,
          next: {
            tool: 'openalex_search_entities',
            arguments: {
              entity_type: 'works',
              id: bare(capped.id),
              slice: { field: 'authorships', offset: 100 },
            },
          },
        },
      ]);
      expect(structured.notice).toMatch(/exactly 100 authorships/);
      const text = textOf(result);
      expect(text).toContain(`**Window:** ${bare(capped.id)} \`authorships\``);
      expect(text).toMatch(/possibly capped/);
      expect(text).not.toContain(`**Window:** ${bare(complete.id)}`);
    });
  });
});
