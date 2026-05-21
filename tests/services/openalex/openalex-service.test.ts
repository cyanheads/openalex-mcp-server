/**
 * @fileoverview Tests for OpenAlexService — exercises normalizeId, buildFilterString,
 * reconstructAbstract, and error handling through the public API with mocked fetch.
 * @module services/openalex/openalex-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiKey: 'test-key',
    baseUrl: 'https://api.openalex.org',
  }),
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

    it('omits the sort param when no sort is provided', async () => {
      const service = await getService();
      await service.search({ entityType: 'works' }, createMockContext());
      expect(lastFetchUrl().searchParams.has('sort')).toBe(false);
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

    it('includes mailto in request URL', async () => {
      const service = await getService();
      await service.search({ entityType: 'works' }, createMockContext());
      expect(lastFetchUrl().searchParams.get('mailto')).toBe('test-key');
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

    it('strips mailto from the message when upstream body is not JSON (400)', async () => {
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
        data: { reason: 'upstream_invalid_params' },
        message: expect.not.stringMatching(/mailto|test-key/),
      });
    });

    it('strips mailto from the message when 404 body is not JSON', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

      const service = await getService();

      await expect(
        service.search({ entityType: 'works', id: 'W99999999999' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'entity_not_found' },
        message: expect.not.stringMatching(/mailto|test-key/),
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

    it('strips the alphabetically-truncated "Valid fields are" list when the body was cut mid-message', async () => {
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

      await expect(
        service.search(
          { entityType: 'works', filters: { nonexistent_filter: 'x' } },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: expect.stringMatching(
          /^nonexistent_filter is not a valid field\..*list of valid fields omitted/,
        ),
        data: {
          reason: 'upstream_invalid_params',
          upstreamMessage: expect.stringContaining('Valid fields are'),
        },
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
