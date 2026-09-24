/**
 * @fileoverview Tests for OpenAlexService — exercises normalizeId, buildFilterString,
 * reconstructAbstract, and error handling through the public API with mocked fetch.
 * @module services/openalex/openalex-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECT } from '@/services/openalex/types.js';

/** The `X-RateLimit-*` header trio OpenAlex emits on every successful response. */
function budgetHeaders(values: {
  cost: number;
  remaining: number;
  reset: number;
}): Record<string, string> {
  return {
    'x-ratelimit-cost-usd': String(values.cost),
    'x-ratelimit-remaining-usd': String(values.remaining),
    'x-ratelimit-reset': String(values.reset),
  };
}

/** Payload of the service's debug metrics line, or undefined when it never fired. */
function findMetricsLog(debug: { mock: { calls: unknown[][] } }): unknown {
  return debug.mock.calls.find(
    ([msg]) => typeof msg === 'string' && msg === 'OpenAlex response metrics',
  )?.[1];
}

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

    /**
     * Fields OpenAlex accepts that the catalog had drifted away from. Regenerating recovers
     * them; asserting them here makes a future regression a test failure rather than a silent
     * gap in what `openalex_describe_fields` advertises.
     */
    it('carries the text.search filter on every non-works entity type (gh #56)', async () => {
      const { getFieldCatalog } = await import('@/services/openalex/openalex-service.js');
      const catalog = getFieldCatalog();
      for (const entityType of ENTITY_TYPES_UNDER_TEST.filter((t) => t !== 'works')) {
        expect(catalog[entityType].filter, `${entityType} is missing text.search`).toContain(
          'text.search',
        );
      }
    });

    it('carries the recovered authors and sources fields (gh #56)', async () => {
      const { getFieldCatalog } = await import('@/services/openalex/openalex-service.js');
      const catalog = getFieldCatalog();
      expect(catalog.authors.filter).toContain('last_known_authorships.institutions.lineage');
      expect(catalog.sources.filter).toContain('is_preprint_repository');
      expect(catalog.sources.select).toContain('is_preprint_repository');
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

    it('normalizes an ORCID URL (gh #50)', async () => {
      const url = await searchById('https://orcid.org/0000-0001-9487-6983');
      expect(url.pathname).toBe('/works/orcid:https://orcid.org/0000-0001-9487-6983');
    });

    it('normalizes a bare ROR (gh #50)', async () => {
      const url = await searchById('013meh722');
      expect(url.pathname).toBe('/works/ror:013meh722');
    });

    /**
     * Bare RORs and PMIDs overlap at nine characters, and all-digit RORs are ordinary —
     * Baylor is `005781934`. The leading zero settles it: PMIDs are assigned sequentially
     * and never carry one, so nothing matching the ROR shape is a reachable PMID.
     */
    it('routes an all-digit ROR to ror, not the overlapping PMID shape (gh #62)', async () => {
      const url = await searchById('005781934');
      expect(url.pathname).toBe('/works/ror:005781934');
    });

    it('keeps a PMID on the PMID branch — no leading zero', async () => {
      const url = await searchById('23903748');
      expect(url.pathname).toBe('/works/pmid:23903748');
    });

    /**
     * OpenAlex's bare external-ID schemes are case-sensitive: `/works/PMID:21491125` answers
     * 404 while `/works/pmid:21491125` resolves. Only the scheme segment is folded — the value
     * belongs to the caller and is forwarded byte-for-byte.
     */
    it.each([
      ['PMID:21491125', '/works/pmid:21491125'],
      ['DOI:10.1136/bmj.f5137', '/works/doi:10.1136/bmj.f5137'],
      ['ORCID:0000-0002-1825-0097', '/works/orcid:0000-0002-1825-0097'],
      ['ISSN:0028-0836', '/works/issn:0028-0836'],
      ['ROR:013meh722', '/works/ror:013meh722'],
      ['PMCID:PMC1234567', '/works/pmcid:PMC1234567'],
      ['Pmid:21491125', '/works/pmid:21491125'],
      ['dOi:10.1038/nature12373', '/works/doi:10.1038/nature12373'],
    ])('lowercases the recognized scheme prefix of %s (gh #66)', async (id, expected) => {
      const url = await searchById(id);
      expect(url.pathname).toBe(expected);
    });

    it.each([
      ['an uppercase DOI value', 'DOI:10.1136/BMJ.F5137', '/works/doi:10.1136/BMJ.F5137'],
      ['an ORCID check digit', 'ORCID:0000-0002-1825-009X', '/works/orcid:0000-0002-1825-009X'],
      ['a ROR URL value', 'ROR:https://ror.org/00HX57361', '/works/ror:https://ror.org/00HX57361'],
      ['a PMCID value', 'PMCID:PMC1234567', '/works/pmcid:PMC1234567'],
    ])(
      'leaves the value untouched when folding the scheme — %s (gh #66)',
      async (_label, id, expected) => {
        const url = await searchById(id);
        expect(url.pathname).toBe(expected);
      },
    );

    it.each([
      ['an unknown scheme', 'FOO:Bar', '/works/FOO:Bar'],
      ['a colon-less uppercase token', 'PMID', '/works/PMID'],
    ])('passes %s through unchanged (gh #66)', async (_label, id, expected) => {
      const url = await searchById(id);
      expect(url.pathname).toBe(expected);
    });

    it.each([
      ['https://pubmed.ncbi.nlm.nih.gov/21491125', '/works/pmid:21491125'],
      ['https://pubmed.ncbi.nlm.nih.gov/21491125/', '/works/pmid:21491125'],
      ['https://www.pubmed.ncbi.nlm.nih.gov/21491125', '/works/pmid:21491125'],
      ['http://pubmed.ncbi.nlm.nih.gov/21491125', '/works/pmid:21491125'],
    ])('resolves the PubMed URL %s to the bare PMID form (gh #66)', async (id, expected) => {
      const url = await searchById(id);
      expect(url.pathname).toBe(expected);
    });

    it('leaves a non-numeric PubMed URL path to the pass-through branch (gh #66)', async () => {
      const url = await searchById('https://pubmed.ncbi.nlm.nih.gov/advanced');
      expect(url.pathname).toBe('/works/https://pubmed.ncbi.nlm.nih.gov/advanced');
    });

    it.each([
      ['https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/', '/works/pmcid:PMC3084216'],
      ['https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216', '/works/pmcid:PMC3084216'],
      ['https://www.pmc.ncbi.nlm.nih.gov/articles/PMC3084216/', '/works/pmcid:PMC3084216'],
      ['http://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/', '/works/pmcid:PMC3084216'],
      ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/', '/works/pmcid:PMC3084216'],
      ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216', '/works/pmcid:PMC3084216'],
      ['https://ncbi.nlm.nih.gov/pmc/articles/PMC3084216/', '/works/pmcid:PMC3084216'],
      ['http://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/', '/works/pmcid:PMC3084216'],
    ])(
      'resolves the PubMed Central URL %s to the bare PMCID form (gh #67)',
      async (id, expected) => {
        const url = await searchById(id);
        expect(url.pathname).toBe(expected);
      },
    );

    it('leaves a non-article PubMed Central URL path to the pass-through branch (gh #67)', async () => {
      const url = await searchById('https://pmc.ncbi.nlm.nih.gov/about/copyright/');
      expect(url.pathname).toBe('/works/https://pmc.ncbi.nlm.nih.gov/about/copyright/');
    });
  });

  // --- Keyword identifiers: slugs, not native IDs (gh #68) ---

  describe('keyword identifiers (gh #68)', () => {
    async function lookupKeyword(id: string): Promise<URL> {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'https://openalex.org/keywords/x', display_name: 'X' }), {
          status: 200,
        }),
      );
      const service = await getService();
      await service.search({ entityType: 'keywords', id }, createMockContext());
      return lastFetchUrl();
    }

    /**
     * The ID a keyword search returns is a URL carrying the `keywords/` path segment the
     * endpoint already supplies. Stripping the host alone builds `/keywords/keywords/<slug>`,
     * which 404s — so the returned ID could not be fed back into its own lookup.
     */
    it.each([
      ['the keyword URL a search returns', 'https://openalex.org/keywords/groundwater'],
      ['the same URL with a trailing slash', 'https://openalex.org/keywords/groundwater/'],
      ['the bare slug', 'groundwater'],
    ])('resolves %s to /keywords/groundwater', async (_label, id) => {
      expect((await lookupKeyword(id)).pathname).toBe('/keywords/groundwater');
    });

    it('resolves a multi-word keyword slug', async () => {
      expect((await lookupKeyword('https://openalex.org/keywords/machine-learning')).pathname).toBe(
        '/keywords/machine-learning',
      );
    });

    it('does not read a slugless keyword path as a lookup', async () => {
      // No slug means no keyword to address — the path must not collapse to the list endpoint.
      expect((await lookupKeyword('https://openalex.org/keywords/')).pathname).not.toBe(
        '/keywords/',
      );
    });

    it('does not read a look-alike host as an OpenAlex keyword URL', async () => {
      expect((await lookupKeyword('https://notopenalex.org/keywords/groundwater')).pathname).toBe(
        '/keywords/https://notopenalex.org/keywords/groundwater',
      );
    });

    it('infers the keywords entity type from a keyword URL', async () => {
      const { inferIdentifier } = await import('@/services/openalex/openalex-service.js');
      expect(inferIdentifier('https://openalex.org/keywords/groundwater')).toEqual({
        entityType: 'keywords',
        id: 'groundwater',
        scheme: 'openalex',
      });
    });

    it.each([
      ['a slugless keyword path', 'https://openalex.org/keywords/'],
      ['a look-alike host', 'https://notopenalex.org/keywords/groundwater'],
      ['a bare slug, which is indistinguishable from a name', 'groundwater'],
    ])('leaves %s to name resolution', async (_label, query) => {
      const { inferIdentifier } = await import('@/services/openalex/openalex-service.js');
      expect(inferIdentifier(query)).toBeUndefined();
    });

    /**
     * The by-ID lookup and `openalex_resolve_name` have to land on the same record for the
     * ID a search hands back — that round trip is the whole point of the identifier.
     */
    it('resolves the keyword URL through resolveIdentifier to the same record', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'https://openalex.org/keywords/groundwater',
            display_name: 'Groundwater',
            works_count: 141298,
            cited_by_count: 2504216,
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const { inferIdentifier } = await import('@/services/openalex/openalex-service.js');
      const identifier = inferIdentifier('https://openalex.org/keywords/groundwater');
      expect(identifier).toBeDefined();

      const result = await service.resolveIdentifier(identifier!, createMockContext());

      expect(lastFetchUrl().pathname).toBe('/keywords/groundwater');
      expect(result.results).toEqual([
        {
          id: 'https://openalex.org/keywords/groundwater',
          display_name: 'Groundwater',
          entity_type: 'keyword',
          external_id: null,
          hint: null,
          works_count: 141298,
          cited_by_count: 2504216,
        },
      ]);
    });
  });

  // --- Identifier shape → entity type inference (gh #50) ---

  describe('inferIdentifier', () => {
    async function infer(query: string) {
      const { inferIdentifier } = await import('@/services/openalex/openalex-service.js');
      return inferIdentifier(query);
    }

    it.each([
      ['bare DOI', '10.1038/nature12373', 'works', 'doi'],
      ['DOI URL', 'https://doi.org/10.1038/nature12373', 'works', 'doi'],
      ['bare ORCID', '0000-0002-1825-0097', 'authors', 'orcid'],
      ['ORCID URL', 'https://orcid.org/0000-0001-9487-6983', 'authors', 'orcid'],
      ['ROR URL', 'https://ror.org/00hx57361', 'institutions', 'ror'],
      ['bare ROR', '013meh722', 'institutions', 'ror'],
      ['all-digit bare ROR', '005781934', 'institutions', 'ror'],
      ['ISSN', '0028-0836', 'sources', 'issn'],
      ['PMCID', 'PMC1234567', 'works', 'pmcid'],
      ['PMID', '23903748', 'works', 'pmid'],
      ['already-prefixed DOI', 'doi:10.1038/nature12373', 'works', 'doi'],
      ['uppercase-scheme PMID', 'PMID:21491125', 'works', 'pmid'],
      ['uppercase-scheme ORCID', 'ORCID:0000-0002-1825-0097', 'authors', 'orcid'],
      ['uppercase-scheme ROR', 'ROR:013meh722', 'institutions', 'ror'],
      ['PubMed URL', 'https://pubmed.ncbi.nlm.nih.gov/21491125', 'works', 'pmid'],
      ['PMC URL', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/', 'works', 'pmcid'],
      ['legacy PMC URL', 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/', 'works', 'pmcid'],
    ])('maps a %s to %s', async (_label, query, entityType, scheme) => {
      expect(await infer(query)).toEqual({
        entityType,
        scheme,
        id: expect.stringContaining(':'),
      });
    });

    it.each([
      ['W2159974629', 'works'],
      ['A5022021627', 'authors'],
      ['S137773608', 'sources'],
      ['I241749', 'institutions'],
      ['T10159', 'topics'],
      ['P4310320595', 'publishers'],
      ['F4320332161', 'funders'],
    ])('derives %s → %s from the native ID letter', async (query, entityType) => {
      expect(await infer(query)).toEqual({ entityType, id: query, scheme: 'openalex' });
    });

    it('strips the OpenAlex URL form before reading the letter', async () => {
      expect(await infer('https://openalex.org/I241749')).toEqual({
        entityType: 'institutions',
        id: 'I241749',
        scheme: 'openalex',
      });
    });

    it.each([
      ['a plain name', 'Albert Einstein'],
      ['a name with a colon', 'Nature: a weekly journal'],
      ['a short numeric string', '1234'],
      ['an empty-ish query', '   '],
    ])('leaves %s to autocomplete', async (_label, query) => {
      expect(await infer(query)).toBeUndefined();
    });

    it('stamps the folded scheme onto the id it hands the by-ID lookup (gh #66)', async () => {
      expect(await infer('PMID:21491125')).toEqual({
        entityType: 'works',
        id: 'pmid:21491125',
        scheme: 'pmid',
      });
    });

    it('reads a bare PubMed URL as a PMID instead of falling through (gh #66)', async () => {
      expect(await infer('https://pubmed.ncbi.nlm.nih.gov/21491125')).toEqual({
        entityType: 'works',
        id: 'pmid:21491125',
        scheme: 'pmid',
      });
    });

    it.each([
      ['C71924100', 'the deprecated Concepts entity'],
      ['G12345', 'an entity type this server does not model'],
      ['K12345', 'a shape OpenAlex never emits — keyword IDs are slugs (gh #68)'],
    ])('does not route %s — %s', async (query) => {
      // No endpoint answers these, so routing them would turn a name search into a 404.
      expect(await infer(query)).toBeUndefined();
    });
  });

  // --- Deterministic identifier resolution (gh #50) ---

  describe('resolveIdentifier', () => {
    async function resolve(entityType: string, id: string, body: unknown, status = 200) {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(status === 200 ? JSON.stringify(body) : '<!doctype html><title>404</title>', {
          status,
          headers: { 'Content-Type': status === 200 ? 'application/json' : 'text/html' },
        }),
      );
      const service = await getService();
      return service.resolveIdentifier(
        { entityType: entityType as 'works', id, scheme: 'doi' },
        createMockContext(),
      );
    }

    it('shapes an author record like an autocomplete match', async () => {
      const result = await resolve('authors', 'orcid:0000-0001-9487-6983', {
        id: 'https://openalex.org/A5022021627',
        display_name: 'B. F. Schutz',
        orcid: 'https://orcid.org/0000-0001-9487-6983',
        works_count: 680,
        cited_by_count: 114591,
        last_known_institutions: [{ display_name: 'Leibniz University Hannover' }],
      });

      expect(result.results).toEqual([
        {
          id: 'https://openalex.org/A5022021627',
          display_name: 'B. F. Schutz',
          entity_type: 'author',
          external_id: 'https://orcid.org/0000-0001-9487-6983',
          works_count: 680,
          cited_by_count: 114591,
          hint: 'Leibniz University Hannover',
        },
      ]);
    });

    it('reports a work with no works of its own as null, matching autocomplete', async () => {
      const result = await resolve('works', 'doi:10.1038/nature12373', {
        id: 'https://openalex.org/W2159974629',
        display_name: 'A paper',
        doi: 'https://doi.org/10.1038/nature12373',
        cited_by_count: 12,
        publication_year: 2013,
      });

      expect(result.results[0]).toMatchObject({
        entity_type: 'work',
        works_count: null,
        hint: '2013',
      });
    });

    it('leaves external_id and hint null when the record carries neither', async () => {
      const result = await resolve('funders', 'F4320332161', {
        id: 'https://openalex.org/F4320332161',
        display_name: 'National Institutes of Health',
        works_count: 1770852,
        cited_by_count: 107411673,
        country_code: 'US',
      });

      expect(result.results[0]).toMatchObject({
        entity_type: 'funder',
        external_id: null,
        hint: null,
      });
    });

    it('preserves an untitled record rather than inventing a name', async () => {
      const result = await resolve('works', 'doi:10.1000/paratext', {
        id: 'https://openalex.org/W999',
        display_name: null,
        cited_by_count: 0,
      });

      expect(result.results[0]?.display_name).toBeNull();
    });

    it('returns no results on a 404 instead of throwing', async () => {
      // A mistyped identifier gets the same soft empty result a mistyped name already gets.
      const result = await resolve('works', 'doi:10.1038/nope', undefined, 404);
      expect(result.results).toEqual([]);
    });

    it('still throws on a non-404 upstream failure', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
      );
      const service = await getService();

      await expect(
        service.resolveIdentifier(
          { entityType: 'works', id: 'doi:10.1038/x', scheme: 'doi' },
          createMockContext(),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.Unauthorized });
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

    // Characterization — behavior #2 established that the fuller decoder must keep.

    it('decodes a legacy named entity missing its semicolon (live sources S2765019955)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [{ id: 'S2765019955', display_name: 'Head &amp Neck' }],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.search({ entityType: 'sources' }, createMockContext());
      expect(result.results[0]?.display_name).toBe('Head & Neck');
    });

    it('decodes in a single pass — a double-encoded entity keeps one level', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [{ id: 'W1', display_name: 'double &amp;lt; stays &amp;#38;' }],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());
      expect(result.results[0]?.display_name).toBe('double &lt; stays &#38;');
    });

    it('decodes an encoded comparison and leaves a literal one alone', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 1 },
            results: [{ id: 'W1', display_name: 'A &lt; B and A < B' }],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());
      expect(result.results[0]?.display_name).toBe('A < B and A < B');
    });
  });

  // --- Provider text normalization: full entity table, markup (gh #76) ---

  describe('provider text normalization (gh #76)', () => {
    function respondWith(body: unknown) {
      vi.mocked(globalThis.fetch).mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      );
    }

    async function searchOne(record: Record<string, unknown>) {
      respondWith({ meta: { count: 1, per_page: 1 }, results: [{ id: 'W1', ...record }] });
      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());
      return result.results[0] as Record<string, unknown>;
    }

    it.each([
      ['&cacute;', 'ć'],
      ['&lstrok;', 'ł'],
      ['&alpha;', 'α'],
      ['&Alpha;', 'Α'],
      ['&le;', '≤'],
      ['&times;', '×'],
      ['&frac12;', '½'],
      ['&sup2;', '²'],
      ['&NotNestedGreaterGreater;', '⪢̸'],
    ])('decodes the WHATWG named reference %s', async (entity, decoded) => {
      const record = await searchOne({ display_name: `x ${entity} y` });
      expect(record.display_name).toBe(`x ${decoded} y`);
    });

    // Live titles carry these recased by an upper- or title-cased source (W4313549949, W4210800286).
    it.each([
      ['&NBSP;', ' '],
      ['&Nbsp;', ' '],
      ['&Quot;', '"'],
      ['&Amp;', '&'],
      ['&APOS;', "'"],
      ['&Lt;', '≪'],
    ])(
      'decodes the recased reference %s by its own table entry, else its lowercase name',
      async (entity, decoded) => {
        const record = await searchOne({ display_name: `x ${entity} y` });
        expect(record.display_name).toBe(`x ${decoded} y`);
      },
    );

    it('decodes the live author name W4407736232 carries', async () => {
      const record = await searchOne({
        display_name: 'Test',
        authorships: [{ raw_author_name: 'Radovi&cacute; Vesela' }],
      });
      expect((record.authorships as { raw_author_name: string }[])[0]?.raw_author_name).toBe(
        'Radović Vesela',
      );
    });

    it.each([
      '&constructor;',
      '&toString;',
      '&__proto__;',
      '&hasOwnProperty;',
      '&valueOf;',
      '&madeupentity;',
      '&constructor',
    ])('leaves the non-entity %s literal instead of reading Object.prototype', async (text) => {
      const record = await searchOne({ display_name: `Proto ${text} end` });
      expect(record.display_name).toBe(`Proto ${text} end`);
    });

    it('leaves a legacy name followed by = or an alphanumeric literal (URL query strings)', async () => {
      const url = 'http://e.x/F?func=service&copy=1&lang=de&not=2&notit;&ampx&sup23';
      const record = await searchOne({
        display_name: 'Test',
        primary_location: { landing_page_url: url },
      });
      expect((record.primary_location as { landing_page_url: string }).landing_page_url).toBe(url);
    });

    it('decodes entities before handling tags, so an encoded tag unwraps (W4382882763)', async () => {
      const record = await searchOne({
        display_name: 'Test',
        primary_location: {
          raw_source_name: 'Revision of the Genus &lt;i&gt;Urosigalphus&lt;/i&gt; Ashmead',
        },
      });
      expect((record.primary_location as { raw_source_name: string }).raw_source_name).toBe(
        'Revision of the Genus Urosigalphus Ashmead',
      );
    });

    it('removes HTML comments from a title and a reconstructed abstract (W2607219574)', async () => {
      const comment = '<!-- No EquationSource Format="TEX", only image -->';
      const record = await searchOne({
        display_name: `Invariant approximations, generalized "Equation missing" ${comment}-contractions`,
        abstract_inverted_index: {
          We: [0],
          prove: [1],
          '<!--': [2],
          No: [3],
          EquationSource: [4],
          'Format="TEX",': [5],
          only: [6],
          image: [7],
          '-->': [8],
          'results.': [9],
        },
      });
      expect(record.display_name).toBe(
        'Invariant approximations, generalized "Equation missing" -contractions',
      );
      expect(record.abstract).toBe('We prove  results.');
    });

    it('unwraps inline-formula/tex-math markup in an abstract (W7114890785)', async () => {
      const record = await searchOne({
        display_name: 'Test',
        abstract_inverted_index: {
          the: [0],
          '<inline-formula': [1],
          'xmlns:mml="http://www.w3.org/1998/Math/MathML"': [2],
          'xmlns:xlink="http://www.w3.org/1999/xlink"><tex-math': [3],
          'notation="LaTeX">$\\bf': [4],
          '{B\\times': [5],
          '\\tau': [6],
          '_{c}}$</tex-math></inline-formula>': [7],
          product: [8],
        },
      });
      expect(record.abstract).toBe('the $\\bf {B\\times \\tau _{c}}$ product');
    });

    it.each([
      ['Fish <Actinopterygii>'],
      ['Pinus <genus>'],
      ['redshift 1.7<z<3'],
      ['indices i1<i2<i3'],
      ['A < B'],
      ['https://doi.org/10.1002/(sici)1097-4636(199604)30:4<521::aid-jbm11>3.0.co;2-u'],
      ['<notatag> <i2> <em'],
    ])('keeps non-allowlisted angle-bracket text literal: %s', async (text) => {
      const record = await searchOne({ display_name: text });
      expect(record.display_name).toBe(text);
    });

    it('unwraps allowlisted inline markup, JATS, and MathML', async () => {
      const record = await searchOne({
        display_name:
          '<i>E. coli</i> <B>bold</B> <jats:italic>x</jats:italic> <span class="a">s</span> <mml:math><mml:mi>y</mml:mi></mml:math> <sc>Sc</sc>',
      });
      expect(record.display_name).toBe('E. coli bold x s y Sc');
    });

    it('turns block elements into paragraph breaks and sub/sup into TeX-style marks', async () => {
      const record = await searchOne({
        display_name: 'Test',
        abstract_inverted_index: {
          '<jats:p>First': [0],
          'H<sub>2</sub>O': [1],
          '10<sup>-3</sup>.</jats:p><jats:p>Second.<br/>Third.</jats:p>': [2],
        },
      });
      expect(record.abstract).toBe('First H_{2}O 10^{-3}.\n\nSecond.\n\nThird.');
    });

    it('strips tags to a fixed point, so no allowlisted tag re-forms', async () => {
      const record = await searchOne({ display_name: 'a <<i>i>b<<<b>b>b> c <!<!---->-- x --> d' });
      expect(record.display_name).toBe('a b c  d');
      expect(String(record.display_name)).not.toMatch(/<(?:i|b)>/);
    });

    it('normalizes a value several levels down inside arrays of objects', async () => {
      const record = await searchOne({
        display_name: 'Test',
        authorships: [
          { author: { display_name: 'First' } },
          {
            institutions: [
              { display_name: 'Inst' },
              {
                lineage: [
                  { display_name: '&lt;b&gt;Deep&lt;/b&gt; &amp; &alpha;-Lab &constructor;' },
                ],
              },
            ],
          },
        ],
      });
      const authorships = record.authorships as {
        institutions?: { lineage?: { display_name: string }[] }[];
      }[];
      expect(authorships[1]?.institutions?.[1]?.lineage?.[0]?.display_name).toBe(
        'Deep & α-Lab &constructor;',
      );
    });

    it('keeps empty strings, numbers, and booleans as they are', async () => {
      const record = await searchOne({
        display_name: '',
        cited_by_count: 0,
        is_oa: false,
        abstract_inverted_index: {},
      });
      expect(record).toMatchObject({
        display_name: '',
        cited_by_count: 0,
        is_oa: false,
        abstract: '',
      });
    });

    it('keeps a null display_name null on a sparse record (gh #51)', async () => {
      const record = await searchOne({ display_name: null, type: 'paratext' });
      expect(record.display_name).toBeNull();
      expect(record.type).toBe('paratext');
    });

    it('normalizes an autocomplete match in one pass', async () => {
      respondWith({
        results: [
          {
            id: 'https://openalex.org/S1',
            display_name: '**Bold** &constructor; &frac12;',
            entity_type: 'source',
            cited_by_count: 1,
            works_count: 1,
            external_id: null,
            hint: 'Pub &lt;i&gt;x&lt;/i&gt; &amp;lt;',
          },
        ],
      });
      const service = await getService();
      const result = await service.autocomplete(
        { entityType: 'sources', query: 'bold' },
        createMockContext(),
      );
      expect(result.results[0]).toMatchObject({
        display_name: '**Bold** &constructor; ½',
        hint: 'Pub x &lt;',
      });
    });

    it('normalizes the identifier path exactly once (resolveIdentifier reuses search)', async () => {
      respondWith({
        id: 'https://openalex.org/A1',
        display_name: 'Radovi&cacute; &amp;lt;V&amp;gt;',
        last_known_institutions: [{ display_name: '&lt;i&gt;Inst&lt;/i&gt; &amp;amp; Co' }],
      });
      const service = await getService();
      const result = await service.resolveIdentifier(
        { entityType: 'authors', id: 'A1', scheme: 'openalex' },
        createMockContext(),
      );
      expect(result.results[0]).toMatchObject({
        display_name: 'Radović &lt;V&gt;',
        hint: 'Inst &amp; Co',
      });
    });

    it('normalizes analyze labels but keeps the group key byte-identical to upstream', async () => {
      respondWith({
        meta: { count: 3 },
        group_by: [
          {
            key: 'Law &amp; Society',
            key_display_name: '# Journal &constructor; <i>Ann</i> &frac12;',
            count: 2,
          },
          { key: 'https://openalex.org/S2', key_display_name: '&lt;genus&gt; source', count: 1 },
        ],
      });
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'primary_location.source.id' },
        createMockContext(),
      );
      expect(result.groups).toEqual([
        {
          key: 'Law &amp; Society',
          key_display_name: '# Journal &constructor; Ann ½',
          count: 2,
        },
        { key: 'https://openalex.org/S2', key_display_name: '<genus> source', count: 1 },
      ]);
    });
  });

  // --- Unknown group_by bucket (gh #75) ---

  describe('unknown group_by bucket (gh #75)', () => {
    function respondWithGroups(groups: { key: string; key_display_name: string; count: number }[]) {
      vi.mocked(globalThis.fetch).mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ meta: { count: 100 }, group_by: groups }), {
            status: 200,
          }),
        ),
      );
    }

    it.each([
      ['apc_paid.value_usd', '-111.0', '-111.0'],
      ['apc_list.value_usd', '-111', '-111'],
      ['apc_paid.value_usd (order: key)', 'unknown', 'unknown'],
      ['primary_topic.subfield.id', 'https://openalex.org/subfields/unknown', 'unknown'],
    ])('flags the %s bucket keyed %s with is_unknown', async (_field, key, display) => {
      respondWithGroups([
        { key, key_display_name: display, count: 48777 },
        { key: '0.0', key_display_name: '0.0', count: 12 },
      ]);
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'apc_paid.value_usd', includeUnknown: true },
        createMockContext(),
      );
      expect(result.groups).toEqual([
        { key, key_display_name: display, count: 48777, is_unknown: true },
        { key: '0.0', key_display_name: '0.0', count: 12 },
      ]);
    });

    it('never flags a group when include_unknown is off', async () => {
      respondWithGroups([
        { key: '-111', key_display_name: '-111', count: 5 },
        { key: 'unknown', key_display_name: 'unknown', count: 3 },
      ]);
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'publication_year', includeUnknown: false },
        createMockContext(),
      );
      expect(result.groups.every((g) => !('is_unknown' in g))).toBe(true);
    });

    it('flags nothing on a page with no unknown bucket', async () => {
      respondWithGroups([
        { key: '2024', key_display_name: '2024', count: 5 },
        { key: '2023', key_display_name: '2023', count: 3 },
      ]);
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'publication_year', includeUnknown: true },
        createMockContext(),
      );
      expect(result.groups.every((g) => !('is_unknown' in g))).toBe(true);
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

    /**
     * Bibliometrics live under `summary_stats` upstream, and `select` projects top-level
     * fields only — so `select: ["h_index"]` was a 400 that named 21 valid fields, none of
     * them resembling what the caller asked for. Aliasing the leaf to its parent makes the
     * first call succeed. (gh #64)
     */
    it.each([
      ['authors', 'h_index'],
      ['sources', 'i10_index'],
      ['institutions', '2yr_mean_citedness'],
      ['publishers', 'h_index'],
      ['funders', 'h_index'],
    ])('aliases a summary_stats leaf to its parent on %s', async (entityType, leaf) => {
      const service = await getService();
      await service.search(
        {
          entityType: entityType as Parameters<typeof service.search>[0]['entityType'],
          select: ['id', 'display_name', leaf],
        },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,summary_stats');
    });

    it('projects summary_stats once when several of its leaves are requested (gh #64)', async () => {
      const service = await getService();
      await service.search(
        {
          entityType: 'authors',
          select: ['h_index', 'i10_index', '2yr_mean_citedness'],
        },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,summary_stats');
    });

    it('leaves the canonical summary_stats name untouched (gh #64)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'authors', select: ['id', 'display_name', 'summary_stats'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,summary_stats');
    });

    it('collapses a leaf requested alongside its canonical parent (gh #64)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'authors', select: ['summary_stats', 'h_index'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,summary_stats');
    });

    it.each([
      ['works', 'works keeps only its own alias map'],
      ['topics', 'topics expose no summary_stats upstream'],
      ['keywords', 'keywords expose no summary_stats upstream'],
    ])('does not alias h_index on %s — %s (gh #64)', async (entityType) => {
      const service = await getService();
      await service.search(
        {
          entityType: entityType as Parameters<typeof service.search>[0]['entityType'],
          select: ['id', 'display_name', 'h_index'],
        },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,h_index');
    });

    it('fails open on an unmapped field name for an aliased entity type (gh #64)', async () => {
      // #17's rule: a miss passes through untranslated so upstream's 400 names the valid fields.
      const service = await getService();
      await service.search(
        { entityType: 'authors', select: ['id', 'display_name', 'h_indx'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,h_indx');
    });

    it('aliases a summary_stats leaf on a singleton id lookup too (gh #64)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'A1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search(
        { entityType: 'authors', id: 'A5022021627', select: ['h_index'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,summary_stats');
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

    /**
     * An alias and its canonical name are two constraints, not one. Merging them into an object
     * dropped whichever arrived first, so JSON property order decided the result set while the
     * response echoed both. OpenAlex ANDs a repeated filter key, which is the semantics the
     * caller asked for and the one this tool documents ("AND across fields"). (gh #70)
     */
    describe('alias collisions preserve AND-conjunction (gh #70)', () => {
      function filterClauses(): string[] {
        return filterParam().split(',').filter(Boolean);
      }

      it.each([
        ['alias first', { year: '2020', publication_year: '2024' }],
        ['canonical first', { publication_year: '2024', year: '2020' }],
      ])('sends both years as an AND’d clause pair — %s', async (_label, filters) => {
        const service = await getService();
        await service.search({ entityType: 'works', filters }, createMockContext());

        expect(filterClauses().sort()).toEqual(['publication_year:2020', 'publication_year:2024']);
      });

      it.each([
        ['alias first', { cited_works: 'W1', cites: 'W2' }],
        ['canonical first', { cites: 'W2', cited_works: 'W1' }],
      ])('sends both citation constraints — %s', async (_label, filters) => {
        const service = await getService();
        await service.search({ entityType: 'works', filters }, createMockContext());

        expect(filterClauses().sort()).toEqual(['cites:W1', 'cites:W2']);
      });

      it.each([
        ['alias first', { id: 'W1', openalex: 'W2' }],
        ['canonical first', { openalex: 'W2', id: 'W1' }],
      ])('sends both OpenAlex-ID constraints — %s', async (_label, filters) => {
        const service = await getService();
        await service.search({ entityType: 'works', filters }, createMockContext());

        expect(filterClauses().sort()).toEqual(['openalex:W1', 'openalex:W2']);
      });

      it('deduplicates aliases resolving to an identical value', async () => {
        // Repeating one constraint changes nothing upstream, so one clause is the honest send.
        const service = await getService();
        await service.search(
          { entityType: 'works', filters: { year: '2020', publication_year: '2020' } },
          createMockContext(),
        );

        expect(filterClauses()).toEqual(['publication_year:2020']);
      });

      it('preserves the collision on the analyze path too', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
        );
        const service = await getService();
        await service.analyze(
          {
            entityType: 'works',
            groupBy: 'oa_status',
            filters: { year: '2020', publication_year: '2024' },
          },
          createMockContext(),
        );

        expect(filterClauses().sort()).toEqual(['publication_year:2020', 'publication_year:2024']);
      });

      it('leaves distinct canonical keys in caller order', async () => {
        const service = await getService();
        await service.search(
          { entityType: 'works', filters: { is_oa: 'true', year: '2020' } },
          createMockContext(),
        );

        expect(filterClauses()).toEqual(['is_oa:true', 'publication_year:2020']);
      });

      it('still rejects a comma in one of two clauses sharing a key', async () => {
        const service = await getService();
        await expect(
          service.search(
            { entityType: 'works', filters: { year: '2020', publication_year: '2021,2022' } },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          data: { reason: 'comma_in_filter_value', filterKey: 'publication_year' },
        });
        expect(globalThis.fetch).not.toHaveBeenCalled();
      });
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

    /**
     * The tool rejects `sample` under semantic mode and alongside `sort` before the service is
     * reached; sampling under the two remaining modes keeps its population lookup. (gh #83, #85)
     */
    it.each([
      ['keyword', 'keyword', 'search'],
      ['exact', 'exact', 'search.exact'],
    ] as const)(
      'keeps the population lookup for a %s-mode sample',
      async (_label, searchMode, searchKey) => {
        vi.mocked(globalThis.fetch).mockImplementation((input) => {
          const url = new URL(input as string);
          const count = url.searchParams.has('sample') ? 5 : 147_663;
          return Promise.resolve(
            new Response(JSON.stringify({ meta: { count, per_page: count }, results: [] }), {
              status: 200,
            }),
          );
        });
        const service = await getService();
        const result = await service.search(
          { entityType: 'works', query: 'groundwater recharge', searchMode, sample: 5, seed: '1' },
          createMockContext(),
        );

        expect(result.meta.count).toBe(147_663);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        const head = populationUrl();
        expect(head.searchParams.get(searchKey)).toBe('groundwater recharge');
        expect(head.searchParams.get('cursor')).toBe('*');
        expect(head.searchParams.has('sample')).toBe(false);
        expect(sampleUrl().searchParams.get(searchKey)).toBe('groundwater recharge');
      },
    );
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

  // --- best_oa_location in the default works projection (gh #79) ---

  describe('default works projection carries best_oa_location (gh #79)', () => {
    /** Fields projected by the default works request, as OpenAlex receives them. */
    function defaultWorksSelect(): string[] {
      return lastFetchUrl().searchParams.get('select')?.split(',') ?? [];
    }

    it('projects best_oa_location on a default works search', async () => {
      const service = await getService();
      await service.search({ entityType: 'works', query: 'groundwater' }, createMockContext());
      expect(defaultWorksSelect()).toContain('best_oa_location');
    });

    it('projects best_oa_location on a default works id lookup', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'W1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search({ entityType: 'works', id: 'W1' }, createMockContext());
      expect(defaultWorksSelect()).toContain('best_oa_location');
    });

    it('leaves every other entity type default projection untouched', async () => {
      const service = await getService();
      for (const entityType of ['authors', 'sources', 'institutions', 'topics'] as const) {
        await service.search({ entityType }, createMockContext());
        expect(defaultWorksSelect(), `${entityType} gained a works-only field`).not.toContain(
          'best_oa_location',
        );
      }
    });

    it('does not add best_oa_location when the caller supplies an explicit select', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', select: ['id', 'display_name', 'doi'] },
        createMockContext(),
      );
      expect(defaultWorksSelect()).toEqual(['id', 'display_name', 'doi']);
    });

    /**
     * A repository-hosted green-OA copy is where `best_oa_location` differs from
     * `primary_location` — the readable PDF lives at the repository, not the publisher.
     * `pdf_url: null` is upstream data and is passed through, never synthesized.
     */
    it('passes a green-OA best_oa_location through the response unchanged', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 1, per_page: 25 },
            results: [
              {
                id: 'W1',
                display_name: 'A green-OA paper',
                primary_location: { pdf_url: null, source: { display_name: 'Elsevier BV' } },
                best_oa_location: {
                  pdf_url: 'https://repo.example.org/paper.pdf',
                  license: 'cc-by',
                  version: 'acceptedVersion',
                  source: { display_name: 'Institutional Repository' },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const result = await service.search({ entityType: 'works' }, createMockContext());

      expect(result.results[0]?.best_oa_location).toEqual({
        pdf_url: 'https://repo.example.org/paper.pdf',
        license: 'cc-by',
        version: 'acceptedVersion',
        source: { display_name: 'Institutional Repository' },
      });
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

    /**
     * Semantic search pages with `page`; OpenAlex rejects a cursor on `search.semantic`
     * outright, so the two never ride together on the wire. (gh #71)
     */
    describe('semantic pagination (gh #71)', () => {
      it('forwards page and sends no cursor in semantic mode', async () => {
        const service = await getService();
        await service.search(
          {
            entityType: 'works',
            query: 'estimating groundwater recharge',
            searchMode: 'semantic',
            perPage: 3,
            page: 2,
          },
          createMockContext(),
        );

        const url = lastFetchUrl();
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('per_page')).toBe('3');
        expect(url.searchParams.get('cursor')).toBeNull();
      });

      it('reaches the last candidate page with no cursor appearing', async () => {
        const service = await getService();
        await service.search(
          {
            entityType: 'works',
            query: 'estimating groundwater recharge',
            searchMode: 'semantic',
            perPage: 3,
            page: 17,
          },
          createMockContext(),
        );

        const url = lastFetchUrl();
        expect(url.searchParams.get('page')).toBe('17');
        expect(url.searchParams.get('cursor')).toBeNull();
      });

      it('sends neither page nor cursor when semantic mode omits page', async () => {
        const service = await getService();
        await service.search(
          { entityType: 'works', query: 'estimating groundwater recharge', searchMode: 'semantic' },
          createMockContext(),
        );

        const url = lastFetchUrl();
        expect(url.searchParams.get('page')).toBeNull();
        expect(url.searchParams.get('cursor')).toBeNull();
      });

      it.each(['keyword', 'exact'] as const)(
        'opens a cursor traversal for %s mode and sends no page',
        async (searchMode) => {
          const service = await getService();
          await service.search(
            { entityType: 'works', query: 'groundwater', searchMode },
            createMockContext(),
          );

          const url = lastFetchUrl();
          expect(url.searchParams.get('cursor')).toBe('*');
          expect(url.searchParams.get('page')).toBeNull();
        },
      );

      it('forwards a caller cursor unchanged on a non-semantic continuation', async () => {
        const service = await getService();
        await service.search(
          { entityType: 'works', query: 'groundwater', searchMode: 'keyword', cursor: 'page-two' },
          createMockContext(),
        );

        expect(lastFetchUrl().searchParams.get('cursor')).toBe('page-two');
      });
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

    /**
     * A response carrying no `group_by` key at all is OpenAlex's plain list shape — the
     * aggregation never ran. Folding it into `groups: []` reported a successful aggregation
     * with nothing in it, which reads as "the filters matched nothing to group". (gh #69)
     */
    it('throws rather than reporting an empty aggregation when group_by is absent (gh #69)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 327790539 }, results: [] }), { status: 200 }),
      );
      const service = await getService();

      await expect(
        service.analyze({ entityType: 'works', groupBy: 'type' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_missing_group_by' },
      });
    });

    it('carries the caller contract recovery on a missing-aggregation response (gh #69)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 1 }, results: [] }), { status: 200 }),
      );
      const ctx = createMockContext({
        errors: [
          {
            reason: 'upstream_missing_group_by',
            code: JsonRpcErrorCode.ServiceUnavailable,
            when: 'the response carried no aggregation',
            recovery: 'DISTINCTIVE_GROUP_BY_HINT retry, then check the group_by field.',
          },
        ],
      });
      const service = await getService();

      await expect(
        service.analyze({ entityType: 'works', groupBy: 'type' }, ctx),
      ).rejects.toMatchObject({
        data: {
          reason: 'upstream_missing_group_by',
          recovery: { hint: expect.stringContaining('DISTINCTIVE_GROUP_BY_HINT') },
        },
      });
    });

    it('still reports an empty aggregation when upstream returns an empty group_by array', async () => {
      // A present-but-empty array is honest data: the filters matched nothing to group.
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      const service = await getService();
      const result = await service.analyze(
        { entityType: 'works', groupBy: 'type' },
        createMockContext(),
      );
      expect(result.groups).toEqual([]);
      expect(result.meta.groups_count).toBe(0);
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
    it('logs header budget figures and db_response_time_ms from meta at debug level', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { count: 10, per_page: 25, cost_usd: 0.0002, db_response_time_ms: 42 },
            results: [],
          }),
          { status: 200, headers: budgetHeaders({ cost: 0.0002, remaining: 0.0688, reset: 5554 }) },
        ),
      );
      const service = await getService();
      const ctx = createMockContext();
      const debug = vi.spyOn(ctx.log, 'debug');

      await service.search({ entityType: 'works' }, ctx);

      expect(findMetricsLog(debug)).toMatchObject({
        costUsd: 0.0002,
        budgetRemainingUsd: 0.0688,
        budgetResetsInSeconds: 5554,
        dbResponseTimeMs: 42,
      });
    });

    it('logs db latency alone when the response carries no budget headers', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ meta: { count: 10, db_response_time_ms: 42 }, results: [] }),
          { status: 200 },
        ),
      );
      const service = await getService();
      const ctx = createMockContext();
      const debug = vi.spyOn(ctx.log, 'debug');

      await service.search({ entityType: 'works' }, ctx);

      const metrics = findMetricsLog(debug);
      expect(metrics).toMatchObject({ dbResponseTimeMs: 42 });
      expect(metrics).not.toHaveProperty('costUsd');
    });

    it('does not log metrics when neither headers nor meta carry them', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, results: [] }), { status: 200 }),
      );
      const service = await getService();
      const ctx = createMockContext();
      const debug = vi.spyOn(ctx.log, 'debug');

      await service.search({ entityType: 'works' }, ctx);

      expect(findMetricsLog(debug)).toBeUndefined();
    });
  });

  // --- Budget enrichment ---

  describe('budget enrichment', () => {
    it('enriches budget from the rate-limit headers on a list search', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 4260025, per_page: 5 }, results: [] }), {
          status: 200,
          headers: budgetHeaders({ cost: 0.001, remaining: 0.0689, reset: 5554 }),
        }),
      );
      const service = await getService();
      const ctx = createMockContext();

      await service.search({ entityType: 'works', query: 'machine learning' }, ctx);

      expect(getEnrichment(ctx).budget).toEqual({
        costUsd: 0.001,
        remainingUsd: 0.0689,
        resetsInSeconds: 5554,
      });
    });

    it('enriches budget on a singleton id lookup, whose body carries no meta wrapper', async () => {
      // The regression this whole mechanism exists for: `/works/{id}` returns a bare entity
      // record — no `meta`, so `meta.cost_usd` is unavailable. Headers are the only channel,
      // and `costUsd: 0` is the signal that ID lookups are free.
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'https://openalex.org/W2741809807', display_name: 'A' }),
          {
            status: 200,
            headers: budgetHeaders({ cost: 0, remaining: 0.0699, reset: 5557 }),
          },
        ),
      );
      const service = await getService();
      const ctx = createMockContext();

      const result = await service.search({ entityType: 'works', id: 'W2741809807' }, ctx);

      expect(result.results).toHaveLength(1);
      expect(getEnrichment(ctx).budget).toEqual({
        costUsd: 0,
        remainingUsd: 0.0699,
        resetsInSeconds: 5557,
      });
    });

    it('sums cost across the two requests a sampled search issues', async () => {
      // Sampling pairs the sample request with a population-count request; both are billed,
      // so the caller-visible cost has to be the sum, not the last response's line item.
      const responses = [
        new Response(JSON.stringify({ meta: { count: 5, per_page: 5 }, results: [] }), {
          status: 200,
          headers: budgetHeaders({ cost: 0.001, remaining: 0.069, reset: 5560 }),
        }),
        new Response(JSON.stringify({ meta: { count: 900, per_page: 1 }, results: [] }), {
          status: 200,
          headers: budgetHeaders({ cost: 0.0005, remaining: 0.0685, reset: 5558 }),
        }),
      ];
      let call = 0;
      vi.mocked(globalThis.fetch).mockImplementation(() => {
        const response = responses[call++];
        if (!response) throw new Error('unexpected extra fetch');
        return Promise.resolve(response);
      });
      const service = await getService();
      const ctx = createMockContext();

      await service.search({ entityType: 'works', sample: 5 }, ctx);

      // Both counters run down, so the merge keeps the smaller (fresher) reading of each.
      expect(getEnrichment(ctx).budget).toEqual({
        costUsd: 0.0015,
        remainingUsd: 0.0685,
        resetsInSeconds: 5558,
      });
    });

    it('counts the cost of an attempt whose body was truncated and retried', async () => {
      // OpenAlex truncates under load and still bills the 200. Recording the budget only
      // after a successful parse would drop the failed attempt's cost, under-reporting
      // what the call actually spent.
      const responses = [
        new Response('{"meta": {"count": 5, "per_p', {
          status: 200,
          headers: budgetHeaders({ cost: 0.001, remaining: 0.069, reset: 5560 }),
        }),
        new Response(JSON.stringify({ meta: { count: 5, per_page: 5 }, results: [] }), {
          status: 200,
          headers: budgetHeaders({ cost: 0.001, remaining: 0.068, reset: 5558 }),
        }),
      ];
      let call = 0;
      vi.mocked(globalThis.fetch).mockImplementation(() => {
        const response = responses[call++];
        if (!response) throw new Error('unexpected extra fetch');
        return Promise.resolve(response);
      });
      const service = await getService();
      const ctx = createMockContext();

      await service.search({ entityType: 'works' }, ctx);

      expect(getEnrichment(ctx).budget).toEqual({
        costUsd: 0.002,
        remainingUsd: 0.068,
        resetsInSeconds: 5558,
      });
    });

    it('enriches budget on analyze', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 120372560 }, group_by: [] }), {
          status: 200,
          headers: budgetHeaders({ cost: 0.0001, remaining: 0.0688, reset: 5554 }),
        }),
      );
      const service = await getService();
      const ctx = createMockContext();

      await service.analyze({ entityType: 'works', groupBy: 'publication_year' }, ctx);

      expect(getEnrichment(ctx).budget).toMatchObject({ costUsd: 0.0001, remainingUsd: 0.0688 });
    });

    it('enriches budget on autocomplete', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: budgetHeaders({ cost: 0.0001, remaining: 0.0687, reset: 5553 }),
        }),
      );
      const service = await getService();
      const ctx = createMockContext();

      await service.autocomplete({ entityType: 'authors', query: 'einstein' }, ctx);

      expect(getEnrichment(ctx).budget).toMatchObject({ costUsd: 0.0001, remainingUsd: 0.0687 });
    });

    it('omits budget when the response carries no rate-limit headers', async () => {
      const service = await getService();
      const ctx = createMockContext();

      await service.search({ entityType: 'works' }, ctx);

      expect(getEnrichment(ctx)).not.toHaveProperty('budget');
    });

    it('omits budget when the header set is incomplete', async () => {
      // A cost with no budget to weigh it against is worse than no reading at all.
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 1, per_page: 25 }, results: [] }), {
          status: 200,
          headers: { 'x-ratelimit-cost-usd': '0.001' },
        }),
      );
      const service = await getService();
      const ctx = createMockContext();

      await service.search({ entityType: 'works' }, ctx);

      expect(getEnrichment(ctx)).not.toHaveProperty('budget');
    });

    it('keeps each request context on its own running total', async () => {
      vi.mocked(globalThis.fetch).mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ meta: { count: 1, per_page: 25 }, results: [] }), {
            status: 200,
            headers: budgetHeaders({ cost: 0.001, remaining: 0.05, reset: 100 }),
          }),
        ),
      );
      const service = await getService();
      const first = createMockContext();
      const second = createMockContext();

      await service.search({ entityType: 'works' }, first);
      await service.search({ entityType: 'works' }, second);

      expect(getEnrichment(first).budget).toMatchObject({ costUsd: 0.001 });
      expect(getEnrichment(second).budget).toMatchObject({ costUsd: 0.001 });
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

    /**
     * `/autocomplete/{entity_type}` answers a `q` over 1,000 Unicode code points (holding an
     * ASCII letter) with an HTML 500 on every attempt; cross-entity `/autocomplete` never does.
     * These run through the real `fetchWithTimeout` → `withRetry` → classification path, so the
     * attempt count is the retry loop's own. (gh #81)
     */
    describe('over-long query 500 (gh #81)', () => {
      /** The body OpenAlex returned for a 1,001-character `q` on /autocomplete/authors. */
      const UPSTREAM_500_HTML =
        '<!doctype html>\n<html lang=en>\n<title>500 Internal Server Error</title>\n<h1>Internal Server Error</h1>\n<p>The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.</p>\n';

      const RECOVERY = 'DISTINCTIVE_SHORTEN_HINT shorten the name and retry the request.';

      function contractCtx() {
        return createMockContext({
          errors: [
            {
              reason: 'query_too_long',
              code: JsonRpcErrorCode.InvalidParams,
              when: 'the autocomplete query is over the upstream length bound',
              recovery: RECOVERY,
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

      function mockStatus(status: number): void {
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.resolve(
            new Response(UPSTREAM_500_HTML, {
              status,
              statusText: status === 500 ? 'Internal Server Error' : 'Service Unavailable',
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }),
          ),
        );
      }

      /** Run one autocomplete under fake timers so a retry loop can't stall the test. */
      async function settle(params: { entityType?: 'authors' | 'works'; query: string }) {
        vi.useFakeTimers();
        const service = await getService();
        const outcome = service.autocomplete(params, contractCtx()).then(
          () => {
            throw new Error('expected autocomplete to reject');
          },
          (error: unknown) =>
            error as { code: number; message: string; data: Record<string, unknown> },
        );
        await vi.runAllTimersAsync();
        return outcome;
      }

      it.each([
        ['1,001 ASCII letters', 'a'.repeat(1001)],
        ['1,001 code points that are 1,402 UTF-16 units', `${'a'.repeat(600)}${'😀'.repeat(401)}`],
        ['a padded name over the bound', `Albert Einstein ${'д'.repeat(990)}`],
      ])('classifies a typed 500 on %s as query_too_long after one attempt', async (_l, query) => {
        mockStatus(500);

        const error = await settle({ entityType: 'authors', query });

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'query_too_long',
            retryable: false,
            recovery: { hint: RECOVERY },
            path: '/autocomplete/authors',
            statusCode: 500,
          },
        });
        expect(error.message).toMatch(/1,000 characters/);
        expect(error.message).not.toMatch(/failed after/);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['exactly 1,000 code points', 'authors', 'a'.repeat(1000)],
        [
          '801 code points that are 1,002 UTF-16 units',
          'authors',
          `${'a'.repeat(600)}${'😀'.repeat(201)}`,
        ],
        ['a short name', 'works', 'groundwater'],
      ] as const)(
        'keeps a typed 500 on %s as retried upstream_unavailable',
        async (_label, entityType, query) => {
          mockStatus(500);

          const error = await settle({ entityType, query });

          expect(error).toMatchObject({
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { reason: 'upstream_unavailable', statusCode: 500 },
          });
          expect(error.data.retryable).toBeUndefined();
          expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        },
      );

      it('keeps a cross-entity 500 on an over-long query as retried upstream_unavailable', async () => {
        mockStatus(500);

        const error = await settle({ query: 'a'.repeat(1001) });

        expect(error).toMatchObject({ data: { reason: 'upstream_unavailable' } });
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('keeps a 503 on an over-long typed query as retried upstream_unavailable', async () => {
        mockStatus(503);

        const error = await settle({ entityType: 'authors', query: 'a'.repeat(1001) });

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unavailable', statusCode: 503 },
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('sends an over-long query upstream unchanged and returns what OpenAlex answers', async () => {
        // No local bound: a letter-free typed query and any cross-entity query over 1,000 code
        // points return 200 upstream today, and must keep doing so.
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
        );
        const service = await getService();
        const digits = '1'.repeat(1001);

        const typed = await service.autocomplete(
          { entityType: 'authors', query: digits },
          contractCtx(),
        );
        expect(typed.results).toEqual([]);
        expect(lastFetchUrl().searchParams.get('q')).toBe(digits);

        const crossEntity = await service.autocomplete({ query: 'a'.repeat(5000) }, contractCtx());
        expect(crossEntity.results).toEqual([]);
        expect(lastFetchUrl().searchParams.get('q')).toHaveLength(5000);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      });

      it('carries query_too_long and its recovery on both tool surfaces', async () => {
        mockStatus(500);
        await getService();
        const { resolveNameTool } = await import(
          '@/mcp-server/tools/definitions/resolve-name.tool.js'
        );

        const result = await runToolContract(resolveNameTool, {
          entity_type: 'authors',
          query: 'a'.repeat(1001),
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.InvalidParams,
            data: {
              reason: 'query_too_long',
              retryable: false,
              recovery: { hint: expect.stringMatching(/shorten/i) },
            },
          },
        });
        const text = (result.content ?? [])
          .map((block) => ('text' in block ? block.text : ''))
          .join('\n');
        expect(text).toMatch(/Recovery: .*shorten/i);
        expect(text).toContain('query_too_long');
        expect(text).toContain('not retryable');
        expect(text).not.toMatch(/wait and retry/i);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });
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

      it('maps a by-name group_by refusal to upstream_ungroupable_group_by (gh #86)', async () => {
        // Verbatim upstream body for works group_by=display_name.
        mock400('Cannot group by display_name.');
        const service = await getService();
        await expect(
          service.analyze({ entityType: 'works', groupBy: 'display_name' }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_ungroupable_group_by' },
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

      /**
       * The search-length ceiling is upstream's to move — OpenAlex's docs say 2,000 characters
       * with truncation while the proxy enforces a hard 400 at 1,500 — so the caller reads the
       * bound off the message rather than off a number pinned here. (gh #71)
       */
      it('maps a search-too-long 400 to query_too_long, quoting the upstream limit', async () => {
        // Verbatim upstream body for a 1,890-character `search.semantic` query.
        mock400(
          'Your search is too long (1890 characters; the limit is 1500). Very long pasted-text or Boolean searches are disproportionately expensive.',
        );
        const service = await getService();
        await expect(
          service.search(
            { entityType: 'works', query: 'a'.repeat(1890), searchMode: 'semantic' },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('the limit is 1500'),
          data: { reason: 'query_too_long' },
        });
      });

      it('classifies the bare "Search query too long" error field too', async () => {
        // Some 400 bodies carry only `error`, which is what `message ?? error` falls back to.
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(JSON.stringify({ error: 'Search query too long' }), {
            status: 400,
            statusText: 'Bad Request',
          }),
        );
        const service = await getService();
        await expect(
          service.search(
            { entityType: 'works', query: 'a'.repeat(9000), searchMode: 'keyword' },
            createMockContext(),
          ),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'query_too_long' },
        });
      });

      it('resolves the query_too_long recovery hint from the caller contract', async () => {
        mock400('Your search is too long (1890 characters; the limit is 1500).');
        const ctx = createMockContext({
          errors: [
            {
              reason: 'query_too_long',
              code: JsonRpcErrorCode.InvalidParams,
              when: 'the search text exceeds the upstream limit',
              recovery: 'DISTINCTIVE_LENGTH_HINT shorten the query or split it into several.',
            },
          ],
        });
        const service = await getService();
        await expect(
          service.search({ entityType: 'works', query: 'a'.repeat(1890) }, ctx),
        ).rejects.toMatchObject({
          data: {
            reason: 'query_too_long',
            recovery: { hint: expect.stringContaining('DISTINCTIVE_LENGTH_HINT') },
          },
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

    /**
     * Two group_by rejections arrive without "Cannot group by": the concept keys on authors
     * come back as an invalid-ID 400 naming a concept ID the caller never sent, and
     * `referenced_works` as "Group by … is not supported at this time." An invalid-ID 400 whose
     * quoted value sits in the request's `filter` stays an invalid-ID failure — upstream
     * validates the filter before group_by. Bodies are verbatim upstream responses. These run
     * through the real `fetchWithTimeout` → classification path. (gh #87)
     */
    describe('group_by rejections outside "Cannot group by" (gh #87)', () => {
      function mock400(message: string): void {
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(JSON.stringify({ error: 'Invalid query parameters error.', message }), {
            status: 400,
            statusText: 'Bad Request',
          }),
        );
      }

      async function analyzeReason(params: {
        entityType: 'authors' | 'works';
        groupBy: string;
        filters?: Record<string, string>;
      }): Promise<unknown> {
        const service = await getService();
        const error = await service.analyze(params, createMockContext()).then(
          () => {
            throw new Error('expected analyze to reject');
          },
          (e: unknown) => e as { code: number; data: { reason?: unknown } },
        );
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        return error.data.reason;
      }

      function toolText(result: { content?: { type: string; text?: string }[] }): string {
        return (result.content ?? []).map((block) => block.text ?? '').join('\n');
      }

      it.each([
        [
          'a name in an ID filter',
          'works',
          'publication_year',
          { 'authorships.author.id': 'Albert Einstein' },
          "'Albert' is not a valid OpenAlex ID.",
        ],
        [
          'a URL-form ID filter with a non-ID tail',
          'works',
          'publication_year',
          { 'authorships.author.id': 'https://openalex.org/Zzz' },
          "'Zzz' is not a valid OpenAlex ID.",
        ],
        [
          'a bad ID filter beside an ungroupable concept group_by',
          'authors',
          'x_concepts.id',
          { 'last_known_institutions.id': 'harvard' },
          "'harvard' is not a valid OpenAlex ID.",
        ],
      ] as const)(
        'keeps an invalid-ID 400 on %s as upstream_invalid_id_value',
        async (_label, entityType, groupBy, filters, message) => {
          mock400(message);
          await expect(analyzeReason({ entityType, groupBy, filters })).resolves.toBe(
            'upstream_invalid_id_value',
          );
        },
      );

      it('keeps "Cannot group by" on a filtered request as upstream_ungroupable_group_by', async () => {
        mock400('Cannot group by display_name.');
        await expect(
          analyzeReason({
            entityType: 'works',
            groupBy: 'display_name',
            filters: { publication_year: '2024' },
          }),
        ).resolves.toBe('upstream_ungroupable_group_by');
      });

      it('keeps a filtered invalid-ID 400 on upstream_invalid_id_value on both tool surfaces', async () => {
        mock400("'Albert' is not a valid OpenAlex ID.");
        await getService();
        const { analyzeTrendsTool } = await import(
          '@/mcp-server/tools/definitions/analyze-trends.tool.js'
        );

        const result = await runToolContract(analyzeTrendsTool, {
          entity_type: 'works',
          group_by: 'publication_year',
          filters: { 'authorships.author.id': 'Albert Einstein' },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.InvalidParams,
            data: {
              reason: 'upstream_invalid_id_value',
              recovery: { hint: expect.stringMatching(/openalex_resolve_name/) },
            },
          },
        });
        const text = toolText(result);
        expect(text).toMatch(/Recovery: .*openalex_resolve_name/);
        expect(text).toContain('upstream_invalid_id_value');
      });

      it.each([
        ['concepts.id', "'41008148' is not a valid OpenAlex ID."],
        ['concept.id', "'41008148' is not a valid OpenAlex ID."],
        ['x_concepts.id', "'41008148' is not a valid OpenAlex ID."],
      ])(
        'maps an unfiltered authors group_by=%s invalid-ID 400 to upstream_ungroupable_group_by',
        async (groupBy, message) => {
          mock400(message);
          await expect(analyzeReason({ entityType: 'authors', groupBy })).resolves.toBe(
            'upstream_ungroupable_group_by',
          );
        },
      );

      it('maps a concept group_by invalid-ID 400 whose value is not in the filter to upstream_ungroupable_group_by', async () => {
        // Upstream names a concept ID from its own aggregation, never one the filter carried.
        mock400("'71924100' is not a valid OpenAlex ID.");
        await expect(
          analyzeReason({
            entityType: 'authors',
            groupBy: 'concepts.id',
            filters: { works_count: '>100' },
          }),
        ).resolves.toBe('upstream_ungroupable_group_by');
      });

      it('maps "Group by … is not supported at this time" to upstream_ungroupable_group_by', async () => {
        mock400('Group by referenced_works is not supported at this time.');
        await expect(
          analyzeReason({ entityType: 'works', groupBy: 'referenced_works' }),
        ).resolves.toBe('upstream_ungroupable_group_by');
      });

      it.each([
        [
          'authors grouped by concepts.id',
          { entity_type: 'authors', group_by: 'concepts.id', per_page: 3 },
          "'41008148' is not a valid OpenAlex ID.",
        ],
        [
          'works grouped by referenced_works',
          { entity_type: 'works', group_by: 'referenced_works' },
          'Group by referenced_works is not supported at this time.',
        ],
      ] as const)(
        'carries upstream_ungroupable_group_by on both tool surfaces for %s',
        async (_label, input, message) => {
          mock400(message);
          await getService();
          const { analyzeTrendsTool } = await import(
            '@/mcp-server/tools/definitions/analyze-trends.tool.js'
          );

          const result = await runToolContract(analyzeTrendsTool, input);

          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: JsonRpcErrorCode.InvalidParams,
              message,
              data: {
                reason: 'upstream_ungroupable_group_by',
                recovery: {
                  hint: expect.stringMatching(
                    /openalex_describe_fields\(entity_type, "group_by"\)/,
                  ),
                },
              },
            },
          });
          const text = toolText(result);
          expect(text).toContain(message);
          expect(text).toMatch(/Recovery: .*openalex_describe_fields/);
          expect(text).toContain('upstream_ungroupable_group_by');
          expect(text).not.toMatch(/openalex_resolve_name/);
        },
      );
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

    /**
     * OpenAlex indexes no PMCIDs at all, so a `pmcid:` lookup 404s however well formed it is.
     * The generic recovery ("verify the ID format") sends a caller back to retry an identifier
     * that can never resolve, so the 404 mapping substitutes the conversion guidance for that
     * one scheme — in the service, where all three ID-accepting tools inherit it.
     */
    describe('PMCID 404 recovery (gh #67)', () => {
      /** Contract with a distinctive generic recovery, so a substitution is unmistakable. */
      const notFoundContract = [
        {
          reason: 'entity_not_found',
          code: JsonRpcErrorCode.NotFound,
          when: 'lookup by id matched no OpenAlex entity',
          recovery: 'GENERIC_NOT_FOUND_HINT verify the ID format or resolve the name first.',
        },
      ] as const;

      function mock404(): void {
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(JSON.stringify({ error: 'Not found.' }), {
            status: 404,
            statusText: 'Not Found',
          }),
        );
      }

      it.each([
        ['a bare PMCID', 'PMC3084216'],
        ['a PMC URL', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/'],
        ['a legacy PMC URL', 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/'],
        ['an uppercase-scheme PMCID', 'PMCID:PMC3084216'],
      ])('substitutes the conversion recovery for %s', async (_label, id) => {
        mock404();
        const ctx = createMockContext({ errors: notFoundContract });
        const service = await getService();

        await expect(service.search({ entityType: 'works', id }, ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'entity_not_found',
            path: '/works/pmcid:PMC3084216',
            recovery: {
              hint: expect.stringContaining('OpenAlex indexes no PMCIDs'),
            },
          },
        });
      });

      it('names the NCBI ID Converter and the PMID/DOI conversion in the hint', async () => {
        mock404();
        const ctx = createMockContext({ errors: notFoundContract });
        const service = await getService();

        const rejection = await service.search({ entityType: 'works', id: 'PMC3084216' }, ctx).then(
          () => undefined,
          (error: unknown) => error,
        );

        const hint = (rejection as { data: { recovery: { hint: string } } }).data.recovery.hint;
        expect(hint).toContain('PMID');
        expect(hint).toContain('DOI');
        expect(hint).toContain('https://www.ncbi.nlm.nih.gov/pmc/tools/idconv/');
        expect(hint).not.toContain('GENERIC_NOT_FOUND_HINT');
      });

      it.each([
        ['a DOI', '10.1371/journal.pone.0000217', '/works/doi:10.1371/journal.pone.0000217'],
        ['a native work ID', 'W99999999999', '/works/W99999999999'],
        ['a PMID', 'PMID:21491125', '/works/pmid:21491125'],
      ])('keeps the generic recovery for %s', async (_label, id, path) => {
        mock404();
        const ctx = createMockContext({ errors: notFoundContract });
        const service = await getService();

        await expect(service.search({ entityType: 'works', id }, ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'entity_not_found',
            path,
            recovery: { hint: expect.stringContaining('GENERIC_NOT_FOUND_HINT') },
          },
        });
      });
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

    it('marks a syntactically valid head-tail elision as truncated', async () => {
      const longMessage =
        'This combination of fields is not allowed. Valid fields are: ' +
        'publication_year, cited_by_count, '.repeat(40);
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
        service.search({ entityType: 'works' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message:
          'This combination of fields is not allowed. (list of valid fields omitted — was truncated upstream; see OpenAlex docs)',
        data: { reason: 'upstream_invalid_params_other' },
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
