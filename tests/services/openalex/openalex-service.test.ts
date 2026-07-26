/**
 * @fileoverview Tests for OpenAlexService — exercises normalizeId, buildFilterString,
 * reconstructAbstract, and error handling through the public API with mocked fetch.
 * @module services/openalex/openalex-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECT } from '@/services/openalex/types.js';

const mockConfig = vi.hoisted(() => ({
  apiKey: 'test-key',
  baseUrl: 'https://api.openalex.org',
  mailto: '',
}));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ ...mockConfig }),
}));

/** Capture the URL from the most recent fetch call. */
function lastFetchUrl(): URL {
  const call = vi.mocked(globalThis.fetch).mock.lastCall;
  if (!call) throw new Error('fetch was not called');
  return new URL(call[0] as string);
}

/** Find the first fetch URL matching `predicate`. Sample searches issue two parallel
 * calls (sample + population) — use this to pick the one under test. */
function findFetchUrl(predicate: (url: URL) => boolean): URL {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  for (const call of calls) {
    const url = new URL(call[0] as string);
    if (predicate(url)) return url;
  }
  throw new Error('no fetch call matched predicate');
}

describe('OpenAlexService', () => {
  beforeEach(() => {
    // Each call gets a fresh Response — parallel fetches (e.g., sample + population
    // lookup) would otherwise reuse the same body and hit `Body already used`.
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<Response>>().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ meta: { count: 0, per_page: 25 }, results: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    mockConfig.mailto = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function getService() {
    const { initOpenAlexService, getOpenAlexService } = await import(
      '@/services/openalex/openalex-service.js'
    );
    initOpenAlexService();
    return getOpenAlexService();
  }

  // --- Singleton lifecycle ---

  it('throws when accessed before initialization', async () => {
    const { getOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    expect(() => getOpenAlexService()).toThrow(/not initialized/);
  });

  // --- Field catalog smoke test (gh #40) ---

  describe('getFieldCatalog', () => {
    const ENTITY_TYPES_UNDER_TEST = [
      'works',
      'authors',
      'sources',
      'institutions',
      'topics',
      'keywords',
      'publishers',
      'funders',
    ] as const;

    it('returns non-empty filter and select arrays for every entity type', async () => {
      const { getFieldCatalog } = await import('@/services/openalex/openalex-service.js');
      const catalog = getFieldCatalog();

      for (const entityType of ENTITY_TYPES_UNDER_TEST) {
        const entry = catalog[entityType];
        expect(entry, `${entityType} missing from catalog`).toBeDefined();
        expect(entry.filter.length, `${entityType}.filter is empty`).toBeGreaterThan(0);
        expect(entry.select.length, `${entityType}.select is empty`).toBeGreaterThan(0);
      }
    });

    it('catalog works.filter contains expected common fields', async () => {
      const { getFieldCatalog } = await import('@/services/openalex/openalex-service.js');
      const { filter } = getFieldCatalog().works;
      expect(filter).toContain('publication_year');
      expect(filter).toContain('is_oa');
      expect(filter).toContain('awards.funder_id');
    });
  });

  // --- ID normalization (tested through search with id param) ---

  describe('normalizeId', () => {
    async function searchById(id: string): Promise<URL> {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search({ entityType: 'works', id }, createMockContext());
      return lastFetchUrl();
    }

    it('passes through OpenAlex IDs', async () => {
      const url = await searchById('W2741809807');
      expect(url.pathname).toBe('/works/W2741809807');
    });

    it('strips OpenAlex URL prefix', async () => {
      const url = await searchById('https://openalex.org/W2741809807');
      expect(url.pathname).toBe('/works/W2741809807');
    });

    it('normalizes DOI strings', async () => {
      const url = await searchById('10.1038/nature12373');
      expect(url.pathname).toBe('/works/doi:10.1038/nature12373');
    });

    it('normalizes DOI URLs', async () => {
      const url = await searchById('https://doi.org/10.1038/nature12373');
      expect(url.pathname).toBe('/works/doi:10.1038/nature12373');
    });

    it('normalizes ORCID', async () => {
      const url = await searchById('0000-0002-1825-0097');
      expect(url.pathname).toBe('/works/orcid:0000-0002-1825-0097');
    });

    it('normalizes ROR URL', async () => {
      const url = await searchById('https://ror.org/00hx57361');
      expect(url.pathname).toBe('/works/ror:https://ror.org/00hx57361');
    });

    it('normalizes ISSN', async () => {
      const url = await searchById('0028-0836');
      expect(url.pathname).toBe('/works/issn:0028-0836');
    });

    it('normalizes PMCID', async () => {
      const url = await searchById('PMC1234567');
      expect(url.pathname).toBe('/works/pmcid:PMC1234567');
    });

    it('normalizes PMID (pure numeric)', async () => {
      const url = await searchById('12345678');
      expect(url.pathname).toBe('/works/pmid:12345678');
    });
  });

  // --- Filter string building ---

  describe('buildFilterString', () => {
    it('builds comma-separated filter string', async () => {
      const service = await getService();
      await service.search(
        {
          entityType: 'works',
          filters: { cited_by_count: '>100', is_oa: 'true' },
        },
        createMockContext(),
      );

      const url = lastFetchUrl();
      const filter = url.searchParams.get('filter') ?? '';
      expect(filter).toContain('cited_by_count:>100');
      expect(filter).toContain('is_oa:true');
    });

    it('omits filter param when no filters provided', async () => {
      const service = await getService();
      await service.search({ entityType: 'works' }, createMockContext());
      expect(lastFetchUrl().searchParams.has('filter')).toBe(false);
    });

    // --- Comma-in-filter-value handling (gh #38) ---

    it('wraps a .search filter value containing a comma in double quotes (faithful phrase passthrough)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { 'title.search': 'deep, learning' } },
        createMockContext(),
      );
      const filter = lastFetchUrl().searchParams.get('filter') ?? '';
      expect(filter).toBe('title.search:"deep, learning"');
    });

    it('does not double-wrap a .search value already quoted', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { 'title.search': '"deep, learning"' } },
        createMockContext(),
      );
      const filter = lastFetchUrl().searchParams.get('filter') ?? '';
      expect(filter).toBe('title.search:"deep, learning"');
    });

    it('throws comma_in_filter_value for a non-search filter with a comma, naming the field', async () => {
      const service = await getService();
      await expect(
        service.search(
          { entityType: 'works', filters: { publication_year: '2020,2021' } },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: expect.stringContaining('publication_year'),
        data: { reason: 'comma_in_filter_value', filterKey: 'publication_year' },
      });
      // Pre-flight: fetch must not have been called.
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('passes comma-free filter values through unchanged', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { publication_year: '2020-2024' } },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('filter')).toBe('publication_year:2020-2024');
    });
  });

  // --- Abstract reconstruction ---

  describe('reconstructAbstract', () => {
    it('reconstructs abstract from inverted index and drops the raw index', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [
              {
                id: 'W1',
                display_name: 'Test',
                abstract_inverted_index: {
                  Machine: [0],
                  learning: [1],
                  is: [2],
                  great: [3],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toHaveProperty('abstract', 'Machine learning is great');
      expect(result.results[0]).not.toHaveProperty('abstract_inverted_index');
    });

    it('handles words appearing at multiple positions', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [
              {
                id: 'W1',
                display_name: 'Test',
                abstract_inverted_index: {
                  the: [0, 4],
                  cat: [1],
                  sat: [2],
                  on: [3],
                  mat: [5],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toHaveProperty('abstract', 'the cat sat on the mat');
    });
  });

  // --- HTML entity decoding ---

  describe('decodeHtmlEntities', () => {
    it('decodes numeric entities in display_name', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [
              {
                id: 'S1',
                display_name: 'Nature Clinical Practice Gastroenterology &#38; Hepatology',
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'sources' }, createMockContext());

      expect(result.results[0]).toHaveProperty(
        'display_name',
        'Nature Clinical Practice Gastroenterology & Hepatology',
      );
    });

    it('decodes malformed entities missing the trailing semicolon (real OpenAlex data)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              {
                id: 'S1',
                display_name: 'Nature Clinical Practice Gastroenterology &#38 Hepatology',
                entity_type: 'source',
                cited_by_count: 0,
                works_count: 0,
                external_id: null,
                hint: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.autocomplete(
        { entityType: 'sources', query: 'nature' },
        createMockContext(),
      );

      expect(result.results[0]?.display_name).toBe(
        'Nature Clinical Practice Gastroenterology & Hepatology',
      );
    });

    it('decodes hex entities in nested string fields', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [
              {
                id: 'W1',
                display_name: 'Test',
                primary_location: { source: { raw_source_name: 'Foo &#x27E9; Bar' } },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());

      const location = result.results[0]?.primary_location as {
        source: { raw_source_name: string };
      };
      expect(location.source.raw_source_name).toBe('Foo ⟩ Bar');
    });

    it('decodes named entities (&amp; &lt; &gt;) in autocomplete results', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              {
                id: 'A1',
                display_name: 'Smith &amp; Jones',
                entity_type: 'author',
                cited_by_count: 0,
                works_count: 0,
                external_id: null,
                hint: '&lt;hint&gt;',
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.autocomplete(
        { entityType: 'authors', query: 'smith' },
        createMockContext(),
      );

      expect(result.results[0]).toMatchObject({
        display_name: 'Smith & Jones',
        hint: '<hint>',
      });
    });

    it('passes through strings with no entities unchanged', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [{ id: 'W1', display_name: 'Plain Title' }],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());
      expect(result.results[0]?.display_name).toBe('Plain Title');
    });

    it('leaves unknown named entities intact', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [{ id: 'W1', display_name: 'Foo &madeupentity; Bar' }],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());
      expect(result.results[0]?.display_name).toBe('Foo &madeupentity; Bar');
    });

    it('leaves out-of-range numeric code points intact instead of throwing', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [{ id: 'W1', display_name: 'Decimal &#9999999999; Hex &#xFFFFFF; Done' }],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());
      expect(result.results[0]?.display_name).toBe('Decimal &#9999999999; Hex &#xFFFFFF; Done');
    });

    it('decodes entities that live in abstract_inverted_index word keys', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [
              {
                id: 'W1',
                display_name: 'Test',
                abstract_inverted_index: {
                  Apple: [0],
                  '&amp;': [1],
                  Friends: [2],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());
      expect(result.results[0]).toHaveProperty('abstract', 'Apple & Friends');
    });

    it('decodes entities in analyze group_by labels', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 100 },
            group_by: [
              {
                key: 'https://openalex.org/I1',
                key_display_name: 'University &#38; Research Inst',
                count: 50,
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'authorships.institutions.id' },
        createMockContext(),
      );
      expect(result.groups[0]?.key_display_name).toBe('University & Research Inst');
    });
  });

  // --- Select translation (abstract → abstract_inverted_index, year → publication_year, …) ---

  describe('translateSelect', () => {
    it('rewrites select: ["abstract"] to abstract_inverted_index for works', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', select: ['id', 'display_name', 'abstract'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,abstract_inverted_index',
      );
    });

    it('rewrites year → publication_year and authors → authorships for works', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', select: ['id', 'display_name', 'year', 'authors'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,publication_year,authorships',
      );
    });

    it('translates abstract on singleton id lookup', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search(
        { entityType: 'works', id: 'W1', select: ['id', 'display_name', 'abstract'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,abstract_inverted_index',
      );
    });

    it('does not translate abstract for non-works entities', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'authors', select: ['id', 'display_name', 'abstract'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,abstract');
    });

    it('does not translate year on non-works entities', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'authors', select: ['id', 'display_name', 'year'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,year');
    });

    it('reconstructs abstract end-to-end when select uses the alias', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [
              {
                id: 'W1',
                display_name: 'Test',
                abstract_inverted_index: { Hello: [0], world: [1] },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', select: ['id', 'display_name', 'abstract'] },
        createMockContext(),
      );
      expect(result.results[0]).toHaveProperty('abstract', 'Hello world');
      expect(result.results[0]).not.toHaveProperty('abstract_inverted_index');
    });
  });

  // --- Filter key translation (gh #17) ---

  describe('translateFilters', () => {
    function filterParam(): string {
      return lastFetchUrl().searchParams.get('filter') ?? '';
    }

    it('rewrites cited_works → cites for works', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { cited_works: 'W2741809807' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('cites:W2741809807');
    });

    it('rewrites year → publication_year for works (range value passes through)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { year: '2020-2024' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('publication_year:2020-2024');
    });

    it('rewrites id → openalex when value is a bare OpenAlex ID', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { id: 'W2741809807' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('openalex:W2741809807');
    });

    it('rewrites id → openalex for pipe-joined OpenAlex IDs', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { id: 'W123|W456|W789' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('openalex:W123|W456|W789');
    });

    it('rewrites id → openalex when value is a URL-form OpenAlex ID', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { id: 'https://openalex.org/W2741809807' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('openalex:https://openalex.org/W2741809807');
    });

    it('rewrites id → openalex universally (works on non-works entities too)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'authors', filters: { id: 'A1234567890' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('openalex:A1234567890');
    });

    it('does not rewrite id when the value is not an OpenAlex ID (fail-open)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { id: 'not-an-openalex-id' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('id:not-an-openalex-id');
    });

    it('does not rewrite cited_works on non-works entities (fail-open to upstream)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'authors', filters: { cited_works: 'W123' } },
        createMockContext(),
      );
      expect(filterParam()).toBe('cited_works:W123');
    });

    it('passes canonical filter keys through unchanged', async () => {
      const service = await getService();
      await service.search(
        {
          entityType: 'works',
          filters: { publication_year: '2024', cites: 'W123', is_oa: 'true' },
        },
        createMockContext(),
      );
      const filter = filterParam();
      expect(filter).toContain('publication_year:2024');
      expect(filter).toContain('cites:W123');
      expect(filter).toContain('is_oa:true');
    });

    it('also applies aliases on the analyze path', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze(
        {
          entityType: 'works',
          groupBy: 'oa_status',
          filters: { year: '2024', id: 'W123' },
        },
        createMockContext(),
      );
      const filter = filterParam();
      expect(filter).toContain('publication_year:2024');
      expect(filter).toContain('openalex:W123');
    });
  });

  // --- Random sampling (gh #14) ---

  describe('sample and seed', () => {
    const sampleUrl = (): URL => findFetchUrl((u) => u.searchParams.has('sample'));
    const populationUrl = (): URL =>
      findFetchUrl((u) => !u.searchParams.has('sample') && u.searchParams.get('per_page') === '1');

    it('passes sample as a query param and aligns per_page to it', async () => {
      const service = await getService();
      await service.search({ entityType: 'works', sample: 7 }, createMockContext());
      const url = sampleUrl();
      expect(url.searchParams.get('sample')).toBe('7');
      expect(url.searchParams.get('per_page')).toBe('7');
    });

    it('omits cursor on the sample request (single-page contract)', async () => {
      const service = await getService();
      await service.search({ entityType: 'works', sample: 5 }, createMockContext());
      expect(sampleUrl().searchParams.has('cursor')).toBe(false);
    });

    it('passes seed when sample is set', async () => {
      const service = await getService();
      await service.search({ entityType: 'works', sample: 3, seed: 'abc' }, createMockContext());
      expect(sampleUrl().searchParams.get('seed')).toBe('abc');
    });

    it('overrides caller-supplied per_page when sample is set', async () => {
      const service = await getService();
      await service.search({ entityType: 'works', sample: 5, perPage: 25 }, createMockContext());
      expect(sampleUrl().searchParams.get('per_page')).toBe('5');
    });

    it('does not send sample/seed when sample is undefined', async () => {
      const service = await getService();
      await service.search({ entityType: 'works' }, createMockContext());
      const url = lastFetchUrl();
      expect(url.searchParams.has('sample')).toBe(false);
      expect(url.searchParams.has('seed')).toBe(false);
      expect(url.searchParams.get('cursor')).toBe('*');
    });

    it('issues a parallel population lookup so meta.count reports the true match count', async () => {
      vi.mocked(globalThis.fetch).mockImplementation((input) => {
        const url = new URL(input as string);
        const count = url.searchParams.has('sample') ? 5 : 1_234_567;
        return Promise.resolve(
          new Response(JSON.stringify({ meta: { count, per_page: count }, results: [] }), {
            status: 200,
          }),
        );
      });
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', sample: 5, filters: { publication_year: '2023' } },
        createMockContext(),
      );
      expect(result.meta.count).toBe(1_234_567);
      const head = populationUrl();
      expect(head.searchParams.get('filter')).toBe('publication_year:2023');
      expect(head.searchParams.get('cursor')).toBe('*');
      expect(head.searchParams.has('seed')).toBe(false);
    });
  });

  // --- Required-field injection (regression: gh #11) ---

  describe('select required-field injection', () => {
    it('prepends id and display_name when caller-supplied select omits them (search path)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'rag', select: ['doi', 'title', 'publication_year'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,doi,title,publication_year',
      );
    });

    it('prepends id and display_name on singleton id-lookup path', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Test', doi: 'd' }), {
          status: 200,
        }),
      );
      const service = await getService();
      await service.search({ entityType: 'works', id: 'W1', select: ['doi'] }, createMockContext());
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,doi');
    });

    it('does not duplicate id or display_name when caller already includes them', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', select: ['id', 'display_name', 'doi'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,doi');
    });

    it('injects display_name when caller supplies only id', async () => {
      const service = await getService();
      await service.search({ entityType: 'authors', select: ['id', 'orcid'] }, createMockContext());
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,orcid');
    });
  });

  // --- Curated default + full-record opt-out (gh #29) ---

  describe('curated default on id lookups (gh #29)', () => {
    it('applies the curated DEFAULT_SELECT to a bare id lookup', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search({ entityType: 'works', id: 'W1' }, createMockContext());

      const select = lastFetchUrl().searchParams.get('select');
      expect(select).not.toBeNull();
      const fields = new Set(select?.split(','));
      for (const field of DEFAULT_SELECT.works) expect(fields.has(field)).toBe(true);
    });

    it('omits select for a full-record id lookup via ["*"]', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search({ entityType: 'works', id: 'W1', select: ['*'] }, createMockContext());
      expect(lastFetchUrl().searchParams.has('select')).toBe(false);
    });

    it('omits select for a full-record search via ["*"]', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'climate', select: ['*'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.has('select')).toBe(false);
    });

    it('treats select: [] as no preference — curated default, not the full record', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search({ entityType: 'works', id: 'W1', select: [] }, createMockContext());
      expect(lastFetchUrl().searchParams.has('select')).toBe(true);
    });
  });

  // --- Search params ---

  describe('search', () => {
    it('sets search param for keyword mode', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'climate', searchMode: 'keyword' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('search')).toBe('climate');
    });

    it('sets search.exact for exact mode', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'climate change', searchMode: 'exact' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('search.exact')).toBe('climate change');
    });

    it('sets search.semantic for semantic mode', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'effects of warming', searchMode: 'semantic' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('search.semantic')).toBe('effects of warming');
    });

    it('passes select as comma-joined string', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', select: ['id', 'display_name', 'doi'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,doi');
    });

    it('passes sort and pagination params', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', sort: '-cited_by_count', perPage: 10, cursor: 'abc' },
        createMockContext(),
      );
      const url = lastFetchUrl();
      expect(url.searchParams.get('sort')).toBe('cited_by_count:desc');
      expect(url.searchParams.get('per_page')).toBe('10');
      expect(url.searchParams.get('cursor')).toBe('abc');
    });

    it('passes a bare sort field unchanged (ascending default)', async () => {
      const service = await getService();
      await service.search({ entityType: 'works', sort: 'publication_date' }, createMockContext());
      expect(lastFetchUrl().searchParams.get('sort')).toBe('publication_date');
    });

    it('coerces bare relevance_score to descending', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'climate', sort: 'relevance_score' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe('relevance_score:desc');
    });

    it('passes -relevance_score as relevance_score:desc', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'climate', sort: '-relevance_score' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe('relevance_score:desc');
    });

    // --- Multi-key sort normalization (gh #52) ---

    it('moves :desc onto the dash-prefixed key, not the last key, in a multi-key sort', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', sort: '-publication_year,cited_by_count' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe('publication_year:desc,cited_by_count');
    });

    it('normalizes a descending marker on a non-leading key', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', sort: 'publication_year,-cited_by_count' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe('publication_year,cited_by_count:desc');
    });

    it('normalizes every dash-prefixed key independently', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', sort: '-publication_year,-cited_by_count' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe(
        'publication_year:desc,cited_by_count:desc',
      );
    });

    it('leaves an already-suffixed key alone while normalizing its dash-prefixed sibling', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', sort: 'publication_year:desc,-cited_by_count' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe(
        'publication_year:desc,cited_by_count:desc',
      );
    });

    it('coerces a bare relevance_score key inside a multi-key sort', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', query: 'climate', sort: 'relevance_score,-publication_year' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe(
        'relevance_score:desc,publication_year:desc',
      );
    });

    it('tolerates whitespace around comma-separated sort keys', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', sort: '-publication_year, cited_by_count' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('sort')).toBe('publication_year:desc,cited_by_count');
    });

    it('omits the sort param when no sort is provided', async () => {
      const service = await getService();
      await service.search({ entityType: 'works' }, createMockContext());
      expect(lastFetchUrl().searchParams.has('sort')).toBe(false);
    });

    // --- Untitled records (gh #51) ---

    it('passes a null display_name through untouched instead of rejecting the record', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'https://openalex.org/W4235673932',
            display_name: null,
            title: null,
            type: 'paratext',
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', id: 'W4235673932' },
        createMockContext(),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toHaveProperty('display_name', null);
      expect(result.results[0]).toHaveProperty('type', 'paratext');
    });

    it('keeps sibling records on a page containing an untitled one', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 2, per_page: 25 },
            results: [
              { id: 'W4235673932', display_name: null },
              { id: 'W2741809807', display_name: 'A Titled Paper' },
            ],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', filters: { openalex: 'W4235673932|W2741809807' } },
        createMockContext(),
      );

      expect(result.results.map((r) => r.display_name)).toEqual([null, 'A Titled Paper']);
    });

    it('wraps single entity in standard response shape', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Solo Paper' }), { status: 200 }),
      );
      const service = await getService();
      const result = await service.search({ entityType: 'works', id: 'W1' }, createMockContext());

      expect(result.meta).toEqual({ count: 1, per_page: 1, next_cursor: null });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toHaveProperty('display_name', 'Solo Paper');
    });
  });

  // --- Analyze ---

  describe('analyze', () => {
    it('sets group_by param', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 100 },
            group_by: [{ key: '2024', key_display_name: '2024', count: 50 }],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'publication_year' },
        createMockContext(),
      );

      expect(lastFetchUrl().searchParams.get('group_by')).toBe('publication_year');
      expect(result.groups).toHaveLength(1);
      expect(result.meta.count).toBe(100);
    });

    it('appends :include_unknown when requested', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze(
        { entityType: 'works', groupBy: 'oa_status', includeUnknown: true },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('group_by')).toBe('oa_status:include_unknown');
    });

    it('handles missing group_by in response', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 } }), { status: 200 }),
      );
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'type' },
        createMockContext(),
      );
      expect(result.groups).toEqual([]);
    });

    it('forwards per_page when provided', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze(
        { entityType: 'works', groupBy: 'type', perPage: 10 },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('per_page')).toBe('10');
    });

    it('omits per_page when not provided', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze({ entityType: 'works', groupBy: 'type' }, createMockContext());
      expect(lastFetchUrl().searchParams.has('per_page')).toBe(false);
    });

    // --- cursor / sort-order fix (gh #37) ---

    it('omits cursor on the first page (count-desc default)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze(
        { entityType: 'works', groupBy: 'primary_topic.field.id' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.has('cursor')).toBe(false);
    });

    it('sends cursor=* when order is "key" (key-asc enumeration first page)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze(
        { entityType: 'works', groupBy: 'primary_topic.field.id', order: 'key' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('cursor')).toBe('*');
    });

    it('forwards an explicit cursor on subsequent pages regardless of order', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze(
        { entityType: 'works', groupBy: 'primary_topic.field.id', cursor: 'abc123' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('cursor')).toBe('abc123');
    });

    it('omits cursor for boolean fields even with order: "key" (upstream rejects cursor on boolean fields)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze(
        { entityType: 'works', groupBy: 'is_oa', order: 'key' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.has('cursor')).toBe(false);
    });

    it('omits cursor for boolean fields in count-desc mode', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.analyze({ entityType: 'works', groupBy: 'is_retracted' }, createMockContext());
      expect(lastFetchUrl().searchParams.has('cursor')).toBe(false);
    });
  });

  // --- Response metrics ---

  describe('response metrics logging', () => {
    it('logs cost_usd and db_response_time_ms from meta at debug level', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 10, per_page: 25, cost_usd: 0.0002, db_response_time_ms: 42 },
            results: [],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const ctx = createMockContext();
      const debug = vi.spyOn(ctx.log, 'debug');

      await service.search({ entityType: 'works' }, ctx);

      const metricsCall = debug.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg === 'OpenAlex response metrics',
      );
      expect(metricsCall).toBeDefined();
      expect(metricsCall?.[1]).toMatchObject({ costUsd: 0.0002, dbResponseTimeMs: 42 });
    });

    it('does not log metrics when meta lacks both fields', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, results: [] }), { status: 200 }),
      );
      const service = await getService();
      const ctx = createMockContext();
      const debug = vi.spyOn(ctx.log, 'debug');

      await service.search({ entityType: 'works' }, ctx);

      const metricsCall = debug.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg === 'OpenAlex response metrics',
      );
      expect(metricsCall).toBeUndefined();
    });
  });

  // --- Autocomplete ---

  describe('autocomplete', () => {
    it('uses entity-specific path when entityType provided', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.autocomplete({ entityType: 'authors', query: 'smith' }, createMockContext());
      expect(lastFetchUrl().pathname).toBe('/autocomplete/authors');
      expect(lastFetchUrl().searchParams.get('q')).toBe('smith');
    });

    it('uses cross-entity path when entityType omitted', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      const service = await getService();
      await service.autocomplete({ query: 'harvard' }, createMockContext());
      expect(lastFetchUrl().pathname).toBe('/autocomplete');
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('surfaces OpenAlex 400 messages as invalid params without retrying', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Invalid query parameters error.',
            message:
              'abstract is not a valid select field. Valid fields for select are: id, doi, title, abstract_inverted_index.',
          }),
          { status: 400, statusText: 'Bad Request' },
        ),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message:
          'abstract is not a valid select field. Valid fields for select are: id, doi, title, abstract_inverted_index.',
        data: { reason: 'upstream_invalid_params' },
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    // --- Invalid-params 400 reason branching (gh #43) ---

    describe('invalid-params 400 reason branching (gh #43)', () => {
      /** Mock a single non-retried 400 carrying the given upstream message. */
      function mock400(message: string): void {
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(JSON.stringify({ error: 'Invalid query parameters error.', message }), {
            status: 400,
            statusText: 'Bad Request',
          }),
        );
      }

      it('keeps upstream_invalid_params when a field name is rejected', async () => {
        mock400('bogus_field is not a valid field for group_by.');
        const service = await getService();
        await expect(
          service.search({ entityType: 'works' }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_invalid_params' },
        });
      });

      it('maps a relevance-sort-without-search 400 to upstream_sort_requires_search', async () => {
        mock400(
          'Must include a search query (such as ?search=example or /filter=fulltext.search:example) in order to sort by relevance_score.',
        );
        const service = await getService();
        await expect(
          service.search({ entityType: 'works', sort: '-relevance_score' }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_sort_requires_search' },
        });
      });

      it('maps an ungroupable group_by 400 to upstream_ungroupable_group_by', async () => {
        mock400('Cannot group by date, number, or search fields.');
        const service = await getService();
        await expect(
          service.analyze(
            { entityType: 'works', groupBy: 'publication_date' },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_ungroupable_group_by' },
        });
      });

      it('maps a non-ID filter value 400 to upstream_invalid_id_value (gh #49)', async () => {
        // Verbatim upstream body — OpenAlex splits the filter value on whitespace before
        // validating, so it names only the first token of the name that was passed.
        mock400("'Albert' is not a valid OpenAlex ID.");
        const service = await getService();
        await expect(
          service.search(
            { entityType: 'works', filters: { 'authorships.author.id': 'Albert Einstein' } },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_invalid_id_value' },
        });
      });

      it('resolves the resolve_name recovery hint for an invalid-ID-value 400', async () => {
        mock400("'Harvard' is not a valid OpenAlex ID.");
        const ctx = createMockContext({
          errors: [
            {
              reason: 'upstream_invalid_id_value',
              code: JsonRpcErrorCode.InvalidParams,
              when: 'an entity-ID filter received a name',
              recovery: 'DISTINCTIVE_ID_HINT call openalex_resolve_name to get the ID first.',
            },
          ],
        });
        const service = await getService();
        await expect(
          service.search(
            { entityType: 'works', filters: { 'authorships.institutions.id': 'Harvard' } },
            ctx,
          ),
        ).rejects.toMatchObject({
          data: {
            reason: 'upstream_invalid_id_value',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_ID_HINT') },
          },
        });
      });

      it('keeps a plainly-malformed value in the neutral bucket, not the ID bucket', async () => {
        mock400('Value for param publication_year must be a number.');
        const service = await getService();
        await expect(
          service.search(
            { entityType: 'works', filters: { publication_year: 'notayear' } },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_invalid_params_other' },
        });
      });

      it('maps any other 400 to the neutral upstream_invalid_params_other', async () => {
        mock400('Invalid cursor value provided.');
        const service = await getService();
        await expect(
          service.search({ entityType: 'works', cursor: 'garbage' }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_invalid_params_other' },
        });
      });

      it('resolves the picked reason recovery hint from the caller contract', async () => {
        mock400(
          'Must include a search query (such as ?search=example) in order to sort by relevance_score.',
        );
        const ctx = createMockContext({
          errors: [
            {
              reason: 'upstream_sort_requires_search',
              code: JsonRpcErrorCode.ValidationError,
              when: 'relevance sort requested without an active search',
              recovery: 'DISTINCTIVE_HINT add a query or choose another sort field.',
            },
          ],
        });
        const service = await getService();
        await expect(
          service.search({ entityType: 'works', sort: '-relevance_score' }, ctx),
        ).rejects.toMatchObject({
          data: {
            reason: 'upstream_sort_requires_search',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_HINT') },
          },
        });
      });
    });

    it('surfaces OpenAlex 422 responses as validation errors', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ message: 'Filter value out of range.' }), {
          status: 422,
          statusText: 'Unprocessable Entity',
        }),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'Filter value out of range.',
        data: { reason: 'upstream_validation_failed' },
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('maps 429 responses to rateLimited and retries them', async () => {
      vi.useFakeTimers();
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' }),
      );
      const service = await getService();
      const promise = service.search({ entityType: 'works' }, createMockContext());
      const rejection = expect(promise).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        message: expect.stringMatching(/Status: 429/),
        data: { reason: 'rate_limited' },
      });

      await vi.runAllTimersAsync();

      await rejection;
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    // --- 429 budget-vs-throttle branching (gh #54) ---

    describe('429 reason branching (gh #54)', () => {
      /** Mock a 429 carrying the given upstream body. */
      function mock429(body: string): void {
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.resolve(new Response(body, { status: 429, statusText: 'Too Many Requests' })),
        );
      }

      it('maps a budget-exhausted 429 to upstream_budget_exhausted and fails fast', async () => {
        mock429(
          JSON.stringify({
            error: 'Rate limit exceeded.',
            message:
              'Insufficient budget. This request costs $0.001 but you only have $0 remaining. Resets at midnight.',
          }),
        );
        const service = await getService();

        await expect(
          service.search({ entityType: 'works' }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'upstream_budget_exhausted', retryable: false },
        });
        // `retryable: false` opts the error out of withRetry's transient set — a budget wall
        // fails identically on every attempt, so burning the full budget buys nothing.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['insufficient budget', 'Insufficient budget for this request.'],
        ['midnight reset', 'You are out of credit. Resets at midnight UTC.'],
        ['remaining budget', 'Daily budget exceeded — $0 remaining until the reset.'],
      ])('recognizes the budget shape from its %s wording', async (_label, message) => {
        mock429(JSON.stringify({ message }));
        const service = await getService();
        await expect(
          service.search({ entityType: 'works' }, createMockContext()),
        ).rejects.toMatchObject({ data: { reason: 'upstream_budget_exhausted' } });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it('leaves a burst-throttle 429 on the retryable rate_limited reason', async () => {
        vi.useFakeTimers();
        mock429(
          JSON.stringify({
            message:
              'Anonymous search is temporarily rate-limited due to heavy load. Try again shortly or use a free API key.',
          }),
        );
        const service = await getService();
        const promise = service.search({ entityType: 'works' }, createMockContext());
        const rejection = expect(promise).rejects.toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'rate_limited' },
        });

        await vi.runAllTimersAsync();

        await rejection;
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('resolves the budget recovery hint from the caller contract', async () => {
        mock429(JSON.stringify({ message: 'Insufficient budget. Resets at midnight.' }));
        const ctx = createMockContext({
          errors: [
            {
              reason: 'upstream_budget_exhausted',
              code: JsonRpcErrorCode.RateLimited,
              when: 'the daily usage budget is spent',
              retryable: false,
              recovery: 'DISTINCTIVE_BUDGET_HINT the budget refills at midnight UTC.',
            },
          ],
        });
        const service = await getService();
        await expect(service.search({ entityType: 'works' }, ctx)).rejects.toMatchObject({
          data: {
            reason: 'upstream_budget_exhausted',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_BUDGET_HINT') },
          },
        });
      });
    });

    // --- Statusless fetch failures: timeout, network, unparseable body (gh #53) ---

    describe('statusless fetch failures (gh #53)', () => {
      /** Contract covering both transient reasons, so the recovery hint is resolvable. */
      function transientCtx() {
        return createMockContext({
          errors: [
            {
              reason: 'upstream_timeout',
              code: JsonRpcErrorCode.Timeout,
              when: 'OpenAlex did not respond within the request deadline',
              retryable: true,
              recovery: 'DISTINCTIVE_TIMEOUT_HINT retry after a short delay.',
            },
            {
              reason: 'upstream_unavailable',
              code: JsonRpcErrorCode.ServiceUnavailable,
              when: 'OpenAlex is unavailable',
              retryable: true,
              recovery: 'DISTINCTIVE_UNAVAILABLE_HINT wait and retry.',
            },
          ],
        });
      }

      it('classifies a client-side request timeout as upstream_timeout with its recovery hint', async () => {
        vi.useFakeTimers();
        // Never settles on its own — only the composed abort signal ends it, which is what
        // the framework's REQUEST_TIMEOUT_MS deadline fires.
        vi.mocked(globalThis.fetch).mockImplementation(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              const signal = (init as RequestInit | undefined)?.signal;
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        );

        const service = await getService();
        const promise = service.search({ entityType: 'works' }, transientCtx());
        const rejection = expect(promise).rejects.toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: {
            reason: 'upstream_timeout',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_TIMEOUT_HINT') },
          },
        });

        await vi.runAllTimersAsync();

        await rejection;
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('states the timeout in OpenAlex terms rather than fetch plumbing', async () => {
        vi.useFakeTimers();
        vi.mocked(globalThis.fetch).mockImplementation(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              const signal = (init as RequestInit | undefined)?.signal;
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        );

        const service = await getService();
        const promise = service.search({ entityType: 'works' }, createMockContext());
        const rejection = expect(promise).rejects.toMatchObject({
          message: expect.stringContaining('OpenAlex did not respond within 10s for /works'),
        });

        await vi.runAllTimersAsync();

        await rejection;
      });

      it('classifies a network failure as upstream_unavailable with its recovery hint', async () => {
        vi.useFakeTimers();
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.reject(new TypeError('fetch failed')),
        );

        const service = await getService();
        const promise = service.search({ entityType: 'works' }, transientCtx());
        const rejection = expect(promise).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining('Could not reach the OpenAlex API for /works'),
          data: {
            reason: 'upstream_unavailable',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_UNAVAILABLE_HINT') },
          },
        });

        await vi.runAllTimersAsync();

        await rejection;
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('attaches the recovery hint to an HTML-instead-of-JSON response', async () => {
        vi.useFakeTimers();
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.resolve(
            new Response('<html><body>503</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
          ),
        );

        const service = await getService();
        const promise = service.search({ entityType: 'works' }, transientCtx());
        const rejection = expect(promise).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining('returned HTML instead of JSON'),
          data: {
            reason: 'upstream_unavailable',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_UNAVAILABLE_HINT') },
          },
        });

        await vi.runAllTimersAsync();

        await rejection;
      });

      it('attaches the recovery hint to a truncated-JSON response', async () => {
        vi.useFakeTimers();
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.resolve(
            new Response('{"meta":', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
        );

        const service = await getService();
        const promise = service.search({ entityType: 'works' }, transientCtx());
        const rejection = expect(promise).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining('returned invalid JSON'),
          data: {
            reason: 'upstream_unavailable',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_UNAVAILABLE_HINT') },
          },
        });

        await vi.runAllTimersAsync();

        await rejection;
      });

      it('attaches the recovery hint to an empty response body', async () => {
        vi.useFakeTimers();
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.resolve(new Response('   ', { status: 200 })),
        );

        const service = await getService();
        const promise = service.search({ entityType: 'works' }, transientCtx());
        const rejection = expect(promise).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining('returned an empty response'),
          data: {
            reason: 'upstream_unavailable',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_UNAVAILABLE_HINT') },
          },
        });

        await vi.runAllTimersAsync();

        await rejection;
      });

      it('keeps the credential out of a network-failure message', async () => {
        vi.useFakeTimers();
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.reject(new TypeError('fetch failed')),
        );

        const service = await getService();
        const promise = service.search({ entityType: 'works' }, createMockContext());
        const rejection = expect(promise).rejects.toMatchObject({
          message: expect.not.stringMatching(/api_key|mailto|test-key/),
        });

        await vi.runAllTimersAsync();

        await rejection;
      });
    });

    it('maps 404 responses to notFound without retrying', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ message: 'No entity found for W404.' }), {
          status: 404,
          statusText: 'Not Found',
        }),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works', id: 'W404' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'No entity found for W404.',
        data: { reason: 'entity_not_found' },
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('maps other 4xx responses to invalidRequest without retrying', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ message: 'Payload too large for this endpoint.' }), {
          status: 413,
          statusText: 'Payload Too Large',
        }),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        message: 'Payload too large for this endpoint.',
        data: { reason: 'upstream_invalid_request' },
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('sends the configured credential as api_key, not mailto', async () => {
      const service = await getService();
      await service.search({ entityType: 'works' }, createMockContext());
      const url = lastFetchUrl();
      expect(url.searchParams.get('api_key')).toBe('test-key');
      expect(url.searchParams.has('mailto')).toBe(false);
    });

    it('forwards OPENALEX_MAILTO as mailto= alongside api_key', async () => {
      mockConfig.mailto = 'ops@example.org';
      const service = await getService();
      await service.search({ entityType: 'works' }, createMockContext());
      const url = lastFetchUrl();
      expect(url.searchParams.get('api_key')).toBe('test-key');
      expect(url.searchParams.get('mailto')).toBe('ops@example.org');
    });

    it('retries malformed JSON responses before failing', async () => {
      vi.useFakeTimers();
      vi.mocked(globalThis.fetch).mockImplementation(() =>
        Promise.resolve(
          new Response('{"meta":', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const service = await getService();
      const promise = service.search({ entityType: 'works' }, createMockContext());
      const rejection = expect(promise).rejects.toThrow(/returned invalid JSON/);

      await vi.runAllTimersAsync();

      await rejection;
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('classifies HTML success responses as transient upstream failures', async () => {
      vi.useFakeTimers();
      vi.mocked(globalThis.fetch).mockImplementation(() =>
        Promise.resolve(
          new Response('<html><body>Rate limited</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
      );

      const service = await getService();
      const promise = service.search({ entityType: 'works' }, createMockContext());
      const rejection = expect(promise).rejects.toThrow(/returned HTML instead of JSON/);

      await vi.runAllTimersAsync();

      await rejection;
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('strips the api_key credential from the message when upstream body is not JSON (400)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' }),
      );

      const service = await getService();

      await expect(
        service.search(
          { entityType: 'works', id: 'W1', select: ['this_field_does_not_exist'] },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'upstream_invalid_params_other' },
        message: expect.not.stringMatching(/api_key|mailto|test-key/),
      });
    });

    it('strips the api_key credential from the message when 404 body is not JSON', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works', id: 'W99999999999' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'entity_not_found' },
        message: expect.not.stringMatching(/api_key|mailto|test-key/),
      });
    });

    it('falls back to upstream `error` when `message` is missing', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Invalid query parameters error.' }), {
          status: 400,
          statusText: 'Bad Request',
        }),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: 'Invalid query parameters error.',
      });
    });

    /**
     * Framework caps error responseBody at 500 bytes. OpenAlex 400 bodies that enumerate
     * valid fields routinely exceed that, so strict JSON.parse fails on the truncated
     * tail and historically dropped the useful prefix on the floor (#19). Regex fallback
     * recovers the surviving message even when the closing quote is past the cap.
     */
    it('extracts upstream message from a body truncated mid-string (gh #19)', async () => {
      const longMessage =
        'totally_made_up_field is not a valid select field. Valid fields for select are: ' +
        'id, doi, title, display_name, relevance_score, publication_year, publication_date, ' +
        'ids, language, primary_location, sources, type, type_crossref, indexed_in, open_access, ' +
        'authorships, institution_assertions, institutions, countries_distinct_count, ' +
        'institutions_distinct_count, corresponding_author_ids, corresponding_institution_ids, ' +
        'apc_list, apc_paid, fwci, is_authors_truncated, has_fulltext, fulltext_origin, ' +
        'cited_by_count, citation_normalized_percentile, cited_by_percentile_year, biblio, ' +
        'is_retracted, is_paratext, is_xpac, primary_topic, topics, keywords, concepts, mesh.';
      const fullBody = JSON.stringify({
        error: 'Invalid query parameters error.',
        message: longMessage,
      });
      // Verifies the fixture actually exercises the truncation path the fix targets.
      expect(fullBody.length).toBeGreaterThan(500);

      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(fullBody, { status: 400, statusText: 'Bad Request' }),
      );

      const service = await getService();

      await expect(
        service.search(
          { entityType: 'works', select: ['totally_made_up_field'] },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'upstream_invalid_params' },
        message: expect.stringContaining('totally_made_up_field is not a valid select field'),
      });
    });

    it('strips the truncated "Valid fields are" list and appends catalog-backed suggestions', async () => {
      const longMessage =
        'nonexistent_filter is not a valid field. Valid fields are underscore or hyphenated versions of: ' +
        'abstract.search, abstract.search.exact, apc_list.currency, apc_list.provenance, apc_list.value, ' +
        'apc_list.value_usd, apc_paid.currency, apc_paid.provenance, apc_paid.value, apc_paid.value_usd, ' +
        'author.id, author.orcid, authors_count, authorships.affiliations.institution_ids, ' +
        'authorships.author.id, authorships.author.orcid, authorships.count, ' +
        'best_oa_location.is_oa, best_oa_location.license, best_oa_location.source.id, ' +
        'best_oa_location.source.issn, best_oa_location.source.publisher_lineage, best_oa_location.version, ' +
        'biblio.first_page, biblio.issue, biblio.last_page, biblio.volume, cited_by_count, cites, ' +
        'concepts.id, concepts.wikidata, corresponding_author_ids, corresponding_institution_ids';
      const fullBody = JSON.stringify({
        error: 'Invalid query parameters error.',
        message: longMessage,
      });
      expect(fullBody.length).toBeGreaterThan(500);

      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(fullBody, { status: 400, statusText: 'Bad Request' }),
      );
      const service = await getService();

      const err = (await service
        .search({ entityType: 'works', filters: { nonexistent_filter: 'x' } }, createMockContext())
        .catch((e) => e)) as { code: unknown; message: string; data: Record<string, unknown> };

      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      // Catalog-backed suggestions replace the truncated valid-fields list. The two are
      // mutually exclusive — the message reads cleanly with no leftover strip-note.
      expect(err.message).toMatch(
        /^nonexistent_filter is not a valid field\. Did you mean: .+\? Browse all with openalex_describe_fields/,
      );
      expect(err.message).not.toContain('list of valid fields omitted');
      expect(err.data).toMatchObject({
        reason: 'upstream_invalid_params',
        upstreamMessage: expect.stringContaining('Valid fields are'),
      });
    });

    it('still surfaces the full message when body fits within the truncation cap', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Invalid query parameters error.',
            message: 'short error message.',
          }),
          { status: 400, statusText: 'Bad Request' },
        ),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: 'short error message.',
      });
    });

    it('stops retrying when ctx.signal aborts during backoff', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const ctx = createMockContext({ signal: controller.signal });
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' }),
      );

      const service = await getService();
      const promise = service.search({ entityType: 'works' }, ctx);
      const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      controller.abort(new DOMException('Cancelled', 'AbortError'));

      await rejection;
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
