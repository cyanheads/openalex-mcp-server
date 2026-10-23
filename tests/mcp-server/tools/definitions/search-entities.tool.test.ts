/**
 * @fileoverview Tests for openalex_search_entities tool.
 * @module mcp-server/tools/definitions/search-entities.tool.test
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampPageSize } from '@/mcp-server/tools/page-size.js';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';
import type { EntityRecord, SearchParams, SearchResult } from '@/services/openalex/types.js';
import {
  authorship,
  authorships,
  contentTextBytes,
  defaultWork,
  slimAuthorship,
  utf8Bytes,
  workWithAuthorships,
} from '../../../helpers/openalex-records.js';

const mockSearch = vi.fn<() => Promise<SearchResult>>();
const mockConfig = vi.hoisted(() => ({
  apiKey: '',
  baseUrl: 'https://api.openalex.org',
  mailto: '',
  filterStringInput: true,
  clampPerPage: true,
}));
const conversionMetrics = vi.hoisted(() => ({ add: vi.fn() }));
const clampMetrics = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) =>
    name === 'openalex.per_page.clamps' ? clampMetrics : conversionMetrics,
}));

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

/** A keyless server, for the one case that runs the real service (the budget 429). */
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ ...mockConfig }),
}));

const {
  BUDGET_EXHAUSTED_KEYLESS_HINT,
  normalizeId,
  PMCID_NOT_INDEXED_HINT,
  SEMANTIC_UNAVAILABLE_HINT,
} = await import('@/services/openalex/openalex-service.js');

const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);

const createMockContext = (options?: Parameters<typeof createCoreMockContext>[0]) =>
  createCoreMockContext({ ...options, errors: searchEntitiesTool.errors });

