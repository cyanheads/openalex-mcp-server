/**
 * @fileoverview Tests for openalex_search_entities tool.
 * @module mcp-server/tools/definitions/search-entities.tool.test
 */

import { invalidParams, JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
        sample: undefined,
        seed: undefined,
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
    const ctx = createMockContext({ errors: searchEntitiesTool.errors });
    const input = searchEntitiesTool.input.parse({
      entity_type: 'works',
      query: 'climate',
      search_mode: 'semantic',
      per_page: 100,
    });

    await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringMatching(/at most 50/i),
      data: expect.objectContaining({ reason: 'semantic_per_page_cap' }),
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

  describe('sample and seed (gh #14)', () => {
    it('passes sample and seed through to the service', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        sample: 5,
        seed: 'reproducible',
      });

      await searchEntitiesTool.handler(input, ctx);
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ sample: 5, seed: 'reproducible' }),
        ctx,
      );
    });

    it('rejects sample + cursor with sample_with_cursor before calling upstream', async () => {
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        sample: 5,
        cursor: 'abc',
      });

      await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
        message: expect.stringMatching(/sample.*cursor|one page only/i),
        data: expect.objectContaining({ reason: 'sample_with_cursor' }),
      });
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('rejects seed without sample with seed_without_sample before calling upstream', async () => {
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        seed: 'abc',
      });

      await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
        message: expect.stringMatching(/seed.*sample/i),
        data: expect.objectContaining({ reason: 'seed_without_sample' }),
      });
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('rejects sample > 100 at the schema layer', () => {
      expect(() => searchEntitiesTool.input.parse({ entity_type: 'works', sample: 101 })).toThrow();
    });

    it('rejects sample < 1 at the schema layer', () => {
      expect(() => searchEntitiesTool.input.parse({ entity_type: 'works', sample: 0 })).toThrow();
    });

    it('surfaces sample and seed in the enrichment echo', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        sample: 10,
        seed: 'xyz',
      });

      await searchEntitiesTool.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.echo).toContain('sample=10');
      expect(enrichment.echo).toContain('seed=xyz');
    });
  });

  describe('enrichment', () => {
    it('populates echo and totalCount on success', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'climate',
        filters: { is_oa: 'true' },
        sort: '-cited_by_count',
        search_mode: 'semantic',
      });

      await searchEntitiesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(2);
      expect(enrichment.echo).toContain('entity_type=works');
      expect(enrichment.echo).toContain('query="climate"');
      expect(enrichment.echo).toContain('filters={"is_oa":"true"}');
      expect(enrichment.echo).toContain('sort=-cited_by_count');
      expect(enrichment.echo).toContain('search_mode=semantic');
      expect(enrichment.notice).toBeUndefined();
    });

    it('carries the budget reading the service writes through to structuredContent', () => {
      // The service populates `budget` from the OpenAlex rate-limit headers via ctx.enrich.
      // structuredContent is built as output.extend(enrichment), which silently strips any
      // field the tool did not declare — the declaration is what makes it reach a client.
      const budget = { costUsd: 0.001, remainingUsd: 0.0689, resetsInSeconds: 5554 };
      const structured = searchEntitiesTool.output
        .extend(searchEntitiesTool.enrichment)
        .parse({ ...sampleResult, echo: 'entity_type=works', totalCount: 2, budget });

      expect(structured.budget).toEqual(budget);
      expect(searchEntitiesTool.enrichmentTrailer?.budget?.render?.(budget)).toContain(
        '$0.0689 left today',
      );
    });

    it('omits search_mode from echo when keyword (default)', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', query: 'x' });
      await searchEntitiesTool.handler(input, ctx);
      expect(getEnrichment(ctx).echo).not.toContain('search_mode');
    });

    it('sets notice when results are empty', async () => {
      mockSearch.mockResolvedValue({
        meta: { count: 0, per_page: 25, next_cursor: null },
        results: [],
      });
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'xyzzy_no_match',
      });

      await searchEntitiesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(0);
      expect(enrichment.notice).toMatch(/No matches/i);
      expect(enrichment.notice).toContain('xyzzy_no_match');
    });

    it('does not set notice when results are present', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', query: 'ml' });

      await searchEntitiesTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  describe('upstream 400 recovery (gh #43)', () => {
    it('carries the sort-requires-search reason and recovery from the service', async () => {
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      mockSearch.mockRejectedValue(
        invalidParams('Must include a search query in order to sort by relevance_score.', {
          reason: 'upstream_sort_requires_search',
          ...ctx.recoveryFor('upstream_sort_requires_search'),
        }),
      );
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        sort: '-relevance_score',
      });

      await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'upstream_sort_requires_search',
          recovery: { hint: expect.stringMatching(/active search/i) },
        },
      });
    });

    it('carries the neutral other-400 reason and recovery from the service', async () => {
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      mockSearch.mockRejectedValue(
        invalidParams('Invalid cursor value provided.', {
          reason: 'upstream_invalid_params_other',
          ...ctx.recoveryFor('upstream_invalid_params_other'),
        }),
      );
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', query: 'climate' });

      await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'upstream_invalid_params_other',
          recovery: { hint: expect.stringMatching(/upstream message/i) },
        },
      });
    });

    it('points an invalid-ID-value 400 at openalex_resolve_name (gh #49)', async () => {
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      mockSearch.mockRejectedValue(
        invalidParams("'Albert' is not a valid OpenAlex ID.", {
          reason: 'upstream_invalid_id_value',
          ...ctx.recoveryFor('upstream_invalid_id_value'),
        }),
      );
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        filters: { 'authorships.author.id': 'Albert Einstein' },
      });

      await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
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
        const entry = searchEntitiesTool.errors?.find((e) => e.reason === reason);
        expect(entry, `${reason} missing from the contract`).toBeDefined();
        expect(entry?.code, `${reason} declares the wrong code`).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
      }
    });
  });

  describe('429 budget exhaustion (gh #54)', () => {
    it('carries the budget reason with a non-retryable recovery', async () => {
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      mockSearch.mockRejectedValue(
        rateLimited('Insufficient budget. Resets at midnight.', {
          reason: 'upstream_budget_exhausted',
          retryable: false,
          ...ctx.recoveryFor('upstream_budget_exhausted'),
        }),
      );
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', query: 'climate' });

      await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'upstream_budget_exhausted',
          retryable: false,
          recovery: { hint: expect.stringMatching(/midnight UTC/i) },
        },
      });
    });

    it('declares the budget entry non-retryable and the throttle entry retryable', () => {
      const budget = searchEntitiesTool.errors?.find(
        (e) => e.reason === 'upstream_budget_exhausted',
      );
      const throttle = searchEntitiesTool.errors?.find((e) => e.reason === 'rate_limited');
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
      mockSearch.mockResolvedValue(untitledPage);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        filters: { openalex: 'W4235673932|W2741809807' },
      });

      const parsed = searchEntitiesTool.output.parse(await searchEntitiesTool.handler(input, ctx));

      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0]).toMatchObject({ id: 'W4235673932', display_name: null });
      expect(parsed.results[1]).toMatchObject({ display_name: 'A Titled Paper' });
    });

    it('renders an untitled record under its ID', () => {
      const blocks = searchEntitiesTool.format?.(untitledPage) ?? [];
      const output = (blocks[0] as { type: 'text'; text: string }).text;
      expect(output).toContain('### W4235673932');
      expect(output).toContain('### A Titled Paper');
    });
  });

  describe('multi-key sort (gh #52)', () => {
    it('forwards a comma-separated sort to the service verbatim', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        sort: '-publication_year,cited_by_count',
      });

      await searchEntitiesTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ sort: '-publication_year,cited_by_count' }),
        ctx,
      );
    });

    it('documents per-key descending prefixes on the sort parameter', () => {
      const description = searchEntitiesTool.input.shape.sort.description ?? '';
      expect(description).toMatch(/comma-separate/i);
      expect(description).toContain('-publication_year,cited_by_count');
    });
  });

  describe('format', () => {
    const text = (result: SearchResult) => {
      const blocks = searchEntitiesTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    it('renders a count header and per-result sections', () => {
      const output = text(sampleResult);
      expect(output).toContain('**2 result(s) — 25 per page**');
      expect(output).toContain('### Paper Alpha');
      expect(output).toContain('### Paper Beta');
      expect(output).toContain('**ID:** W001');
      expect(output).toContain('**ID:** W002');
    });

    it('renders scalar fields with humanized labels', () => {
      const output = text({
        meta: { count: 1, per_page: 1, next_cursor: null },
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
        meta: { count: 1, per_page: 1, next_cursor: null },
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
        meta: { count: 1, per_page: 1, next_cursor: null },
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
        },
        results: [{ id: 'W001', display_name: 'Paper' }],
      });
      expect(output).toContain('next cursor: `next123`');
    });

    it('renders empty responses with just the count header', () => {
      const output = text({
        meta: {
          count: 0,
          per_page: 25,
          next_cursor: null,
        },
        results: [],
      });
      expect(output).toContain('**0 result(s) — 25 per page**');
    });
  });
});
