/**
 * @fileoverview Tests for openalex_search_entities tool.
 * @module mcp-server/tools/definitions/search-entities.tool.test
 */

import {
  invalidParams,
  JsonRpcErrorCode,
  notFound,
  rateLimited,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createCoreMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/services/openalex/types.js';

const mockSearch = vi.fn<() => Promise<SearchResult>>();

/**
 * Only the service accessor is faked. `normalizeId` stays real, so the id cases can check the
 * path segment the service will actually request rather than restating the tool's own input.
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

const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);

const createMockContext = (options?: Parameters<typeof createCoreMockContext>[0]) =>
  createCoreMockContext({ ...options, errors: searchEntitiesTool.errors });

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

  /**
   * The tool hands `id` to the service verbatim; the service's `normalizeId` is what settles
   * the upstream path segment. Both halves are asserted so the chain a caller depends on —
   * the spelling they typed reaching OpenAlex in the one casing it answers — is pinned here.
   */
  it.each([
    ['an uppercase scheme', 'PMID:21491125', 'pmid:21491125'],
    ['a mixed-case scheme', 'Doi:10.1136/bmj.f5137', 'doi:10.1136/bmj.f5137'],
    ['a PubMed URL', 'https://pubmed.ncbi.nlm.nih.gov/21491125', 'pmid:21491125'],
  ])(
    'forwards %s to the service in a form that resolves upstream (gh #66)',
    async (_label, id, normalized) => {
      mockSearch.mockResolvedValue({
        meta: { count: 1, per_page: 1, next_cursor: null },
        results: [{ id: 'W3147052403', display_name: 'The short QT syndrome' }],
      });
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', id });

      const result = await searchEntitiesTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'works', id }),
        ctx,
      );
      expect(normalizeId(id)).toBe(normalized);
      expect(result.results).toHaveLength(1);
    },
  );

  /**
   * `select` projects top-level fields, so a bibliometric leaf resolves as its parent object.
   * Both client surfaces must carry it — structuredContent and the rendered content[]. (gh #64)
   */
  it('carries an aliased summary_stats object on both output surfaces (gh #64)', async () => {
    const withStats: SearchResult = {
      meta: { count: 1, per_page: 25, next_cursor: null },
      results: [
        {
          id: 'A5022021627',
          display_name: 'Yann LeCun',
          summary_stats: { '2yr_mean_citedness': 13.98, h_index: 121, i10_index: 282 },
        },
      ],
    };
    mockSearch.mockResolvedValue(withStats);
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({
      entity_type: 'authors',
      query: 'Yann LeCun',
      select: ['id', 'display_name', 'h_index'],
    });

    const result = await searchEntitiesTool.handler(input, ctx);

    // The tool forwards the leaf name; the service is what widens it to the parent.
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ select: ['id', 'display_name', 'h_index'] }),
      ctx,
    );
    expect(result.results[0]).toMatchObject({
      summary_stats: { h_index: 121, i10_index: 282, '2yr_mean_citedness': 13.98 },
    });

    const blocks = searchEntitiesTool.format?.(result) ?? [];
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('121');
    expect(text).toContain('282');
    expect(text).toContain('13.98');
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
        .extend(searchEntitiesTool.enrichment!)
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

  describe('id precedence (gh #55)', () => {
    const single: SearchResult = {
      meta: { count: 1, per_page: 1, next_cursor: null },
      results: [{ id: 'W2741809807', display_name: 'The state of OA' }],
    };

    /** Every param `search()`'s `id` branch drops, passed together. */
    const idWithSearchParams = {
      entity_type: 'works',
      id: 'W2741809807',
      query: 'quantum computing',
      search_mode: 'semantic',
      filters: { publication_year: '1900' },
      sort: '-cited_by_count',
      sample: 5,
      seed: 'abc',
    };

    it('echoes only entity_type and id, never the dropped search params', async () => {
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse(idWithSearchParams);

      await searchEntitiesTool.handler(input, ctx);

      const { echo } = getEnrichment(ctx);
      expect(echo).toBe('entity_type=works | id=W2741809807');
      for (const dropped of ['query', 'filters', 'sort', 'sample', 'seed', 'search_mode']) {
        expect(echo, `echo still advertises ${dropped}`).not.toContain(dropped);
      }
    });

    it('notices every dropped param by name, sample and seed included', async () => {
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse(idWithSearchParams);

      await searchEntitiesTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      for (const dropped of ['query', 'search_mode', 'filters', 'sort', 'sample', 'seed']) {
        expect(notice, `${dropped} is dropped but unnamed in the notice`).toContain(dropped);
      }
      expect(notice).toMatch(/not applied/i);
    });

    it('stays silent when an id lookup carries no search params', async () => {
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', id: 'W2741809807' });

      await searchEntitiesTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does not notice pagination params, which carry no caller intent here', async () => {
      // `per_page` always arrives with its schema default, so a caller's intent cannot be
      // told apart from its absence — naming it would be noise on every id lookup.
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        id: 'W2741809807',
        per_page: 50,
        cursor: 'abc',
      });

      await searchEntitiesTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('still accepts the combination rather than rejecting it', async () => {
      // Rejecting id + filters would break callers passing a harmless leftover today.
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        id: 'W2741809807',
        filters: { is_oa: 'true' },
      });

      const result = await searchEntitiesTool.handler(input, ctx);
      expect(result.results).toHaveLength(1);
    });

    it('leaves the echo untouched on a search with no id', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'climate',
        filters: { is_oa: 'true' },
        sort: '-cited_by_count',
      });

      await searchEntitiesTool.handler(input, ctx);

      const { echo } = getEnrichment(ctx);
      expect(echo).toContain('query="climate"');
      expect(echo).toContain('filters={"is_oa":"true"}');
      expect(echo).toContain('sort=-cited_by_count');
    });
  });

  describe('search-only validations skipped on an id lookup (gh #61)', () => {
    const single: SearchResult = {
      meta: { count: 1, per_page: 1, next_cursor: null },
      results: [{ id: 'W2741809807', display_name: 'The state of OA' }],
    };

    it('accepts a semantic per_page over the cap, which the lookup never paginates', async () => {
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        id: 'W2741809807',
        search_mode: 'semantic',
        per_page: 100,
      });

      const result = await searchEntitiesTool.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(mockSearch).toHaveBeenCalled();
      expect(getEnrichment(ctx).notice).toContain('search_mode');
    });

    it('accepts sample alongside cursor, neither of which reaches the lookup', async () => {
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        id: 'W2741809807',
        sample: 5,
        cursor: '*',
      });

      const result = await searchEntitiesTool.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(mockSearch).toHaveBeenCalled();
      expect(getEnrichment(ctx).notice).toContain('sample');
    });

    it('accepts seed without sample, which the lookup never seeds', async () => {
      mockSearch.mockResolvedValue(single);
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        id: 'W2741809807',
        seed: 'abc',
      });

      const result = await searchEntitiesTool.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(mockSearch).toHaveBeenCalled();
      expect(getEnrichment(ctx).notice).toContain('seed');
    });

    it('still validates when id is an empty string, which lists rather than looks up', async () => {
      // `search()` branches on truthiness, so "" takes the list path — the checks must too.
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        id: '',
        seed: 'abc',
      });

      await expect(searchEntitiesTool.handler(input, ctx)).rejects.toMatchObject({
        data: expect.objectContaining({ reason: 'seed_without_sample' }),
      });
      expect(mockSearch).not.toHaveBeenCalled();
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

  /**
   * OpenAlex indexes no PMCIDs, so a PMCID lookup can only 404. The tool still forwards it —
   * a wasted call plus an actionable error beats a local block that would have to be removed
   * by hand the day upstream starts populating the field — and the service's substituted
   * recovery has to reach the caller on both client surfaces.
   */
  describe('PMCID lookups (gh #67)', () => {
    const pmcIds: [label: string, id: string][] = [
      ['a bare PMCID', 'PMC3084216'],
      ['a PMC URL', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/'],
      ['a legacy PMC URL', 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/'],
    ];

    it.each(pmcIds)('forwards %s to the service as pmcid:PMC…', async (_label, id) => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', id });

      await searchEntitiesTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'works', id }),
        ctx,
      );
      expect(normalizeId(id)).toBe('pmcid:PMC3084216');
    });

    it.each(pmcIds)(
      'carries the conversion hint on both client surfaces for %s',
      async (_label, id) => {
        mockSearch.mockRejectedValue(
          notFound('Entity not found at /works/pmcid:PMC3084216', {
            reason: 'entity_not_found',
            path: '/works/pmcid:PMC3084216',
            recovery: { hint: PMCID_NOT_INDEXED_HINT },
          }),
        );

        const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', id });

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
        expect(rendered).toContain('PMID');
        expect(rendered).toContain('https://www.ncbi.nlm.nih.gov/pmc/tools/idconv/');
      },
    );

    it('leaves a non-PMCID 404 on the generic contract recovery', async () => {
      mockSearch.mockRejectedValue(
        notFound('Entity not found at /works/W99999999999', {
          reason: 'entity_not_found',
          path: '/works/W99999999999',
          recovery: {
            hint: 'Verify the ID format or call openalex_resolve_name to find the correct ID.',
          },
        }),
      );

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        id: 'W99999999999',
      });

      const rendered = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(rendered).toContain('Verify the ID format');
      expect(rendered).not.toContain('PMCID');
    });

    it('no longer advertises PMCID as an id that resolves', () => {
      const description = searchEntitiesTool.input.shape.id.description ?? '';
      expect(description).toMatch(/OpenAlex indexes no PMCIDs/i);
      expect(description).toMatch(/PMID or DOI/i);
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