describe('searchEntitiesTool', () => {
  it.each([
    ['openalex_search_entities', 100],
    ['openalex_get_citation_graph', 100],
    ['openalex_analyze_trends', 200],
  ] as const)('counts and logs every effective clamp for %s', (tool, maximum) => {
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'info');
    expect(clampPageSize(1000, maximum, tool, ctx)).toEqual({
      applied: maximum,
      notice: `per_page 1000 exceeds the maximum of ${maximum}; using per_page ${maximum}.`,
    });
    expect(clampMetrics.add).toHaveBeenCalledExactlyOnceWith(1, {
      'mcp.tool.name': tool,
      'openalex.per_page.maximum': maximum,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith('Clamped per_page', {
      tool,
      requested: 1000,
      applied: maximum,
    });
    expect(clampPageSize(maximum, maximum, tool, ctx)).toEqual({
      applied: maximum,
      notice: undefined,
    });
    mockConfig.clampPerPage = false;
    expect(clampPageSize(1000, maximum, tool, ctx)).toEqual({ applied: 1000, notice: undefined });
    expect(clampMetrics.add).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('budgets a clamp alongside filter conversion, list cap and window notices', async () => {
    mockSearch.mockResolvedValue({
      meta: { count: 1, per_page: 100, next_cursor: null },
      results: [
        workWithAuthorships(1, 100, (n) => ({
          ...authorship(n),
          raw_affiliation_strings: ['Institute '.repeat(100)],
        })),
      ],
    });
    const result = await runToolContract(searchEntitiesTool, {
      entity_type: 'works',
      filters: 'type:article',
      select: ['authorships'],
      per_page: 150,
    });
    expect(result.isError).toBeFalsy();
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('using per_page 100');
    expect(notice).toContain('Converted native filter string');
    expect(notice).toContain('windowed');
    expect(notice).toContain('exactly 100');
    expect(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain(notice);
    expect(utf8Bytes(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(64_000);
    expect(contentTextBytes(result.content)).toBeLessThanOrEqual(64_000);
  });

  it('logs and counts one actual clamp with only bounded metric attributes', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'info');
    await searchEntitiesTool.handler(
      searchEntitiesTool.input.parse({ entity_type: 'works', per_page: 1_000_000 }),
      ctx,
    );
    expect(clampMetrics.add).toHaveBeenCalledExactlyOnceWith(1, {
      'mcp.tool.name': 'openalex_search_entities',
      'openalex.per_page.maximum': 100,
    });
    expect(log).toHaveBeenCalledWith('Clamped per_page', {
      tool: 'openalex_search_entities',
      requested: 1_000_000,
      applied: 100,
    });
    expect(log.mock.calls.filter(([message]) => message === 'Clamped per_page')).toHaveLength(1);
  });

  it.each([
    { id: 'W1', search_mode: 'semantic' as const, per_page: 150 },
    { sample: 10, per_page: 150 },
    { per_page: 100 },
  ])('does not disclose or count an unused clamp: %j', async (args) => {
    mockSearch.mockResolvedValue(sampleResult);
    const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', ...args });
    expect(result.isError).toBeFalsy();
    expect(clampMetrics.add).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('using per_page');
  });

  it.each([51, 150])(
    'preserves the requested semantic cap at %i on both surfaces',
    async (per_page) => {
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'graph',
        search_mode: 'semantic',
        per_page,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'semantic_per_page_cap',
            recovery: { hint: expect.stringContaining('50') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('semantic_per_page_cap');
      expect(mockSearch).not.toHaveBeenCalled();
      expect(clampMetrics.add).not.toHaveBeenCalled();
    },
  );
  it('clamps an oversized page and joins the empty-result notice on both surfaces', async () => {
    mockSearch.mockResolvedValue({
      meta: { count: 0, per_page: 100, next_cursor: null },
      results: [],
    });
    const result = await runToolContract(searchEntitiesTool, {
      entity_type: 'works',
      per_page: 150,
    });
    expect(result.isError).toBeFalsy();
    expect(mockSearch).toHaveBeenCalledWith(
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
    expect(text).toContain('No matches');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.filterStringInput = true;
    mockConfig.clampPerPage = true;
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

  /**
   * The default works projection now carries `best_oa_location`, so the readable copy of a
   * paper is one call away. It is an upstream passthrough field, so both client surfaces
   * have to carry it — `structuredContent` and the rendered `content[]` alike. (gh #79)
   */
  it('carries best_oa_location on both output surfaces (gh #79)', async () => {
    const withBestOa: SearchResult = {
      meta: { count: 1, per_page: 25, next_cursor: null },
      results: [
        {
          id: 'W001',
          display_name: 'Paper Alpha',
          open_access: { is_oa: true, oa_status: 'green' },
          primary_location: { pdf_url: null },
          best_oa_location: {
            pdf_url: 'https://repo.example.org/alpha.pdf',
            license: 'cc-by',
            version: 'acceptedVersion',
          },
        },
      ],
    };
    mockSearch.mockResolvedValue(withBestOa);
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({ entity_type: 'works', query: 'alpha' });

    const parsed = searchEntitiesTool.output.parse(await searchEntitiesTool.handler(input, ctx));

    expect(parsed.results[0]).toMatchObject({
      best_oa_location: { pdf_url: 'https://repo.example.org/alpha.pdf' },
    });

    const blocks = searchEntitiesTool.format?.(withBestOa) ?? [];
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).toContain('**Best OA Location:**');
    expect(text).toContain('https://repo.example.org/alpha.pdf');
    expect(text).toContain('cc-by');
  });

  it('passes all optional params through on a cursor-paginated search', async () => {
    mockSearch.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = searchEntitiesTool.input.parse({
      entity_type: 'authors',
      query: 'smith',
      search_mode: 'exact',
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
        searchMode: 'exact',
        filters: { has_orcid: 'true' },
        sort: '-cited_by_count',
        select: ['id', 'display_name'],
        perPage: 10,
        cursor: 'abc123',
        page: undefined,
        id: undefined,
        sample: undefined,
        seed: undefined,
      },
      ctx,
    );
  });

  it('passes all optional params through on a page-paginated semantic search', async () => {
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
      page: 3,
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
        cursor: undefined,
        page: 3,
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
      expect(enrichment.echo).toContain('seed="xyz"');
    });
  });

  /**
   * OpenAlex ignores `sample` under `search.semantic` (the ranked page comes back under every
   * seed) and refuses any `sort` alongside `sample`. Both are settled locally, before the round
   * trip; an `id` lookup never applies either parameter and keeps passing them through with the
   * dropped-parameter notice. (gh #83, #85)
   */
  describe('sample conflicts (gh #83, #85)', () => {
    const renderedText = (blocks: { type: string; text?: string }[] | undefined) =>
      (blocks ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

    const single: SearchResult = {
      meta: { count: 1, per_page: 1, next_cursor: null },
      results: [{ id: 'W2741809807', display_name: 'The state of OA' }],
    };

    it.each([
      ['sample alone', { sample: 5 }],
      ['sample with seed', { sample: 5, seed: '1' }],
      ['a sample above the semantic per-page cap', { sample: 60 }],
      ['the largest sample', { sample: 100, seed: 'x' }],
    ] as const)(
      'rejects %s under semantic mode on both surfaces with no upstream call',
      async (_label, extra) => {
        // A resolved value makes `not.toHaveBeenCalled()` load-bearing: a forwarded call would
        // succeed rather than fail for some other reason.
        mockSearch.mockResolvedValue(sampleResult);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          query: 'groundwater recharge',
          search_mode: 'semantic',
          select: ['id'],
          ...extra,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'sample_with_semantic',
              recovery: { hint: expect.stringMatching(/keyword or exact/i) },
            },
          },
        });
        const rendered = renderedText(result.content);
        expect(rendered).toContain('sample_with_semantic');
        expect(rendered).toMatch(/keyword or exact/i);
        expect(rendered).toMatch(/page/);
        expect(mockSearch).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'a keyword query sorted by citations',
        { query: 'groundwater recharge', sort: 'cited_by_count' },
      ],
      ['a relevance sort', { query: 'groundwater recharge', sort: '-relevance_score' }],
      [
        'a filter-only listing sorted by date',
        { filters: { publication_year: '2023' }, sort: 'publication_date' },
      ],
      [
        'an exact query with a multi-key sort',
        { query: 'aquifer', search_mode: 'exact', sort: '-publication_year,cited_by_count' },
      ],
      ['a seeded sample', { query: 'groundwater recharge', seed: '1', sort: '-cited_by_count' }],
    ] as const)(
      'rejects sample with sort — %s — on both surfaces with no upstream call',
      async (_label, extra) => {
        mockSearch.mockResolvedValue(sampleResult);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          sample: 5,
          select: ['id'],
          ...extra,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'sample_with_sort',
              recovery: { hint: expect.stringMatching(/remove `sort` or remove `sample`/i) },
            },
          },
        });
        const rendered = renderedText(result.content);
        expect(rendered).toContain('sample_with_sort');
        expect(rendered).toMatch(/remove `sort` or remove `sample`/i);
        expect(mockSearch).not.toHaveBeenCalled();
      },
    );

    it('keeps page as the reported conflict when semantic sample also pages', async () => {
      mockSearch.mockResolvedValue(sampleResult);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'groundwater',
        search_mode: 'semantic',
        sample: 5,
        page: 2,
      });

      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'sample_with_page' } },
      });
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it.each([
      ['sample and semantic mode', { sample: 5, search_mode: 'semantic', query: 'groundwater' }],
      ['sample and sort', { sample: 5, sort: 'cited_by_count' }],
      [
        'sample, semantic mode, and sort',
        { sample: 60, search_mode: 'semantic', query: 'x', sort: '-cited_by_count', seed: '1' },
      ],
    ] as const)(
      'still resolves an id lookup carrying %s, naming them in the notice',
      async (_label, extra) => {
        mockSearch.mockResolvedValue(single);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: 'W2741809807',
          ...extra,
        });

        expect(result.isError).toBeFalsy();
        expect(mockSearch).toHaveBeenCalledTimes(1);
        const notice = (result.structuredContent as { notice?: string }).notice ?? '';
        expect(notice).toMatch(/not applied/i);
        const rendered = renderedText(result.content);
        for (const name of Object.keys(extra).filter((key) => key !== 'query')) {
          expect(notice, `${name} missing from the notice`).toContain(name);
          expect(rendered, `${name} missing from content[]`).toContain(name);
        }
        expect(rendered).toContain('W2741809807');
      },
    );

    it.each([
      ['keyword', 'keyword'],
      ['exact', 'exact'],
    ] as const)('forwards a %s-mode sample with no sort to the service', async (_l, searchMode) => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'groundwater recharge',
        search_mode: searchMode,
        sample: 5,
        seed: '1',
      });

      await searchEntitiesTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ searchMode, sample: 5, seed: '1', sort: undefined }),
        ctx,
      );
    });

    it('forwards a sort with no sample to the service', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'groundwater recharge',
        sort: 'cited_by_count',
      });

      await searchEntitiesTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'cited_by_count', sample: undefined }),
        ctx,
      );
    });

    it.each(['', '  '])(
      'treats the blank sort %j from a form client as no sort, which the service never sends',
      async (sort) => {
        mockSearch.mockResolvedValue(sampleResult);
        const ctx = createMockContext();
        const input = searchEntitiesTool.input.parse({ entity_type: 'works', sample: 5, sort });

        await expect(searchEntitiesTool.handler(input, ctx)).resolves.toBeDefined();
        expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ sample: 5 }), ctx);
      },
    );

    it('declares both reasons as handler-local ValidationErrors', () => {
      for (const reason of ['sample_with_semantic', 'sample_with_sort']) {
        const entry = searchEntitiesTool.errors?.find((e) => e.reason === reason);
        expect(entry, `${reason} missing from the contract`).toBeDefined();
        expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
        // Unmarked, so `error-contract-unthrown` keeps checking the handler throws them.
        expect(entry).not.toHaveProperty('thrownBy');
      }
    });

    it('documents the conflicts on the sample and sort descriptions', () => {
      const sample = searchEntitiesTool.input.shape.sample.description ?? '';
      const sort = searchEntitiesTool.input.shape.sort.description ?? '';
      expect(sample).toMatch(/semantic/i);
      expect(sample).toMatch(/sort/);
      expect(sort).toMatch(/sample/);
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
      expect(enrichment.echo).toContain('sort="-cited_by_count"');
      expect(enrichment.echo).toContain('search_mode=semantic');
      // Semantic responses always disclose that `meta.count` is a candidate count.
      expect(enrichment.notice).toMatch(/candidate set rather than every match/i);
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

    /**
     * The echo used to advertise two constraints while only one reached upstream. Both are
     * forwarded to the service now, so the echo and the query agree. (gh #70)
     */
    it.each([
      ['alias first', { year: '2020', publication_year: '2024' }],
      ['canonical first', { publication_year: '2024', year: '2020' }],
    ])('echoes both colliding filter constraints and forwards both — %s', async (_l, filters) => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({ entity_type: 'works', filters });

      await searchEntitiesTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ filters }), ctx);
      const { echo } = getEnrichment(ctx);
      expect(echo).toContain('"year":"2020"');
      expect(echo).toContain('"publication_year":"2024"');
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
      expect(echo).toBe('entity_type=works | id="W2741809807"');
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
      expect(echo).toContain('sort="-cited_by_count"');
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

    it('rejects an empty-string id at the schema layer rather than quietly listing (gh #69)', () => {
      // `search()` branches on truthiness, so "" used to take the list path — a supplied-but-
      // blank identifier became an unfiltered sweep of the whole catalog.
      expect(() =>
        searchEntitiesTool.input.parse({ entity_type: 'works', id: '', seed: 'abc' }),
      ).toThrow();
    });
  });

  /**
   * An explicitly blank input is a caller mistake, not a request for everything. Each of these
   * used to be dropped by a truthiness check and answered with the whole unfiltered catalog.
   * (gh #69)
   */
  describe('blank inputs (gh #69)', () => {
    it.each([
      ['id', { entity_type: 'works', id: '', per_page: 1, select: ['id'] }],
      ['query', { entity_type: 'works', query: '', per_page: 1, select: ['id'] }],
    ])('rejects a blank %s before any upstream call', (_label, raw) => {
      expect(() => searchEntitiesTool.input.parse(raw)).toThrow();
    });

    it('rejects semantic search with no query, which never ran a semantic search', async () => {
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        search_mode: 'semantic',
        per_page: 1,
        select: ['id'],
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          data: expect.objectContaining({
            reason: 'semantic_without_query',
            recovery: { hint: expect.stringMatching(/query/i) },
          }),
        },
      });
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('declares semantic_without_query as a ValidationError on the contract', () => {
      const entry = searchEntitiesTool.errors?.find((e) => e.reason === 'semantic_without_query');
      expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
    });

    it.each([
      ['exact', 'exact'],
      ['keyword', 'keyword'],
    ])('leaves %s mode free to run without a query', async (_label, searchMode) => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        search_mode: searchMode,
        filters: { is_oa: 'true' },
      });

      await expect(searchEntitiesTool.handler(input, ctx)).resolves.toBeDefined();
    });

    it('keeps filter-only and bare listing queries working', async () => {
      // Omitting `query` and `id` is a supported discovery path, not the bug.
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext({ errors: searchEntitiesTool.errors });
      const input = searchEntitiesTool.input.parse({ entity_type: 'works' });

      const result = await searchEntitiesTool.handler(input, ctx);

      expect(result.results).toHaveLength(2);
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: undefined, id: undefined }),
        ctx,
      );
    });
  });

  describe('upstream 400 recovery (gh #43)', () => {
    it('carries the sort-requires-search reason and recovery from the service', async () => {
      mockSearch.mockRejectedValue(
        invalidParams('Must include a search query in order to sort by relevance_score.', {
          reason: 'upstream_sort_requires_search',
        }),
      );

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
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
      mockSearch.mockRejectedValue(
        invalidParams('Invalid cursor value provided.', {
          reason: 'upstream_invalid_params_other',
        }),
      );

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'climate',
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

    it('points an invalid-ID-value 400 at openalex_resolve_name (gh #49)', async () => {
      mockSearch.mockRejectedValue(
        invalidParams("'Albert' is not a valid OpenAlex ID.", {
          reason: 'upstream_invalid_id_value',
        }),
      );

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
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
        const entry = searchEntitiesTool.errors?.find((e) => e.reason === reason);
        expect(entry, `${reason} missing from the contract`).toBeDefined();
        expect(entry?.code, `${reason} declares the wrong code`).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
      }
    });
  });

  describe('429 budget exhaustion (gh #54)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Run a search whose service call fails on the budget; return the wire hint and text. */
    async function budgetFailure(): Promise<{ hint: unknown; text: string }> {
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'climate',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'upstream_budget_exhausted', retryable: false },
        },
      });
      const { error } = result.structuredContent as {
        error: { data: { recovery?: { hint?: unknown } } };
      };
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return { hint: error.data.recovery?.hint, text };
    }

    /**
     * A keyed server's throw carries no hint of its own, so the contract's recovery reaches the
     * caller — and it must not tell a caller to set a key the server already sends. (gh #90)
     */
    it('keyed: fills a key-neutral recovery from the contract', async () => {
      mockSearch.mockRejectedValue(
        rateLimited('Insufficient budget. Resets at midnight.', {
          reason: 'upstream_budget_exhausted',
          retryable: false,
        }),
      );
      const { hint, text } = await budgetFailure();
      expect(hint).toMatch(/midnight UTC/);
      expect(hint).not.toMatch(/OPENALEX_API_KEY|openalex\.org\/settings/);
      expect(text).toContain(`Recovery: ${String(hint)}`);
    });

    /**
     * The free-key advice is written by the service on a keyless server, so the search runs on the
     * real service (keyless via the config mock) against a stubbed budget 429 — the case fails if
     * the service stops attaching the hint.
     */
    it('keyless: carries the service hint with the free-key advice on both surfaces (gh #90)', async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              message:
                'Insufficient budget. This request costs $0.001 but you only have $0 remaining. Resets at midnight.',
            }),
            { status: 429, statusText: 'Too Many Requests' },
          ),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockSearch.mockImplementation((...args: unknown[]) =>
        service.search(...(args as [SearchParams, Context])),
      );

      const { hint, text } = await budgetFailure();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(hint).toBe(BUDGET_EXHAUSTED_KEYLESS_HINT);
      expect(hint).toMatch(/midnight UTC/);
      expect(hint).toContain('OPENALEX_API_KEY');
      expect(hint).toContain('https://openalex.org/settings/api');
      expect(text).toContain(`Recovery: ${BUDGET_EXHAUSTED_KEYLESS_HINT}`);
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

  /**
   * A semantic search whose query embedding failed upstream reaches the caller as an outage with
   * the retry-or-keyword hint, through the real service against a stubbed OpenAlex error body —
   * never as a caller error naming the embedding service's host. The classification table lives
   * in the service suite; these cases prove the wiring to both client surfaces. (gh #96)
   */
  describe('semantic embedding failures (gh #96)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    async function failWith(
      status: number,
      error: string,
      message: string,
      searchMode: 'keyword' | 'semantic',
    ) {
      vi.useFakeTimers();
      const fetchMock = vi.fn((input: unknown) =>
        new URL(String(input)).hostname === 'api.openalex.org'
          ? Promise.resolve(new Response(JSON.stringify({ error, message }), { status }))
          : Promise.reject(new Error(`unmocked fetch: ${String(input)}`)),
      );
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockSearch.mockImplementation((...args: unknown[]) =>
        service.search(...(args as [SearchParams, Context])),
      );

      const pending = runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'graph neural networks for molecules',
        search_mode: searchMode,
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      const { error: envelope } = result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: Record<string, unknown> & { recovery?: { hint?: string } };
        };
      };
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return { envelope, text, attempts: fetchMock.mock.calls.length };
    }

    it.each([
      [
        'an embedding-service 429',
        'Failed to embed query: 429 Client Error: Too Many Requests for url: https://embed.example.com/ai-gateway/mlflow/v1/embeddings',
      ],
      [
        'an embedding-service connection failure',
        "Failed to embed query: HTTPSConnectionPool(host='embed.example.com', port=443): Max retries exceeded with url: /ai-gateway/mlflow/v1/embeddings (Caused by NewConnectionError('…'))",
      ],
    ])('reports %s as upstream_unavailable with the semantic hint', async (_label, message) => {
      const { envelope, text, attempts } = await failWith(
        400,
        'Invalid query parameters error.',
        message,
        'semantic',
      );

      expect(envelope).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_unavailable',
          recovery: { hint: SEMANTIC_UNAVAILABLE_HINT },
          upstreamMessage: message,
          responseBody: JSON.stringify({ error: 'Invalid query parameters error.', message }),
        },
      });
      expect(envelope.message).not.toContain('embed.example.com');
      expect(text).not.toContain('embed.example.com');
      expect(text).toContain(`Recovery: ${SEMANTIC_UNAVAILABLE_HINT}`);
      expect(text).toContain('(reason upstream_unavailable');
      expect(attempts).toBe(3);
    });

    it('adds the semantic hint to a semantic search that OpenAlex answers 503', async () => {
      const { envelope, text } = await failWith(
        503,
        'Semantic search is busy',
        'Semantic search is busy (the query embedding timed out). Please retry in a minute.',
        'semantic',
      );

      expect(envelope).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', recovery: { hint: SEMANTIC_UNAVAILABLE_HINT } },
      });
      expect(text).toContain(`Recovery: ${SEMANTIC_UNAVAILABLE_HINT}`);
    });

    it('keeps the contract recovery on a keyword search that OpenAlex answers 503', async () => {
      const { envelope, text, attempts } = await failWith(
        503,
        'Service Unavailable',
        'Service Unavailable',
        'keyword',
      );
      const recovery = searchEntitiesTool.errors?.find(
        (e) => e.reason === 'upstream_unavailable',
      )?.recovery;
      if (!recovery) throw new Error('upstream_unavailable declares no recovery');

      expect(envelope).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', recovery: { hint: recovery } },
      });
      expect(text).toContain(`Recovery: ${recovery}`);
      expect(text).not.toContain(SEMANTIC_UNAVAILABLE_HINT);
      expect(attempts).toBe(3);
    });

    it('says which id lookups OpenAlex bills in the costUsd description', () => {
      const costUsd =
        searchEntitiesTool.enrichment?.budget?.unwrap().shape.costUsd.description ?? '';
      expect(costUsd).not.toMatch(/^USD this call spent\. 0 for an `id` lookup —/);
      expect(costUsd).toMatch(/keyword looked up by its slug/);
      expect(costUsd).toContain('W2741809807#x');
    });

    it('names the failed semantic embedding where upstream_unavailable applies', () => {
      const entry = searchEntitiesTool.errors?.find((e) => e.reason === 'upstream_unavailable');
      expect(entry?.when).toContain('Failed to embed query:');
      expect(entry?.when).toMatch(/semantic/);
    });
  });

  /**
   * Identifier and URL fields skip provider-text normalization and come back byte-identical to
   * upstream, so the `results` description cannot call every text value decoded. (gh #94)
   */
  it('describes identifier and URL fields as returned exactly as OpenAlex stores them', () => {
    expect(searchEntitiesTool.output.shape.results.description ?? '').toMatch(
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

  it('documents the keyword slug and URL forms on the id parameter (gh #68)', () => {
    const description = searchEntitiesTool.input.shape.id.description ?? '';
    expect(description).toMatch(/keywords?/i);
    expect(description).toContain('https://openalex.org/keywords/groundwater');
  });

  /**
   * These run the real service against a routed `fetch`, so the URL parse, the type check, and
   * the funder-DOI lookup are the ones that ship; only `api.openalex.org` paths a case lists
   * answer. (gh #98, #99)
   */
  describe('id lookups through the real service (gh #98, #99)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

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

    const contentText = (result: { content?: { type: string; text?: string }[] }) =>
      (result.content ?? []).map((block) => block.text ?? '').join('\n');

    it('fetches a record-page URL as the bare ID on both surfaces', async () => {
      const fetchMock = await useRealService({
        '/works/W2741809807': { id: 'https://openalex.org/W2741809807', display_name: 'A Work' },
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        id: 'https://openalex.org/works/W2741809807',
      });

      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toMatchObject({
        results: [{ id: 'https://openalex.org/W2741809807', display_name: 'A Work' }],
      });
      expect(contentText(result)).toContain('A Work');
    });

    it.each([
      ['authors', 'W2741809807', 'work', 'works'],
      ['works', 'https://openalex.org/authors/A5023888391', 'author', 'authors'],
    ])(
      'fails entity_type %s with %s as id_type_mismatch before any request',
      async (entityType, id, noun, ownType) => {
        const fetchMock = await useRealService({});

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: entityType as 'works',
          id,
        });

        expect(result.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'id_type_mismatch',
              recovery: { hint: expect.stringContaining('letter') },
            },
          },
        });
        const text = contentText(result);
        expect(text).toContain(`${noun} ID`);
        expect(text).toContain(`entity_type "${ownType}"`);
        expect(text).toContain('id_type_mismatch');
      },
    );

    it('fails a concept ID under topics as id_type_mismatch, steering to topics by name', async () => {
      const fetchMock = await useRealService({});

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'topics',
        id: 'C71924100',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'id_type_mismatch' } },
      });
      const text = contentText(result);
      expect(text).toContain('concept ID');
      expect(text).toContain('openalex_resolve_name');
    });

    it('declares id_type_mismatch as a service-thrown ValidationError', () => {
      const entry = searchEntitiesTool.errors?.find((e) => e.reason === 'id_type_mismatch');
      expect(entry).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        thrownBy: 'service',
      });
    });

    it('documents the URL spellings an id accepts', () => {
      const description = searchEntitiesTool.input.shape.id.description ?? '';
      expect(description).toContain('https://openalex.org/works/W2741809807');
      expect(description).toMatch(/api\.openalex\.org/);
    });

    const nsfFunder = {
      id: 'https://openalex.org/F4320306076',
      display_name: 'National Science Foundation',
    };

    it.each(['10.13039/100000001', 'doi:10.13039/100000001', 'https://doi.org/10.13039/100000001'])(
      'returns the funder a Funder Registry DOI %s names, on both surfaces (gh #98)',
      async (id) => {
        const fetchMock = await useRealService({
          '/funders': { meta: { count: 1, per_page: 1, next_cursor: null }, results: [nsfFunder] },
        });

        const result = await runToolContract(searchEntitiesTool, { entity_type: 'funders', id });

        expect(result.isError).toBeFalsy();
        const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(url.searchParams.get('filter')).toBe('ids.doi:10.13039/100000001');
        expect(result.structuredContent).toMatchObject({ results: [nsfFunder] });
        expect(contentText(result)).toContain('National Science Foundation');
      },
    );

    it('fails a DOI no funder carries as entity_not_found (gh #98)', async () => {
      const fetchMock = await useRealService({
        '/funders': { meta: { count: 0, per_page: 1, next_cursor: null }, results: [] },
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'funders',
        id: '10.1038/nature12373',
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.pathname).toBe('/funders');
      expect(url.searchParams.get('filter')).toBe('ids.doi:10.1038/nature12373');
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'entity_not_found' } },
      });
      const text = contentText(result);
      expect(text).toContain('No funder in OpenAlex carries the DOI 10.1038/nature12373.');
      expect(text).toContain('(reason entity_not_found');
    });

    it.each(['../authors/A5023888391', '../works?search=graphene'])(
      'fails id %j as id_dot_segment before any request, on both surfaces (gh #109)',
      async (id) => {
        const fetchMock = await useRealService({});

        const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', id });

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
        expect(contentText(result)).toContain('id_dot_segment');
        expect(contentText(result)).toContain('relative path segments');
      },
    );

    it('fetches a DOI ending in # as the record it names, on both surfaces (gh #109)', async () => {
      const fetchMock = await useRealService({
        '/works/doi:10.1002/(sici)1097-461x(1997)64:6%3C735::aid-qua10%3E3.0.co;2-%23': {
          id: 'https://openalex.org/W1538625961',
          display_name: 'The quantum theory of radiation',
        },
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        id: '10.1002/(sici)1097-461x(1997)64:6<735::aid-qua10>3.0.co;2-#',
      });

      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toMatchObject({
        results: [{ id: 'https://openalex.org/W1538625961' }],
      });
      expect(contentText(result)).toContain('The quantum theory of radiation');
    });

    it('declares id_dot_segment as a service-thrown ValidationError (gh #109)', () => {
      const entry = searchEntitiesTool.errors?.find((e) => e.reason === 'id_dot_segment');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });

    it('prices a funder looked up by DOI as the billed exception to free id lookups (gh #98)', () => {
      const costUsd =
        searchEntitiesTool.enrichment?.budget.unwrap().shape.costUsd.description ?? '';
      expect(costUsd).toMatch(/funder/);
      expect(costUsd).toMatch(/DOI/);
      expect(searchEntitiesTool.input.shape.id.description ?? '').toMatch(/10\.13039/);
    });
  });

  /**
   * The filter path is shared by every filter-taking tool; this proves the tool reaches it with
   * the caller's filters and that the request carries what the service built, as sent. The
   * value table itself lives in the service suite.
   */
  describe('filters on the wire through the real service (gh #107, #101)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const contentText = (result: { content?: { type: string; text?: string }[] }) =>
      (result.content ?? []).map((block) => block.text ?? '').join('\n');

    async function run(filters: Record<string, unknown> | string) {
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        return url.hostname === 'api.openalex.org' && url.pathname === '/works'
          ? Promise.resolve(
              new Response(JSON.stringify({ meta: { count: 0, per_page: 25 }, results: [] })),
            )
          : Promise.reject(new Error(`unmocked fetch: ${url.href}`));
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

      const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', filters });
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
      expect(sentFilter()).toBe('filter=authorships.institutions.country_code%3ADE+US');
    });

    it.each([
      ['title.search', '"graph neural" networks'],
      ['title.search.exact', '"graph neural" networks'],
      ['type', '"article"'],
      ['geo.city', '!"New York"'],
    ])('preserves balanced quotation for %s', async (key, value) => {
      const { result, fetchMock } = await run({ [key]: value });
      expect(result.isError).toBeFalsy();
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('filter')).toBe(
        `${key}:${value}`,
      );
    });

    it('converts a native filter string before the service', async () => {
      const { result, fetchMock } = await run('issn:0920-8542');
      expect(result.isError).toBeFalsy();
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('filter')).toBe(
        'issn:0920-8542',
      );
    });

    it.each([
      ['title.search', 'graph "neural'],
      ['abstract.search.exact', 'graph "neural'],
      ['type', 'ar"ticle'],
    ])('rejects unmatched quotation in %s before a request', async (key, value) => {
      const { result, fetchMock } = await run({ [key]: value });
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
      expect(contentText(result)).toContain('unmatched_quote_in_filter_value');
      expect(contentText(result)).toContain('Pair');
    });

    it('converts native string filters and joins the empty-result notice', async () => {
      const { result, fetchMock } = await run(
        'doi:https://doi.org/10.1136/bmj.n160,title.search:"graph, neural"',
      );
      expect(result.isError).toBeFalsy();
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('filter')).toBe(
        'doi:https://doi.org/10.1136/bmj.n160,title.search:"graph, neural"',
      );
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('Converted native filter string'),
      });
      expect(contentText(result)).toContain('Converted native filter string');
      expect(contentText(result)).toContain('No matches');
    });

    it.each([
      ['title.search:graph,title.search:review', 'duplicate_filter_string_key'],
      ['title.search:graph, rag', 'invalid_filter_string'],
      ['title.search:graph "neural', 'invalid_filter_string'],
      ['', 'invalid_filter_string'],
      [':value', 'invalid_filter_string'],
      ['type:article,', 'invalid_filter_string'],
    ])('rejects ambiguous native filters %j without a request', async (filters, reason) => {
      const { result, fetchMock } = await run(filters);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: expect.stringContaining('record object') } },
        },
      });
      expect(contentText(result)).toContain(reason);
      expect(contentText(result)).toContain('record object');
    });

    it('restores record-only validation when conversion is disabled', async () => {
      mockConfig.filterStringInput = false;
      const rejected = await run('issn:0920-8542');
      expect(rejected.result.isError).toBe(true);
      expect(rejected.fetchMock).not.toHaveBeenCalled();
      const accepted = await run({ issn: '0920-8542' });
      expect(accepted.result.isError).toBeFalsy();
      expect(contentText(accepted.result)).not.toContain('Converted');
    });

    it.each([true, false])(
      'retains framework representation repairs with conversion=%s',
      async (enabled) => {
        mockConfig.filterStringInput = enabled;
        for (const filters of [
          { publication_year: 2020 },
          '{"publication_year":"2020"}',
          '  {"publication_year":"2020"}',
        ]) {
          const { result, fetchMock } = await run(filters);
          expect(result.isError).toBeFalsy();
          expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('filter')).toBe(
            'publication_year:2020',
          );
          expect(contentText(result)).not.toContain('Converted native');
        }
        // The published framework repairs one representation layer, not JSON plus its values.
        const nestedRepair = await run('  {"publication_year":2020}');
        expect(nestedRepair.result.isError).toBe(true);
        expect(nestedRepair.fetchMock).not.toHaveBeenCalled();
      },
    );

    it('does not admit a caller-supplied normalization wrapper or leak wrapper paths', async () => {
      const forged = await run({ value: { type: 'article' }, converted: true });
      expect(forged.result.isError).toBe(true);
      expect(forged.fetchMock).not.toHaveBeenCalled();
      const invalid = await run({ publication_year: { nested: true } });
      expect(invalid.result.isError).toBe(true);
      expect(contentText(invalid.result)).toContain('filters.publication_year');
      expect(contentText(invalid.result)).not.toContain('filters.value.publication_year');
    });

    it('preserves record value bytes and distinct aliases that AND upstream', async () => {
      const { result, fetchMock } = await run(
        'year:2020,publication_year:2024,title.search: graph  neural ',
      );
      expect(result.isError).toBeFalsy();
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('filter')).toBe(
        'publication_year:2020,publication_year:2024,title.search: graph  neural ',
      );
    });

    it('advertises the canonical record schema in both JSON Schema modes', () => {
      const canonical = z.record(z.string(), z.string()).optional();
      for (const io of ['input', 'output'] as const) {
        const schema = z.toJSONSchema(searchEntitiesTool.input, { io });
        const expected = z.toJSONSchema(canonical, { io });
        const field = schema.properties?.filters;
        expect(field).toEqual(
          expect.objectContaining({
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: { type: 'string' },
          }),
        );
        const { description: _description, ...actual } = field as Record<string, unknown>;
        const { $schema: _schema, ...projection } = expected;
        expect(actual).toEqual(projection);
        expect(schema.required).not.toContain('filters');
      }
    });

    it('keeps conversion provenance isolated across concurrent canonical and alias calls', async () => {
      mockSearch.mockResolvedValue({
        meta: { count: 0, per_page: 25, next_cursor: null },
        results: [],
      });
      const aliasArgs = { entity_type: 'works' as const, filter: 'type:article' };
      const results = await Promise.all([
        runToolContract(searchEntitiesTool, aliasArgs),
        runToolContract(searchEntitiesTool, { entity_type: 'works', filters: { type: 'article' } }),
        runToolContract(searchEntitiesTool, { entity_type: 'works', filters: 'type:article' }),
      ]);
      for (const [index, result] of results.entries()) {
        expect(result.isError).toBeFalsy();
        expect(contentText(result).includes('Converted native filter string')).toBe(index !== 1);
        expect(
          String((result.structuredContent as { notice?: string })?.notice).includes(
            'Converted native filter string',
          ),
        ).toBe(index !== 1);
      }
      const conflictArgs = {
        entity_type: 'works' as const,
        filter: 'type:article',
        filters: { type: 'book' },
      };
      const conflict = await runToolContract(searchEntitiesTool, conflictArgs);
      expect(conflict.isError).toBe(true);
    });

    it('logs successful conversion and counts it without caller values in attributes', async () => {
      mockSearch.mockResolvedValue({
        meta: { count: 1, per_page: 25, next_cursor: null },
        results: [{ id: 'W1', display_name: null }],
      });
      const ctx = createMockContext();
      const log = vi.spyOn(ctx.log, 'info');
      await searchEntitiesTool.handler(
        searchEntitiesTool.input.parse({ entity_type: 'works', filters: 'type:article' }),
        ctx,
      );
      expect(log).toHaveBeenCalledWith('Converted native filter string', {
        tool: 'openalex_search_entities',
      });
      expect(conversionMetrics.add).toHaveBeenCalledExactlyOnceWith(1, {
        'mcp.tool.name': 'openalex_search_entities',
      });
    });

    it.each([
      ['pagination', { cursor: 'past-end' }, [], 'Pagination exhausted'],
      [
        'possibly capped array',
        {},
        [{ id: 'W1', display_name: null, authorships: authorships(100) }],
        'author list may be longer',
      ],
      [
        'slice past end',
        { id: 'W1', slice: { field: 'referenced_works', offset: 3 } },
        [{ id: 'W1', display_name: null, referenced_works: ['W2'] }],
        'past the end',
      ],
    ])(
      'joins conversion with %s and accounting on both surfaces',
      async (_label, extra, records, existingNotice) => {
        mockSearch.mockImplementation(async (...args: unknown[]) => {
          const [, ctx] = args as [SearchParams, Context];
          ctx.enrich({ budget: { costUsd: 0.001, remainingUsd: 0.999, resetsInSeconds: 10 } });
          return {
            meta: { count: records.length, per_page: 25, next_cursor: null },
            results: records,
          };
        });
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          filters: 'type:article',
          ...extra,
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          notice: expect.stringContaining('Converted native filter string'),
          budget: { costUsd: 0.001, remainingUsd: 0.999 },
        });
        expect(String((result.structuredContent as { notice?: string })?.notice)).toContain(
          existingNotice,
        );
        expect(contentText(result)).toContain(existingNotice);
        expect(contentText(result)).toContain('Converted native filter string');
        expect(contentText(result)).toContain('0.001');
      },
    );

    it('sends a comma in a .search.exact value quoted rather than refusing it (gh #113)', async () => {
      const { result, sentFilter } = await run({ 'title.search.exact': 'cats, dogs' });
      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe('filter=title.search.exact%3A%22cats%2C+dogs%22');
    });

    it('sends a comma in a raw_affiliation_strings value quoted rather than refusing it (gh #115)', async () => {
      const { result, sentFilter } = await run({
        raw_affiliation_strings: 'University of California, Berkeley',
      });
      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=raw_affiliation_strings%3A%22University+of+California%2C+Berkeley%22',
      );
    });

    it('sends a multi-word name on an exact-match key as one quoted phrase (gh #115)', async () => {
      const { result, sentFilter } = await run({
        'awards.funder_display_name': 'National Science Foundation',
      });
      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=awards.funder_display_name%3A%22National+Science+Foundation%22',
      );
    });

    it('sends converted country and language values, echoing the caller spelling', async () => {
      const filters = { 'authorships.institutions.country_code': 'DEU+FRA', language: 'English' };
      const { result, sentFilter } = await run(filters);

      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=authorships.institutions.country_code%3ADE+FR%2Clanguage%3Aen',
      );
      const { echo } = result.structuredContent as { echo: string };
      expect(echo).toContain(JSON.stringify(filters));
      expect(contentText(result)).toContain(JSON.stringify(filters));
    });

    it('sends an OR of multi-word country and language names as codes', async () => {
      const { result, sentFilter } = await run({
        'authorships.institutions.country_code': 'South Korea|Japan',
        language: 'Scottish Gaelic|English',
      });

      expect(result.isError).toBeFalsy();
      expect(sentFilter()).toBe(
        'filter=authorships.institutions.country_code%3AKR%7CJP%2Clanguage%3Agd%7Cen',
      );
    });

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
      expect(contentText(result)).toContain('"Narnia" is not a country code');
      expect(contentText(result)).toContain('invalid_country_code');
    });

    it('declares invalid_country_code as a service-thrown ValidationError', () => {
      const entry = searchEntitiesTool.errors?.find((e) => e.reason === 'invalid_country_code');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });

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
      expect(contentText(result)).toContain('mixes "|" (OR) with an AND operator');
      expect(contentText(result)).toContain('mixed_and_or_in_filter_value');
    });

    it('declares mixed_and_or_in_filter_value as a service-thrown ValidationError', () => {
      const entry = searchEntitiesTool.errors?.find(
        (e) => e.reason === 'mixed_and_or_in_filter_value',
      );
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });

    it('refuses a quoted-phrase value carrying a stray double quote before any request', async () => {
      const { fetchMock, result } = await run({
        raw_affiliation_strings: 'Harvard", publication_year:1800, display_name:"x',
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'quote_in_filter_value',
            recovery: { hint: expect.stringContaining('Remove the double quote') },
          },
        },
      });
      expect(contentText(result)).toContain('quote_in_filter_value');
    });

    it('declares quote_in_filter_value as a service-thrown ValidationError', () => {
      const entry = searchEntitiesTool.errors?.find((e) => e.reason === 'quote_in_filter_value');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });
  });

  /**
   * `select` aliases resolve in the service, before the request; the record carries the
   * upstream key on both surfaces. These run the real service against routed fetches.
   */
  describe('select aliases through the real service (gh #97)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const contentText = (result: { content?: { type: string; text?: string }[] }) =>
      (result.content ?? []).map((block) => block.text ?? '').join('\n');

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

    const sentSelect = (fetchMock: ReturnType<typeof vi.fn>) =>
      new URL(String(fetchMock.mock.calls.at(-1)?.[0])).searchParams.get('select');

    const psychMed = {
      id: 'https://openalex.org/S71144982',
      display_name: 'Psychological Medicine',
      host_organization_name: 'Cambridge University Press',
    };

    it.each([
      ['list', { query: 'psychological medicine' }, '/sources'],
      ['id', { id: 'S71144982' }, '/sources/S71144982'],
    ] as const)(
      'returns host_organization_name for select ["publisher"] on the %s path, on both surfaces',
      async (_path, args, route) => {
        const fetchMock = await useRealService({
          [route]:
            route === '/sources'
              ? { meta: { count: 1, per_page: 25 }, results: [psychMed] }
              : psychMed,
        });

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'sources',
          select: ['publisher'],
          ...args,
        });

        expect(result.isError).toBeFalsy();
        expect(sentSelect(fetchMock)).toBe('id,display_name,host_organization_name');
        expect(result.structuredContent).toMatchObject({ results: [psychMed] });
        expect(contentText(result)).toContain('Cambridge University Press');
      },
    );

    it('returns host_organization_name and summary_stats for ["publisher", "h_index"]', async () => {
      const record = { ...psychMed, summary_stats: { h_index: 220 } };
      const fetchMock = await useRealService({ '/sources/S71144982': record });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'sources',
        id: 'S71144982',
        select: ['publisher', 'h_index'],
      });

      expect(sentSelect(fetchMock)).toBe('id,display_name,host_organization_name,summary_stats');
      expect(result.structuredContent).toMatchObject({ results: [record] });
      expect(contentText(result)).toContain('Cambridge University Press');
      expect(contentText(result)).toContain('220');
    });

    it('documents the sources publisher alias on select', () => {
      const description = searchEntitiesTool.input.shape.select.description ?? '';
      expect(description).toContain('`publisher` returns `host_organization_name`');
    });
  });

  /**
   * `author_list` is derived in the service from the `authorships` it requests, before the
   * response budget runs. These run the real service against an upstream fake that projects
   * each record to the `select` it receives, as OpenAlex does, so the derivation, the budget,
   * and the slice handler all see what a caller would.
   */
  describe('author_list through the real service (gh #102)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const textOf = (result: { content?: { type: string; text?: string }[] }) =>
      (result.content ?? []).map((block) => block.text ?? '').join('\n');
    const bare = (id: string) => id.replace('https://openalex.org/', '');

    type Window = {
      id: string;
      field: string;
      offset: number;
      shown: number;
      total: number;
      possibly_capped: boolean;
      next: { tool: string; arguments: Record<string, unknown> } | null;
    };
    type Structured = {
      results: EntityRecord[];
      notice?: string;
      omitted?: { ids: string[]; next: { tool: string; arguments: Record<string, unknown> } };
      windows?: Window[];
      over_budget?: boolean;
    };

    /** A record as OpenAlex would return it for a comma-joined `select` (all fields without one). */
    function project(record: EntityRecord, select: string | null): EntityRecord {
      if (select === null) return record;
      const fields = select.split(',');
      return Object.fromEntries(
        Object.entries(record).filter(([key]) => fields.includes(key)),
      ) as EntityRecord;
    }

    /**
     * Serve `records` as upstream works: `/works/{id}` by bare ID, and `/works` as the
     * `openalex` filter's ID set (in reverse, as OpenAlex orders an ID set) or the first
     * `per_page` records. `/authors` answers the 400 OpenAlex gives an unknown select field;
     * any other request rejects.
     */
    function serveUpstream(records: EntityRecord[]) {
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        if (url.hostname !== 'api.openalex.org') {
          return Promise.reject(new Error(`unmocked fetch: ${url.href}`));
        }
        const select = url.searchParams.get('select');
        const json = (body: unknown, status = 200) =>
          Promise.resolve(new Response(JSON.stringify(body), { status }));
        if (url.pathname.startsWith('/works/')) {
          const record = records.find((r) => bare(r.id) === url.pathname.slice('/works/'.length));
          return record
            ? json(project(record, select))
            : Promise.resolve(new Response('<!doctype html>', { status: 404 }));
        }
        if (url.pathname === '/works') {
          const ids = /^openalex:(.+)$/.exec(url.searchParams.get('filter') ?? '')?.[1];
          const page = ids
            ? records.filter((r) => ids.split('|').includes(bare(r.id))).reverse()
            : records.slice(0, Number(url.searchParams.get('per_page')));
          return json({
            meta: { count: page.length, per_page: page.length, next_cursor: null },
            results: page.map((record) => project(record, select)),
          });
        }
        if (url.pathname === '/authors') {
          return json(
            {
              error: 'Invalid query parameters error.',
              message: `${select?.split(',').at(-1)} is not a valid select field. Valid fields: id, display_name, orcid.`,
            },
            400,
          );
        }
        return Promise.reject(new Error(`unmocked fetch: ${url.href}`));
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    async function useRealService(records: EntityRecord[]) {
      const fetchMock = serveUpstream(records);
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

    const sentSelect = (fetchMock: ReturnType<typeof vi.fn>) =>
      new URL(String(fetchMock.mock.calls.at(-1)?.[0])).searchParams.get('select');

    /** Upstream works with `count` slim authorships each, ORCIDs on every third author. */
    const upstreamWork = (n: number, count: number) =>
      workWithAuthorships(n, count, (i) => ({
        ...slimAuthorship(i),
        author: {
          ...(slimAuthorship(i).author as Record<string, unknown>),
          ...(i % 3 === 0 && {
            orcid: `https://orcid.org/0000-0002-0000-${String(i).padStart(4, '0')}`,
          }),
        },
        institutions: [{ id: 'https://openalex.org/I1', display_name: 'Some University' }],
      }));
    const expectedList = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `https://openalex.org/A${9_000_000 + i}`,
        display_name: `Author ${i}`,
        orcid:
          i % 3 === 0 ? `https://orcid.org/0000-0002-0000-${String(i).padStart(4, '0')}` : null,
      }));

    it.each(['authorships', 'author_list'])(
      'walks every stored singleton %s entry with cap uncertainty and finite continuation',
      async (field) => {
        const fetchMock = await useRealService([upstreamWork(1, 5000)]);
        type SearchArgs = Parameters<typeof runToolContract<typeof searchEntitiesTool>>[1];
        let args: SearchArgs | undefined = {
          entity_type: 'works',
          id: 'W3000000001',
          select: [field],
        };
        const seen: string[] = [];
        let calls = 0;
        while (args && calls < 100) {
          const result = await runToolContract(searchEntitiesTool, args);
          expect(result.isError).toBeFalsy();
          expect(utf8Bytes(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(64_000);
          expect(contentTextBytes(result.content)).toBeLessThanOrEqual(64_000);
          const structured = result.structuredContent as Structured;
          const window = structured.windows?.[0];
          expect(window).toMatchObject({
            field,
            offset: seen.length,
            total: 5000,
            possibly_capped: true,
          });
          expect(window?.shown).toBeGreaterThan(0);
          const text = textOf(result);
          expect(text).toContain('5,000');
          expect(text).toContain('stored entries');
          expect(structured.notice).toContain('snapshots cannot recover');
          if (window?.next) expect(text).toContain(JSON.stringify(window.next.arguments));
          const items = structured.results[0]?.[field] as Record<string, unknown>[];
          const renderedAuthors = [
            ...text.matchAll(/^- \[(\d+)\] (?:author\.)?id: (https:\/\/openalex\.org\/A\d+),/gm),
          ].map((match) => [Number(match[1]), match[2]]);
          expect(renderedAuthors).toEqual(
            Array.from({ length: items.length }, (_, index) => [
              seen.length + index,
              `https://openalex.org/A${9_000_000 + seen.length + index}`,
            ]),
          );
          for (const item of items)
            seen.push(
              String(field === 'author_list' ? item.id : (item.author as { id: string }).id),
            );
          args = window?.next?.arguments as SearchArgs | undefined;
          calls++;
        }
        expect(calls).toBeGreaterThan(2);
        expect(calls).toBeLessThan(100);
        expect(seen).toHaveLength(5000);
        expect(new Set(seen).size).toBe(5000);
        expect(seen[0]).toBe('https://openalex.org/A9000000');
        expect(seen.at(-1)).toBe('https://openalex.org/A9004999');
        expect(seen).toEqual(
          Array.from({ length: 5000 }, (_, index) => `https://openalex.org/A${9_000_000 + index}`),
        );
        const past = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: 'W3000000001',
          slice: { field, offset: 5001 },
          select: ['doi'],
        });
        expect(past.isError).toBeFalsy();
        expect(past.structuredContent).toMatchObject({
          results: [{ [field]: [] }],
          windows: [{ offset: 5001, total: 5000, shown: 0, possibly_capped: true, next: null }],
          notice: expect.stringContaining('past the end'),
        });
        expect(textOf(past)).toContain('5,000');
        expect(textOf(past)).toContain('`select` was not applied');
        expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
      },
    );

    it.each([
      ['list', { filters: { 'title.search': 'collaboration' } }],
      ['id', { id: 'W3000000001' }],
    ] as const)(
      'returns author_list in place of authorships on the %s path, on both surfaces',
      async (_path, args) => {
        const fetchMock = await useRealService([upstreamWork(1, 4)]);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          select: ['author_list'],
          ...args,
        });

        expect(result.isError).toBeFalsy();
        expect(sentSelect(fetchMock)).toBe('id,display_name,authorships');
        const structured = result.structuredContent as Structured;
        expect(structured.results).toEqual([
          {
            id: 'https://openalex.org/W3000000001',
            display_name: 'Collaboration paper 1',
            author_list: expectedList(4),
          },
        ]);
        const text = textOf(result);
        expect(text).toContain('**Author List:**');
        expect(text).toContain(
          '- [0] id: https://openalex.org/A9000000, display_name: Author 0, orcid: https://orcid.org/0000-0002-0000-0000',
        );
        expect(text).toContain(
          '- [1] id: https://openalex.org/A9000001, display_name: Author 1, orcid: —',
        );
        expect(text).not.toContain('Authorships');
        expect(text).not.toContain('Some University');
      },
    );

    /** One window entry per author array of exactly 100 on a list record; never on a lookup. */
    it('windows only the 100-entry author_list on a list page of 99, 100, and 101', async () => {
      const works = [upstreamWork(1, 99), upstreamWork(2, 100), upstreamWork(3, 101)];
      await useRealService(works);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'collaboration' },
        select: ['author_list'],
      });

      const structured = result.structuredContent as Structured;
      expect(structured.results.map((r) => (r.author_list as unknown[]).length)).toEqual([
        99, 100, 101,
      ]);
      const continuation = {
        tool: 'openalex_search_entities',
        arguments: {
          entity_type: 'works',
          id: 'W3000000002',
          slice: { field: 'author_list', offset: 100 },
        },
      };
      expect(structured.windows).toEqual([
        {
          id: 'W3000000002',
          field: 'author_list',
          offset: 0,
          shown: 100,
          total: 100,
          possibly_capped: true,
          next: continuation,
        },
      ]);
      expect(structured.notice).toMatch(
        /1 record\(s\) carry exactly 100 authorships or author_list/,
      );
      const text = textOf(result);
      expect(text).toContain(
        `**Window:** W3000000002 \`author_list\` — offset 0, 100 shown of 100 — possibly capped`,
      );
      expect(text).toContain(JSON.stringify(continuation.arguments));
      expect(text).not.toContain('**Window:** W3000000001');
      expect(text).not.toContain('**Window:** W3000000003');
    });

    it.each([99, 100, 101])(
      'never windows a %i-entry author_list on an id lookup',
      async (count) => {
        await useRealService([upstreamWork(1, count)]);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: 'W3000000001',
          select: ['author_list'],
        });

        const structured = result.structuredContent as Structured;
        expect(structured.results[0]?.author_list).toHaveLength(count);
        expect(structured).not.toHaveProperty('windows');
        expect(structured.notice).toBeUndefined();
        expect(textOf(result)).not.toContain('**Window:**');
      },
    );

    describe('slice', () => {
      const record = upstreamWork(1_858_542_512, 2932);
      const id = bare(record.id);

      it('pages a 2,932-author author_list to the end with no gap or overlap', {
        timeout: 30_000,
      }, async () => {
        const fetchMock = await useRealService([record]);
        const collected: unknown[] = [];
        const windows: Window[] = [];
        let offset: number | undefined = 0;
        let calls = 0;
        while (offset !== undefined && calls < 50) {
          const result = await runToolContract(searchEntitiesTool, {
            entity_type: 'works',
            id,
            slice: { field: 'author_list', offset },
          });
          calls++;
          expect(result.isError).toBeFalsy();
          expect(sentSelect(fetchMock)).toBe('id,display_name,authorships');
          const structured = result.structuredContent as Structured;
          expect(Object.keys(structured.results[0] ?? {})).toEqual([
            'id',
            'display_name',
            'author_list',
          ]);
          const items = structured.results[0]?.author_list as unknown[];
          collected.push(...items);
          const [window] = structured.windows ?? [];
          if (!window) throw new Error('slice returned no window');
          windows.push(window);
          expect(window).toMatchObject({ field: 'author_list', offset, total: 2932 });
          expect(textOf(result)).toContain(`**Window:** ${id} \`author_list\` — offset ${offset}`);
          const next = window.next?.arguments.slice as
            | { field: string; offset: number }
            | undefined;
          if (next) expect(next.field).toBe('author_list');
          offset = next?.offset;
        }

        expect(collected).toEqual(expectedList(2932));
        expect(calls).toBeGreaterThan(1);
        expect(windows.at(-1)?.next).toBeNull();
        expect(windows[1]?.offset).toBe(windows[0]?.shown);
      });

      it('returns an empty final window past the end of author_list', async () => {
        await useRealService([record]);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id,
          slice: { field: 'author_list', offset: 5000 },
        });

        const structured = result.structuredContent as Structured;
        expect(structured.results[0]?.author_list).toEqual([]);
        expect(structured.windows).toEqual([
          expect.objectContaining({ field: 'author_list', offset: 5000, shown: 0, next: null }),
        ]);
        expect(structured.notice).toContain('past the end of `author_list`, which holds 2932');
      });

      it('continues a windowed id lookup with a slice on author_list', async () => {
        const wide = workWithAuthorships(7, 2932, (i) => ({
          author: {
            id: `https://openalex.org/A${i}`,
            display_name: `Member ${'x'.repeat(60)} ${i}`,
          },
        }));
        await useRealService([wide]);

        const first = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: bare(wide.id),
          select: ['author_list'],
        });
        const [window] = (first.structuredContent as Structured).windows ?? [];
        expect(window).toMatchObject({ field: 'author_list', offset: 0, total: 2932 });
        expect(window?.next?.arguments).toEqual({
          entity_type: 'works',
          id: bare(wide.id),
          slice: { field: 'author_list', offset: window?.shown },
        });

        const second = await runToolContract(
          searchEntitiesTool,
          window?.next?.arguments as Parameters<
            typeof runToolContract<typeof searchEntitiesTool>
          >[1],
        );
        const items = (second.structuredContent as Structured).results[0]?.author_list as {
          id: string;
        }[];
        expect(items[0]?.id).toBe(`https://openalex.org/A${window?.shown}`);
      });
    });

    it('repeats select in the omitted call, which returns the same author_list shape', async () => {
      // 30 works of ~100 authors each run well past the budget on one page.
      const works = Array.from({ length: 30 }, (_, n) => upstreamWork(n, 98));
      await useRealService(works);

      const first = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'collaboration' },
        per_page: 30,
        select: ['author_list'],
      });
      const omitted = (first.structuredContent as Structured).omitted;
      expect(omitted?.next.arguments).toMatchObject({ select: ['author_list'] });

      const second = await runToolContract(
        searchEntitiesTool,
        omitted?.next.arguments as Parameters<typeof runToolContract<typeof searchEntitiesTool>>[1],
      );
      const results = (second.structuredContent as Structured).results;
      expect(results.length).toBeGreaterThan(0);
      for (const record of results) {
        expect(Object.keys(record)).toEqual(['id', 'display_name', 'author_list']);
        expect(record.author_list).toEqual(expectedList(98));
      }
    });

    it('documents author_list on select, slice, and results', () => {
      const { shape } = searchEntitiesTool.input;
      expect(shape.select.description).toContain('`author_list` returns each author');
      expect(shape.select.description).toContain('neither the default nor `["*"]` includes it');
      expect(shape.slice.unwrap().shape.field.description).toContain('"author_list"');
      expect(searchEntitiesTool.output.shape.results.description).toContain('`author_list`');
    });

    it('forwards author_list untranslated on authors, where OpenAlex rejects it', async () => {
      const fetchMock = await useRealService([]);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'authors',
        query: 'einstein',
        select: ['author_list'],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe('/authors');
      expect(sentSelect(fetchMock)).toBe('id,display_name,author_list');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_invalid_params' },
        },
      });
      expect(textOf(result)).toContain('author_list is not a valid select field');
      expect(textOf(result)).toContain('(reason upstream_invalid_params');
    });
  });

  /**
   * Semantic search ranks a candidate set and pages it with `page`; OpenAlex rejects a
   * cursor on a semantic query, and no other mode accepts `page`. Both mismatches are settled
   * locally so neither costs a round trip. (gh #71)
   */
  describe('semantic pagination (gh #71)', () => {
    const renderedText = (blocks: { type: string; text?: string }[] | undefined) =>
      (blocks ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

    it('forwards page to the service and leaves cursor unset', async () => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'estimating groundwater recharge',
        search_mode: 'semantic',
        per_page: 3,
        page: 17,
      });

      await searchEntitiesTool.handler(input, ctx);

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ searchMode: 'semantic', page: 17, cursor: undefined }),
        ctx,
      );
    });

    it('rejects cursor in semantic mode on both surfaces before the round trip', async () => {
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'estimating groundwater recharge',
        search_mode: 'semantic',
        cursor: 'definitely-invalid',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'semantic_with_cursor',
            recovery: { hint: expect.stringContaining('page') },
          },
        },
      });
      expect(renderedText(result.content)).toContain('page');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it.each([
      ['an omitted search_mode', {}],
      ['keyword mode', { search_mode: 'keyword' }],
      ['exact mode', { search_mode: 'exact' }],
    ] as const)(
      'rejects page with %s on both surfaces before the round trip',
      async (_label, extra) => {
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          query: 'groundwater',
          page: 2,
          ...extra,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'page_without_semantic',
              recovery: { hint: expect.stringContaining('cursor') },
            },
          },
        });
        expect(renderedText(result.content)).toContain('cursor');
        expect(mockSearch).not.toHaveBeenCalled();
      },
    );

    it('rejects sample + page on both surfaces before the round trip', async () => {
      // The resolved value is what makes `not.toHaveBeenCalled()` load-bearing: without it a
      // forwarded call would still fail, just for a different reason.
      mockSearch.mockResolvedValue(sampleResult);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'groundwater',
        search_mode: 'semantic',
        sample: 5,
        page: 2,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'sample_with_page',
            recovery: { hint: expect.stringContaining('remove `page`') },
          },
        },
      });
      const rendered = renderedText(result.content);
      expect(rendered).toContain('remove `page`');
      expect(rendered).toContain('sample_with_page');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('accepts page 1 and rejects page 0 at the schema layer', () => {
      const first = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'groundwater',
        search_mode: 'semantic',
        page: 1,
      });
      expect(first.page).toBe(1);

      expect(() =>
        searchEntitiesTool.input.parse({
          entity_type: 'works',
          query: 'groundwater',
          search_mode: 'semantic',
          page: 0,
        }),
      ).toThrow();
    });

    it('discloses the candidate count on both surfaces for a semantic response', async () => {
      mockSearch.mockResolvedValue({
        meta: { count: 50, per_page: 3, next_cursor: null },
        results: [{ id: 'W001', display_name: 'Paper Alpha' }],
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'estimating groundwater recharge',
        search_mode: 'semantic',
        per_page: 3,
      });

      expect(result.isError).toBeFalsy();
      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toMatch(/candidate/i);
      expect(notice).toContain('50');
      const rendered = renderedText(result.content);
      expect(rendered).toMatch(/candidate/i);
      expect(rendered).toContain('50');
    });

    /**
     * The candidate count is query-dependent — OpenAlex reports 70 for "groundwater recharge"
     * and serves candidates 51-55 on page 11 at per_page 5 — so the notice interpolates the real
     * count and asserts no fixed ceiling of its own. (gh #84)
     */
    it('reports a candidate count above 50 without claiming a 50-candidate ceiling', async () => {
      mockSearch.mockResolvedValue({
        meta: { count: 70, per_page: 5, next_cursor: null },
        results: [{ id: 'W2046654411', display_name: 'Groundwater recharge' }],
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'groundwater recharge',
        search_mode: 'semantic',
        per_page: 5,
        page: 11,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { notice?: string; meta: { count: number } };
      expect(structured.meta.count).toBe(70);
      const rendered = renderedText(result.content);
      for (const [surface, text] of [
        ['structuredContent.notice', structured.notice ?? ''],
        ['content[]', rendered],
      ] as const) {
        expect(text, surface).toMatch(/`meta\.count` \(70\)/);
        expect(text, surface).toMatch(/candidate/i);
        expect(text, surface).not.toMatch(/at most 50/i);
        expect(text, surface).not.toMatch(/\bceiling\b/i);
      }
    });

    it('states no fixed semantic candidate ceiling on any definition surface', () => {
      const schemaText = JSON.stringify([
        z.toJSONSchema(searchEntitiesTool.input),
        z.toJSONSchema(searchEntitiesTool.output),
        z.toJSONSchema(z.object(searchEntitiesTool.enrichment ?? {})),
        searchEntitiesTool.description,
      ]);
      expect(schemaText).not.toMatch(/at most 50 candidates/i);
      expect(schemaText).not.toMatch(/candidate count — at most/i);
      expect(schemaText).not.toMatch(/ceil\(50/);
      expect(schemaText).not.toMatch(/page 17 with per_page=3/);
      // The per-page bound is real and stays documented.
      expect(searchEntitiesTool.input.shape.per_page.description ?? '').toMatch(/caps at 50/);
    });

    it.each([
      ['keyword', 'keyword'],
      ['exact', 'exact'],
    ])('leaves a %s response without a candidate-count notice', async (_label, searchMode) => {
      mockSearch.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'groundwater',
        search_mode: searchMode,
      });

      await searchEntitiesTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('declares query_too_long as a service-thrown InvalidParams reason', () => {
      const entry = searchEntitiesTool.errors?.find((e) => e.reason === 'query_too_long');
      expect(entry?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(entry?.thrownBy).toBe('service');
    });

    it('carries the query_too_long reason, upstream limit, and recovery from the service', async () => {
      mockSearch.mockRejectedValue(
        invalidParams('Your search is too long (1890 characters; the limit is 1500).', {
          reason: 'query_too_long',
        }),
      );

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'a'.repeat(1890),
        search_mode: 'semantic',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('the limit is 1500'),
          data: {
            reason: 'query_too_long',
            recovery: { hint: expect.stringMatching(/shorten/i) },
          },
        },
      });
    });

    it('puts no local length limit on query', () => {
      // The ceiling is upstream's to move; a local `.max()` would pin a number that has
      // already drifted from what OpenAlex enforces.
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'a'.repeat(5000),
        search_mode: 'semantic',
      });
      expect(input.query).toHaveLength(5000);
    });

    it('documents page alongside cursor and search_mode', () => {
      expect(searchEntitiesTool.input.shape.page.description ?? '').toMatch(/semantic/i);
      expect(searchEntitiesTool.input.shape.cursor.description ?? '').toMatch(/page/i);
      expect(searchEntitiesTool.input.shape.search_mode.description ?? '').toMatch(/page/i);
    });

    it('names the semantic candidate total in the meta.count description', () => {
      expect(searchEntitiesTool.output.shape.meta.shape.count.description ?? '').toMatch(
        /semantic/i,
      );
    });
  });

  /**
   * A zero-result page on a *continuing* call means the traversal ran past its last page, not
   * that the criteria matched nothing — broadening advice there tells the caller to widen a
   * search that already returned everything it had. (gh #74)
   */
  describe('exhausted pages (gh #74)', () => {
    const renderedText = (blocks: { type: string; text?: string }[] | undefined) =>
      (blocks ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

    /** Terminal cursor page: nonzero count, empty results, null cursor. */
    const terminalCursorPage: SearchResult = {
      meta: { count: 2, per_page: 2, next_cursor: null },
      results: [],
    };

    it('replaces the broadening advice on a cursor continuation, on both surfaces', async () => {
      mockSearch.mockResolvedValue(terminalCursorPage);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'publishers',
        query: 'Elsevier',
        per_page: 2,
        cursor: 'second-page',
      });

      expect(result.isError).toBeFalsy();
      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain('Pagination exhausted');
      expect(notice).not.toContain('No matches for');
      expect(notice).not.toContain('Try broadening');
      const rendered = renderedText(result.content);
      expect(rendered).toContain('Pagination exhausted');
      expect(rendered).not.toContain('No matches for');
      expect(rendered).not.toContain('Try broadening');
    });

    it('leaves echo, totalCount, and meta.count untouched on the exhausted branch', async () => {
      mockSearch.mockResolvedValue(terminalCursorPage);
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'publishers',
        query: 'Elsevier',
        per_page: 2,
        cursor: 'second-page',
      });

      const output = await searchEntitiesTool.handler(input, ctx);

      expect(output.meta.count).toBe(2);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(2);
      expect(enrichment.echo).toContain('entity_type=publishers');
    });

    it('treats a semantic page past the last candidate as exhausted', async () => {
      mockSearch.mockResolvedValue({
        meta: { count: 50, per_page: 3, next_cursor: null },
        results: [],
      });
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'estimating groundwater recharge',
        search_mode: 'semantic',
        per_page: 3,
        page: 18,
      });

      await searchEntitiesTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('Pagination exhausted');
      expect(notice).not.toContain('No matches for');
    });

    it('keeps the broadening advice on semantic page 1', async () => {
      mockSearch.mockResolvedValue({
        meta: { count: 0, per_page: 3, next_cursor: null },
        results: [],
      });
      const ctx = createMockContext();
      const input = searchEntitiesTool.input.parse({
        entity_type: 'works',
        query: 'xyzzy_no_match',
        search_mode: 'semantic',
        per_page: 3,
        page: 1,
      });

      await searchEntitiesTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('No matches for');
      expect(notice).not.toContain('Pagination exhausted');
    });

    it('keeps the broadening advice on a first call with no cursor', async () => {
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

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('No matches for');
      expect(notice).not.toContain('Pagination exhausted');
    });

    it('describes meta.per_page as the requested page size, not the result count', () => {
      const description = searchEntitiesTool.output.shape.meta.shape.per_page.description ?? '';
      expect(description).toMatch(/request/i);
      expect(description).not.toBe('Results on this page.');
    });
  });

  /**
   * A supplied-but-blank `cursor` used to reach upstream as `cursor=`, which OpenAlex answers
   * with page 1 — restarting the traversal — while the tool read the parameter's presence as a
   * continuation and reported a genuine zero-match first call as an exhausted page. (gh #80)
   */
  describe('blank cursor (gh #80)', () => {
    it('rejects a blank cursor on the error envelope before the round trip', async () => {
      // The resolved value is what makes `not.toHaveBeenCalled()` load-bearing: without it a
      // forwarded call would still fail, just for a different reason.
      mockSearch.mockResolvedValue(sampleResult);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'groundwater recharge',
        per_page: 2,
        select: ['id'],
        cursor: '',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('rejects a blank cursor on an id lookup too, which never paginates', () => {
      expect(() =>
        searchEntitiesTool.input.parse({ entity_type: 'works', id: 'W2741809807', cursor: '' }),
      ).toThrow();
    });

    it('documents that a blank cursor is rejected rather than read as page 1', () => {
      expect(searchEntitiesTool.input.shape.cursor.description ?? '').toMatch(/empty string/i);
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

  /**
   * Characterization: responses that already fit the 64,000-byte budget must come back exactly
   * as they did before the budget existed — same records, same text, no disclosure fields.
   */
  describe('response budget — pages that fit stay unchanged (gh #72, #73)', () => {
    const DISCLOSURE_KEYS = ['omitted', 'windows', 'over_budget'];

    function expectNoDisclosure(structured: unknown) {
      for (const key of DISCLOSURE_KEYS) expect(structured).not.toHaveProperty(key);
    }

    it('returns a 25-record default works page byte-for-byte as rendered today', async () => {
      const page: SearchResult = {
        meta: { count: 500, per_page: 25, next_cursor: 'cursor-2' },
        results: Array.from({ length: 25 }, (_, n) => defaultWork(n)),
      };
      mockSearch.mockResolvedValue(page);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'proton collisions' },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.results).toEqual(page.results);
      expect(structured.notice).toBeUndefined();
      expectNoDisclosure(structured);
      const expected = [
        '**500 result(s) — 25 per page** — next cursor: `cursor-2`',
        ...page.results.flatMap((record) => renderEntityRecord(record)),
      ].join('\n');
      expect(result.content[0]).toEqual({ type: 'text', text: expected });
      expect(utf8Bytes(JSON.stringify(structured))).toBeLessThan(64_000);
      expect(contentTextBytes(result.content)).toBeLessThan(64_000);
    });

    it('returns a list record with 99 authorships whole and unflagged', async () => {
      const record = workWithAuthorships(1, 99, slimAuthorship);
      mockSearch.mockResolvedValue({
        meta: { count: 1, per_page: 25, next_cursor: null },
        results: [record],
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { openalex: 'W3000000001' },
        select: ['authorships'],
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.results).toEqual([record]);
      expect(structured.notice).toBeUndefined();
      expectNoDisclosure(structured);
    });

    it('returns an id lookup whose array fits the budget whole', async () => {
      const record = workWithAuthorships(2, 50);
      mockSearch.mockResolvedValue({
        meta: { count: 1, per_page: 1, next_cursor: null },
        results: [record],
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        id: 'W3000000002',
        select: ['authorships'],
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.results).toEqual([record]);
      expectNoDisclosure(structured);
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('- [49] author_position: middle');
    });
  });

  /**
   * The budget itself (gh #72) and the 100-authorship cap disclosure (gh #73). Every size
   * assertion reads the assembled `CallToolResult` from `runToolContract`, enrichment trailer
   * included, and the service fake writes the `budget` enrichment the real service writes.
   */
  describe('response budget (gh #72, #73)', () => {
    const BUDGET = 64_000;
    /** A budget reading with long float tails, so the trailer is as wide as it realistically gets. */
    const SPEND = {
      costUsd: 0.30000000000000004,
      remainingUsd: 12345.678901234567,
      resetsInSeconds: 86399.99999999999,
      prepaidRemainingUsd: 98765.43210987654,
    };
    const bare = (id: string) => id.replace('https://openalex.org/', '');
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');

    type Structured = {
      meta: { count: number; per_page: number; next_cursor: string | null };
      results: EntityRecord[];
      notice?: string;
      omitted?: {
        ids: string[];
        next: { tool: string; arguments: Record<string, unknown> };
      };
      windows?: {
        id: string;
        field: string;
        offset: number;
        shown: number;
        total: number;
        possibly_capped: boolean;
        next: { tool: string; arguments: Record<string, unknown> } | null;
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
     * Fake service: answers an ID filter — `openalex`, or `id` for keywords — with exactly those
     * records, in reverse page order as OpenAlex returns an ID set in its own order; an `id`
     * lookup with the record projected to `select`; and anything else with the first `per_page`
     * records plus a next cursor. Writes the budget enrichment the way the real service does.
     */
    function serve(records: EntityRecord[], nextCursor: string | null = 'cursor-2') {
      mockSearch.mockImplementation(async (...args: unknown[]) => {
        const [params, ctx] = args as [SearchParams, Context];
        ctx.enrich({ budget: SPEND });
        if (params.id) {
          const record = records.find((r) => bare(r.id) === params.id);
          if (!record) throw notFound(`No entity ${params.id}`, { reason: 'entity_not_found' });
          if (params.select?.includes('*')) {
            return { meta: { count: 1, per_page: 1, next_cursor: null }, results: [record] };
          }
          const projected: EntityRecord = { id: record.id, display_name: record.display_name };
          for (const field of params.select ?? []) {
            const key = field === 'authors' ? 'authorships' : field;
            if (key in record) projected[key] = record[key];
          }
          return { meta: { count: 1, per_page: 1, next_cursor: null }, results: [projected] };
        }
        const wanted = (params.filters?.openalex ?? params.filters?.id)?.split('|');
        const perPage = params.perPage ?? 25;
        const results = wanted
          ? records.filter((r) => wanted.includes(bare(r.id)) || wanted.includes(r.id)).reverse()
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

    it('windows an oversized id lookup to the budget on both surfaces (repro 1)', async () => {
      const record = workWithAuthorships(1_858_542_512, 2932);
      serve([record]);
      const id = bare(record.id);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        id,
        select: ['authorships'],
      });

      expect(result.isError).toBeFalsy();
      expectWithinBudget(result);
      const structured = result.structuredContent as Structured;
      const shown = structured.windows?.[0]?.shown ?? 0;
      expect(shown).toBeGreaterThan(50);
      expect(structured.windows).toEqual([
        {
          id,
          field: 'authorships',
          offset: 0,
          shown,
          total: 2932,
          possibly_capped: false,
          next: {
            tool: 'openalex_search_entities',
            arguments: { entity_type: 'works', id, slice: { field: 'authorships', offset: shown } },
          },
        },
      ]);
      expect(structured.results[0]?.authorships).toEqual(
        (record.authorships as unknown[]).slice(0, shown),
      );
      expect(structured.notice).toMatch(/slice/);
      const text = textOf(result);
      expect(text).toContain(`- [${shown - 1}] author_position`);
      expect(text).not.toContain(`- [${shown}] author_position`);
      expect(text).toContain(`"slice":{"field":"authorships","offset":${shown}}`);
    });

    it('cuts an overflowing list page to whole records and names every omitted ID', async () => {
      const records = Array.from({ length: 25 }, (_, n) => workWithAuthorships(n, 8));
      serve(records);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'collaboration' },
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
      const text = textOf(result);
      for (const omittedId of omittedIds) expect(text).toContain(omittedId);
      expect(text).toContain(JSON.stringify(structured.omitted?.next.arguments));
    });

    it('walks every cut continuation to the full set with no gap or overlap', async () => {
      // ~12 KB records: each call keeps about five, so the continuation is itself cut, twice over.
      const records = Array.from({ length: 25 }, (_, n) => workWithAuthorships(n, 20));
      serve(records);

      type SearchArgs = Parameters<typeof runToolContract<typeof searchEntitiesTool>>[1];
      const seen: string[] = [];
      let args: SearchArgs | undefined = {
        entity_type: 'works',
        filters: { 'title.search': 'collaboration' },
        select: ['authorships'],
      };
      let calls = 0;
      while (args && calls < 25) {
        const result = await runToolContract(searchEntitiesTool, args);
        calls++;
        expect(result.isError).toBeFalsy();
        expectWithinBudget(result);
        const structured = result.structuredContent as Structured;
        seen.push(...structured.results.map((r) => bare(r.id)));
        args = structured.omitted?.next.arguments as SearchArgs | undefined;
      }

      expect(calls).toBeGreaterThan(2);
      expect(seen).toHaveLength(25);
      expect(new Set(seen)).toEqual(new Set(records.map((r) => bare(r.id))));
    });

    it('windows an oversized first list record and omits the rest', async () => {
      const records = [
        workWithAuthorships(1, 2932),
        workWithAuthorships(2, 3),
        workWithAuthorships(3, 3),
      ];
      serve(records);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'collaboration' },
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
      expect(window?.next?.arguments).toEqual({
        entity_type: 'works',
        id: bare(records[0]!.id),
        slice: { field: 'authorships', offset: window?.shown },
      });
      expect(structured.omitted?.ids).toEqual([bare(records[1]!.id), bare(records[2]!.id)]);
    });

    it('returns a record whose non-array fields alone overflow with every array emptied, flagged', async () => {
      const record: EntityRecord = {
        id: 'https://openalex.org/W77',
        display_name: 'An abstract longer than the budget',
        abstract: 'lorem ipsum '.repeat(6000),
        authorships: authorships(3),
        referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
      };
      serve([record]);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        id: 'W77',
        select: ['*'],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Structured;
      expect(structured.over_budget).toBe(true);
      expect(structured.results[0]?.abstract).toBe(record.abstract);
      expect(structured.results[0]?.authorships).toEqual([]);
      expect(structured.windows?.map((w) => [w.field, w.shown, w.total])).toEqual(
        expect.arrayContaining([
          ['authorships', 0, 3],
          ['referenced_works', 0, 2],
        ]),
      );
      expect(textOf(result)).toMatch(/over budget/i);
    });

    it('marks each emptied array on an over-budget record as windowed, never (empty)', async () => {
      const record: EntityRecord = {
        id: 'https://openalex.org/W77',
        display_name: 'An abstract longer than the budget',
        abstract: 'lorem ipsum '.repeat(6000),
        authorships: authorships(3),
        referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
        topics: [],
      };
      serve([record]);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        id: 'W77',
        select: ['*'],
      });

      const structured = result.structuredContent as Structured;
      expect(structured.over_budget).toBe(true);
      expect(structured.results[0]?.topics).toEqual([]);
      const text = textOf(result);
      expect(text).toContain('**Authorships:** (0 of 3 shown — windowed; see Window)');
      expect(text).toContain('**Referenced Works:** (0 of 2 shown — windowed; see Window)');
      expect(text).not.toContain('**Authorships:** (empty)');
      expect(text).not.toContain('**Referenced Works:** (empty)');
      // `topics` came back empty from OpenAlex, not from the budget.
      expect(text).toContain('**Topics:** (empty)');
    });

    it('shows elements of every windowed array of a list record, on both surfaces', async () => {
      // ~900-byte elements: 100 authorships (a capped list record) and 82 locations, each too
      // large to sit beside the other emptied, so both are windowed.
      const big = (i: number) => ({
        ...authorship(i),
        raw_affiliation_strings: ['Laboratory for Particle Physics, CERN, Geneva '.repeat(6)],
      });
      const first: EntityRecord = {
        ...workWithAuthorships(1, 100, big),
        locations: Array.from({ length: 82 }, (_, i) => big(1_000 + i)),
      };
      serve([first, workWithAuthorships(2, 3), workWithAuthorships(3, 3)]);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'collaboration' },
        per_page: 3,
        select: ['*'],
      });

      expect(result.isError).toBeFalsy();
      expectWithinBudget(result);
      const structured = result.structuredContent as Structured;
      expect(structured.results).toHaveLength(1);
      const byField = new Map(structured.windows?.map((w) => [w.field, w]));
      const auth = byField.get('authorships');
      const locs = byField.get('locations');
      expect(auth).toMatchObject({ total: 100, possibly_capped: true });
      expect(locs).toMatchObject({ total: 82, possibly_capped: false });
      expect(auth?.shown).toBeGreaterThan(0);
      expect(locs?.shown).toBeGreaterThan(0);
      expect(structured.results[0]?.authorships).toHaveLength(auth?.shown ?? -1);
      expect(structured.results[0]?.locations).toHaveLength(locs?.shown ?? -1);
      const text = textOf(result);
      expect(text).toContain(
        `**Authorships:** (${auth?.shown} of 100 shown — windowed; see Window)`,
      );
      expect(text).toContain(`**Locations:** (${locs?.shown} of 82 shown — windowed; see Window)`);
      expect(text).toContain(`- [${(auth?.shown ?? 0) - 1}] author_position`);
    });

    it('returns an omitted keywords page through the `id` filter continuation', async () => {
      const keywords: EntityRecord[] = Array.from({ length: 10 }, (_, n) => ({
        id: `https://openalex.org/keywords/keyword-${n}`,
        display_name: `Keyword ${n}`,
        description: 'x'.repeat(12_000),
      }));
      serve(keywords, null);

      type SearchArgs = Parameters<typeof runToolContract<typeof searchEntitiesTool>>[1];
      const seen: string[] = [];
      let args: SearchArgs | undefined = {
        entity_type: 'keywords',
        query: 'keyword',
        per_page: 10,
      };
      let calls = 0;
      while (args && calls < 10) {
        const result = await runToolContract(searchEntitiesTool, args);
        calls++;
        expect(result.isError).toBeFalsy();
        expectWithinBudget(result);
        const structured = result.structuredContent as Structured;
        seen.push(...structured.results.map((r) => r.id));
        const next = structured.omitted?.next;
        if (next) {
          expect(next.arguments.filters).toEqual({ id: structured.omitted?.ids.join('|') });
          expect(textOf(result)).toContain(JSON.stringify(next.arguments));
        }
        args = next?.arguments as SearchArgs | undefined;
      }

      expect(calls).toBeGreaterThan(1);
      expect(seen).toHaveLength(keywords.length);
      expect(new Set(seen)).toEqual(new Set(keywords.map((k) => k.id)));
    });

    it('keeps a sparse record — null title, no arrays — within the budget and undisclosed', async () => {
      const records: EntityRecord[] = [{ id: 'https://openalex.org/W5', display_name: null }];
      serve(records, null);

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { openalex: 'W5' },
      });

      const structured = result.structuredContent as Structured;
      expect(structured.results).toEqual(records);
      expect(structured).not.toHaveProperty('omitted');
      expect(structured).not.toHaveProperty('windows');
    });

    describe('possibly-capped authorships (gh #73)', () => {
      it('flags a list record with exactly 100 authorships on both surfaces', async () => {
        const capped = workWithAuthorships(1, 100, slimAuthorship);
        const complete = workWithAuthorships(2, 99, slimAuthorship);
        serve([capped, complete], null);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          filters: { 'title.search': 'collaboration' },
          select: ['authorships'],
        });

        expectWithinBudget(result);
        const structured = result.structuredContent as Structured;
        expect(structured.results).toEqual([capped, complete]);
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
        expect(structured.notice).toMatch(/100 authorships/);
        const text = textOf(result);
        expect(text).toMatch(/possibly capped/i);
        expect(text).toContain(
          `"id":"${bare(capped.id)}","slice":{"field":"authorships","offset":100}`,
        );
        expect(text).not.toContain(`"id":"${bare(complete.id)}"`);
      });

      it('never flags an id lookup with exactly 100 authorships', async () => {
        const record = workWithAuthorships(1, 100, slimAuthorship);
        serve([record]);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: bare(record.id),
          select: ['authorships'],
        });

        const structured = result.structuredContent as Structured;
        expect(structured).not.toHaveProperty('windows');
        expect(structured.notice).toBeUndefined();
      });

      it('points a windowed capped record at the same id + slice continuation', async () => {
        // ~900-byte authorships, so 100 of them overflow the budget on their own.
        const record = workWithAuthorships(1, 100, (i) => ({
          ...authorship(i),
          raw_affiliation_strings: ['Laboratory for Particle Physics, CERN, Geneva '.repeat(6)],
        }));
        serve([record]);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          filters: { openalex: bare(record.id) },
          select: ['authorships'],
        });

        expectWithinBudget(result);
        const structured = result.structuredContent as Structured;
        expect(structured.windows).toHaveLength(1);
        const window = structured.windows![0]!;
        expect(window).toMatchObject({ field: 'authorships', total: 100, possibly_capped: true });
        expect(window.shown).toBeLessThan(100);
        expect(window.next?.arguments).toEqual({
          entity_type: 'works',
          id: bare(record.id),
          slice: { field: 'authorships', offset: window.shown },
        });
      });
    });

    describe('slice', () => {
      const record = workWithAuthorships(1_858_542_512, 2932);
      const id = bare(record.id);

      it('walks all 2,932 authorships in windows with no gap or overlap', {
        timeout: 30_000,
      }, async () => {
        serve([record]);
        const collected: unknown[] = [];
        let offset: number | undefined = 0;
        let calls = 0;
        while (offset !== undefined && calls < 100) {
          const result = await runToolContract(searchEntitiesTool, {
            entity_type: 'works',
            id,
            slice: { field: 'authorships', offset },
          });
          calls++;
          expect(result.isError).toBeFalsy();
          expectWithinBudget(result);
          const structured = result.structuredContent as Structured;
          const window = structured.windows?.[0];
          expect(window).toMatchObject({ id, field: 'authorships', offset, total: 2932 });
          const items = structured.results[0]?.authorships as unknown[];
          expect(items).toHaveLength(window?.shown ?? -1);
          expect(textOf(result)).toContain(`- [${offset}] author_position`);
          collected.push(...items);
          const next = window?.next?.arguments.slice as { offset: number } | undefined;
          if (next) expect(next.offset).toBe(offset + items.length);
          offset = next?.offset;
        }
        expect(calls).toBeGreaterThan(20);
        expect(collected).toEqual(record.authorships);
        expect(mockSearch).toHaveBeenCalledWith(
          expect.objectContaining({ id, select: ['authorships'] }),
          expect.anything(),
        );
      });

      it('returns only id, display_name, and the sliced field', async () => {
        serve([{ ...record, doi: 'https://doi.org/10.1/x', cited_by_count: 5 }]);
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id,
          slice: { field: 'authorships', offset: 2900 },
        });
        const structured = result.structuredContent as Structured;
        expect(Object.keys(structured.results[0] ?? {}).sort()).toEqual(
          ['authorships', 'display_name', 'id'].sort(),
        );
        expect(structured.windows?.[0]).toMatchObject({ offset: 2900, shown: 32, next: null });
      });

      it('resolves the works `authors` alias to authorships', async () => {
        serve([record]);
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id,
          slice: { field: 'authors', offset: 0 },
        });
        expect((result.structuredContent as Structured).windows?.[0]?.field).toBe('authorships');
      });

      it.each([
        ['at the end', 2932],
        ['past the end', 5000],
      ])('returns an empty, final window for an offset %s', async (_label, offset) => {
        serve([record]);
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id,
          slice: { field: 'authorships', offset },
        });
        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as Structured;
        expect(structured.results[0]?.authorships).toEqual([]);
        expect(structured.windows?.[0]).toMatchObject({
          offset,
          shown: 0,
          total: 2932,
          next: null,
        });
        if (offset > 2932) expect(structured.notice).toMatch(/past the end/);
      });

      it('rejects slice without id with a typed error and recovery', async () => {
        serve([record]);
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          filters: { openalex: id },
          slice: { field: 'authorships', offset: 0 },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: { reason: 'slice_without_id', recovery: { hint: expect.stringMatching(/id/) } },
          },
        });
        expect(mockSearch).not.toHaveBeenCalled();
      });

      it('rejects a slice field that is not an array on the record', async () => {
        serve([{ ...record, doi: 'https://doi.org/10.1/x' }]);
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id,
          slice: { field: 'doi', offset: 0 },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'slice_field_not_array',
              recovery: { hint: expect.stringMatching(/array/) },
            },
          },
        });
        expect(textOf(result)).toContain('slice_field_not_array');
      });

      it('rejects a `*` slice field before fetching the record', async () => {
        serve([record]);
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id,
          slice: { field: '*', offset: 0 },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'slice_field_not_array',
              recovery: { hint: expect.stringMatching(/array/) },
            },
          },
        });
        expect(textOf(result)).toContain('slice_field_not_array');
        expect(mockSearch).not.toHaveBeenCalled();
      });

      it('flags a window whose one element alone exceeds the budget, on both surfaces', async () => {
        const huge = { note: 'x'.repeat(70_000) };
        const oversized: EntityRecord = {
          id: 'https://openalex.org/W6',
          display_name: 'Huge elements',
          authorships: [huge, huge],
        };
        serve([oversized]);

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: 'W6',
          slice: { field: 'authorships', offset: 0 },
        });

        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as Structured;
        expect(structured.over_budget).toBe(true);
        expect(structured.results[0]?.authorships).toEqual([huge]);
        expect(structured.windows?.[0]).toMatchObject({ offset: 0, shown: 1, total: 2 });
        expect(structured.notice).toMatch(/alone exceeds the 64,000-byte response budget/);
        const text = textOf(result);
        expect(text).toMatch(/\*\*Over budget:\*\*/);
        expect(text).toContain('"slice":{"field":"authorships","offset":1}');
      });

      it('rejects a negative offset at the schema layer', async () => {
        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id,
          slice: { field: 'authorships', offset: -1 },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
      });

      it('declares both slice reasons as handler-local ValidationErrors', () => {
        for (const reason of ['slice_without_id', 'slice_field_not_array']) {
          const entry = searchEntitiesTool.errors?.find((e) => e.reason === reason);
          expect(entry, `${reason} missing from the contract`).toBeDefined();
          expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(entry).not.toHaveProperty('thrownBy');
        }
      });
    });
  });
});
