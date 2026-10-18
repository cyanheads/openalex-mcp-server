/**
 * @fileoverview Tests for OpenAlexService — exercises normalizeId, buildFilterString,
 * reconstructAbstract, and error handling through the public API with mocked fetch.
 * @module services/openalex/openalex-service.test
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECT, type EntityType } from '@/services/openalex/types.js';

/** The `structuredContent.error` a failed tool call returns. */
interface ErrorEnvelope {
  code: number;
  data: Record<string, unknown>;
  message: string;
}

/**
 * Run `call` inside a throwaway tool that declares `errors`, through `runToolContract`, and
 * return the error envelope a client receives. The service puts only `data.reason` on a throw;
 * the framework fills the matching entry's recovery from the calling tool's contract, so a
 * recovery assertion reads the envelope rather than the service throw.
 */
async function failThroughContract(
  errors: readonly ErrorContract[],
  call: (ctx: Context) => Promise<unknown>,
): Promise<ErrorEnvelope> {
  const probe = tool('contract_probe', {
    description: 'Runs one service call under a declared error contract.',
    input: z.object({}),
    output: z.object({}),
    errors,
    async handler(_input, ctx) {
      await call(ctx);
      return {};
    },
  });
  const result = await runToolContract(probe, {});
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

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

/** A JSON response for a routed fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The HTML page OpenAlex serves for a by-ID path that addresses nothing. */
function html404(): Response {
  return new Response('<!doctype html><title>404 Not Found</title>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * Answer each `api.openalex.org` request from `routes`, keyed by path. Any other host, and any
 * path the case did not list, rejects — so a request the code under test should never make
 * fails the case instead of reading a default body.
 */
function routeFetch(routes: Record<string, (url: URL) => Response>): void {
  vi.mocked(globalThis.fetch).mockImplementation((input) => {
    const url = new URL(String(input));
    const route = url.hostname === 'api.openalex.org' ? routes[url.pathname] : undefined;
    return route
      ? Promise.resolve(route(url))
      : Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
  });
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
    mockConfig.apiKey = 'test-key';
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

    it('carries the fields the 2026-10-18 regeneration recovered (gh #104)', async () => {
      const { getFieldCatalog } = await import('@/services/openalex/openalex-service.js');
      const catalog = getFieldCatalog();
      expect(catalog.works.filter).toEqual(
        expect.arrayContaining([
          'funders.country_code',
          'primary_location.source.listed_in',
          'study_designs.id',
          'title_abstract_keywords.search',
          'volume.id',
        ]),
      );
      expect(catalog.works.select).toEqual(
        expect.arrayContaining(['rerank_score', 'study_designs', 'volume']),
      );
      expect(catalog.sources.filter).toEqual(
        expect.arrayContaining(['host_organization.country_code', 'listed_in']),
      );
      expect(catalog.sources.select).toEqual(expect.arrayContaining(['apc_usd_by_year']));
      expect(catalog.institutions.filter).toEqual(expect.arrayContaining(['geo.city']));
      expect(catalog.keywords.filter).toEqual(expect.arrayContaining(['topics.id']));
    });

    it('suggests a recovered field for a near-miss upstream rejects (gh #104)', async () => {
      const message = `study_design is not a valid select field. Valid fields: ${'apc_list, '.repeat(60)}id`;
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Invalid query parameters error.', message }), {
          status: 400,
        }),
      );
      const { initOpenAlexService, getOpenAlexService } = await import(
        '@/services/openalex/openalex-service.js'
      );
      initOpenAlexService();

      const err = (await getOpenAlexService()
        .search({ entityType: 'works', select: ['study_design'] }, createMockContext())
        .catch((e) => e)) as { message: string };

      expect(err.message).toMatch(/Did you mean: study_designs\b/);
    });

    /**
     * `author_list` is derived by this server, so no upstream valid-field list names it and the
     * generator's JSON never will; the catalog adds it in code. (gh #102)
     */
    it('lists the derived author_list in works select only, beside the generated fields (gh #102)', async () => {
      const { default: generated } = await import('@/services/openalex/field-catalog.json');
      const { getFieldCatalog } = await import('@/services/openalex/openalex-service.js');
      const catalog = getFieldCatalog();

      expect(generated.works.select).not.toContain('author_list');
      expect(catalog.works.select).toEqual([...generated.works.select, 'author_list']);
      expect(catalog.works.filter).toEqual(generated.works.filter);
      for (const entityType of ENTITY_TYPES_UNDER_TEST.filter((t) => t !== 'works')) {
        expect(catalog[entityType]).toEqual(generated[entityType]);
      }
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

    /**
     * OpenAlex's record pages put the entity type in the path (`/works/W…`), and its API URLs,
     * `http://` links, and scheme-less copies carry a different host or scheme. Each names
     * exactly one ID, so each reaches the by-ID path as that bare ID. (gh #99)
     */
    it.each([
      'https://openalex.org/works/W2741809807',
      'https://api.openalex.org/works/W2741809807',
      'https://api.openalex.org/W2741809807',
      'http://openalex.org/W2741809807',
      'http://api.openalex.org/works/W2741809807',
      'https://www.openalex.org/works/W2741809807',
      'openalex.org/works/W2741809807',
      'api.openalex.org/W2741809807',
      'https://openalex.org/W2741809807/',
      'https://openalex.org/works/W2741809807/',
      'https://api.openalex.org/works/W2741809807?select=id',
      'https://openalex.org/works/W2741809807#cited-by',
      'HTTPS://OPENALEX.ORG/WORKS/W2741809807',
      'https://openalex.org/works/w2741809807',
      '  https://openalex.org/works/W2741809807\n',
    ])('resolves the OpenAlex URL %j to the bare ID (gh #99)', async (id) => {
      expect((await searchById(id)).pathname).toBe('/works/W2741809807');
    });

    it.each([
      ['a look-alike host', 'https://notopenalex.org/works/W2741809807'],
      ['a host that only starts with openalex.org', 'https://openalex.org.example/W2741809807'],
      ['a scheme-less look-alike host', 'openalex.org.example/W2741809807'],
      ['a path segment that is not an entity type', 'https://openalex.org/fields/17'],
      ['an extra path segment', 'https://openalex.org/works/W2741809807/cites'],
      ['an entity-type path with no ID', 'https://api.openalex.org/works'],
      ['a port', 'https://openalex.org:8443/W2741809807'],
      ['another scheme', 'ftp://openalex.org/W2741809807'],
    ])('passes %s through unchanged (gh #99)', async (_label, id) => {
      expect((await searchById(id)).pathname).toBe(`/works/${id}`);
    });

    it.each([
      [
        'https://openalex.org/works/W27418\n09807',
        '/works/https://openalex.org/works/W27418%0A09807',
      ],
      ['openalex.org/W27 41809807', '/works/openalex.org/W27%2041809807'],
    ])(
      'does not read the URL %j, with whitespace inside it, as an OpenAlex ID (gh #99)',
      async (id, path) => {
        // The URL parser drops tabs and line breaks, which would quietly join the halves. The
        // value passes through as written, its whitespace percent-encoded inside the path.
        expect((await searchById(id)).pathname).toBe(path);
      },
    );
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

    it.each([
      'http://openalex.org/keywords/groundwater',
      'https://api.openalex.org/keywords/groundwater',
      'https://www.openalex.org/keywords/groundwater?x=1',
      'openalex.org/keywords/groundwater',
    ])('resolves the keyword URL %s to /keywords/groundwater (gh #99)', async (id) => {
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
        entityTypes: ['keywords'],
        id: 'groundwater',
        scheme: 'openalex',
      });
    });

    it.each([
      ['http://openalex.org/keywords/groundwater'],
      ['https://api.openalex.org/keywords/groundwater'],
    ])('infers the keywords entity type from the keyword URL %s (gh #99)', async (query) => {
      const { inferIdentifier } = await import('@/services/openalex/openalex-service.js');
      expect(inferIdentifier(query)).toEqual({
        entityTypes: ['keywords'],
        id: 'groundwater',
        scheme: 'openalex',
      });
    });

    it.each([
      ['a slugless keyword path', 'https://openalex.org/keywords/'],
      ['a slugless keyword path without the slash', 'https://api.openalex.org/keywords'],
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
    async function infer(query: string, requested?: EntityType) {
      const { inferIdentifier } = await import('@/services/openalex/openalex-service.js');
      return inferIdentifier(query, requested);
    }

    it.each([
      ['bare DOI', '10.1038/nature12373', 'works', 'doi'],
      ['DOI URL', 'https://doi.org/10.1038/nature12373', 'works', 'doi'],
      ['bare ORCID', '0000-0002-1825-0097', 'authors', 'orcid'],
      ['ORCID URL', 'https://orcid.org/0000-0001-9487-6983', 'authors', 'orcid'],
      ['ISSN', '0028-0836', 'sources', 'issn'],
      ['PMCID', 'PMC1234567', 'works', 'pmcid'],
      ['PMID', '23903748', 'works', 'pmid'],
      ['already-prefixed DOI', 'doi:10.1038/nature12373', 'works', 'doi'],
      ['uppercase-scheme PMID', 'PMID:21491125', 'works', 'pmid'],
      ['uppercase-scheme ORCID', 'ORCID:0000-0002-1825-0097', 'authors', 'orcid'],
      ['PubMed URL', 'https://pubmed.ncbi.nlm.nih.gov/21491125', 'works', 'pmid'],
      ['PMC URL', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/', 'works', 'pmcid'],
      ['legacy PMC URL', 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/', 'works', 'pmcid'],
    ])('maps a %s to %s', async (_label, query, entityType, scheme) => {
      expect(await infer(query)).toEqual({
        entityTypes: [entityType],
        scheme,
        id: expect.stringContaining(':'),
      });
    });

    /**
     * A bare native ID is also the shape of a short name — keyword `p53`, `F1`, `S1` — so it is
     * marked as one a miss should search by name next. (gh #106)
     */
    it.each([
      ['W2159974629', 'works'],
      ['A5022021627', 'authors'],
      ['S137773608', 'sources'],
      ['I241749', 'institutions'],
      ['T10159', 'topics'],
      ['P4310320595', 'publishers'],
      ['F4320332161', 'funders'],
    ])('derives %s → %s from the native ID letter', async (query, entityType) => {
      expect(await infer(query)).toEqual({
        entityTypes: [entityType],
        id: query,
        scheme: 'openalex',
        mayBeName: true,
      });
    });

    it.each(['P53', 'F1', 'S1', 'A1', 'T10159', 'W2741809807'])(
      'reads the bare native-ID shape %s as a keyword name under entity_type keywords (gh #106)',
      async (query) => {
        expect(await infer(query, 'keywords')).toBeUndefined();
      },
    );

    it('keeps an OpenAlex URL an identifier under entity_type keywords (gh #106)', async () => {
      // The URL names its record outright, so neither entity_type nor a name search applies.
      expect(await infer('https://openalex.org/P53', 'keywords')).toEqual({
        entityTypes: ['publishers'],
        id: 'P53',
        scheme: 'openalex',
      });
    });

    it('strips the OpenAlex URL form before reading the letter', async () => {
      expect(await infer('https://openalex.org/I241749')).toEqual({
        entityTypes: ['institutions'],
        id: 'I241749',
        scheme: 'openalex',
      });
    });

    /**
     * One ROR can address an institution, a funder, and a publisher record at once — NSF's
     * `021nxhr62` is all three — so with no `entity_type` (or one a ROR cannot name) every
     * type is looked up, institution first; one of the three narrows it to that type. (gh #98)
     */
    it.each([
      ['ROR URL', 'https://ror.org/021nxhr62', 'ror:https://ror.org/021nxhr62'],
      ['bare ROR', '021nxhr62', 'ror:021nxhr62'],
      ['all-digit bare ROR', '005781934', 'ror:005781934'],
      ['uppercase-scheme ROR', 'ROR:013meh722', 'ror:013meh722'],
    ])('looks a %s up as all three organization types (gh #98)', async (_label, query, id) => {
      const all = ['institutions', 'funders', 'publishers'];
      expect(await infer(query)).toEqual({ entityTypes: all, id, scheme: 'ror' });
      expect(await infer(query, 'works')).toEqual({ entityTypes: all, id, scheme: 'ror' });
      expect(await infer(query, 'keywords')).toEqual({ entityTypes: all, id, scheme: 'ror' });
    });

    it.each(['institutions', 'funders', 'publishers'] as const)(
      'narrows a ROR to %s when entity_type names it (gh #98)',
      async (requested) => {
        expect(await infer('021nxhr62', requested)).toEqual({
          entityTypes: [requested],
          id: 'ror:021nxhr62',
          scheme: 'ror',
        });
      },
    );

    /**
     * Funders are keyed by Crossref Funder Registry DOIs (`10.13039/…`), so one reads as a funder
     * unless the caller asks for works — 3,147 works carry such a DOI by mis-attribution, and
     * `entity_type: "works"` keeps each of them reachable. (gh #98)
     */
    it.each([
      ['a bare funder DOI', '10.13039/100000001'],
      ['a doi:-prefixed funder DOI', 'doi:10.13039/100000001'],
      ['a doi.org funder DOI URL', 'https://doi.org/10.13039/100000001'],
    ])('reads %s as a funder unless works is asked for (gh #98)', async (_label, query) => {
      const funder = { entityTypes: ['funders'], id: 'doi:10.13039/100000001', scheme: 'doi' };
      expect(await infer(query)).toEqual(funder);
      expect(await infer(query, 'funders')).toEqual(funder);
      expect(await infer(query, 'authors')).toEqual(funder);
      expect(await infer(query, 'works')).toEqual({ ...funder, entityTypes: ['works'] });
    });

    it.each([
      ['an ordinary DOI', '10.1038/nature12373', 'works'],
      ['an ORCID', '0000-0002-1825-0097', 'authors'],
      ['an ISSN', '0028-0836', 'sources'],
      ['a native ID', 'W2159974629', 'works'],
    ])(
      'keeps %s on its own entity type whatever entity_type asks for (gh #98)',
      async (_label, query, own) => {
        for (const requested of ['funders', 'institutions', 'publishers', undefined] as const) {
          expect((await infer(query, requested))?.entityTypes).toEqual([own]);
        }
      },
    );

    it.each([
      ['https://openalex.org/works/W2741809807', 'works', 'W2741809807'],
      ['https://api.openalex.org/works/W2741809807', 'works', 'W2741809807'],
      ['https://api.openalex.org/W2741809807', 'works', 'W2741809807'],
      ['http://openalex.org/W2741809807', 'works', 'W2741809807'],
      ['openalex.org/works/W2741809807', 'works', 'W2741809807'],
      ['https://openalex.org/W2741809807/', 'works', 'W2741809807'],
      ['https://api.openalex.org/works/W2741809807?select=id', 'works', 'W2741809807'],
      ['https://openalex.org/works/w2741809807', 'works', 'W2741809807'],
      ['https://openalex.org/authors/A5023888391', 'authors', 'A5023888391'],
      ['https://openalex.org/funders/F4320306076', 'funders', 'F4320306076'],
    ])('reads the OpenAlex URL %s as a %s ID (gh #99)', async (query, entityType, id) => {
      expect(await infer(query)).toEqual({ entityTypes: [entityType], id, scheme: 'openalex' });
    });

    it.each([
      ['a bare lowercase work ID', 'w2741809807'],
      ['a bare lowercase keyword-shaped name', 'p53'],
      ['an OpenAlex path that is not an entity type', 'https://openalex.org/fields/17'],
    ])('leaves %s to name resolution (gh #99)', async (_label, query) => {
      expect(await infer(query)).toBeUndefined();
    });

    it.each([
      ['a plain name', 'Albert Einstein'],
      ['a name with a colon', 'Nature: a weekly journal'],
      ['a short numeric string', '1234'],
      ['an empty-ish query', '   '],
      // Prefixes that lower-case to an Object.prototype member — a scheme lookup that read
      // inherited members routed these to the by-ID path with a function, or the prototype
      // object itself, as the entity type. (gh #93)
      ['a constructor: prefix', 'Constructor: a theory'],
      ['an upper-case CONSTRUCTOR: prefix', 'CONSTRUCTOR:x'],
      ['a __proto__: prefix', '__proto__: prototypes in practice'],
      ['an upper-case __PROTO__: prefix', '__PROTO__:x'],
    ])('leaves %s to autocomplete', async (_label, query) => {
      expect(await infer(query)).toBeUndefined();
    });

    it('leaves camel-case prototype-member prefixes to autocomplete (gh #93)', async () => {
      // Characterization: the scheme is lower-cased before the table lookup, so `toString` and
      // `hasOwnProperty` read as `tostring` / `hasownproperty` and never named a member.
      expect(await infer('toString: a history of string conversion')).toBeUndefined();
      expect(await infer('hasOwnProperty: ownership in law')).toBeUndefined();
    });

    it('stamps the folded scheme onto the id it hands the by-ID lookup (gh #66)', async () => {
      expect(await infer('PMID:21491125')).toEqual({
        entityTypes: ['works'],
        id: 'pmid:21491125',
        scheme: 'pmid',
      });
    });

    it('reads a bare PubMed URL as a PMID instead of falling through (gh #66)', async () => {
      expect(await infer('https://pubmed.ncbi.nlm.nih.gov/21491125')).toEqual({
        entityTypes: ['works'],
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
        { entityTypes: [entityType as 'works'], id, scheme: 'doi' },
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
          { entityTypes: ['works'], id: 'doi:10.1038/x', scheme: 'doi' },
          createMockContext(),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.Unauthorized });
    });

    /**
     * A ROR with no narrowing entity_type is looked up as an institution, a funder, and a
     * publisher at once — three unbilled singleton fetches — and every record found comes back,
     * institution first, whatever order the responses arrive in. (gh #98)
     */
    describe('ROR fan-out (gh #98)', () => {
      const ROR_TYPES = ['institutions', 'funders', 'publishers'] as const;
      const nsf = {
        institutions: { id: 'https://openalex.org/I1311060795', display_name: 'U.S. NSF' },
        funders: { id: 'https://openalex.org/F4320306076', display_name: 'NSF' },
        publishers: { id: 'https://openalex.org/P4365365866', display_name: 'NSF' },
      };

      /** Answer each type's `/…/ror:<ror>` path after `delayMs`, with its record or a 404. */
      function routeRor(
        ror: string,
        answers: Partial<Record<(typeof ROR_TYPES)[number], () => Response>>,
        delayMs: Partial<Record<(typeof ROR_TYPES)[number], number>> = {},
      ) {
        vi.mocked(globalThis.fetch).mockImplementation((input) => {
          const url = new URL(String(input));
          const type = ROR_TYPES.find((t) => url.pathname === `/${t}/ror:${ror}`);
          if (url.hostname !== 'api.openalex.org' || type === undefined) {
            return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
          }
          const answer = answers[type] ?? html404;
          return new Promise((resolve) => setTimeout(() => resolve(answer()), delayMs[type] ?? 0));
        });
      }

      async function resolveRor(ror: string, ctx = createMockContext()) {
        const service = await getService();
        return service.resolveIdentifier(
          { entityTypes: ROR_TYPES, id: `ror:${ror}`, scheme: 'ror' },
          ctx,
        );
      }

      it('returns every record found, institution first, in parallel', async () => {
        // The funder answers first and the institution last; the order stays I, F, P.
        let requestedWhenFunderAnswered = 0;
        routeRor(
          '021nxhr62',
          {
            institutions: () => jsonResponse(nsf.institutions),
            funders: () => {
              requestedWhenFunderAnswered = vi.mocked(globalThis.fetch).mock.calls.length;
              return jsonResponse(nsf.funders);
            },
            publishers: () => jsonResponse(nsf.publishers),
          },
          { institutions: 30, funders: 0, publishers: 15 },
        );

        const result = await resolveRor('021nxhr62');

        // All three lookups were in flight before the first answer; one at a time, the funder
        // lookup would answer after only the institution's and its own were sent.
        expect(requestedWhenFunderAnswered).toBe(3);
        expect(result.results.map((r) => [r.id, r.entity_type])).toEqual([
          ['https://openalex.org/I1311060795', 'institution'],
          ['https://openalex.org/F4320306076', 'funder'],
          ['https://openalex.org/P4365365866', 'publisher'],
        ]);
        expect(result.failedEntityTypes).toBeUndefined();
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('returns the one record a ROR holds when the other two 404', async () => {
        routeRor('04dzdm737', {
          institutions: () =>
            jsonResponse({ id: 'https://openalex.org/I1327191685', display_name: 'deCODE' }),
        });

        const result = await resolveRor('04dzdm737');

        expect(result.results.map((r) => r.id)).toEqual(['https://openalex.org/I1327191685']);
        expect(result.failedEntityTypes).toBeUndefined();
      });

      it('returns no results, without throwing, when all three 404', async () => {
        routeRor('0zzzzzz99', {});
        const result = await resolveRor('0zzzzzz99');
        expect(result).toEqual({ results: [] });
      });

      it('keeps the records that resolved when one lookup fails, and names the failed type', async () => {
        routeRor('021nxhr62', {
          institutions: () => jsonResponse(nsf.institutions),
          funders: () => jsonResponse({ error: 'Forbidden' }, 403),
          publishers: () => jsonResponse(nsf.publishers),
        });

        const result = await resolveRor('021nxhr62');

        expect(result.results.map((r) => r.entity_type)).toEqual(['institution', 'publisher']);
        expect(result.failedEntityTypes).toEqual(['funders']);
      });

      it('throws when a lookup fails and none returned a record', async () => {
        // An empty answer would claim no funder exists when the funder lookup never finished.
        routeRor('021nxhr62', { funders: () => jsonResponse({ error: 'Forbidden' }, 403) });

        await expect(resolveRor('021nxhr62')).rejects.toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
        });
      });

      it('never reports a caller cancellation as a partial success', async () => {
        const controller = new AbortController();
        let hung = 0;
        vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
          const url = new URL(String(input));
          if (url.hostname !== 'api.openalex.org') {
            return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
          }
          if (url.pathname === '/institutions/ror:021nxhr62') {
            return Promise.resolve(jsonResponse(nsf.institutions));
          }
          // The funder and publisher lookups hang until the caller cancels, which it does once
          // both are in flight, so the institution's record is in hand when the abort lands.
          hung += 1;
          if (hung === 2) setTimeout(() => controller.abort(), 0);
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        });

        await expect(
          resolveRor('021nxhr62', createMockContext({ signal: controller.signal })),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        expect(hung).toBe(2);
      });
    });

    /**
     * A bare native-ID shape is also a short name (`P53` is a keyword), so a lookup that finds no
     * record runs the caller's name search next — once, on a miss only, inside one deadline that
     * starts with the lookup. (gh #106)
     */
    describe('name search after an ID miss (gh #106)', () => {
      const P53 = {
        entityTypes: ['publishers'],
        id: 'P53',
        scheme: 'openalex',
        mayBeName: true,
      } as const;
      const nameSearch = { query: 'P53', entityType: 'keywords' } as const;
      const p53Keyword = {
        id: 'https://openalex.org/keywords/p53',
        display_name: 'p53',
        entity_type: 'keyword',
        external_id: null,
        cited_by_count: 3606453,
        works_count: 116388,
        hint: null,
      };

      /** A fetch that never settles on its own — only an abort of its signal ends it. */
      function hang(init: RequestInit | undefined): Promise<Response> {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }

      it('runs no name search when the identifier resolves, so a real ID costs one request', async () => {
        routeFetch({
          '/publishers/P4310320595': () =>
            jsonResponse({ id: 'https://openalex.org/P4310320595', display_name: 'Elsevier' }),
        });
        const service = await getService();

        const result = await service.resolveIdentifier(
          { ...P53, id: 'P4310320595' },
          createMockContext(),
          nameSearch,
        );

        expect(result).toEqual({
          results: [expect.objectContaining({ id: 'https://openalex.org/P4310320595' })],
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it('returns the name matches after a miss, flagged as a name search', async () => {
        routeFetch({
          '/publishers/P53': html404,
          '/autocomplete/keywords': () =>
            jsonResponse({ meta: { count: 1 }, results: [p53Keyword] }),
        });
        const service = await getService();

        const result = await service.resolveIdentifier(P53, createMockContext(), nameSearch);

        expect(result).toEqual({ results: [p53Keyword], nameFallback: {} });
        expect(lastFetchUrl().searchParams.get('q')).toBe('P53');
      });

      it('keeps the plain miss when no name search is given', async () => {
        routeFetch({ '/publishers/P53': html404 });
        const service = await getService();

        const result = await service.resolveIdentifier(P53, createMockContext());

        expect(result).toEqual({ results: [] });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it('settles the slow lookup and its name search under one 45 s deadline', async () => {
        vi.useFakeTimers();
        let lookups = 0;
        vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
          const url = new URL(String(input));
          if (url.hostname !== 'api.openalex.org') {
            return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
          }
          // Two by-ID attempts time out before the third answers 404; the name search never answers.
          if (url.pathname === '/publishers/P53') {
            lookups += 1;
            return lookups < 3 ? hang(init) : Promise.resolve(html404());
          }
          if (url.pathname === '/autocomplete/keywords') return hang(init);
          return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
        });
        const service = await getService();
        const startedAt = Date.now();

        let settledAt = 0;
        const pending = service
          .resolveIdentifier(P53, createMockContext(), nameSearch)
          .finally(() => {
            settledAt = Date.now();
          });
        const outcome = expect(pending).resolves.toEqual({
          results: [],
          nameFallback: { failedReason: 'upstream_timeout' },
        });
        await vi.runAllTimersAsync();

        await outcome;
        expect(lookups).toBe(3);
        expect(settledAt - startedAt).toBeLessThanOrEqual(45_000);
        // The ID phase alone took over 20 s, so the deadline — not the name search's own retry
        // budget, which outlasts what was left — is what ended the call.
        expect(settledAt - startedAt).toBeGreaterThan(40_000);
      });

      it('rethrows a caller cancellation during the name search instead of degrading it', async () => {
        const controller = new AbortController();
        vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
          const url = new URL(String(input));
          if (url.hostname !== 'api.openalex.org') {
            return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
          }
          if (url.pathname === '/publishers/P53') return Promise.resolve(html404());
          if (url.pathname === '/autocomplete/keywords') {
            setTimeout(() => controller.abort(), 0);
            return hang(init);
          }
          return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
        });
        const service = await getService();

        await expect(
          service.resolveIdentifier(
            P53,
            createMockContext({ signal: controller.signal }),
            nameSearch,
          ),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      });

      it.each([
        ['an outage', 503, { error: 'Service Unavailable' }, 'upstream_unavailable'],
        ['a burst throttle', 429, { error: 'Rate limit exceeded' }, 'rate_limited'],
      ])(
        'discloses %s on the name search as a failed fallback, not an error',
        async (_label, status, body, failedReason) => {
          vi.useFakeTimers();
          routeFetch({
            '/publishers/P53': html404,
            '/autocomplete/keywords': () => jsonResponse(body, status),
          });
          const service = await getService();

          const outcome = expect(
            service.resolveIdentifier(P53, createMockContext(), nameSearch),
          ).resolves.toEqual({ results: [], nameFallback: { failedReason } });
          await vi.runAllTimersAsync();

          await outcome;
          // One lookup, then every attempt the retry budget allows at the name search.
          expect(globalThis.fetch).toHaveBeenCalledTimes(4);
        },
      );

      it.each([
        [
          'a rejected filter',
          400,
          { error: 'Invalid query parameters error.', message: 'bogus is not a valid field.' },
          JsonRpcErrorCode.InvalidParams,
        ],
        [
          'a spent daily budget',
          429,
          { error: 'Rate limit exceeded', message: 'Insufficient budget. Resets at midnight UTC.' },
          JsonRpcErrorCode.RateLimited,
        ],
        // gh #114: a filter the caller's name search carries that OpenAlex serves only on a paid plan.
        [
          'a plan-gated filter',
          429,
          {
            error: 'Plan upgrade required',
            message:
              'The "from_created_date:2026-10-01" filter is part of daily sync, which comes with the Member+ and Partner plans. See https://help.openalex.org/access/sync/ for details.',
          },
          JsonRpcErrorCode.Forbidden,
        ],
      ])('fails the call on %s from the name search', async (_label, status, body, code) => {
        routeFetch({
          '/publishers/P53': html404,
          '/autocomplete/keywords': () => jsonResponse(body, status),
        });
        const service = await getService();

        await expect(
          service.resolveIdentifier(P53, createMockContext(), nameSearch),
        ).rejects.toMatchObject({ code });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      });
    });
  });

  // --- A funder looked up by its Crossref Funder Registry DOI (gh #98) ---

  describe('funder DOI lookups (gh #98)', () => {
    const nsfFunder = {
      id: 'https://openalex.org/F4320306076',
      display_name: 'National Science Foundation',
    };

    /**
     * OpenAlex's `/funders/doi:` path resolves nothing, while the `ids.doi` filter matches a
     * funder by its bare registry DOI; the DOI's URL form matches nothing there.
     */
    it.each([
      '10.13039/100000001',
      'doi:10.13039/100000001',
      'DOI:10.13039/100000001',
      'https://doi.org/10.13039/100000001',
    ])('looks %s up through the ids.doi filter', async (id) => {
      routeFetch({
        '/funders': () =>
          jsonResponse({
            meta: { count: 1, per_page: 1, next_cursor: null },
            results: [nsfFunder],
          }),
      });
      const service = await getService();

      const result = await service.search({ entityType: 'funders', id }, createMockContext());

      const url = lastFetchUrl();
      expect(url.pathname).toBe('/funders');
      expect(url.searchParams.get('filter')).toBe('ids.doi:10.13039/100000001');
      expect(url.searchParams.get('per_page')).toBe('1');
      expect(url.searchParams.get('select')).toBe(DEFAULT_SELECT.funders.join(','));
      expect(result).toEqual({
        meta: { count: 1, per_page: 1, next_cursor: null },
        results: [nsfFunder],
      });
    });

    it('fails a DOI no funder carries as entity_not_found', async () => {
      routeFetch({
        '/funders': () =>
          jsonResponse({ meta: { count: 0, per_page: 1, next_cursor: null }, results: [] }),
      });
      const service = await getService();

      await expect(
        service.search({ entityType: 'funders', id: '10.1038/nature12373' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'entity_not_found' },
        message: expect.stringContaining('10.1038/nature12373'),
      });
      expect(lastFetchUrl().searchParams.get('filter')).toBe('ids.doi:10.1038/nature12373');
    });

    /**
     * A filter value is read as filter syntax: `|` is OR, `+` is AND, `!` negates, and a comma
     * splits the clause. A DOI carrying one would match some other funder — or every funder —
     * and come back as "the entity at that ID", so it fails without a request.
     */
    it.each([
      '10.1000/a|10.13039/100000001',
      'doi:!10.13039/100000001',
      'doi:10.13039/1+10.13039/2',
      'doi:10.13039/1,2',
      'doi:>10.13039/1',
    ])('fails %j as entity_not_found without a request', async (id) => {
      routeFetch({});
      const service = await getService();

      await expect(
        service.search({ entityType: 'funders', id }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'entity_not_found' },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['works', '10.13039/100000001', '/works/doi:10.13039/100000001'],
      ['funders', 'https://ror.org/021nxhr62', '/funders/ror:https://ror.org/021nxhr62'],
      ['funders', 'F4320306076', '/funders/F4320306076'],
    ])('keeps a %s lookup of %s on its by-ID path', async (entityType, id, path) => {
      routeFetch({ [path]: () => jsonResponse(nsfFunder) });
      const service = await getService();

      await service.search({ entityType: entityType as 'works', id }, createMockContext());

      expect(lastFetchUrl().pathname).toBe(path);
    });
  });

  // --- A by-ID `id` stays inside its own path segment (gh #109) ---

  describe('by-ID request URLs (gh #109)', () => {
    /** Send one by-ID lookup and return the URL it requested. */
    async function requestFor(entityType: EntityType, id: string): Promise<URL> {
      vi.mocked(globalThis.fetch).mockImplementation((input) => {
        const url = new URL(String(input));
        return url.hostname === 'api.openalex.org'
          ? Promise.resolve(jsonResponse({ id: 'https://openalex.org/W1', display_name: 'One' }))
          : Promise.reject(new Error(`unmocked fetch: ${url.href}`));
      });
      const service = await getService();
      await service.search({ entityType, id, select: ['id'] }, createMockContext());
      return lastFetchUrl();
    }

    /**
     * Characterization: every legitimate identifier shape is sent exactly as it was before the
     * path was confined — `/` stays a separator (DOIs carry it), and the characters a URL parse
     * already encodes (`<`, `>`, a space) are encoded the same way.
     */
    it.each([
      ['works', 'W2741809807', '/works/W2741809807'],
      ['works', 'w2741809807', '/works/w2741809807'],
      ['works', 'https://openalex.org/works/W2741809807', '/works/W2741809807'],
      ['works', 'https://api.openalex.org/W2741809807', '/works/W2741809807'],
      ['authors', 'https://openalex.org/authors/A5023888391', '/authors/A5023888391'],
      ['sources', 'V137773608', '/sources/V137773608'],
      ['funders', 'F4320306076', '/funders/F4320306076'],
      ['keywords', 'groundwater', '/keywords/groundwater'],
      ['keywords', 'https://openalex.org/keywords/machine-learning', '/keywords/machine-learning'],
      ['works', '10.1038/nature12373', '/works/doi:10.1038/nature12373'],
      ['works', 'https://doi.org/10.1038/nature12373', '/works/doi:10.1038/nature12373'],
      ['works', 'DOI:10.1136/BMJ.F5137', '/works/doi:10.1136/BMJ.F5137'],
      ['works', '10.1000/a/b/c', '/works/doi:10.1000/a/b/c'],
      [
        'works',
        '10.1002/(SICI)1097-4636(199706)35:4<439::AID-JBM4>3.0.CO;2-H',
        '/works/doi:10.1002/(SICI)1097-4636(199706)35:4%3C439::AID-JBM4%3E3.0.CO;2-H',
      ],
      ['works', '10.1000/100%25', '/works/doi:10.1000/100%25'],
      ['works', '10.1000/a b', '/works/doi:10.1000/a%20b'],
      ['authors', '0000-0002-1825-0097', '/authors/orcid:0000-0002-1825-0097'],
      [
        'authors',
        'https://orcid.org/0000-0002-1825-0097',
        '/authors/orcid:https://orcid.org/0000-0002-1825-0097',
      ],
      ['institutions', 'https://ror.org/021nxhr62', '/institutions/ror:https://ror.org/021nxhr62'],
      ['publishers', '021nxhr62', '/publishers/ror:021nxhr62'],
      ['sources', '0028-0836', '/sources/issn:0028-0836'],
      ['works', '23903748', '/works/pmid:23903748'],
      ['works', 'https://pubmed.ncbi.nlm.nih.gov/21491125', '/works/pmid:21491125'],
      ['works', 'PMC3084216', '/works/pmcid:PMC3084216'],
      ['works', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/', '/works/pmcid:PMC3084216'],
      ['works', 'X-Custom:AbC', '/works/X-Custom:AbC'],
    ])('requests %s %s at %s', async (entityType, id, path) => {
      const url = await requestFor(entityType as EntityType, id);
      expect(url.pathname).toBe(path);
      expect([...url.searchParams.keys()]).toEqual(['api_key', 'select']);
      expect(url.hash).toBe('');
    });

    /**
     * `?` and `#` are legal in a DOI — SICI DOIs end in a `#` check character — and reach
     * OpenAlex percent-encoded, which it decodes back into the ID, instead of starting a query
     * string or a fragment that drops the rest of the DOI.
     */
    it.each([
      [
        '10.1002/(sici)1097-461x(1997)64:6<735::aid-qua10>3.0.co;2-#',
        '/works/doi:10.1002/(sici)1097-461x(1997)64:6%3C735::aid-qua10%3E3.0.co;2-%23',
      ],
      ['10.1000/what?x=1', '/works/doi:10.1000/what%3Fx=1'],
      ['10.1000/a?b#c', '/works/doi:10.1000/a%3Fb%23c'],
    ])('keeps the ? and # of %s inside the ID', async (id, path) => {
      const url = await requestFor('works', id);
      expect(url.pathname).toBe(path);
      expect([...url.searchParams.keys()]).toEqual(['api_key', 'select']);
      expect(url.hash).toBe('');
    });

    it('fails a dot segment as id_dot_segment before any request', async () => {
      const service = await getService();
      await expect(
        service.search({ entityType: 'works', id: '../authors/A5023888391' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'id_dot_segment', id: '../authors/A5023888391', entityType: 'works' },
        message: expect.stringContaining('".."'),
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('fails every lookup of a ROR with a dot segment instead of answering for some', async () => {
      const service = await getService();
      await expect(
        service.resolveIdentifier(
          {
            entityTypes: ['institutions', 'funders', 'publishers'],
            id: 'ror:https://ror.org/../x',
            scheme: 'ror',
          },
          createMockContext(),
        ),
      ).rejects.toMatchObject({ data: { reason: 'id_dot_segment' } });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  // --- A native ID's letter names its entity type (gh #99) ---

  describe('id_type_mismatch (gh #99)', () => {
    /**
     * A native ID's letter names the one entity type that holds it — no record of one type
     * carries another type's letter, and every cross-letter lookup 404s upstream — so a
     * mismatch is settled before any request, naming the type the ID belongs to.
     */
    it.each([
      ['authors', 'W2741809807', 'work', 'works'],
      ['authors', 'w2741809807', 'work', 'works'],
      ['works', 'https://openalex.org/authors/A5023888391', 'author', 'authors'],
      ['funders', 'I1311060795', 'institution', 'institutions'],
      ['institutions', 'F4320306076', 'funder', 'funders'],
      ['sources', 'P4310320990', 'publisher', 'publishers'],
      ['works', 'S137773608', 'source', 'sources'],
      ['works', 'T10159', 'topic', 'topics'],
    ])(
      'rejects entity_type %s with %s before any request',
      async (entityType, id, noun, ownType) => {
        routeFetch({});
        const service = await getService();
        const error = await service
          .search({ entityType: entityType as 'works', id }, createMockContext())
          .then(
            () => undefined,
            (e: unknown) => e,
          );

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'id_type_mismatch' },
        });
        const message = (error as Error).message;
        expect(message).toContain(`${noun} ID`);
        expect(message).toContain(`entity_type "${ownType}"`);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

    it('names a concept ID as a type this server does not serve', async () => {
      routeFetch({});
      const service = await getService();

      await expect(
        service.search({ entityType: 'topics', id: 'C71924100' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'id_type_mismatch' },
        message: expect.stringMatching(/C71924100 is an OpenAlex concept ID/),
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('quotes at most 200 characters of the id in the message, and the whole id in data', async () => {
      routeFetch({});
      const service = await getService();
      const id = `W${'1'.repeat(80_000)}`;

      const error = await service
        .search({ entityType: 'authors', id }, createMockContext())
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ data: { reason: 'id_type_mismatch', id } });
      const { message } = error as Error;
      expect(message).toContain(`W${'1'.repeat(199)}… is an OpenAlex work ID`);
      expect(message.length).toBeLessThan(500);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    /**
     * Characterization — these resolve upstream and must keep doing so. Keyword slugs can look
     * like native IDs (`P53`, `F1`, `S1`, `A1` are all real keywords, matched case-insensitively),
     * and a legacy `V…` venue ID still resolves under `/sources/`.
     */
    it.each([
      ['keywords', 'P53', '/keywords/P53'],
      ['keywords', 'F1', '/keywords/F1'],
      ['keywords', 's1', '/keywords/s1'],
      ['keywords', 'A1', '/keywords/A1'],
      ['sources', 'V137773608', '/sources/V137773608'],
      ['authors', 'A5023888391', '/authors/A5023888391'],
      ['works', 'w2741809807', '/works/w2741809807'],
    ])('looks up %s %s without a mismatch', async (entityType, id, path) => {
      routeFetch({
        [path]: () => jsonResponse({ id: 'https://openalex.org/X1', display_name: 'X' }),
      });
      const service = await getService();

      const result = await service.search(
        { entityType: entityType as 'works', id },
        createMockContext(),
      );

      expect(result.results).toHaveLength(1);
      expect(lastFetchUrl().pathname).toBe(path);
    });

    it('leaves a missing ID of the right type on entity_not_found', async () => {
      routeFetch({ '/works/W99999999999': html404 });
      const service = await getService();

      await expect(
        service.search({ entityType: 'works', id: 'W99999999999' }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'entity_not_found' },
      });
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

    /**
     * Every free-text search filter takes a phrase, whatever follows `.search` — so a comma in one
     * is part of the phrase, sent double-quoted as a `.search` value is. OpenAlex answers
     * `title.search.exact:"cats, dogs"` with the works whose title holds that phrase. (gh #113)
     */
    it.each([
      'title.search.exact',
      'abstract.search.exact',
      'title_and_abstract.search.exact',
      'title_abstract_keywords.search',
      'title_abstract_keywords.search.exact',
      'raw_affiliation_strings.search.exact',
      'semantic.search',
    ])('wraps a %s value containing a comma in double quotes (gh #113)', async (key) => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { [key]: 'cats, dogs' } },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('filter')).toBe(`${key}:"cats, dogs"`);
    });

    it('does not double-wrap a quoted .search.exact value (gh #113)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { 'title.search.exact': '"cats, dogs"' } },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('filter')).toBe('title.search.exact:"cats, dogs"');
    });

    it.each(['title.searchable', 'research_area', 'search', 'title_search'])(
      'still refuses a comma in %s, which only resembles a search filter (gh #113)',
      async (key) => {
        const service = await getService();
        await expect(
          service.search({ entityType: 'works', filters: { [key]: 'a, b' } }, createMockContext()),
        ).rejects.toMatchObject({ data: { reason: 'comma_in_filter_value', filterKey: key } });
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

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

  /**
   * A value the clause sends double-quoted — a free-text search value or a whole-text field — is
   * matched as one phrase. OpenAlex ends that phrase at the next `"`, with no escape for one
   * inside, so a value carrying a `"` beyond its own outer pair would let the text after it parse
   * as further filter clauses. Such a value is refused before any request; the caller's own
   * wrapping pair is fine, and a value with no comma that the caller quoted goes out unchanged.
   */
  describe('quote_in_filter_value', () => {
    it.each([
      ['title.search.exact', 'cats", publication_year:1800, title.search:"dogs'],
      ['raw_affiliation_strings', 'Harvard", publication_year:1800, display_name:"x'],
      ['raw_affiliation_strings', 'one phrase" two'],
      ['display_name', '"a""b"'],
      ['geo.city', 'New "York'],
      // Quoting each `|` alternative separately leaves a `"` mid-value; the whole-value wrap is the
      // form that ORs two phrases. Both returned nothing upstream before; now they fail loudly.
      ['geo.city', '"New York"|"Boston"'],
      ['raw_affiliation_strings', '"A, B"|"C, D"'],
      // A caller's quote pair the server's own wrap encloses — a pair set off by a blank or behind
      // a `!` the wrap does not read as negation — puts a `"` inside the phrase as sent.
      ['geo.city', '! "New York"'],
      ['raw_affiliation_strings', '! "University of California, Berkeley"'],
      ['title.search', ' "cats, dogs"'],
      ['title.search', '"cats, dogs" '],
      ['title.search.exact', '!"cats, dogs"'],
    ])(
      'refuses a %s value carrying a stray double quote before any request',
      async (key, value) => {
        routeFetch({});
        const service = await getService();
        await expect(
          service.search({ entityType: 'works', filters: { [key]: value } }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(`Filter ${JSON.stringify(key)}`),
          data: { reason: 'quote_in_filter_value', filterKey: key },
        });
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['title.search', '"deep, learning"', 'title.search:"deep, learning"'],
      [
        'raw_affiliation_strings',
        '"University of California, Berkeley"',
        'raw_affiliation_strings:"University of California, Berkeley"',
      ],
      ['geo.city', '"New York"', 'geo.city:"New York"'],
      ['geo.city', '!"New York"', 'geo.city:!"New York"'],
    ])('sends a cleanly quoted %s value %j unchanged', async (key, value, filter) => {
      const service = await getService();
      await service.search({ entityType: 'works', filters: { [key]: value } }, createMockContext());
      expect(lastFetchUrl().searchParams.get('filter')).toBe(filter);
    });
  });

  // --- "+" reaches OpenAlex as AND (gh #107) ---

  /**
   * OpenAlex reads AND within a field only from a decoded space — a raw `+` in the query string.
   * `URLSearchParams` sends a `+` in a value as `%2B`, a literal plus that matches nothing. These
   * read the `filter=` pair exactly as the request put it on the wire, still percent-encoded,
   * because the decoded `searchParams.get('filter')` cannot tell a raw `+` from a space.
   */
  describe('"+" on the wire (gh #107)', () => {
    /** The `filter=` pair of the last request, as sent. */
    function sentFilter(): string | undefined {
      const call = vi.mocked(globalThis.fetch).mock.lastCall;
      if (!call) throw new Error('fetch was not called');
      return new URL(String(call[0])).search
        .slice(1)
        .split('&')
        .find((pair) => pair.startsWith('filter='));
    }

    const emptyList = () => jsonResponse({ meta: { count: 0, per_page: 25 }, results: [] });

    async function searchWith(filters: Record<string, string>): Promise<string | undefined> {
      routeFetch({ '/works': emptyList });
      const service = await getService();
      await service.search({ entityType: 'works', filters }, createMockContext());
      return sentFilter();
    }

    it.each([
      [
        'OR',
        { 'authorships.institutions.country_code': 'DE|US' },
        'filter=authorships.institutions.country_code%3ADE%7CUS',
      ],
      [
        'NOT',
        { 'authorships.institutions.country_code': '!DE' },
        'filter=authorships.institutions.country_code%3A%21DE',
      ],
      [
        'no operator',
        { 'authorships.institutions.country_code': 'DE' },
        'filter=authorships.institutions.country_code%3ADE',
      ],
      ['a year range', { publication_year: '2020-2024' }, 'filter=publication_year%3A2020-2024'],
      [
        'a date bound',
        { from_publication_date: '2020-01-01' },
        'filter=from_publication_date%3A2020-01-01',
      ],
      [
        'a literal space',
        { 'authorships.author.id': 'A5023888391 A5014420283' },
        'filter=authorships.author.id%3AA5023888391+A5014420283',
      ],
      [
        'free text holding a space',
        { 'title.search': 'machine learning' },
        'filter=title.search%3Amachine+learning',
      ],
    ])('sends %s exactly as before', async (_label, filters, wire) => {
      expect(await searchWith(filters)).toBe(wire);
    });

    it.each([
      ['DE+US', 'filter=authorships.institutions.country_code%3ADE+US'],
      ['!DE+!FR', 'filter=authorships.institutions.country_code%3A%21DE+%21FR'],
    ])('sends the AND in %s as a raw "+"', async (value, wire) => {
      expect(await searchWith({ 'authorships.institutions.country_code': value })).toBe(wire);
    });

    /**
     * OpenAlex splits a filter value on `|` first, and an alternative holding a `+` — raw or
     * `%2B` — matches nothing: `DE|FR+US` returns the 7,274,418 works with a German institution,
     * not the 1,201,334 in (DE or FR) and US, `DE|FR+` returns the same German set, and
     * `!DE+!FR|US` on institutions returns every institution outside the US. Where `+` means AND,
     * such a value fails before any request.
     */
    it.each([
      ['authorships.institutions.country_code', 'DE|FR+US'],
      ['authorships.institutions.country_code', 'US+DE|FR'],
      ['authorships.institutions.country_code', '!DE+!FR|US'],
      ['authorships.institutions.country_code', 'DE|FR+'],
      ['authorships.institutions.country-code', 'DEU|FRA+USA'],
      ['authorships.institutions.country_code', 'Narnia|FR+US'],
      ['authorships.author.id', 'A5023888391|A5014420283+A5051226891'],
      ['language', 'en|fr+de'],
      ['type', 'article+review|book'],
      ['has_pdf_url', 'true+false|true'],
      ['authorships.institutions.geo.city', 'Tokyo+Kyoto|Osaka'],
      ['raw_affiliation_strings', 'Harvard University+MIT|Yale University'],
      // A space is the AND operator too: an alternative of more than one value drops to its first
      // ID, or matches nothing for a code — the same silent partial a "+" would make. (gh-follow-up)
      ['authorships.author.id', 'A5023888391 A5014420283|A5051226891'],
      ['type', 'article review|book'],
      ['indexed_in', 'crossref pubmed|doaj'],
      ['language', 'en fr|de'],
      // A language segment that names no language is sent as given, so its space is still an AND.
      ['language', 'Scottish Gaelic|en fr'],
      // So is a country path form, its space with it.
      ['authorships.institutions.country_code', 'countries/DE countries/FR|US'],
      // A "+" beside a "|" is read before the conversion, multi-word names included.
      ['authorships.institutions.country_code', 'South Korea|Japan+US'],
    ])('fails %s %j as mixed_and_or_in_filter_value before any request', async (key, value) => {
      routeFetch({});
      const service = await getService();
      await expect(
        service.search({ entityType: 'works', filters: { [key]: value } }, createMockContext()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(`Filter ${JSON.stringify(key)} value mixes "|" (OR)`),
        data: { reason: 'mixed_and_or_in_filter_value', filterKey: key },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    /**
     * Unchanged: where `+` is a literal character — free-text search phrases, DOIs, exactly
     * matched names, `biblio` fields — and in a phrase the caller quoted, which OpenAlex reads
     * as text split on `|`, a `+` beside a `|` is not an AND to lose. Inside the caller's quotes
     * the `+` is literal text and reaches OpenAlex as `%2B`, not a decoded space.
     */
    it.each([
      ['display_name', 'C++|Java', 'filter=display_name%3AC%2B%2B%7CJava'],
      [
        'awards.funder_display_name',
        'Erasmus+|DFG',
        'filter=awards.funder_display_name%3AErasmus%2B%7CDFG',
      ],
      ['biblio.issue', '1+2|3', 'filter=biblio.issue%3A1%2B2%7C3'],
      ['title.search', 'c++|java', 'filter=title.search%3Ac%2B%2B%7Cjava'],
      ['doi', '10.1/a+b|10.1/c', 'filter=doi%3A10.1%2Fa%2Bb%7C10.1%2Fc'],
      [
        'authorships.institutions.geo.city',
        '"Tokyo+Kyoto|Osaka"',
        'filter=authorships.institutions.geo.city%3A%22Tokyo%2BKyoto%7COsaka%22',
      ],
      [
        'raw_affiliation_strings',
        ' !"China+Japan|Korea" ',
        'filter=raw_affiliation_strings%3A+%21%22China%2BJapan%7CKorea%22+',
      ],
    ])(
      'still sends a %s value %j holding "|" and a "+" that is not AND',
      async (key, value, wire) => {
        expect(await searchWith({ [key]: value })).toBe(wire);
      },
    );

    /**
     * A caller who wraps a comma-free value in quotes keeps its `+` as a literal character — the
     * comma path already sent a quoted value's `+` literal, and the comma-free path now matches it.
     * The space form the comma-free path used to send matched nothing where the literal `+` form
     * matched (a `PRISMA+` affiliation: 31 works literal, 0 with the space).
     */
    it.each([
      ['geo.city', '"A+B"', 'filter=geo.city%3A%22A%2BB%22'],
      [
        'raw_affiliation_strings',
        '"PRISMA+ Cluster"',
        'filter=raw_affiliation_strings%3A%22PRISMA%2B+Cluster%22',
      ],
      ['type', '"a+b"', 'filter=type%3A%22a%2Bb%22'],
    ])('keeps "+" literal inside a caller-quoted %s value %j', async (key, value, wire) => {
      expect(await searchWith({ [key]: value })).toBe(wire);
    });

    /**
     * The space-as-AND mix fires only on an interior space inside a `|` alternative. A space at the
     * edge of an alternative, or on a value with no `|`, is not an AND beside an OR, so it reaches
     * the wire as before rather than being refused.
     */
    it.each([
      [
        'authorships.author.id',
        'A5023888391|A5014420283 ',
        'filter=authorships.author.id%3AA5023888391%7CA5014420283+',
      ],
      [
        'authorships.author.id',
        'A5023888391| A5014420283',
        'filter=authorships.author.id%3AA5023888391%7C+A5014420283',
      ],
      ['indexed_in', 'crossref pubmed', 'filter=indexed_in%3Acrossref+pubmed'],
    ])('sends %s value %j rather than refusing its space', async (key, value, wire) => {
      expect(await searchWith({ [key]: value })).toBe(wire);
    });

    /**
     * A `+` stays a literal character where the value is text rather than filter syntax: free-text
     * `.search` filters (a semantic search embeds the characters it is given), and DOIs — SICI
     * supplement DOIs carry one, and `doi:<that DOI>` matches its work only as `%2B`.
     */
    it.each([
      ['title.search', 'c++', 'filter=title.search%3Ac%2B%2B'],
      ['title.search.exact', 'dna+rna', 'filter=title.search.exact%3Adna%2Brna'],
      ['semantic.search', 'C++ templates', 'filter=semantic.search%3AC%2B%2B+templates'],
      [
        'doi',
        '10.1002/1097-0142(19940801)74:3+<1030::aid-cncr2820741510>3.0.co;2-q',
        'filter=doi%3A10.1002%2F1097-0142%2819940801%2974%3A3%2B%3C1030%3A%3Aaid-cncr2820741510%3E3.0.co%3B2-q',
      ],
      [
        'doi_starts_with',
        '10.1002/1097-0142(19940801)74:3+',
        'filter=doi_starts_with%3A10.1002%2F1097-0142%2819940801%2974%3A3%2B',
      ],
      ['awards.doi', '10.1/a+b', 'filter=awards.doi%3A10.1%2Fa%2Bb'],
    ])('keeps the "+" in a %s value literal', async (key, value, wire) => {
      expect(await searchWith({ [key]: value })).toBe(wire);
    });

    /**
     * Dates and URLs are text too. In a timestamp, `+hh:mm` is the UTC offset — OpenAlex reads
     * `from_created_date:2026-10-01T00:00:00+00:00` from `%2B` and `…T00:00:00 00:00` from a raw
     * `+`. A landing-page URL can carry a `+` of its own: W1999130958's
     * `https://doi.org/10.1002/(sici)1097-0142(19980515)82:10+<2057::aid-cncr14>3.0.co;2-a`
     * matches its work as `%2B` and nothing as a raw `+`. `has_pdf_url` is a boolean, not a URL.
     */
    it.each([
      [
        'from_created_date',
        '2026-10-01T00:00:00+00:00',
        'filter=from_created_date%3A2026-10-01T00%3A00%3A00%2B00%3A00',
      ],
      [
        'to_updated_date',
        '2026-10-01T00:00:00+05:30',
        'filter=to_updated_date%3A2026-10-01T00%3A00%3A00%2B05%3A30',
      ],
      [
        'from-created-date',
        '2026-10-01T00:00:00+00:00',
        'filter=from-created-date%3A2026-10-01T00%3A00%3A00%2B00%3A00',
      ],
      ['publication_date', '2020-01-01+x', 'filter=publication_date%3A2020-01-01%2Bx'],
      [
        'primary_location.landing_page_url',
        'https://doi.org/10.1002/(sici)1097-0142(19980515)82:10+<2057::aid-cncr14>3.0.co;2-a',
        'filter=primary_location.landing_page_url%3Ahttps%3A%2F%2Fdoi.org%2F10.1002%2F%28sici%291097-0142%2819980515%2982%3A10%2B%3C2057%3A%3Aaid-cncr14%3E3.0.co%3B2-a',
      ],
      [
        'locations.landing_page_url',
        'https://example.org/a+b',
        'filter=locations.landing_page_url%3Ahttps%3A%2F%2Fexample.org%2Fa%2Bb',
      ],
    ])('keeps the "+" in a %s value literal', async (key, value, wire) => {
      expect(await searchWith({ [key]: value })).toBe(wire);
    });

    /**
     * Exact-match text keys hold stored values with a literal `+`, and a raw `+` matches none of
     * them: works titled `C++` (20) and the keyword `C++` match `display_name` only as `%2B`, as do
     * 202 works in `biblio.issue` `1+2`, 3,932 works whose `awards.funder_display_name` is
     * `Erasmus+`, and the works carrying `awards.funder_award_id` `2.05E+13`.
     */
    it.each([
      ['display_name', 'C++', 'filter=display_name%3AC%2B%2B'],
      ['biblio.issue', '1+2', 'filter=biblio.issue%3A1%2B2'],
      ['biblio.volume', '1+2', 'filter=biblio.volume%3A1%2B2'],
      ['biblio.first_page', '1+', 'filter=biblio.first_page%3A1%2B'],
      ['awards.funder_display_name', 'Erasmus+', 'filter=awards.funder_display_name%3AErasmus%2B'],
      ['awards.funder_award_id', '2.05E+13', 'filter=awards.funder_award_id%3A2.05E%2B13'],
    ])('keeps the "+" in a %s value literal', async (key, value, wire) => {
      expect(await searchWith({ [key]: value })).toBe(wire);
    });

    it('still sends a "+" in has_pdf_url, a boolean, as the AND operator', async () => {
      expect(await searchWith({ has_pdf_url: 'true+false' })).toBe(
        'filter=has_pdf_url%3Atrue+false',
      );
    });

    /**
     * Other text-valued exact-match keys keep the AND reading, which OpenAlex applies to each of
     * them: their stored values carry no `+` a filter could reach. No institution city holds one,
     * `listed_in` and `indexed_in` are fixed vocabularies, and every raw affiliation string seen
     * with a `+` also holds a comma, which sends the value quoted with its `+` literal (gh #115).
     */
    it.each([
      ['geo.city', 'Tokyo+Kyoto', 'filter=geo.city%3ATokyo+Kyoto'],
      [
        'authorships.institutions.geo.city',
        'Tokyo+Kyoto',
        'filter=authorships.institutions.geo.city%3ATokyo+Kyoto',
      ],
      ['raw_affiliation_strings', 'China+Japan', 'filter=raw_affiliation_strings%3AChina+Japan'],
      ['indexed_in', 'crossref+pubmed', 'filter=indexed_in%3Acrossref+pubmed'],
      [
        'primary_location.source.listed_in',
        'doaj+medline',
        'filter=primary_location.source.listed_in%3Adoaj+medline',
      ],
    ])('sends the "+" in a %s value as the AND operator', async (key, value, wire) => {
      expect(await searchWith({ [key]: value })).toBe(wire);
    });

    /** A phrase holding a comma goes out quoted, its space and `+` as any other phrase's. (gh #113) */
    it.each([
      ['title.search.exact', 'cats, dogs', 'filter=title.search.exact%3A%22cats%2C+dogs%22'],
      [
        'abstract.search.exact',
        'c++, java',
        'filter=abstract.search.exact%3A%22c%2B%2B%2C+java%22',
      ],
    ])(
      'sends a comma in a %s value inside the quoted phrase (gh #113)',
      async (key, value, wire) => {
        expect(await searchWith({ [key]: value })).toBe(wire);
      },
    );

    it('carries the raw "+" on both requests of a sampled search', async () => {
      routeFetch({ '/works': emptyList });
      const service = await getService();
      await service.search(
        {
          entityType: 'works',
          filters: { 'authorships.institutions.country_code': 'DE+US' },
          sample: 5,
        },
        createMockContext(),
      );
      const sent = vi.mocked(globalThis.fetch).mock.calls.map(([input]) =>
        new URL(String(input)).search
          .slice(1)
          .split('&')
          .find((pair) => pair.startsWith('filter=')),
      );
      expect(sent).toEqual([
        'filter=authorships.institutions.country_code%3ADE+US',
        'filter=authorships.institutions.country_code%3ADE+US',
      ]);
    });

    it('sends a raw "+" from analyze()', async () => {
      routeFetch({ '/works': () => jsonResponse({ meta: { count: 0 }, group_by: [] }) });
      const service = await getService();
      await service.analyze(
        {
          entityType: 'works',
          groupBy: 'is_oa',
          filters: { 'authorships.institutions.country_code': 'DE+US' },
        },
        createMockContext(),
      );
      expect(sentFilter()).toBe('filter=authorships.institutions.country_code%3ADE+US');
    });

    it('sends a raw "+" from autocomplete()', async () => {
      routeFetch({ '/autocomplete/institutions': () => jsonResponse({ results: [] }) });
      const service = await getService();
      await service.autocomplete(
        {
          entityType: 'institutions',
          query: 'technische',
          filters: { type: 'education+facility' },
        },
        createMockContext(),
      );
      expect(sentFilter()).toBe('filter=type%3Aeducation+facility');
    });
  });

  // --- Multi-word values on exact-match text keys (gh #115) ---

  /**
   * OpenAlex reads an unquoted space in a filter value as AND, so a multi-word name on a key it
   * matches whole — `geo.city:New York` — asks for a city named both `New` and `York` and matches
   * nothing, while `geo.city:"New York"` matches the 1,552 institutions there. A quote around the
   * whole value carries `!` (`"!New York"`, every institution but those 1,552) and `|`
   * (`"New York|Boston"`, 1,552 + 492); a quote around one `|` alternative is read as part of it,
   * and no form ANDs a phrase with another value inside one clause. These read the `filter=` pair
   * as the request put it on the wire.
   */
  describe('multi-word values on exact-match text keys (gh #115)', () => {
    /** The `filter=` pair of the last request, as sent. */
    function sentFilter(): string | undefined {
      const call = vi.mocked(globalThis.fetch).mock.lastCall;
      if (!call) throw new Error('fetch was not called');
      return new URL(String(call[0])).search
        .slice(1)
        .split('&')
        .find((pair) => pair.startsWith('filter='));
    }

    async function searchWith(
      entityType: EntityType,
      filters: Record<string, string>,
    ): Promise<string | undefined> {
      routeFetch({
        [`/${entityType}`]: () => jsonResponse({ meta: { count: 0, per_page: 25 }, results: [] }),
      });
      const service = await getService();
      await service.search({ entityType, filters }, createMockContext());
      return sentFilter();
    }

    it.each([
      [
        'works',
        'awards.funder_display_name',
        'National Science Foundation',
        'filter=awards.funder_display_name%3A%22National+Science+Foundation%22',
      ],
      ['institutions', 'geo.city', 'New York', 'filter=geo.city%3A%22New+York%22'],
      [
        'works',
        'authorships.institutions.geo.city',
        'New York',
        'filter=authorships.institutions.geo.city%3A%22New+York%22',
      ],
      ['institutions', 'geo.region', 'New York', 'filter=geo.region%3A%22New+York%22'],
      [
        'authors',
        'last_known_institutions.geo.region',
        'New York',
        'filter=last_known_institutions.geo.region%3A%22New+York%22',
      ],
      [
        'sources',
        'display_name',
        'Nature Communications',
        'filter=display_name%3A%22Nature+Communications%22',
      ],
      [
        'works',
        'display_name',
        'Attention Is All You Need',
        'filter=display_name%3A%22Attention+Is+All+You+Need%22',
      ],
      [
        'works',
        'raw_affiliation_strings',
        'Harvard University',
        'filter=raw_affiliation_strings%3A%22Harvard+University%22',
      ],
      [
        'works',
        'raw-affiliation-strings',
        'Harvard University',
        'filter=raw-affiliation-strings%3A%22Harvard+University%22',
      ],
      [
        'works',
        'awards.funder_award_id',
        'DE AC02 05CH11231',
        'filter=awards.funder_award_id%3A%22DE+AC02+05CH11231%22',
      ],
      ['works', 'biblio.issue', 'Supplement 1', 'filter=biblio.issue%3A%22Supplement+1%22'],
      ['authors', 'block_key', 'j priem', 'filter=block_key%3A%22j+priem%22'],
      [
        'authors',
        'parsed_longest_name.first',
        'Mary Ann',
        'filter=parsed_longest_name.first%3A%22Mary+Ann%22',
      ],
    ] as const)(
      'on %s, sends a %s value with a space as one quoted phrase',
      async (entityType, key, value, wire) => {
        expect(await searchWith(entityType, { [key]: value })).toBe(wire);
      },
    );

    /**
     * The quote goes around the whole value, operators included: `"!New York"` and
     * `!"New York"` both match the 141,903 institutions outside New York, and
     * `"National Science Foundation|National Institutes of Health"` matches the works funded by
     * either. A `+` on a key that keeps it literal stays a literal inside the phrase, and the
     * value is quoted without its edge whitespace, which a quoted phrase would otherwise keep.
     */
    it.each([
      ['institutions', 'geo.city', '!New York', 'filter=geo.city%3A%22%21New+York%22'],
      ['institutions', 'geo.city', 'New York|Boston', 'filter=geo.city%3A%22New+York%7CBoston%22'],
      [
        'works',
        'awards.funder_display_name',
        'National Science Foundation|National Institutes of Health',
        'filter=awards.funder_display_name%3A%22National+Science+Foundation%7CNational+Institutes+of+Health%22',
      ],
      ['works', 'display_name', 'C++ Primer', 'filter=display_name%3A%22C%2B%2B+Primer%22'],
      ['institutions', 'geo.city', '  New York  ', 'filter=geo.city%3A%22New+York%22'],
    ] as const)(
      'on %s, sends the %s value %j as one quoted phrase',
      async (entityType, key, value, wire) => {
        expect(await searchWith(entityType, { [key]: value })).toBe(wire);
      },
    );

    /**
     * Unchanged: values with no space between words, values the caller already quoted (a leading
     * `!` aside), every key that is not exact-match text — IDs, codes, free-text search — and a
     * name ANDed with `+` on a key where `+` is AND, which no single clause can express.
     */
    it.each([
      ['institutions', 'geo.city', 'Tokyo', 'filter=geo.city%3ATokyo'],
      ['institutions', 'geo.city', 'Boston ', 'filter=geo.city%3ABoston+'],
      ['institutions', 'geo.city', 'Tokyo+Kyoto', 'filter=geo.city%3ATokyo+Kyoto'],
      ['institutions', 'geo.city', 'New York+Boston', 'filter=geo.city%3ANew+York+Boston'],
      [
        'works',
        'raw_affiliation_strings',
        'Harvard University+MIT',
        'filter=raw_affiliation_strings%3AHarvard+University+MIT',
      ],
      [
        'works',
        'awards.funder_display_name',
        '"National Science Foundation"',
        'filter=awards.funder_display_name%3A%22National+Science+Foundation%22',
      ],
      ['institutions', 'geo.city', '!"New York"', 'filter=geo.city%3A%21%22New+York%22'],
      [
        'works',
        'authorships.institutions.lineage',
        'I136199984 I27837315',
        'filter=authorships.institutions.lineage%3AI136199984+I27837315',
      ],
      ['works', 'indexed_in', 'crossref pubmed', 'filter=indexed_in%3Acrossref+pubmed'],
      ['works', 'language', 'Old English', 'filter=language%3AOld+English'],
      ['works', 'display_name.search', 'New York', 'filter=display_name.search%3ANew+York'],
      [
        'works',
        'raw_affiliation_strings.search',
        'Harvard University',
        'filter=raw_affiliation_strings.search%3AHarvard+University',
      ],
      [
        'works',
        'title.search.exact',
        'machine learning',
        'filter=title.search.exact%3Amachine+learning',
      ],
    ] as const)('on %s, sends the %s value %j as before', async (entityType, key, value, wire) => {
      expect(await searchWith(entityType, { [key]: value })).toBe(wire);
    });

    /**
     * A comma inside a phrase is part of it: raw affiliation strings almost always carry one.
     * OpenAlex reads the comma inside the quotes as text, not as its clause separator —
     * `raw_affiliation_strings:"Associazione Meteonetwork OdV, Milano, Italy"` matches that
     * string's 129,488 works, beside another clause in either order — and reads the quoted value
     * as the other phrases are read: `|` ORs (`"…, Italy|University of California, Berkeley"`,
     * 129,488 + 92,012), a leading `!` negates the whole value, and a `+` is the literal character
     * (`"PRISMA+ Cluster of Excellence & …, Mainz, Germany"` matches its 31 works only as `%2B`).
     * So the value goes out as a free-text search phrase does — whole, quoted, `+` literal —
     * trimmed as any other phrase is. (gh #115)
     */
    it.each([
      [
        'works',
        'raw_affiliation_strings',
        'Associazione Meteonetwork OdV, Milano, Italy',
        'filter=raw_affiliation_strings%3A%22Associazione+Meteonetwork+OdV%2C+Milano%2C+Italy%22',
      ],
      [
        'works',
        'raw_affiliation_strings',
        'PRISMA+ Cluster of Excellence & Mainz Institute for Theoretical Physics, Johannes Gutenberg University, 55099, Mainz, Germany',
        'filter=raw_affiliation_strings%3A%22PRISMA%2B+Cluster+of+Excellence+%26+Mainz+Institute+for+Theoretical+Physics%2C+Johannes+Gutenberg+University%2C+55099%2C+Mainz%2C+Germany%22',
      ],
      [
        'works',
        'raw_affiliation_strings',
        'Associazione Meteonetwork OdV, Milano, Italy|University of California, Berkeley',
        'filter=raw_affiliation_strings%3A%22Associazione+Meteonetwork+OdV%2C+Milano%2C+Italy%7CUniversity+of+California%2C+Berkeley%22',
      ],
      [
        'works',
        'raw_affiliation_strings',
        '!University of California, Berkeley',
        'filter=raw_affiliation_strings%3A%22%21University+of+California%2C+Berkeley%22',
      ],
      [
        'works',
        'raw_affiliation_strings',
        '  University of California, Berkeley  ',
        'filter=raw_affiliation_strings%3A%22University+of+California%2C+Berkeley%22',
      ],
      [
        'works',
        'raw_affiliation_strings',
        'PRISMA+, Mainz|University of California, Berkeley',
        'filter=raw_affiliation_strings%3A%22PRISMA%2B%2C+Mainz%7CUniversity+of+California%2C+Berkeley%22',
      ],
      [
        'works',
        'raw-affiliation-strings',
        'University of California, Berkeley',
        'filter=raw-affiliation-strings%3A%22University+of+California%2C+Berkeley%22',
      ],
      [
        'authors',
        'last_known_institutions.geo.city',
        'Washington, D.C.',
        'filter=last_known_institutions.geo.city%3A%22Washington%2C+D.C.%22',
      ],
      [
        'authors',
        'parsed_longest_name.suffix',
        'Jr., PhD',
        'filter=parsed_longest_name.suffix%3A%22Jr.%2C+PhD%22',
      ],
      [
        'works',
        'awards.funder_display_name',
        'Ministry of Education, Culture, Sports, Science and Technology',
        'filter=awards.funder_display_name%3A%22Ministry+of+Education%2C+Culture%2C+Sports%2C+Science+and+Technology%22',
      ],
      [
        'institutions',
        'display_name',
        'University of California, Berkeley',
        'filter=display_name%3A%22University+of+California%2C+Berkeley%22',
      ],
      [
        'works',
        'display_name',
        'Cancer statistics, 2020',
        'filter=display_name%3A%22Cancer+statistics%2C+2020%22',
      ],
      ['institutions', 'geo.city', 'New York, NY', 'filter=geo.city%3A%22New+York%2C+NY%22'],
      ['works', 'biblio.issue', '1,2', 'filter=biblio.issue%3A%221%2C2%22'],
      ['authors', 'block_key', 'smith, j', 'filter=block_key%3A%22smith%2C+j%22'],
    ] as const)(
      'on %s, sends a %s value holding a comma as one quoted phrase: %j',
      async (entityType, key, value, wire) => {
        expect(await searchWith(entityType, { [key]: value })).toBe(wire);
      },
    );

    /**
     * A comma value the caller already quoted goes out as written — `!` outside the quotes
     * negates it as well (`!"…, Italy"`, every work but those 129,488). To OR two comma phrases,
     * the caller wraps the whole value once (`A, B|C, D` → `"A, B|C, D"`); quoting each alternative
     * separately leaves a `"` mid-value, which OpenAlex cannot read, so it is refused below.
     */
    it.each([
      [
        'raw_affiliation_strings',
        '"University of California, Berkeley"',
        'filter=raw_affiliation_strings%3A%22University+of+California%2C+Berkeley%22',
      ],
      [
        'raw_affiliation_strings',
        '!"University of California, Berkeley"',
        'filter=raw_affiliation_strings%3A%21%22University+of+California%2C+Berkeley%22',
      ],
      [
        'raw_affiliation_strings',
        'University of California, Berkeley|Stanford University, Stanford',
        'filter=raw_affiliation_strings%3A%22University+of+California%2C+Berkeley%7CStanford+University%2C+Stanford%22',
      ],
    ] as const)('sends the quoted %s value %j as written', async (key, value, wire) => {
      expect(await searchWith('works', { [key]: value })).toBe(wire);
    });

    /**
     * Elsewhere a comma can only be read as OpenAlex's clause separator, so it still fails before
     * any request — on keys that merely resemble a phrase key too.
     */
    it.each([
      ['works', 'publication_year', '2020,2021'],
      ['works', 'authorships.author.id', 'A5023888391,A5014420283'],
      ['works', 'type', 'article, review'],
      ['works', 'authorships.institutions.country_code', 'DE,FR'],
      ['works', 'language', 'en, fr'],
      ['works', 'primary_location.raw_type', 'Journal Article, Review'],
      ['institutions', 'display_name_alternatives', 'UC Berkeley, Cal'],
      ['institutions', 'geo.city_id', 'New York, NY'],
    ] as const)(
      'on %s, still refuses a comma in %s %j before any request',
      async (entityType, key, value) => {
        routeFetch({});
        const service = await getService();
        await expect(
          service.search({ entityType, filters: { [key]: value } }, createMockContext()),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining(`Filter ${JSON.stringify(key)} value contains a comma`),
          data: { reason: 'comma_in_filter_value', filterKey: key },
        });
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

    it('quotes the phrase on analyze() and autocomplete() requests too', async () => {
      routeFetch({
        '/works': () => jsonResponse({ meta: { count: 0 }, group_by: [] }),
        '/autocomplete/institutions': () => jsonResponse({ results: [] }),
      });
      const service = await getService();
      await service.analyze(
        {
          entityType: 'works',
          groupBy: 'is_oa',
          filters: { 'awards.funder_display_name': 'National Science Foundation' },
        },
        createMockContext(),
      );
      expect(sentFilter()).toBe(
        'filter=awards.funder_display_name%3A%22National+Science+Foundation%22',
      );
      await service.autocomplete(
        { entityType: 'institutions', query: 'columbia', filters: { 'geo.city': 'New York' } },
        createMockContext(),
      );
      expect(sentFilter()).toBe('filter=geo.city%3A%22New+York%22');
    });

    it('quotes a comma phrase on analyze() and autocomplete() requests too', async () => {
      routeFetch({
        '/works': () => jsonResponse({ meta: { count: 0 }, group_by: [] }),
        '/autocomplete/institutions': () => jsonResponse({ results: [] }),
      });
      const service = await getService();
      await service.analyze(
        {
          entityType: 'works',
          groupBy: 'publication_year',
          filters: { raw_affiliation_strings: 'Associazione Meteonetwork OdV, Milano, Italy' },
        },
        createMockContext(),
      );
      expect(sentFilter()).toBe(
        'filter=raw_affiliation_strings%3A%22Associazione+Meteonetwork+OdV%2C+Milano%2C+Italy%22',
      );
      await service.autocomplete(
        {
          entityType: 'institutions',
          query: 'berkeley',
          filters: { display_name: 'University of California, Berkeley' },
        },
        createMockContext(),
      );
      expect(sentFilter()).toBe('filter=display_name%3A%22University+of+California%2C+Berkeley%22');
    });
  });

  // --- Country and language filter values (gh #101) ---

  /**
   * OpenAlex country fields hold ISO 3166-1 alpha-2 codes and `language` holds ISO 639-1 codes;
   * any other spelling still gets HTTP 200 and matches nothing (or, negated, everything). Each
   * `|`/`+` segment is trimmed and converted where the mapping is certain, a country segment that
   * cannot be a code fails before any request, and everything else is sent as given — the stored
   * values are not clean, so a spelling that matches records today must keep matching.
   */
  describe('country and language filter values (gh #101)', () => {
    const emptyList = () => jsonResponse({ meta: { count: 0, per_page: 25 }, results: [] });

    async function searchWith(entityType: EntityType, filters: Record<string, string>) {
      routeFetch({ [`/${entityType}`]: emptyList });
      const service = await getService();
      await service.search({ entityType, filters }, createMockContext());
      return lastFetchUrl().searchParams.get('filter');
    }

    it.each([
      ['institutions', 'country_code', 'de'],
      ['institutions', 'country_code', 'XK'],
      ['funders', 'country_code', 'EU'],
      ['sources', 'country_code', 'NYU'],
      ['institutions', 'country_code', 'null'],
      ['institutions', 'country_code', '!null'],
      ['institutions', 'country_code', 'DE|'],
      ['institutions', 'country_code', 'https://openalex.org/countries/DE'],
      ['sources', 'country_code', 'countries/DEU'],
      ['works', 'language', 'ceb'],
      ['works', 'language', 'zh-cn'],
      ['works', 'language', 'EN-US'],
      ['works', 'language', '中文'],
      ['works', 'language', 'uk'],
      ['works', 'language', 'languages/ENGLISH'],
      ['works', 'language', 'constructor'],
      ['works', 'language', '__proto__'],
      ['works', 'countries_distinct_count', '276'],
      ['institutions', 'type', 'Germany'],
      ['works', 'title.search', 'Germany'],
    ] as const)('sends %s %s %j unchanged', async (entityType, key, value) => {
      expect(await searchWith(entityType, { [key]: value })).toBe(`${key}:${value}`);
    });

    it.each([
      ['institutions', 'country_code', 'DEU', 'DE'],
      ['institutions', 'country_code', 'deu', 'DE'],
      ['institutions', 'country_code', '276', 'DE'],
      ['institutions', 'country_code', 'Germany', 'DE'],
      ['institutions', 'country_code', 'GERMANY', 'DE'],
      ['institutions', 'country_code', 'United States', 'US'],
      ['institutions', 'country_code', 'South Korea', 'KR'],
      ['institutions', 'country_code', 'Türkiye', 'TR'],
      ['institutions', 'country_code', 'UK', 'GB'],
      ['institutions', 'country_code', 'uk', 'GB'],
      ['institutions', 'country_code', 'Uk', 'GB'],
      ['institutions', 'country_code', '!DEU', '!DE'],
      ['institutions', 'country_code', 'DEU|FRA', 'DE|FR'],
      ['institutions', 'country_code', 'DE| FR', 'DE|FR'],
      ['institutions', 'country_code', ' DE ', 'DE'],
      ['institutions', 'country_code', '!null|DEU', '!null|DE'],
      ['institutions', 'country-code', 'DEU', 'DE'],
      ['works', 'authorships.institutions.country_code', 'USA', 'US'],
      ['works', 'authorships.countries', 'DEU', 'DE'],
      ['works', 'institutions.country_code', 'uk', 'GB'],
      ['authors', 'last_known_institutions.country_code', 'FRA', 'FR'],
      ['publishers', 'country_codes', 'usa', 'US'],
      ['works', 'language', 'eng', 'en'],
      ['works', 'language', 'ENG', 'en'],
      ['works', 'language', 'ger', 'de'],
      ['works', 'language', 'deu', 'de'],
      ['works', 'language', 'English', 'en'],
      ['works', 'language', 'english', 'en'],
      ['works', 'language', 'Castilian', 'es'],
      ['works', 'language', 'Cebuano', 'ceb'],
      ['works', 'language', '!English', '!en'],
      ['works', 'language', 'eng| fre', 'en|fr'],
    ] as const)('sends %s %s %j as %j', async (entityType, key, value, sent) => {
      expect(await searchWith(entityType, { [key]: value })).toBe(`${key}:${sent}`);
    });

    /**
     * A multi-word English name is one segment, so a `|` beside it ORs whole names: the space
     * inside `South Korea` is part of the name, never an AND to lose.
     */
    it.each([
      ['institutions', 'country_code', 'South Korea|Japan', 'KR|JP'],
      ['institutions', 'country_code', 'United States|DE', 'US|DE'],
      ['institutions', 'country_code', '!South Korea|New Zealand', '!KR|NZ'],
      ['institutions', 'country_code', 'South Africa | Saudi Arabia', 'ZA|SA'],
      ['institutions', 'country-code', 'United Kingdom|United States', 'GB|US'],
      ['works', 'authorships.institutions.country_code', 'south korea|null', 'KR|null'],
      ['works', 'language', 'Scottish Gaelic|English', 'gd|en'],
      ['works', 'language', '!Central Khmer|Haitian Creole', '!km|ht'],
    ] as const)(
      'sends the multi-word names in %s %s %j as %j',
      async (entityType, key, value, sent) => {
        expect(await searchWith(entityType, { [key]: value })).toBe(`${key}:${sent}`);
      },
    );

    /**
     * The names OpenAlex itself displays for country groups (`key_display_name` on a country
     * `group_by`) where they differ from every ISO name, so a name copied from an OpenAlex facet
     * converts like an ISO one.
     */
    it.each([
      ['Bosnia & Herzegovina', 'BA'],
      ['British Virgin Islands', 'VG'],
      ['Brunei', 'BN'],
      ['Caribbean Netherlands', 'BQ'],
      ['Dominican Rep.', 'DO'],
      ['DR Congo', 'CD'],
      ['Falkland Islands', 'FK'],
      ['Ivory Coast', 'CI'],
      ['Kosovo', 'XK'],
      ['Micronesia', 'FM'],
      ['Northern Mariana Is.', 'MP'],
      ['Palestine', 'PS'],
      ['Russia', 'RU'],
      ['Saint Martin', 'MF'],
      ['São Tomé & Príncipe', 'ST'],
      ['Sint Maarten', 'SX'],
      ['South Georgia & South Sandwich Is.', 'GS'],
      ['St. Kitts & Nevis', 'KN'],
      ['St. Vincent & Grenadines', 'VC'],
      ['Trinidad & Tobago', 'TT'],
      ['Turkey', 'TR'],
      ['Turks & Caicos Islands', 'TC'],
      ['US Virgin Islands', 'VI'],
      ['Vatican City', 'VA'],
    ])('converts the OpenAlex country name %j to %s', async (name, code) => {
      expect(
        await searchWith('works', { 'authorships.institutions.country_code': name.toLowerCase() }),
      ).toBe(`authorships.institutions.country_code:${code}`);
      expect(await searchWith('institutions', { country_code: `!${name}` })).toBe(
        `country_code:!${code}`,
      );
    });

    /** A converted `+` segment still reaches OpenAlex as the AND it spells (gh #107). */
    it.each([
      ['DEU+FRA', 'filter=authorships.institutions.country_code%3ADE+FR'],
      ['!DEU+!FRA', 'filter=authorships.institutions.country_code%3A%21DE+%21FR'],
      ['Germany + United States', 'filter=authorships.institutions.country_code%3ADE+US'],
      ['South Korea+Japan', 'filter=authorships.institutions.country_code%3AKR+JP'],
    ])('sends %j as an AND of alpha-2 codes', async (value, wire) => {
      routeFetch({ '/works': emptyList });
      const service = await getService();
      await service.search(
        { entityType: 'works', filters: { 'authorships.institutions.country_code': value } },
        createMockContext(),
      );
      const pair = lastFetchUrl()
        .search.slice(1)
        .split('&')
        .find((p) => p.startsWith('filter='));
      expect(pair).toBe(wire);
    });

    it.each([
      'Germanyy',
      '999',
      'NULL',
      'unknown',
      'Narnia',
      'DE|Germanyy',
      '!Narnia',
      'DEU+Narnia',
      'toString',
      '__proto__',
      'DE US|FR',
      'South Koreaa|Japan',
      'Narnia Land|DE',
    ])('fails country segment %j as invalid_country_code before any request', async (value) => {
      routeFetch({});
      const service = await getService();
      await expect(
        service.search(
          { entityType: 'institutions', filters: { type: 'education', country_code: value } },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringMatching(/"country_code".*ISO 3166-1 alpha-2/),
        data: { reason: 'invalid_country_code', filterKey: 'country_code' },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('names the segment it rejected, not the whole value', async () => {
      routeFetch({});
      const service = await getService();
      const failure = service.search(
        { entityType: 'institutions', filters: { country_code: 'DEU|Narnia' } },
        createMockContext(),
      );
      await expect(failure).rejects.toMatchObject({
        message: expect.stringContaining('"Narnia"'),
        data: { segment: 'Narnia' },
      });
    });

    /**
     * A space is no operator on a country key — a segment is one code or one name — so a `|`
     * beside it changes nothing: `DE US|FR` fails the way `DE US` does, naming that segment, and
     * the message says how codes are joined.
     */
    it.each(['DE US', 'DE US|FR'])('refuses %j for its segment "DE US"', async (value) => {
      routeFetch({});
      const service = await getService();
      await expect(
        service.search(
          { entityType: 'institutions', filters: { country_code: value } },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        message: expect.stringMatching(
          /value "DE US" is not a country code\..* A space is part of a country name \("South Korea"\), never a separator: join codes with "\|" for OR or "\+" for AND\.$/,
        ),
        data: { reason: 'invalid_country_code', filterKey: 'country_code', segment: 'DE US' },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('adds no separator advice for a segment without a space', async () => {
      routeFetch({});
      const service = await getService();
      await expect(
        service.search(
          { entityType: 'institutions', filters: { country_code: 'DE|Germanyy' } },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        message: expect.not.stringContaining('separator'),
        data: { reason: 'invalid_country_code', segment: 'Germanyy' },
      });
    });

    it('keeps the comma pre-flight ahead of the country check', async () => {
      routeFetch({});
      const service = await getService();
      await expect(
        service.search(
          { entityType: 'institutions', filters: { country_code: 'Germany,France' } },
          createMockContext(),
        ),
      ).rejects.toMatchObject({ data: { reason: 'comma_in_filter_value' } });
    });

    it('converts the values analyze() sends', async () => {
      routeFetch({ '/works': () => jsonResponse({ meta: { count: 0 }, group_by: [] }) });
      const service = await getService();
      await service.analyze(
        {
          entityType: 'works',
          groupBy: 'is_oa',
          filters: { 'authorships.institutions.country_code': 'USA', language: 'English' },
        },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('filter')).toBe(
        'authorships.institutions.country_code:US,language:en',
      );
    });

    it('converts the values autocomplete() sends, and rejects there before any request', async () => {
      routeFetch({ '/autocomplete/institutions': () => jsonResponse({ results: [] }) });
      const service = await getService();
      await service.autocomplete(
        { entityType: 'institutions', query: 'technische', filters: { country_code: 'DEU' } },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('filter')).toBe('country_code:DE');

      vi.mocked(globalThis.fetch).mockClear();
      await expect(
        service.autocomplete(
          { entityType: 'institutions', query: 'technische', filters: { country_code: '999' } },
          createMockContext(),
        ),
      ).rejects.toMatchObject({ data: { reason: 'invalid_country_code' } });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('carries the invalid_country_code recovery from the calling contract', async () => {
      routeFetch({});
      const recovery =
        'Pass an ISO 3166-1 alpha-2 code such as DE, or null for records with no country.';
      const error = await failThroughContract(
        [
          {
            reason: 'invalid_country_code',
            code: JsonRpcErrorCode.ValidationError,
            when: 'A country filter segment cannot be a country code.',
            recovery,
          },
        ],
        async (ctx) => {
          const service = await getService();
          await service.search(
            { entityType: 'institutions', filters: { country_code: 'Narnia' } },
            ctx,
          );
        },
      );
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_country_code', recovery: { hint: recovery } },
      });
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
      // A source name is provider text, and repositories often give their URL as one.
      const url = 'http://e.x/F?func=service&copy=1&lang=de&not=2&notit;&ampx&sup23';
      const record = await searchOne({
        display_name: 'Test',
        primary_location: { raw_source_name: url },
      });
      expect((record.primary_location as { raw_source_name: string }).raw_source_name).toBe(url);
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
        { entityTypes: ['authors'], id: 'A1', scheme: 'openalex' },
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

    /**
     * XML/JATS delimiters and double-escaped line breaks (gh #89). Strings are copied from each
     * named record's upstream text as of 2026-09-30.
     */
    describe('delimiters and literal \\n (gh #89)', () => {
      const CDATA_TITLE = '<![CDATA[Immune cellular response to HPV: current concepts]]>';
      const TITLE = 'Immune cellular response to HPV: current concepts';
      const IOP_ABSTRACT = String.raw`sodium blueshifted by <?CDATA $(8\pm 2)$?> <?MML ( 8 ± 2 ) ?> km s −1 , this likely implies`;
      const IOP_NORMALIZED = String.raw`sodium blueshifted by $(8\pm 2)$ km s −1 , this likely implies`;
      const LOST_CLOSER = String.raw`it satisfies AX=bX≥O ]] <![CDATA[$$AX = bX \geqslant O$$ where A is`;
      const LOST_CLOSER_NORMALIZED = String.raw`it satisfies AX=bX≥O $$AX = bX \geqslant O$$ where A is`;

      /** The inverted index OpenAlex serves in place of an abstract: word → positions. */
      function invertedIndex(text: string): Record<string, number[]> {
        const index: Record<string, number[]> = {};
        text.split(' ').forEach((word, position) => {
          index[word] = [...(index[word] ?? []), position];
        });
        return index;
      }

      it('unwraps a CDATA-wrapped title and display_name (W2143241432)', async () => {
        const record = await searchOne({ display_name: CDATA_TITLE, title: CDATA_TITLE });
        expect(record.display_name).toBe(TITLE);
        expect(record.title).toBe(TITLE);
      });

      it('turns the literal \\n in a title into spaces (W3100494400)', async () => {
        const record = await searchOne({
          title: String.raw`VISIR / VLT mid-infrared imaging of Seyfert\n nuclei: \n nuclear dust emission and the Seyfert-2 dichotomy`,
        });
        expect(record.title).toBe(
          'VISIR / VLT mid-infrared imaging of Seyfert nuclei: nuclear dust emission and the Seyfert-2 dichotomy',
        );
      });

      it.each([
        ['an IOP instruction pair (W3105622196)', IOP_ABSTRACT, IOP_NORMALIZED],
        ['a lost ]] before a CDATA opener (W2337004314)', LOST_CLOSER, LOST_CLOSER_NORMALIZED],
      ])(
        'normalizes %s in an abstract rebuilt from its inverted index',
        async (_l, raw, expected) => {
          const record = await searchOne({
            display_name: 'Test',
            abstract_inverted_index: invertedIndex(raw),
          });
          expect(record.abstract).toBe(expected);
        },
      );

      it('normalizes a raw_author_name nested two levels down', async () => {
        const record = await searchOne({
          display_name: 'Test',
          authorships: [
            { author: { display_name: 'First' } },
            { raw_author_name: String.raw`A.\n <?CDATA Smith?>` },
          ],
        });
        expect((record.authorships as { raw_author_name?: string }[])[1]?.raw_author_name).toBe(
          'A. Smith',
        );
      });

      it('carries the normalized text on both tool surfaces', async () => {
        respondWith({
          id: 'https://openalex.org/W2143241432',
          display_name: CDATA_TITLE,
          title: CDATA_TITLE,
          abstract_inverted_index: invertedIndex(`${IOP_ABSTRACT} ${LOST_CLOSER}`),
        });
        await getService();
        const { searchEntitiesTool } = await import(
          '@/mcp-server/tools/definitions/search-entities.tool.js'
        );

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: 'W2143241432',
          select: ['title', 'abstract'],
        });

        expect(result.isError).toBeFalsy();
        const work = (result.structuredContent as { results: Record<string, unknown>[] })
          .results[0];
        expect(work?.title).toBe(TITLE);
        expect(work?.abstract).toBe(`${IOP_NORMALIZED} ${LOST_CLOSER_NORMALIZED}`);
        const text = (result.content ?? [])
          .map((block) => ('text' in block ? block.text : ''))
          .join('\n');
        expect(text).toContain(`### ${TITLE}`);
        expect(text).toContain(`**Abstract:** ${IOP_NORMALIZED} ${LOST_CLOSER_NORMALIZED}`);
        expect(text).not.toMatch(/CDATA|<\?MML|\]\]/);
      });
    });

    /**
     * Identifiers leave byte-identical to upstream, so each one resolves when passed back. W7134264040's
     * DOI is stored with a literal `&amp;`; the decoded `&itemid=129` form is not found.
     */
    describe('identifiers pass through (gh #94)', () => {
      const DOI = 'https://doi.org/10.1051/0004-6361/200912724&amp;itemid=129';
      const WORK = {
        id: 'https://openalex.org/W7134264040',
        display_name: 'Seyfert &amp; <i>nuclei</i>',
        doi: DOI,
        ids: { openalex: 'https://openalex.org/W7134264040', doi: DOI },
        primary_location: {
          landing_page_url: DOI,
          pdf_url: 'https://e.x/get.pdf?a=1&amp;b=2',
          source: {
            id: 'https://openalex.org/S1',
            display_name: 'Astron. &amp; Astrophys.',
            host_organization_lineage: ['https://openalex.org/P1&amp;x'],
          },
        },
        authorships: [
          {
            author: { display_name: 'A. &amp; B.', orcid: 'https://orcid.org/0000-0001&lt;2' },
            raw_author_name: 'A. &amp; B.',
          },
        ],
      };

      it('returns identifiers byte-identical and display text normalized, nested levels included', async () => {
        const record = await searchOne(WORK);
        expect(record).toEqual({
          ...WORK,
          display_name: 'Seyfert & nuclei',
          primary_location: {
            ...WORK.primary_location,
            source: { ...WORK.primary_location.source, display_name: 'Astron. & Astrophys.' },
          },
          authorships: [
            {
              author: { display_name: 'A. & B.', orcid: 'https://orcid.org/0000-0001&lt;2' },
              raw_author_name: 'A. & B.',
            },
          ],
        });
      });

      it('returns autocomplete identifiers byte-identical and names normalized', async () => {
        respondWith({
          results: [
            {
              id: 'https://openalex.org/A1&amp;',
              display_name: 'A. &amp; B.',
              entity_type: 'author',
              cited_by_count: 1,
              works_count: 1,
              external_id: 'https://orcid.org/0000-0001&amp;2',
              hint: 'Inst &amp; Co',
            },
          ],
        });
        const service = await getService();
        const result = await service.autocomplete(
          { entityType: 'authors', query: 'a' },
          createMockContext(),
        );
        expect(result.results[0]).toMatchObject({
          id: 'https://openalex.org/A1&amp;',
          display_name: 'A. & B.',
          external_id: 'https://orcid.org/0000-0001&amp;2',
          hint: 'Inst & Co',
        });
      });

      it('carries the upstream DOI on both surfaces of openalex_search_entities', async () => {
        respondWith(WORK);
        await getService();
        const { searchEntitiesTool } = await import(
          '@/mcp-server/tools/definitions/search-entities.tool.js'
        );

        const result = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: 'W7134264040',
          select: ['doi', 'ids', 'primary_location'],
        });

        expect(result.isError).toBeFalsy();
        const work = (result.structuredContent as { results: Record<string, unknown>[] })
          .results[0];
        expect(work?.doi).toBe(DOI);
        expect(work?.ids).toEqual(WORK.ids);
        const text = (result.content ?? [])
          .map((block) => ('text' in block ? block.text : ''))
          .join('\n');
        expect(text).toContain(`**DOI:** ${DOI}`);
        expect(text).toContain(`landing_page_url: ${DOI}`);
      });

      it('carries the upstream DOI on both surfaces of openalex_resolve_name', async () => {
        respondWith({
          results: [
            {
              id: WORK.id,
              display_name: 'Seyfert &amp; nuclei',
              entity_type: 'work',
              cited_by_count: 1,
              works_count: null,
              external_id: DOI,
              hint: 'A. &amp; B.',
            },
          ],
        });
        await getService();
        const { resolveNameTool } = await import(
          '@/mcp-server/tools/definitions/resolve-name.tool.js'
        );

        const result = await runToolContract(resolveNameTool, {
          entity_type: 'works',
          query: 'seyfert nuclei',
        });

        expect(result.isError).toBeFalsy();
        const match = (result.structuredContent as { results: Record<string, unknown>[] })
          .results[0];
        expect(match).toMatchObject({
          id: WORK.id,
          display_name: 'Seyfert & nuclei',
          external_id: DOI,
          hint: 'A. & B.',
        });
        const text = (result.content ?? [])
          .map((block) => ('text' in block ? block.text : ''))
          .join('\n');
        expect(text).toContain(DOI);
      });
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

    /**
     * The alias maps are plain object literals, so reading a name an `Object.prototype` member
     * carries returned the inherited member — a function, or the prototype object itself for
     * `__proto__` — and its string form went upstream as the field name. (gh #93)
     */
    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      'passes a %s select field through unchanged on both alias maps (gh #93)',
      async (field) => {
        const service = await getService();
        for (const entityType of ['works', 'authors'] as const) {
          await service.search({ entityType, select: [field] }, createMockContext());
          expect(lastFetchUrl().searchParams.get('select')).toBe(`id,display_name,${field}`);
        }
      },
    );

    it('translates real aliases beside a prototype-member name in one request (gh #93)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'works', select: ['authors', 'constructor', 'year'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,authorships,constructor,publication_year',
      );
      await service.search(
        { entityType: 'authors', select: ['toString', 'h_index'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,toString,summary_stats',
      );
    });

    /**
     * On sources OpenAlex names a journal's publisher `host_organization_name`; `publisher` is
     * a 400 whose ranked suggestions cannot reach it. The alias shares the sources map with the
     * summary_stats leaves, so both kinds translate in one request. (gh #97)
     */
    it.each([
      [['publisher'], 'id,display_name,host_organization_name'],
      [['publisher', 'host_organization_name'], 'id,display_name,host_organization_name'],
      [['publisher', 'h_index'], 'id,display_name,host_organization_name,summary_stats'],
    ])('aliases sources select %j to host_organization_name (gh #97)', async (select, sent) => {
      const service = await getService();
      await service.search({ entityType: 'sources', select }, createMockContext());
      expect(lastFetchUrl().searchParams.get('select')).toBe(sent);
    });

    it('aliases publisher on a sources id lookup too (gh #97)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ id: 'S1', display_name: 'Test' }), { status: 200 }),
      );
      const service = await getService();
      await service.search(
        { entityType: 'sources', id: 'S137773608', select: ['publisher'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,host_organization_name',
      );
    });

    it.each(['works', 'publishers', 'authors', 'topics'] as const)(
      'forwards publisher untranslated in %s select, where no field carries it (gh #97)',
      async (entityType) => {
        const service = await getService();
        await service.search({ entityType, select: ['publisher'] }, createMockContext());
        expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,publisher');
      },
    );

    it('leaves publisher as a sources filter key, sort, and group_by untouched (gh #97)', async () => {
      const service = await getService();
      await service.search(
        { entityType: 'sources', filters: { publisher: 'P4310320990' }, sort: 'publisher' },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('filter')).toBe('publisher:P4310320990');
      expect(lastFetchUrl().searchParams.get('sort')).toBe('publisher');
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ meta: { count: 0 }, group_by: [] }), { status: 200 }),
      );
      await service.analyze({ entityType: 'sources', groupBy: 'publisher' }, createMockContext());
      expect(lastFetchUrl().searchParams.get('group_by')).toBe('publisher');
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

    /**
     * `JSON.parse` builds the filters the way a JSON-RPC argument arrives, keeping `__proto__` an
     * own key. The works alias map is a plain object literal, so these keys used to resolve to
     * inherited members and reach upstream as `function Object() { … }` or `[object Object]`.
     * (gh #93)
     */
    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      'passes a works filter key named %s through unchanged beside a real alias (gh #93)',
      async (key) => {
        const service = await getService();
        const filters = JSON.parse(`{${JSON.stringify(key)}:"x","year":"2024"}`) as Record<
          string,
          string
        >;
        await service.search({ entityType: 'works', filters }, createMockContext());
        expect(filterParam()).toBe(`${key}:x,publication_year:2024`);
      },
    );

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

    /**
     * Upstream's `openalex` filter accepts every spelling of an OpenAlex ID — record pages, API
     * URLs, `http://`, scheme-less, lowercase, and space-padded `|` segments — while `id` is no
     * filter at all. The key is rewritten; the value is forwarded exactly as given. (gh #99)
     */
    it.each([
      'https://openalex.org/works/W2741809807',
      'W2741809807|https://api.openalex.org/works/W3002222772',
      'http://openalex.org/W2741809807',
      'openalex.org/works/W2741809807',
      'w2741809807',
      'W2741809807| https://openalex.org/works/W3002222772',
    ])('rewrites id → openalex for %j and forwards the value unchanged (gh #99)', async (value) => {
      const service = await getService();
      await service.search({ entityType: 'works', filters: { id: value } }, createMockContext());
      expect(filterParam()).toBe(`openalex:${value}`);
    });

    it.each([
      ['a keyword URL', 'https://openalex.org/keywords/groundwater'],
      ['a path that is not an entity type', 'https://openalex.org/fields/17'],
      ['a look-alike host', 'https://notopenalex.org/works/W2741809807'],
      ['one non-ID segment among IDs', 'W2741809807|https://openalex.org/fields/17'],
    ])('leaves id unrewritten for %s (gh #99)', async (_label, value) => {
      const service = await getService();
      await service.search({ entityType: 'works', filters: { id: value } }, createMockContext());
      expect(filterParam()).toBe(`id:${value}`);
    });

    it('rewrites a URL-form id filter on the group_by path too (gh #99)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        jsonResponse({ meta: { count: 1, groups_count: 1 }, group_by: [] }),
      );
      const service = await getService();
      await service.analyze(
        {
          entityType: 'works',
          groupBy: 'publication_year',
          filters: { id: 'https://openalex.org/works/W2741809807' },
        },
        createMockContext(),
      );
      expect(filterParam()).toBe('openalex:https://openalex.org/works/W2741809807');
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

  // --- author_list: a compact author array derived from authorships (gh #102) ---

  describe('author_list (gh #102)', () => {
    /**
     * Authorships shaped the ways OpenAlex returns them: a full entry, one with no ORCID key,
     * one with `orcid: null`, one whose `author` is missing outright, and a display name
     * carrying an HTML entity the provider-text pass decodes.
     */
    const upstreamAuthorships = [
      {
        author_position: 'first',
        author: {
          id: 'https://openalex.org/A5010999391',
          display_name: 'Shumin Ren',
          orcid: 'https://orcid.org/0000-0002-1376-1891',
        },
        institutions: [{ id: 'https://openalex.org/I1', display_name: 'Some University' }],
        raw_author_name: 'S. Ren',
      },
      { author_position: 'middle', author: { id: 'https://openalex.org/A2', display_name: 'B' } },
      {
        author_position: 'middle',
        author: { id: 'https://openalex.org/A3', display_name: 'Jos&eacute; Ruiz', orcid: null },
      },
      { author_position: 'last', institutions: [] },
    ];
    const expectedAuthorList = [
      {
        id: 'https://openalex.org/A5010999391',
        display_name: 'Shumin Ren',
        orcid: 'https://orcid.org/0000-0002-1376-1891',
      },
      { id: 'https://openalex.org/A2', display_name: 'B', orcid: null },
      { id: 'https://openalex.org/A3', display_name: 'José Ruiz', orcid: null },
      { id: null, display_name: null, orcid: null },
    ];
    const work = { id: 'https://openalex.org/W1', display_name: 'A work' };

    function serveWorks(results: Record<string, unknown>[]): void {
      routeFetch({
        '/works': () => jsonResponse({ meta: { count: results.length, per_page: 25 }, results }),
        '/works/W1': () => jsonResponse(results[0]),
      });
    }

    it('requests authorships and returns author_list in its place on a list search', async () => {
      serveWorks([{ ...work, authorships: upstreamAuthorships }]);
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', select: ['author_list'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,authorships');
      expect(result.results).toEqual([{ ...work, author_list: expectedAuthorList }]);
    });

    it('returns author_list in place of authorships on an id lookup', async () => {
      serveWorks([{ ...work, authorships: upstreamAuthorships }]);
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', id: 'W1', select: ['author_list'] },
        createMockContext(),
      );
      expect(lastFetchUrl().pathname).toBe('/works/W1');
      expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,authorships');
      expect(result.results).toEqual([{ ...work, author_list: expectedAuthorList }]);
    });

    it.each([['authorships'], ['authors']])(
      'returns author_list beside authorships from one upstream field when %s is selected too',
      async (alias) => {
        serveWorks([{ ...work, authorships: upstreamAuthorships }]);
        const service = await getService();
        const result = await service.search(
          { entityType: 'works', select: ['author_list', alias, 'doi'] },
          createMockContext(),
        );
        expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,authorships,doi');
        const [record] = result.results;
        expect(record?.author_list).toEqual(expectedAuthorList);
        expect(record?.authorships).toHaveLength(upstreamAuthorships.length);
      },
    );

    it('returns author_list beside the full record for ["*", "author_list"]', async () => {
      serveWorks([{ ...work, authorships: upstreamAuthorships, doi: 'https://doi.org/10.1/x' }]);
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', select: ['*', 'author_list'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.has('select')).toBe(false);
      expect(result.results[0]).toMatchObject({ author_list: expectedAuthorList });
      expect(result.results[0]?.authorships).toHaveLength(upstreamAuthorships.length);
    });

    it.each([
      ['the default projection', undefined],
      ['["*"]', ['*']],
      ['an explicit authorships', ['authorships']],
    ])('adds no author_list under %s', async (_label, select) => {
      serveWorks([{ ...work, authorships: upstreamAuthorships }]);
      const service = await getService();
      const result = await service.search({ entityType: 'works', select }, createMockContext());
      expect(result.results[0]).not.toHaveProperty('author_list');
      expect(lastFetchUrl().searchParams.get('select') ?? '').not.toContain('author_list');
    });

    it('returns an empty author_list for an empty authorships array', async () => {
      serveWorks([{ ...work, authorships: [] }]);
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', select: ['author_list'] },
        createMockContext(),
      );
      expect(result.results).toEqual([{ ...work, author_list: [] }]);
    });

    it('derives no author_list from a record OpenAlex returned without authorships', async () => {
      serveWorks([work]);
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', select: ['author_list'] },
        createMockContext(),
      );
      expect(result.results).toEqual([work]);
    });

    it('derives author_list and abstract on one record', async () => {
      serveWorks([
        {
          ...work,
          authorships: upstreamAuthorships.slice(0, 1),
          abstract_inverted_index: { Hello: [0], world: [1] },
        },
      ]);
      const service = await getService();
      const result = await service.search(
        { entityType: 'works', select: ['abstract', 'author_list'] },
        createMockContext(),
      );
      expect(lastFetchUrl().searchParams.get('select')).toBe(
        'id,display_name,abstract_inverted_index,authorships',
      );
      expect(result.results).toEqual([
        { ...work, abstract: 'Hello world', author_list: expectedAuthorList.slice(0, 1) },
      ]);
    });

    it.each(['authors', 'sources', 'topics'] as const)(
      'forwards author_list untranslated on %s, where upstream rejects it',
      async (entityType) => {
        const service = await getService();
        await service.search({ entityType, select: ['author_list'] }, createMockContext());
        expect(lastFetchUrl().searchParams.get('select')).toBe('id,display_name,author_list');
      },
    );
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

    /**
     * `authorships.countries` counts only each work's first 100 authorships; its full-count
     * counterpart `authorships.institutions.country_code` counts them all and carries no notice.
     */
    it.each([
      ['authorships.countries', true],
      ['authorships.institutions.country_code', false],
    ] as const)(
      'grouped by %s, discloses the first-100 cap on both tool surfaces: %s (gh #91)',
      async (groupBy, discloses) => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(
            JSON.stringify({
              meta: { count: 1 },
              group_by: [
                {
                  key: 'https://openalex.org/countries/US',
                  key_display_name: 'United States',
                  count: 1,
                },
              ],
            }),
            { status: 200 },
          ),
        );
        await getService();
        const { analyzeTrendsTool } = await import(
          '@/mcp-server/tools/definitions/analyze-trends.tool.js'
        );

        const result = await runToolContract(analyzeTrendsTool, {
          entity_type: 'works',
          group_by: groupBy,
          filters: { openalex: 'W1858542512' },
        });

        expect(result.isError).toBeFalsy();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(lastFetchUrl().searchParams.get('group_by')).toBe(groupBy);
        const { notice } = result.structuredContent as { notice?: string };
        const text = (result.content ?? [])
          .map((block) => ('text' in block ? block.text : ''))
          .join('\n');
        if (discloses) {
          for (const surface of [notice ?? '', text]) {
            expect(surface).toMatch(/first 100 authorships/);
            expect(surface).toContain('authorships.institutions.country_code');
          }
        } else {
          expect(notice).toBeUndefined();
          expect(text).not.toMatch(/first 100/);
        }
      },
    );

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
      const service = await getService();

      await expect(
        failThroughContract(
          [
            {
              reason: 'upstream_missing_group_by',
              code: JsonRpcErrorCode.ServiceUnavailable,
              when: 'the response carried no aggregation',
              recovery: 'DISTINCTIVE_GROUP_BY_HINT retry, then check the group_by field.',
            },
          ],
          (ctx) => service.analyze({ entityType: 'works', groupBy: 'type' }, ctx),
        ),
      ).resolves.toMatchObject({
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
        const outcome = service.autocomplete(params, createMockContext()).then(
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
          createMockContext(),
        );
        expect(typed.results).toEqual([]);
        expect(lastFetchUrl().searchParams.get('q')).toBe(digits);

        const crossEntity = await service.autocomplete(
          { query: 'a'.repeat(5000) },
          createMockContext(),
        );
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

    /**
     * OpenAlex answers a semantic search whose query-embedding call failed for any reason but a
     * timeout with HTTP 400 `Failed to embed query: <requests exception>` — and with HTTP 400
     * `Semantic search is not configured` when its embedder is unset. Neither is the caller's
     * mistake, and the exception text names the embedding service's host. Both are relabelled
     * an outage under a message of the server's own; every outage of a semantic request carries
     * the retry-or-keyword hint. Bodies follow ourresearch/openalex-elastic-api@0cba1f8
     * `core/semantic_search.py` and `app.py`. (gh #96)
     */
    describe('semantic embedding failures (gh #96)', () => {
      const EMBED_429 =
        'Failed to embed query: 429 Client Error: Too Many Requests for url: https://embed.example.com/ai-gateway/mlflow/v1/embeddings';
      const EMBED_CONNECTION =
        "Failed to embed query: HTTPSConnectionPool(host='embed.example.com', port=443): Max retries exceeded with url: /ai-gateway/mlflow/v1/embeddings (Caused by NewConnectionError('<urllib3.connection.HTTPSConnection object at 0x7f>: Failed to establish a new connection: [Errno 111] Connection refused'))";
      const BUSY =
        'Semantic search is busy (the query embedding timed out). Please retry in a minute.';

      /** Answer every request with `status` and an OpenAlex error envelope carrying `message`. */
      function answer(status: number, message: string, error = 'Invalid query parameters error.') {
        vi.mocked(globalThis.fetch).mockImplementation(() =>
          Promise.resolve(jsonResponse({ error, message }, status)),
        );
      }

      async function search(searchMode: 'semantic' | 'keyword') {
        vi.useFakeTimers();
        const service = await getService();
        const outcome = service
          .search(
            { entityType: 'works', query: 'graph neural networks for molecules', searchMode },
            createMockContext(),
          )
          .then(
            () => {
              throw new Error('expected the search to fail');
            },
            (error: unknown) => error as McpErrorShape,
          );
        await vi.runAllTimersAsync();
        return outcome;
      }

      interface McpErrorShape {
        code: number;
        data: Record<string, unknown> & { recovery?: { hint?: string } };
        message: string;
      }

      it.each([
        ['an embedding-service 429', EMBED_429],
        ['an embedding-service connection failure', EMBED_CONNECTION],
        ['an unconfigured embedder', 'Semantic search is not configured'],
      ])('relabels %s at HTTP 400 as an outage with the semantic hint', async (_label, message) => {
        answer(400, message);
        const { SEMANTIC_UNAVAILABLE_HINT } = await import(
          '@/services/openalex/openalex-service.js'
        );

        const error = await search('semantic');

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringMatching(
            /^OpenAlex could not embed the query for semantic search\. The failure is upstream; the request itself is valid\./,
          ),
          data: {
            reason: 'upstream_unavailable',
            recovery: { hint: SEMANTIC_UNAVAILABLE_HINT },
            upstreamMessage: message,
            upstreamError: 'Invalid query parameters error.',
            responseBody: JSON.stringify({ error: 'Invalid query parameters error.', message }),
          },
        });
        expect(error.message).not.toContain('embed.example.com');
        expect(error.message).not.toContain(message);
        // Retried like every other outage: three attempts, then the classified failure.
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('gives a semantic 503 the semantic hint and keeps its reason', async () => {
        answer(503, BUSY, 'Semantic search is busy');
        const { SEMANTIC_UNAVAILABLE_HINT } = await import(
          '@/services/openalex/openalex-service.js'
        );

        const error = await search('semantic');

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unavailable', recovery: { hint: SEMANTIC_UNAVAILABLE_HINT } },
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('leaves a keyword-mode 503 to the contract recovery', async () => {
        answer(503, 'Service Unavailable', 'Service Unavailable');

        const error = await search('keyword');

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unavailable' },
        });
        expect(error.data).not.toHaveProperty('recovery');
      });

      it.each([
        [
          'an unsupported semantic filter',
          'semantic',
          "Filter '_x' is not supported with semantic search. Supported filters: author.id, funders.id",
        ],
        [
          'a semantic search with no query',
          'semantic',
          'Search query is required for semantic search',
        ],
        [
          'two search methods at once',
          'semantic',
          'Cannot combine search.semantic with filter=title.search. Use only one search method per request.',
        ],
        ['a keyword-mode 400 with the embed wording', 'keyword', `${EMBED_429}`],
        ['the embed wording anywhere but the start', 'semantic', `Query rejected. ${EMBED_429}`],
      ] as const)('keeps %s an InvalidParams caller error', async (_label, searchMode, message) => {
        answer(400, message);

        const error = await search(searchMode);

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.InvalidParams,
          message,
          data: { reason: 'upstream_invalid_params_other' },
        });
        expect(error.data).not.toHaveProperty('recovery');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });
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
        const service = await getService();
        await expect(
          failThroughContract(
            [
              {
                reason: 'upstream_invalid_id_value',
                code: JsonRpcErrorCode.InvalidParams,
                when: 'an entity-ID filter received a name',
                recovery: 'DISTINCTIVE_ID_HINT call openalex_resolve_name to get the ID first.',
              },
            ],
            (ctx) =>
              service.search(
                { entityType: 'works', filters: { 'authorships.institutions.id': 'Harvard' } },
                ctx,
              ),
          ),
        ).resolves.toMatchObject({
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
        const service = await getService();
        await expect(
          failThroughContract(
            [
              {
                reason: 'query_too_long',
                code: JsonRpcErrorCode.InvalidParams,
                when: 'the search text exceeds the upstream limit',
                recovery: 'DISTINCTIVE_LENGTH_HINT shorten the query or split it into several.',
              },
            ],
            (ctx) => service.search({ entityType: 'works', query: 'a'.repeat(1890) }, ctx),
          ),
        ).resolves.toMatchObject({
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
        const service = await getService();
        await expect(
          failThroughContract(
            [
              {
                reason: 'upstream_sort_requires_search',
                code: JsonRpcErrorCode.ValidationError,
                when: 'relevance sort requested without an active search',
                recovery: 'DISTINCTIVE_HINT add a query or choose another sort field.',
              },
            ],
            (ctx) => service.search({ entityType: 'works', sort: '-relevance_score' }, ctx),
          ),
        ).resolves.toMatchObject({
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

      /**
       * The budget that ran out is the one this server spends — its keyed budget when
       * OPENALEX_API_KEY is set. Setting a key helps only a keyless server, so only that throw
       * carries the key advice; the contract's own recovery has to hold either way. (gh #90)
       */
      describe.each<[name: string, run: () => ReturnType<typeof runToolContract>]>([
        [
          'openalex_search_entities',
          async () => {
            const { searchEntitiesTool } = await import(
              '@/mcp-server/tools/definitions/search-entities.tool.js'
            );
            return runToolContract(searchEntitiesTool, { entity_type: 'works', query: 'climate' });
          },
        ],
        [
          'openalex_resolve_name',
          async () => {
            const { resolveNameTool } = await import(
              '@/mcp-server/tools/definitions/resolve-name.tool.js'
            );
            return runToolContract(resolveNameTool, { query: 'climate' });
          },
        ],
        [
          'openalex_analyze_trends',
          async () => {
            const { analyzeTrendsTool } = await import(
              '@/mcp-server/tools/definitions/analyze-trends.tool.js'
            );
            return runToolContract(analyzeTrendsTool, {
              entity_type: 'works',
              group_by: 'publication_year',
            });
          },
        ],
        [
          'openalex_get_citation_graph',
          async () => {
            const { getCitationGraphTool } = await import(
              '@/mcp-server/tools/definitions/citation-graph.tool.js'
            );
            return runToolContract(getCitationGraphTool, {
              seed_id: 'W2741809807',
              direction: 'cites',
            });
          },
        ],
      ])('budget recovery on %s (gh #90)', (_name, run) => {
        /** Run the tool against a budget 429 and return the wire hint and the rendered text. */
        async function budgetFailure(apiKey: string): Promise<{ hint: string; text: string }> {
          mockConfig.apiKey = apiKey;
          mock429(
            JSON.stringify({
              message:
                'Insufficient budget. This request costs $0.001 but you only have $0 remaining. Resets at midnight.',
            }),
          );
          await getService();

          const result = await run();

          expect(result.isError).toBe(true);
          expect(globalThis.fetch).toHaveBeenCalledTimes(1);
          const { error } = result.structuredContent as { error: ErrorEnvelope };
          expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
          expect(error.data).toMatchObject({
            reason: 'upstream_budget_exhausted',
            retryable: false,
          });
          const text = (result.content ?? [])
            .map((block) => ('text' in block ? block.text : ''))
            .join('\n');
          return { hint: (error.data.recovery as { hint: string }).hint, text };
        }

        it('says only what holds with a key when one is configured', async () => {
          const { hint, text } = await budgetFailure('test-key');
          expect(hint).toMatch(/midnight UTC/);
          expect(hint).not.toMatch(/OPENALEX_API_KEY|openalex\.org\/settings/);
          expect(text).toContain(`Recovery: ${hint}`);
        });

        it('adds the free-key advice when no key is configured', async () => {
          const { hint, text } = await budgetFailure('');
          // The service's own throw-site hint, not the contract's fill.
          const { BUDGET_EXHAUSTED_KEYLESS_HINT } = await import(
            '@/services/openalex/openalex-service.js'
          );
          expect(hint).toBe(BUDGET_EXHAUSTED_KEYLESS_HINT);
          expect(hint).toMatch(/midnight UTC/);
          expect(hint).toContain('OPENALEX_API_KEY');
          expect(hint).toContain('https://openalex.org/settings/api');
          expect(text).toContain(`Recovery: ${hint}`);
        });
      });
    });

    // --- A filter OpenAlex serves only on a paid plan (gh #114) ---

    /**
     * OpenAlex answers a filter its paid plans gate — `created_date`, `updated_date`, and their
     * `from_`/`to_` forms — with HTTP 429 `{"error":"Plan upgrade required", …}`. No wait clears a
     * plan gate, so it fails on its one request under a reason and message of its own; every other
     * 429 keeps the rate-limit handling. `CREATED_BODY` is a verbatim live capture (2026-10-18), and
     * `planBody` rebuilds the same shape for the other clauses OpenAlex refused.
     */
    describe('plan-gated filters (gh #114)', () => {
      const CREATED_BODY =
        '{"error":"Plan upgrade required","message":"The \\"from_created_date:2026-10-01\\" filter is part of daily sync, which comes with the Member+ and Partner plans. See https://help.openalex.org/access/sync/ for details."}';
      const CREATED_MESSAGE =
        "The `from_created_date` filter needs a paid OpenAlex plan, which this server's OpenAlex access does not include.";
      const UNNAMED_MESSAGE =
        "A filter in this request needs a paid OpenAlex plan, which this server's OpenAlex access does not include.";

      /** The upstream body for a plan-gated filter `clause`, as OpenAlex words it. */
      function planBody(clause: string): string {
        return JSON.stringify({
          error: 'Plan upgrade required',
          message: `The "${clause}" filter is part of daily sync, which comes with the Member+ and Partner plans. See https://help.openalex.org/access/sync/ for details.`,
        });
      }

      function status429(body: string): Response {
        return new Response(body, { status: 429, statusText: 'Too Many Requests' });
      }

      interface Failure {
        code: number;
        data: Record<string, unknown>;
        message: string;
      }

      /** Run a works search under fake timers, so a retried failure settles without real waits. */
      async function failSearch(filters: Record<string, string>): Promise<Failure> {
        vi.useFakeTimers();
        const service = await getService();
        const outcome = service.search({ entityType: 'works', filters }, createMockContext()).then(
          () => {
            throw new Error('expected the search to fail');
          },
          (error: unknown) => error as Failure,
        );
        await vi.runAllTimersAsync();
        return outcome;
      }

      it('fails on its one request under its own reason and message, keeping the body', async () => {
        routeFetch({ '/works': () => status429(CREATED_BODY) });

        const error = await failSearch({ from_created_date: '2026-10-01' });

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
          message: CREATED_MESSAGE,
          data: {
            reason: 'upstream_plan_required',
            retryable: false,
            statusCode: 429,
            upstreamError: 'Plan upgrade required',
            upstreamMessage: JSON.parse(CREATED_BODY).message,
            responseBody: CREATED_BODY,
          },
        });
        expect(error.data).not.toHaveProperty('retryAttempts');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(lastFetchUrl().searchParams.get('filter')).toBe('from_created_date:2026-10-01');
      });

      it.each([
        ['from_created_date', 'from_created_date:2026-10-01T00:00:00+00:00'],
        ['to_created_date', 'to_created_date:2026-10-01'],
        ['from_updated_date', 'from_updated_date:2026-10-01T00:00:00+00:00'],
        ['to_updated_date', 'to_updated_date:2026-10-01'],
        ['created_date', 'created_date:2026-10-01'],
        ['updated_date', 'updated_date:2026-10-01'],
      ])('names %s, the filter the upstream message refused', async (key, clause) => {
        routeFetch({ '/works': () => status429(planBody(clause)) });

        const error = await failSearch({ [key]: clause.slice(key.length + 1) });

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
          message: CREATED_MESSAGE.replace('from_created_date', key),
          data: { reason: 'upstream_plan_required', retryable: false },
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['no message', JSON.stringify({ error: 'Plan upgrade required' })],
        [
          'a message in another shape',
          JSON.stringify({
            error: 'Plan upgrade required',
            message: 'Daily sync comes with the Member+ and Partner plans.',
          }),
        ],
        ['a clause whose name is not a field name', planBody('x\n# Forged heading:2026-10-01')],
        ['a clause whose name holds a backtick', planBody('a`b:2026-10-01')],
      ])('falls back to an unnamed filter on %s', async (_label, body) => {
        routeFetch({ '/works': () => status429(body) });

        const error = await failSearch({ from_created_date: '2026-10-01' });

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
          message: UNNAMED_MESSAGE,
          data: { reason: 'upstream_plan_required', retryable: false, responseBody: body },
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it('still classifies a body cut to the capture limit, and names its filter', async () => {
        const value = Array.from(
          { length: 60 },
          (_, i) => `2026-10-${String(i).padStart(2, '0')}`,
        ).join('|');
        const body = planBody(`from_created_date:${value}`);
        routeFetch({ '/works': () => status429(body) });

        const error = await failSearch({ from_created_date: value });

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
          message: CREATED_MESSAGE,
          data: { reason: 'upstream_plan_required', upstreamError: 'Plan upgrade required' },
        });
        // The framework keeps the head and tail of an over-limit body; the cut is what reaches us.
        expect(error.data.responseBody).toMatch(/^\{"error":"Plan upgrade required".*elided\]…/s);
        expect(body.length).toBeGreaterThan(String(error.data.responseBody).length);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['a plain-text throttle', 'Rate limited'],
        [
          'a burst throttle',
          JSON.stringify({
            error: 'Rate limit exceeded',
            message: 'Anonymous search is temporarily rate-limited due to heavy load.',
          }),
        ],
        [
          'a throttle whose message mentions a plan',
          JSON.stringify({
            error: 'Rate limit exceeded',
            message: 'Plan upgrade required for a higher per-second rate limit.',
          }),
        ],
      ])('keeps %s on the retried rate_limited reason', async (_label, body) => {
        routeFetch({ '/works': () => status429(body) });

        const error = await failSearch({ from_created_date: '2026-10-01' });

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'rate_limited', retryAttempts: 3, responseBody: body },
        });
        expect(error.data).not.toHaveProperty('retryable');
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      /** A loaded tool: its declared contract, and the call that runs the repro through it. */
      interface LoadedTool {
        call: () => ReturnType<typeof runToolContract>;
        errors: readonly ErrorContract[] | undefined;
      }

      /**
       * Every tool that sends `filters` fails the same way, with its own contract's recovery on
       * both surfaces. Each case answers the filtered request with the plan-gated 429 and any
       * request before it (the citation graph's seed lookup) as OpenAlex does. The tool module
       * loads before fake timers start, so a retry's backoff would run instead of stalling.
       */
      describe.each<
        [
          name: string,
          gatedPath: string,
          routes: Record<string, (url: URL) => Response>,
          load: () => Promise<LoadedTool>,
        ]
      >([
        [
          'openalex_search_entities',
          '/works',
          {},
          async () => {
            const { searchEntitiesTool } = await import(
              '@/mcp-server/tools/definitions/search-entities.tool.js'
            );
            return {
              errors: searchEntitiesTool.errors,
              call: () =>
                runToolContract(searchEntitiesTool, {
                  entity_type: 'works',
                  filters: { from_created_date: '2026-10-01' },
                }),
            };
          },
        ],
        [
          'openalex_analyze_trends',
          '/works',
          {},
          async () => {
            const { analyzeTrendsTool } = await import(
              '@/mcp-server/tools/definitions/analyze-trends.tool.js'
            );
            return {
              errors: analyzeTrendsTool.errors,
              call: () =>
                runToolContract(analyzeTrendsTool, {
                  entity_type: 'works',
                  group_by: 'type',
                  filters: { from_created_date: '2026-10-01' },
                }),
            };
          },
        ],
        [
          'openalex_resolve_name',
          '/autocomplete/works',
          {},
          async () => {
            const { resolveNameTool } = await import(
              '@/mcp-server/tools/definitions/resolve-name.tool.js'
            );
            return {
              errors: resolveNameTool.errors,
              call: () =>
                runToolContract(resolveNameTool, {
                  query: 'cancer',
                  entity_type: 'works',
                  filters: { from_created_date: '2026-10-01' },
                }),
            };
          },
        ],
        [
          'openalex_get_citation_graph',
          '/works',
          { '/works/W2741809807': () => jsonResponse({ id: 'https://openalex.org/W2741809807' }) },
          async () => {
            const { getCitationGraphTool } = await import(
              '@/mcp-server/tools/definitions/citation-graph.tool.js'
            );
            return {
              errors: getCitationGraphTool.errors,
              call: () =>
                runToolContract(getCitationGraphTool, {
                  seed_id: 'W2741809807',
                  direction: 'cites',
                  filters: { from_created_date: '2026-10-01' },
                }),
            };
          },
        ],
      ])('on %s', (_name, gatedPath, routes, load) => {
        it('fails on one gated request with the contract recovery on both surfaces', async () => {
          routeFetch({ ...routes, [gatedPath]: () => status429(CREATED_BODY) });
          await getService();
          const { errors, call } = await load();

          vi.useFakeTimers();
          const pending = call();
          await vi.runAllTimersAsync();
          const result = await pending;

          const gatedCalls = vi
            .mocked(globalThis.fetch)
            .mock.calls.filter(([input]) => new URL(String(input)).pathname === gatedPath);
          expect(gatedCalls).toHaveLength(1);
          expect(globalThis.fetch).toHaveBeenCalledTimes(Object.keys(routes).length + 1);

          const recovery = errors?.find((e) => e.reason === 'upstream_plan_required')?.recovery;
          expect(recovery).toMatch(/publication_date/);
          expect(result.isError).toBe(true);
          const { error } = result.structuredContent as { error: ErrorEnvelope };
          expect(error).toMatchObject({
            code: JsonRpcErrorCode.Forbidden,
            message: CREATED_MESSAGE,
            data: {
              reason: 'upstream_plan_required',
              retryable: false,
              recovery: { hint: recovery },
              upstreamError: 'Plan upgrade required',
              upstreamMessage: JSON.parse(CREATED_BODY).message,
              responseBody: CREATED_BODY,
            },
          });

          const text = (result.content ?? [])
            .map((block) => ('text' in block ? block.text : ''))
            .join('\n');
          expect(text).toContain(`Error: ${CREATED_MESSAGE}`);
          expect(text).toContain(`Recovery: ${recovery}`);
          expect(text).toContain('(reason upstream_plan_required · not retryable)');
          expect(text).not.toMatch(/Wait several seconds|failed after/);
        });
      });
    });

    // --- Statusless fetch failures: timeout, network, unparseable body (gh #53) ---

    describe('statusless fetch failures (gh #53)', () => {
      /** Contract covering both transient reasons, so the recovery hint is resolvable. */
      const TRANSIENT_CONTRACT: readonly ErrorContract[] = [
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
      ];

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
        const promise = failThroughContract(TRANSIENT_CONTRACT, (ctx) =>
          service.search({ entityType: 'works' }, ctx),
        );
        const rejection = expect(promise).resolves.toMatchObject({
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
        const promise = failThroughContract(TRANSIENT_CONTRACT, (ctx) =>
          service.search({ entityType: 'works' }, ctx),
        );
        const rejection = expect(promise).resolves.toMatchObject({
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
        const promise = failThroughContract(TRANSIENT_CONTRACT, (ctx) =>
          service.search({ entityType: 'works' }, ctx),
        );
        const rejection = expect(promise).resolves.toMatchObject({
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
        const promise = failThroughContract(TRANSIENT_CONTRACT, (ctx) =>
          service.search({ entityType: 'works' }, ctx),
        );
        const rejection = expect(promise).resolves.toMatchObject({
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
        const promise = failThroughContract(TRANSIENT_CONTRACT, (ctx) =>
          service.search({ entityType: 'works' }, ctx),
        );
        const rejection = expect(promise).resolves.toMatchObject({
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
        const service = await getService();

        await expect(
          failThroughContract(notFoundContract, (ctx) =>
            service.search({ entityType: 'works', id }, ctx),
          ),
        ).resolves.toMatchObject({
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
        const service = await getService();

        const envelope = await failThroughContract(notFoundContract, (ctx) =>
          service.search({ entityType: 'works', id: 'PMC3084216' }, ctx),
        );

        const hint = (envelope.data.recovery as { hint: string }).hint;
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
        const service = await getService();

        await expect(
          failThroughContract(notFoundContract, (ctx) =>
            service.search({ entityType: 'works', id }, ctx),
          ),
        ).resolves.toMatchObject({
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

    it('suggests the server-derived author_list for a near-miss works select field (gh #102)', async () => {
      const longMessage = `author_names is not a valid select field. Valid fields: ${'apc_list, '.repeat(60)}id`;
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Invalid query parameters error.', message: longMessage }),
          {
            status: 400,
          },
        ),
      );
      const service = await getService();

      const err = (await service
        .search({ entityType: 'works', select: ['author_names'] }, createMockContext())
        .catch((e) => e)) as { message: string };

      expect(err.message).toMatch(
        /^author_names is not a valid select field\. Did you mean: author_list,/,
      );
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
