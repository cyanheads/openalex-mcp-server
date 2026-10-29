/**
 * @fileoverview Tests for openalex_resolve_name tool.
 * @module mcp-server/tools/definitions/resolve-name.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createCoreMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteEntityType, AutocompleteResult } from '@/services/openalex/types.js';
import { nodeTypes, nonAutolinks, renderedText } from '../../../helpers/markdown.js';

const mockAutocomplete = vi.fn<() => Promise<AutocompleteResult>>();
const mockResolveIdentifier = vi.fn<() => Promise<AutocompleteResult>>();

/** A keyless server, for the cases that run the real service against a routed `fetch`. */
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ apiKey: '', baseUrl: 'https://api.openalex.org', mailto: '' }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/**
 * Route both service methods to the real service over a stubbed `fetch`. Only an
 * `api.openalex.org` request `answer` returns a response for is answered; every other call
 * rejects. `requests()` lists each request as `<path>?<params>`, in order, with the credential
 * and `select` params dropped. Pair with `vi.unstubAllGlobals()` in an `afterEach`.
 */
async function routeToRealService(answer: (url: URL) => Response | undefined) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = new URL(String(input));
    const response = url.hostname === 'api.openalex.org' ? answer(url) : undefined;
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error(`unmocked fetch: ${url.href}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  const actual = await vi.importActual<typeof import('@/services/openalex/openalex-service.js')>(
    '@/services/openalex/openalex-service.js',
  );
  actual.initOpenAlexService();
  const service = actual.getOpenAlexService();
  mockResolveIdentifier.mockImplementation((...args: unknown[]) =>
    service.resolveIdentifier(...(args as Parameters<typeof service.resolveIdentifier>)),
  );
  mockAutocomplete.mockImplementation((...args: unknown[]) =>
    service.autocomplete(...(args as Parameters<typeof service.autocomplete>)),
  );
  const requests = () =>
    fetchMock.mock.calls.map(([input]) => {
      const url = new URL(String(input));
      for (const param of ['api_key', 'mailto', 'select']) url.searchParams.delete(param);
      return `${url.pathname}${url.search}`;
    });
  return { fetchMock, requests };
}

/** The `content[]` text blocks of a tool result, joined. */
const contentText = (result: { content?: { type: string; text?: string }[] }) =>
  (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');

/**
 * Only the service accessor is faked. `inferIdentifier` stays real so these cases exercise
 * the actual name-vs-identifier routing rather than a restatement of it.
 */
vi.mock('@/services/openalex/openalex-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/openalex/openalex-service.js')>();
  return {
    ...actual,
    getOpenAlexService: () => ({
      autocomplete: mockAutocomplete,
      resolveIdentifier: mockResolveIdentifier,
    }),
  };
});

const { resolveNameTool } = await import('@/mcp-server/tools/definitions/resolve-name.tool.js');

const createMockContext = (options?: Parameters<typeof createCoreMockContext>[0]) =>
  createCoreMockContext({ ...options, errors: resolveNameTool.errors });

describe('resolveNameTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('error contract', () => {
    /**
     * `filters` reaches the autocomplete endpoint, so every 400 shape the search tools
     * see is reachable here too — each needs a declared entry or its recovery hint is
     * dropped on the floor. The 400 family is thrown through the `invalidParams` factory,
     * so an entry declaring `ValidationError` advertises a code the caller never receives.
     */
    it('declares InvalidParams for every reason the 400 family delivers (gh #53)', () => {
      const upstream400Reasons = [
        'comma_in_filter_value',
        'upstream_invalid_params',
        'upstream_invalid_id_value',
        'upstream_invalid_params_other',
      ];
      for (const reason of upstream400Reasons) {
        const entry = resolveNameTool.errors?.find((e) => e.reason === reason);
        expect(entry, `${reason} missing from the contract`).toBeDefined();
        expect(entry?.code, `${reason} declares the wrong code`).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
      }
    });

    it('declares the budget entry non-retryable and the throttle entry retryable (gh #54)', () => {
      const budget = resolveNameTool.errors?.find((e) => e.reason === 'upstream_budget_exhausted');
      const throttle = resolveNameTool.errors?.find((e) => e.reason === 'rate_limited');
      expect(budget?.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(budget?.retryable).toBe(false);
      expect(throttle?.retryable).toBe(true);
    });

    it('carries the invalid-ID-value recovery through to the caller (gh #49)', async () => {
      mockAutocomplete.mockRejectedValue(
        invalidParams("'Einstein' is not a valid OpenAlex ID.", {
          reason: 'upstream_invalid_id_value',
        }),
      );

      const result = await runToolContract(resolveNameTool, {
        query: 'climate',
        entity_type: 'works',
        filters: { 'authorships.author.id': 'Einstein' },
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'upstream_invalid_id_value',
            recovery: { hint: expect.stringMatching(/resolve that name/i) },
          },
        },
      });
    });

    /**
     * An over-long typed autocomplete query fails upstream with a 500 on every attempt; the
     * service reclassifies it, so the contract must declare the reason for its recovery to
     * resolve. The wire path through the real service is covered in the service suite. (gh #81)
     */
    it('declares query_too_long as a non-retryable, service-thrown InvalidParams reason', () => {
      const entry = resolveNameTool.errors?.find((e) => e.reason === 'query_too_long');
      expect(entry?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(entry?.thrownBy).toBe('service');
      expect(entry?.retryable).toBe(false);
      expect(entry?.recovery).toMatch(/shorten/i);
      expect(entry?.recovery).toMatch(/1,000/);
    });

    it('carries the query_too_long recovery to both surfaces', async () => {
      mockAutocomplete.mockRejectedValue(
        invalidParams('OpenAlex autocomplete cannot take a query this long.', {
          reason: 'query_too_long',
          retryable: false,
        }),
      );

      const result = await runToolContract(resolveNameTool, {
        entity_type: 'authors',
        query: 'a'.repeat(1001),
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'query_too_long', recovery: { hint: expect.stringMatching(/shorten/i) } },
        },
      });
      const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toMatch(/Recovery: .*shorten/i);
      expect(text).toContain('(reason query_too_long · not retryable)');
    });

    it('puts no length limit on query, so tools/list is unchanged', () => {
      const query = z.toJSONSchema(resolveNameTool.input).properties?.query;
      expect(query).not.toHaveProperty('maxLength');
      expect(query).toMatchObject({ type: 'string', minLength: 1 });
      expect(resolveNameTool.input.parse({ query: 'a'.repeat(5000) }).query).toHaveLength(5000);
    });
  });

  const harvard = {
    id: 'https://openalex.org/I136199984',
    external_id: 'https://ror.org/02jbv0t02',
    display_name: 'Harvard University',
    entity_type: 'institution',
    cited_by_count: 25000000,
    works_count: 800000,
    hint: 'Cambridge, Massachusetts, USA',
  } as const;

  const sampleResults: AutocompleteResult = {
    results: [
      harvard,
      {
        id: 'https://openalex.org/I136199985',
        external_id: null,
        display_name: 'Harvard Medical School',
        entity_type: 'institution',
        cited_by_count: 5000000,
        works_count: 200000,
        hint: 'Boston, Massachusetts, USA',
      },
    ],
  };

  it('calls autocomplete with correct params and returns results', async () => {
    mockAutocomplete.mockResolvedValue(sampleResults);
    const ctx = createMockContext();
    const input = resolveNameTool.input.parse({
      entity_type: 'institutions',
      query: 'Harvard',
    });

    const result = await resolveNameTool.handler(input, ctx);

    expect(mockAutocomplete).toHaveBeenCalledWith(
      { entityType: 'institutions', query: 'Harvard', filters: undefined },
      ctx,
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toHaveProperty('display_name', 'Harvard University');
  });

  it('passes filters through to service', async () => {
    mockAutocomplete.mockResolvedValue({ results: [] });
    const ctx = createMockContext();
    const input = resolveNameTool.input.parse({
      query: 'MIT',
      entity_type: 'institutions',
      filters: { country_code: 'us' },
    });

    await resolveNameTool.handler(input, ctx);

    expect(mockAutocomplete).toHaveBeenCalledWith(
      { entityType: 'institutions', query: 'MIT', filters: { country_code: 'us' } },
      ctx,
    );
  });

  /**
   * Cross-entity autocomplete rejects `filter` outright (HTTP 400 "filter is not a valid parameter
   * for the full autocomplete endpoint"), so a name search with `filters` and no `entity_type`
   * can only fail upstream — and fail with a recovery about field names, which were never the
   * problem. It is refused before any request. (gh #105)
   */
  describe('filters without entity_type (gh #105)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fails a name search before any request, with its own reason and recovery', async () => {
      const result = await runToolContract(resolveNameTool, {
        query: 'University of Cambridge',
        filters: { country_code: 'US' },
      });

      expect(result.isError).toBe(true);
      expect(mockAutocomplete).not.toHaveBeenCalled();
      expect(mockResolveIdentifier).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'filters_without_entity_type',
            recovery: { hint: expect.stringMatching(/entity_type/) },
          },
        },
      });
      const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(text).toMatch(/Recovery: .*entity_type/);
      expect(text).toContain('(reason filters_without_entity_type');
    });

    it('declares the reason as a handler-local ValidationError', () => {
      const entry = resolveNameTool.errors?.find((e) => e.reason === 'filters_without_entity_type');
      expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(entry).not.toHaveProperty('thrownBy');
      expect(entry?.recovery).toMatch(/entity_type/);
      expect(entry?.recovery).toMatch(/drop `filters`/);
    });

    it.each([
      [
        'filters with entity_type',
        { entity_type: 'institutions', filters: { country_code: 'US' } },
        '/autocomplete/institutions?q=Cambridge&filter=country_code%3AUS',
      ],
      ['neither', {}, '/autocomplete?q=Cambridge'],
      ['an empty filters object', { filters: {} }, '/autocomplete?q=Cambridge'],
    ] as const)('runs the name search for %s, as before', async (_label, extra, request) => {
      const { requests } = await routeToRealService((url) =>
        url.pathname === request.split('?')[0]
          ? jsonResponse({ results: sampleResults.results })
          : undefined,
      );

      const result = await runToolContract(resolveNameTool, { query: 'Cambridge', ...extra });

      expect(result.isError).toBeFalsy();
      expect(requests()).toEqual([request]);
      expect((result.structuredContent as AutocompleteResult).results).toEqual(
        sampleResults.results,
      );
      expect(contentText(result)).toContain('**Harvard University** (institution)');
      expect(contentText(result)).toContain('**Harvard Medical School** (institution)');
    });

    it('leaves an identifier query with filters to the identifier lookup', async () => {
      const ror = 'https://ror.org/02jbv0t02';
      const lookups = ['institutions', 'funders', 'publishers'].map(
        (type) => `/${type}/ror:${ror}`,
      );
      const { requests } = await routeToRealService((url) => {
        if (url.pathname === lookups[0]) {
          return jsonResponse({ id: harvard.id, display_name: harvard.display_name, ror });
        }
        return lookups.includes(url.pathname)
          ? new Response('<!doctype html><title>404</title>', { status: 404 })
          : undefined;
      });

      const result = await runToolContract(resolveNameTool, {
        query: ror,
        filters: { country_code: 'US' },
      });

      expect(result.isError).toBeFalsy();
      expect(requests()).toEqual(lookups);
      const { results, notice } = result.structuredContent as AutocompleteResult & {
        notice?: string;
      };
      expect(results.map((r) => r.id)).toEqual([harvard.id]);
      expect(notice).toBe(
        `Resolved "${ror}" by ROR — it identifies an institution, a funder, or a publisher directly, so filters did not apply.`,
      );
      expect(contentText(result)).toContain(notice);
      expect(contentText(result)).toContain(harvard.id);
    });

    it('states the requirement in the filters description', () => {
      const filters = resolveNameTool.input.shape.filters.description ?? '';
      expect(filters).toMatch(/requires entity_type/i);
    });
  });

  it('omits entity_type for cross-entity search', async () => {
    mockAutocomplete.mockResolvedValue({ results: [] });
    const ctx = createMockContext();
    const input = resolveNameTool.input.parse({ query: 'machine learning' });

    await resolveNameTool.handler(input, ctx);

    expect(mockAutocomplete).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: undefined }),
      ctx,
    );
  });

  describe('enrichment', () => {
    it('sets no notice when results are present', async () => {
      mockAutocomplete.mockResolvedValue(sampleResults);
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'Harvard' });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('sets notice when no matches found (cross-entity)', async () => {
      mockAutocomplete.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'xyzzy_nonexistent_entity_abc' });

      await resolveNameTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toMatch(/No matches/i);
      expect(notice).toContain('xyzzy_nonexistent_entity_abc');
    });

    it('includes entity_type scope in notice when specified', async () => {
      mockAutocomplete.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({
        entity_type: 'works',
        query: 'missing_title_xyz',
      });

      await resolveNameTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('works');
    });

    /**
     * A filter can exclude the match the name was meant to find, so the notice for a miss under
     * `filters` echoes them and points at them first — and never suggests omitting entity_type,
     * which with `filters` kept fails pre-flight. Echoes are JSON-encoded, so a quote or line
     * break in a value cannot leave the notice's one line. (gh #103)
     */
    describe('a miss under filters (gh #103)', () => {
      async function miss(args: Record<string, unknown>) {
        mockAutocomplete.mockResolvedValue({ results: [] });
        const result = await runToolContract(resolveNameTool, args as { query: string });
        expect(result.isError).toBeFalsy();
        const notice = (result.structuredContent as { notice?: string }).notice ?? '';
        const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
        return { notice, text };
      }

      it('echoes the filters and suggests loosening them, not omitting entity_type', async () => {
        const { notice, text } = await miss({
          query: 'University of Cambridge',
          entity_type: 'institutions',
          filters: { country_code: 'US' },
        });

        for (const surface of [notice, text]) {
          expect(surface).toContain(
            'No matches for "University of Cambridge" among institutions with filters={"country_code":"US"}.',
          );
          expect(surface).toMatch(/Loosen or drop filters/);
          expect(surface).not.toMatch(/omit entity_type/);
        }
      });

      it('keeps the notice on one line when a filter value or the query holds a quote or line break', async () => {
        const { notice, text } = await miss({
          query: 'Cambridge\n# Injected query',
          entity_type: 'institutions',
          filters: { 'display_name.search': 'a "b"\n# Injected filter' },
        });

        expect(notice).not.toMatch(/[\r\n]/);
        // The notice is Markdown (gh #127): the JSON echo reads back as written once rendered.
        expect(renderedText(`> ${notice}`)).toContain(
          '"Cambridge\\n# Injected query" among institutions with filters={"display_name.search":"a \\"b\\"\\n# Injected filter"}.',
        );
        expect(text).toContain(`> ${notice}`);
        expect(text.split('\n').some((line) => line.trimStart().startsWith('# Injected'))).toBe(
          false,
        );
      });

      it('keeps the notice for a miss without filters unchanged', async () => {
        const { notice, text } = await miss({
          query: 'qwxzqxzpwoiuasdhfkj',
          entity_type: 'institutions',
        });
        expect(notice).toBe(
          'No matches for "qwxzqxzpwoiuasdhfkj" among institutions. Try a shorter name, alternate spelling, or omit entity_type to search across all types.',
        );
        expect(text).toContain(notice);
      });

      it('suggests passing entity_type, not omitting it, when none was given', async () => {
        const { notice, text } = await miss({ query: 'qwxzqxzpwoiuasdhfkj' });
        expect(notice).toContain('No matches for "qwxzqxzpwoiuasdhfkj" across all entity types.');
        expect(notice).toMatch(/pass entity_type to search one type/);
        expect(notice).not.toMatch(/omit entity_type/);
        expect(text).toContain(notice);
      });

      it('keeps the identifier-miss notice, filters included, on an identifier query', async () => {
        mockResolveIdentifier.mockResolvedValue({ results: [] });
        const result = await runToolContract(resolveNameTool, {
          query: '10.1038/thisdoesnotexist999999',
          filters: { publication_year: '2020' },
        });

        const notice = (result.structuredContent as { notice?: string }).notice ?? '';
        expect(notice).toContain('filters did not apply');
        expect(notice).toMatch(/check it for a typo/);
        expect(notice).not.toContain('filters={');
        expect(contentText(result)).toContain(notice);
      });

      it('describes the filters echo in the notice description', () => {
        expect(resolveNameTool.enrichment?.notice?.description).toMatch(/filters/);
      });
    });

    it('carries the budget reading the service writes through to structuredContent', () => {
      // The service populates `budget` from the OpenAlex rate-limit headers via ctx.enrich.
      // structuredContent is built as output.extend(enrichment), which silently strips any
      // field the tool did not declare.
      const budget = { costUsd: 0.0001, remainingUsd: 0.0687, resetsInSeconds: 5553 };
      const structured = resolveNameTool.output
        .extend(resolveNameTool.enrichment!)
        .parse({ ...sampleResults, budget });

      expect(structured.budget).toEqual(budget);
      expect(resolveNameTool.enrichmentTrailer?.budget?.render?.(budget)).toContain(
        '$0.0687 left today',
      );
    });
  });

  describe('identifier front door (gh #50)', () => {
    const schutz = {
      id: 'https://openalex.org/A5022021627',
      external_id: 'https://orcid.org/0000-0001-9487-6983',
      display_name: 'B. F. Schutz',
      entity_type: 'author',
      cited_by_count: 114591,
      works_count: 680,
      hint: 'Leibniz University Hannover',
    } as const;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /**
     * Shapes that resolve today only by accident, or not at all, through autocomplete. Every
     * lookup here misses, so the requests show both readings: each shape goes to its by-ID
     * path(s), and only a bare OpenAlex ID — whose shape short names share — searches the query
     * as a name next. (gh #106) The last column opens the miss notice on both surfaces.
     */
    const ror = (id: string) =>
      ['institutions', 'funders', 'publishers'].map((type) => `/${type}/ror:${id}`);
    const rorMiss = 'No institution, funder, or publisher in OpenAlex for ROR';
    const identifiers: [label: string, query: string, requests: string[], missed: string][] = [
      [
        'bare ORCID',
        '0000-0001-9487-6983',
        ['/authors/orcid:0000-0001-9487-6983'],
        'No author in OpenAlex for ORCID',
      ],
      [
        'ORCID URL',
        'https://orcid.org/0000-0001-9487-6983',
        ['/authors/orcid:https://orcid.org/0000-0001-9487-6983'],
        'No author in OpenAlex for ORCID',
      ],
      [
        'bare DOI',
        '10.1038/nature12373',
        ['/works/doi:10.1038/nature12373'],
        'No work in OpenAlex for DOI',
      ],
      [
        'DOI URL',
        'https://doi.org/10.1038/nature12373',
        ['/works/doi:10.1038/nature12373'],
        'No work in OpenAlex for DOI',
      ],
      ['ROR URL', 'https://ror.org/013meh722', ror('https://ror.org/013meh722'), rorMiss],
      ['bare ROR', '013meh722', ror('013meh722'), rorMiss],
      [
        'funder DOI',
        '10.13039/100000001',
        ['/funders?filter=ids.doi%3A10.13039%2F100000001&per_page=1'],
        'No funder in OpenAlex for DOI',
      ],
      ['bare PMID', '23903748', ['/works/pmid:23903748'], 'No work in OpenAlex for PMID'],
      ['PMCID', 'PMC1234567', ['/works/pmcid:PMC1234567'], 'No work in OpenAlex for PMCID'],
      ['ISSN', '1234-5678', ['/sources/issn:1234-5678'], 'No source in OpenAlex for ISSN'],
      [
        'OpenAlex work ID',
        'W2159974629',
        ['/works/W2159974629', '/autocomplete?q=W2159974629'],
        'No work in OpenAlex for OpenAlex ID',
      ],
      [
        'OpenAlex funder ID',
        'F4320332161',
        ['/funders/F4320332161', '/autocomplete?q=F4320332161'],
        'No funder in OpenAlex for OpenAlex ID',
      ],
      [
        'OpenAlex ID URL',
        'https://openalex.org/I241749',
        ['/institutions/I241749'],
        'No institution in OpenAlex for OpenAlex ID',
      ],
    ];

    it.each(identifiers)(
      'looks a %s up by ID, searching it as a name only when it may be one',
      async (_label, query, expected, missed) => {
        const paths = new Set(expected.map((request) => request.split('?')[0]));
        const { requests } = await routeToRealService((url) => {
          if (!paths.has(url.pathname)) return;
          if (url.pathname === '/funders') return jsonResponse({ meta: { count: 0 }, results: [] });
          if (url.pathname === '/autocomplete') return jsonResponse({ results: [] });
          return new Response('<!doctype html><title>404</title>', { status: 404 });
        });

        const result = await runToolContract(resolveNameTool, { query });

        expect(result.isError).toBeFalsy();
        expect(requests()).toEqual(expected);
        const { results, notice } = result.structuredContent as AutocompleteResult & {
          notice?: string;
        };
        expect(results).toEqual([]);
        for (const surface of [notice ?? '', contentText(result)]) {
          expect(surface).toContain(`${missed} ${JSON.stringify(query)}`);
        }
      },
    );

    /**
     * The scheme is folded before the by-ID lookup runs, so an uppercase spelling reaches
     * upstream in the one casing it answers. A bare PubMed URL is an identifier too — it
     * used to read as an `https` scheme, find no entry, and fall through to a name search.
     */
    it.each([
      ['uppercase PMID scheme', 'PMID:21491125', 'works', 'pmid:21491125'],
      ['mixed-case DOI scheme', 'Doi:10.1038/nature12373', 'works', 'doi:10.1038/nature12373'],
      [
        'uppercase ORCID scheme',
        'ORCID:0000-0001-9487-6983',
        'authors',
        'orcid:0000-0001-9487-6983',
      ],
      ['PubMed URL', 'https://pubmed.ncbi.nlm.nih.gov/21491125', 'works', 'pmid:21491125'],
    ])(
      'routes a %s to the deterministic lookup (gh #66)',
      async (_label, query, entityType, id) => {
        mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
        const ctx = createMockContext();
        const input = resolveNameTool.input.parse({ query });

        await resolveNameTool.handler(input, ctx);

        expect(mockAutocomplete).not.toHaveBeenCalled();
        expect(mockResolveIdentifier).toHaveBeenCalledWith(
          expect.objectContaining({ entityTypes: [entityType], id }),
          ctx,
          undefined,
          query,
        );
      },
    );

    /**
     * Keywords are the one entity type OpenAlex addresses by slug, so the URL form is the
     * only spelling that names its own type. The bare slug stays a name query — nothing
     * distinguishes it from any other word — and autocomplete resolves it. (gh #68)
     */
    it('routes a keyword URL to the deterministic lookup (gh #68)', async () => {
      mockResolveIdentifier.mockResolvedValue({
        results: [
          {
            id: 'https://openalex.org/keywords/groundwater',
            external_id: null,
            display_name: 'Groundwater',
            entity_type: 'keyword',
            cited_by_count: 2504216,
            works_count: 141298,
            hint: null,
          },
        ],
      });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({
        query: 'https://openalex.org/keywords/groundwater',
      });

      const result = await resolveNameTool.handler(input, ctx);

      expect(mockAutocomplete).not.toHaveBeenCalled();
      expect(mockResolveIdentifier).toHaveBeenCalledWith(
        { entityTypes: ['keywords'], id: 'groundwater', scheme: 'openalex' },
        ctx,
        undefined,
        'https://openalex.org/keywords/groundwater',
      );
      expect(result.results[0]?.id).toBe('https://openalex.org/keywords/groundwater');
    });

    /**
     * OpenAlex record-page and API URLs carry the entity type in the path; each names one ID,
     * so each goes to the by-ID lookup as that bare ID instead of a name search — one request to
     * `/<type>/<id>`, whatever else the URL carried. (gh #99)
     */
    const urlRecords: Record<string, { id: string; display_name: string; entity: string }> = {
      '/works/W2741809807': {
        id: 'https://openalex.org/W2741809807',
        display_name: 'The state of OA',
        entity: 'work',
      },
      '/authors/A5023888391': {
        id: 'https://openalex.org/A5023888391',
        display_name: 'Jason Priem',
        entity: 'author',
      },
      '/keywords/groundwater': {
        id: 'https://openalex.org/keywords/groundwater',
        display_name: 'Groundwater',
        entity: 'keyword',
      },
    };

    it.each([
      ['https://openalex.org/works/W2741809807', '/works/W2741809807'],
      ['https://api.openalex.org/works/W2741809807', '/works/W2741809807'],
      ['https://api.openalex.org/W2741809807', '/works/W2741809807'],
      ['http://openalex.org/W2741809807', '/works/W2741809807'],
      ['openalex.org/works/W2741809807', '/works/W2741809807'],
      ['https://openalex.org/W2741809807/', '/works/W2741809807'],
      ['https://api.openalex.org/works/W2741809807?select=id', '/works/W2741809807'],
      ['https://openalex.org/authors/A5023888391', '/authors/A5023888391'],
      ['http://openalex.org/keywords/groundwater', '/keywords/groundwater'],
      ['https://api.openalex.org/keywords/groundwater', '/keywords/groundwater'],
    ])('looks the OpenAlex URL %s up at %s alone (gh #99)', async (query, path) => {
      const record = urlRecords[path];
      if (!record) throw new Error(`no record for ${path}`);
      const { requests } = await routeToRealService((url) =>
        url.pathname === path
          ? jsonResponse({ id: record.id, display_name: record.display_name })
          : undefined,
      );

      const result = await runToolContract(resolveNameTool, { query });

      expect(result.isError).toBeFalsy();
      expect(requests()).toEqual([path]);
      const { results, notice } = result.structuredContent as AutocompleteResult & {
        notice?: string;
      };
      expect(results).toMatchObject([
        { id: record.id, display_name: record.display_name, entity_type: record.entity },
      ]);
      expect(notice).toBeUndefined();
      expect(contentText(result)).toContain(`**${record.display_name}** (${record.entity})`);
      expect(contentText(result)).toContain(record.id);
    });

    it.each(['p53', 'w2741809807'])(
      'keeps the bare lowercase token %s a name query (gh #99)',
      async (query) => {
        const { requests } = await routeToRealService((url) =>
          url.pathname === '/autocomplete'
            ? jsonResponse({ results: sampleResults.results })
            : undefined,
        );

        const result = await runToolContract(resolveNameTool, { query });

        expect(result.isError).toBeFalsy();
        expect(requests()).toEqual([`/autocomplete?q=${query}`]);
        expect((result.structuredContent as AutocompleteResult).results).toEqual(
          sampleResults.results,
        );
        expect(contentText(result)).toContain('**Harvard University** (institution)');
      },
    );

    it('documents the OpenAlex URL forms query accepts (gh #99)', () => {
      const description = resolveNameTool.input.shape.query.description ?? '';
      expect(description).toContain('https://openalex.org/works/W2741809807');
    });

    it('sends a bare keyword slug to autocomplete (gh #68)', async () => {
      mockAutocomplete.mockResolvedValue(sampleResults);
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'groundwater' });

      await resolveNameTool.handler(input, ctx);

      expect(mockResolveIdentifier).not.toHaveBeenCalled();
      expect(mockAutocomplete).toHaveBeenCalled();
    });

    it('sends real names to autocomplete', async () => {
      mockAutocomplete.mockResolvedValue(sampleResults);
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'Albert Einstein' });

      await resolveNameTool.handler(input, ctx);

      expect(mockResolveIdentifier).not.toHaveBeenCalled();
      expect(mockAutocomplete).toHaveBeenCalled();
    });

    it('sends a name containing a colon to autocomplete, not the identifier path', async () => {
      // The scheme prefix is read off the first colon — a titled name must not look like one.
      mockAutocomplete.mockResolvedValue(sampleResults);
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'Nature: a weekly journal' });

      await resolveNameTool.handler(input, ctx);
      expect(mockResolveIdentifier).not.toHaveBeenCalled();
    });

    /**
     * A prefix named after an `Object.prototype` member is no identifier scheme. The scheme table
     * read inherited members, so these queries were routed to the by-ID lookup with a function
     * as their entity type instead of reaching autocomplete. (gh #93)
     */
    it.each(['Constructor: a theory', '__proto__: prototypes in practice'])(
      'sends %j to autocomplete through the tool contract (gh #93)',
      async (query) => {
        mockAutocomplete.mockResolvedValue(sampleResults);

        const result = await runToolContract(resolveNameTool, { query });

        expect(result.isError).toBeFalsy();
        expect(mockResolveIdentifier).not.toHaveBeenCalled();
        expect(mockAutocomplete).toHaveBeenCalledWith(
          expect.objectContaining({ query }),
          expect.anything(),
        );
        expect((result.structuredContent as AutocompleteResult).results.map((r) => r.id)).toEqual(
          sampleResults.results.map((r) => r.id),
        );
      },
    );

    it('sends camel-case prototype-member prefixes to autocomplete (gh #93)', async () => {
      // Characterization: the scheme is lower-cased before lookup, so these never named a member.
      mockAutocomplete.mockResolvedValue(sampleResults);
      for (const query of ['toString: a history', 'hasOwnProperty: ownership in law']) {
        const result = await runToolContract(resolveNameTool, { query });
        expect(result.isError).toBeFalsy();
      }
      expect(mockResolveIdentifier).not.toHaveBeenCalled();
      expect(mockAutocomplete).toHaveBeenCalledTimes(2);
    });

    it('resolves an identifier without entity_type', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: '0000-0001-9487-6983' });

      const result = await resolveNameTool.handler(input, ctx);
      expect(result.results[0]).toHaveProperty('id', 'https://openalex.org/A5022021627');
    });

    it('notices a conflicting entity_type rather than silently overriding it', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({
        entity_type: 'works',
        query: '0000-0001-9487-6983',
      });

      await resolveNameTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('entity_type="works"');
      expect(notice).toContain('ORCID');
      expect(notice).toContain('author');
    });

    it('notices filters, which the identifier path cannot apply', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({
        query: '10.1038/nature12373',
        filters: { publication_year: '2020' },
      });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toContain('filters');
    });

    it('stays silent when the identifier query carries nothing extra', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'W2159974629' });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('returns an empty result with an identifier-specific notice on a miss', async () => {
      // Not "try a shorter name" — an identifier is not a name, and shortening it is
      // never the fix.
      mockResolveIdentifier.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: '10.1038/thisdoesnotexist999999' });

      const result = await resolveNameTool.handler(input, ctx);

      expect(result.results).toHaveLength(0);
      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('DOI');
      expect(notice).not.toMatch(/shorter name/i);
    });

    it('keeps the name-miss notice unchanged', async () => {
      mockAutocomplete.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'xyzzy_nonexistent_entity_abc' });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toMatch(/shorter name/i);
    });
  });

  /**
   * One ROR can name an institution, a funder, and a publisher record at once, and funders are
   * keyed by Crossref Funder Registry DOIs. These run the real `resolveIdentifier` against a
   * routed `fetch`: only the listed `api.openalex.org` paths answer, the `missing` ones 404, and
   * anything else rejects. Upstream values are the ones OpenAlex returned on 2026-10-17. (gh #98)
   */
  describe('RORs and funder DOIs (gh #98)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const nsfFunder = {
      id: 'https://openalex.org/F4320306076',
      display_name: 'National Science Foundation',
      works_count: 543210,
      cited_by_count: 9876543,
      country_code: 'US',
    };
    const records: Record<string, unknown> = {
      '/institutions/ror:021nxhr62': {
        id: 'https://openalex.org/I1311060795',
        display_name: 'U.S. National Science Foundation',
        ror: 'https://ror.org/021nxhr62',
        country_code: 'US',
        works_count: 12204,
        cited_by_count: 412345,
      },
      '/funders/ror:021nxhr62': nsfFunder,
      '/funders/ror:https://ror.org/021nxhr62': nsfFunder,
      '/publishers/ror:021nxhr62': {
        id: 'https://openalex.org/P4365365866',
        display_name: 'National Science Foundation',
        works_count: 120,
        cited_by_count: 3456,
      },
      '/publishers/ror:https://ror.org/02scfj030': {
        id: 'https://openalex.org/P4310320990',
        display_name: 'Elsevier BV',
        works_count: 23456789,
        cited_by_count: 345678901,
      },
      '/institutions/ror:04dzdm737': {
        id: 'https://openalex.org/I1327191685',
        display_name: 'deCODE Genetics (Iceland)',
        ror: 'https://ror.org/04dzdm737',
        country_code: 'IS',
        works_count: 2345,
        cited_by_count: 456789,
      },
      '/works/doi:10.13039/100000001': {
        id: 'https://openalex.org/W775343536',
        display_name: 'Myxomycetes collected in the first phase of a North-South transect of Chile',
        doi: 'https://doi.org/10.13039/100000001',
        cited_by_count: 3,
        publication_year: 2008,
      },
    };
    const missing = new Set([
      '/funders/ror:04dzdm737',
      '/publishers/ror:04dzdm737',
      '/institutions/ror:0zzzzzz99',
      '/funders/ror:0zzzzzz99',
      '/publishers/ror:0zzzzzz99',
      // The line break and `#` stay in the ID, percent-encoded, rather than ending the path. (gh #109)
      ...['institutions', 'funders', 'publishers'].map(
        (type) => `/${type}/ror:https://ror.org/0zzzzzz99%0A%23%20Injected`,
      ),
    ]);

    /** Route `mockResolveIdentifier` to the real service over the routed `fetch`. */
    async function useRealService(failing: Record<string, number> = {}) {
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        const path = url.pathname;
        if (url.hostname !== 'api.openalex.org') {
          return Promise.reject(new Error(`unmocked fetch: ${url.href}`));
        }
        const json = (body: unknown, status = 200) =>
          Promise.resolve(new Response(JSON.stringify(body), { status }));
        if (failing[path] !== undefined) return json({ error: 'Forbidden' }, failing[path]);
        if (path in records) return json(records[path]);
        if (missing.has(path)) {
          return Promise.resolve(
            new Response('<!doctype html><title>404</title>', { status: 404 }),
          );
        }
        if (path === '/funders') {
          const hit = url.searchParams.get('filter') === 'ids.doi:10.13039/100000001';
          return json({
            meta: { count: hit ? 1 : 0, per_page: 1, next_cursor: null },
            results: hit ? [nsfFunder] : [],
          });
        }
        return Promise.reject(new Error(`unmocked fetch: ${path}`));
      });
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockResolveIdentifier.mockImplementation((...args: unknown[]) =>
        service.resolveIdentifier(...(args as Parameters<typeof service.resolveIdentifier>)),
      );
      return fetchMock;
    }

    async function call(args: { query: string; entity_type?: AutocompleteEntityType }) {
      const result = await runToolContract(resolveNameTool, args);
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as AutocompleteResult & { notice?: string };
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return { ids: structured.results.map((r) => r.id), notice: structured.notice, text };
    }

    it('returns the institution, funder, and publisher a ROR names, in that order', async () => {
      const fetchMock = await useRealService();

      const { ids, notice, text } = await call({ query: '021nxhr62' });

      expect(ids).toEqual([
        'https://openalex.org/I1311060795',
        'https://openalex.org/F4320306076',
        'https://openalex.org/P4365365866',
      ]);
      expect(notice).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const id of ids) expect(text).toContain(id);
      expect(text.indexOf('(institution)')).toBeLessThan(text.indexOf('(funder)'));
      expect(text.indexOf('(funder)')).toBeLessThan(text.indexOf('(publisher)'));
    });

    it.each([
      ['funders', 'https://ror.org/021nxhr62', 'https://openalex.org/F4320306076'],
      ['publishers', 'https://ror.org/02scfj030', 'https://openalex.org/P4310320990'],
      ['institutions', '021nxhr62', 'https://openalex.org/I1311060795'],
    ])(
      'returns only the %s record a ROR names under that entity_type',
      async (entityType, query, id) => {
        const fetchMock = await useRealService();

        const { ids, notice } = await call({
          query,
          entity_type: entityType as AutocompleteEntityType,
        });

        expect(ids).toEqual([id]);
        expect(notice).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it('returns the one record a ROR holds when the other types have none', async () => {
      await useRealService();
      const { ids, notice } = await call({ query: '04dzdm737' });
      expect(ids).toEqual(['https://openalex.org/I1327191685']);
      expect(notice).toBeUndefined();
    });

    it('names funders and suggests omitting entity_type when that ROR type is missing', async () => {
      await useRealService();

      const { ids, notice, text } = await call({ query: '04dzdm737', entity_type: 'funders' });

      expect(ids).toEqual([]);
      expect(notice).toBe(
        'No funder in OpenAlex for ROR "04dzdm737" under entity_type="funders". One ROR can name an institution, a funder, and a publisher — omit entity_type to look up all three.',
      );
      expect(text).toContain(notice);
    });

    it('gives a ROR no type has a record for the identifier-miss notice', async () => {
      await useRealService();

      const { ids, notice, text } = await call({ query: '0zzzzzz99' });

      expect(ids).toEqual([]);
      expect(notice).toBe(
        'No institution, funder, or publisher in OpenAlex for ROR "0zzzzzz99". An identifier either resolves or does not — check it for a typo, or search for the entity by name instead.',
      );
      expect(text).toContain(notice);
    });

    it('looks a ROR up as all three types under another entity_type, and says so', async () => {
      await useRealService();

      const { ids, notice, text } = await call({ query: '021nxhr62', entity_type: 'works' });

      expect(ids).toEqual([
        'https://openalex.org/I1311060795',
        'https://openalex.org/F4320306076',
        'https://openalex.org/P4365365866',
      ]);
      expect(notice).toBe(
        'Resolved "021nxhr62" by ROR — it identifies an institution, a funder, or a publisher directly, so entity_type="works" did not apply.',
      );
      expect(text).toContain(notice);
    });

    it('keeps the records that resolved when one type fails, and names the failed type', async () => {
      await useRealService({ '/funders/ror:021nxhr62': 403 });

      const { ids, notice, text } = await call({ query: '021nxhr62' });

      expect(ids).toEqual(['https://openalex.org/I1311060795', 'https://openalex.org/P4365365866']);
      expect(notice).toMatch(/funder lookup failed/);
      expect(text).toMatch(/funder lookup failed/);
    });

    it.each([
      ['10.13039/100000001', undefined],
      ['doi:10.13039/100000001', 'funders'],
      ['https://doi.org/10.13039/100000001', 'funders'],
      ['10.13039/100000001', 'institutions'],
    ])('resolves the funder DOI %s (entity_type %s) to the funder', async (query, entityType) => {
      const fetchMock = await useRealService();

      const { ids } = await call({
        query,
        ...(entityType ? { entity_type: entityType as AutocompleteEntityType } : {}),
      });

      expect(ids).toEqual(['https://openalex.org/F4320306076']);
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.pathname).toBe('/funders');
      expect(url.searchParams.get('filter')).toBe('ids.doi:10.13039/100000001');
    });

    it('notices an entity_type a funder DOI does not apply to', async () => {
      await useRealService();
      const { ids, notice, text } = await call({
        query: '10.13039/100000001',
        entity_type: 'authors',
      });
      expect(ids).toEqual(['https://openalex.org/F4320306076']);
      expect(notice).toBe(
        'Resolved "10.13039/100000001" by DOI — it identifies one funder directly, so entity_type="authors" did not apply.',
      );
      expect(text).toContain(notice);
    });

    it('points a funder DOI no funder carries at entity_type works, on both surfaces', async () => {
      await useRealService();

      const { ids, notice, text } = await call({ query: '10.13039/999999999' });

      expect(ids).toEqual([]);
      expect(notice).toContain('No funder in OpenAlex for DOI "10.13039/999999999"');
      expect(notice).toContain('entity_type="works"');
      expect(text).toContain('entity_type="works"');
    });

    it('keeps a funder DOI reachable as a work under entity_type works', async () => {
      await useRealService();
      const { ids, notice } = await call({ query: '10.13039/100000001', entity_type: 'works' });
      expect(ids).toEqual(['https://openalex.org/W775343536']);
      expect(notice).toBeUndefined();
    });

    it('JSON-encodes the echoed query so a line break cannot start a heading', async () => {
      await useRealService();

      const { notice, text } = await call({ query: 'https://ror.org/0zzzzzz99\n# Injected' });

      expect(notice).toContain('"https://ror.org/0zzzzzz99\\n# Injected"');
      expect(text.split('\n').some((line) => line.trimStart().startsWith('# Injected'))).toBe(
        false,
      );
    });

    it('fails an identifier with a .. segment as id_dot_segment before any request (gh #109)', async () => {
      const fetchMock = await useRealService();

      const result = await runToolContract(resolveNameTool, {
        query: 'doi:10.1000/../../authors/A5023888391',
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
    });

    it('quotes a refused identifier as the caller wrote it, on both surfaces', async () => {
      const fetchMock = await useRealService();
      const query = 'https://doi.org/10.1000/../../authors/A5023888391';

      const result = await runToolContract(resolveNameTool, { query });

      expect(fetchMock).not.toHaveBeenCalled();
      const quoted = `id ${JSON.stringify(query)} holds`;
      expect(result.structuredContent).toMatchObject({
        error: {
          message: expect.stringContaining(quoted),
          data: { reason: 'id_dot_segment', id: query },
        },
      });
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain(quoted);
      expect(text).not.toContain('doi:10.1000');
    });

    it('describes when entity_type applies to an identifier', () => {
      expect(resolveNameTool.description).not.toMatch(/needs no entity_type/);
      expect(resolveNameTool.description).toMatch(/ROR/);
      const entityType = resolveNameTool.input.shape.entity_type.description ?? '';
      expect(entityType).not.toMatch(/an identifier determines its own entity type/);
      expect(entityType).toMatch(/ROR/);
      expect(entityType).toMatch(/10\.13039/);
    });
  });

  /**
   * A bare native OpenAlex ID shape (`^[AFIPSTW]\d+$`) is also the shape of short names — keyword
   * `p53`, `F1`, `S1`. These run the real service against a routed `fetch`: only the listed
   * `api.openalex.org` paths answer (a `/<type>/<ID>` path not listed 404s), and any other host
   * rejects. Autocomplete bodies are the ones OpenAlex returned on 2026-10-17. (gh #106)
   */
  describe('short names shaped like OpenAlex IDs (gh #106)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const p53Keyword = {
      id: 'https://openalex.org/keywords/p53',
      short_id: 'keywords/p53',
      display_name: 'p53',
      hint: 'A tumor-suppressor protein that regulates cellular responses to DNA damage and is studied in cancer biology and molecular genetics.',
      cited_by_count: 3606453,
      works_count: 116388,
      entity_type: 'keyword',
      external_id: null,
      filter_key: 'keywords.id',
    };
    const tp53Keyword = {
      id: 'https://openalex.org/keywords/tp53',
      short_id: 'keywords/tp53',
      display_name: 'TP53',
      hint: 'P53',
      cited_by_count: 520285,
      works_count: 24860,
      entity_type: 'keyword',
      external_id: null,
      filter_key: 'keywords.id',
    };
    const p53Work = {
      id: 'https://openalex.org/W1990130549',
      display_name: 'p53, the cellular gatekeeper for growth and division',
      entity_type: 'work',
      external_id: 'https://doi.org/10.1016/s0092-8674(00)81871-1',
      cited_by_count: 7000,
      works_count: null,
      hint: 'Arnold J. Levine',
    };
    const byId: Record<string, unknown> = {
      '/works/W2741809807': {
        id: 'https://openalex.org/W2741809807',
        display_name: 'The state of OA',
        doi: 'https://doi.org/10.7717/peerj.4375',
        cited_by_count: 1200,
        publication_year: 2018,
      },
      '/institutions/I241749': {
        id: 'https://openalex.org/I241749',
        display_name: 'University of Cambridge',
        ror: 'https://ror.org/013meh722',
        country_code: 'GB',
        works_count: 508356,
        cited_by_count: 62040570,
      },
      '/topics/T10159': {
        id: 'https://openalex.org/T10159',
        display_name: 'Groundwater flow and contamination studies',
        works_count: 98765,
        cited_by_count: 1234567,
      },
      '/works/doi:10.7717/peerj.4375': {
        id: 'https://openalex.org/W2741809807',
        display_name: 'The state of OA',
        doi: 'https://doi.org/10.7717/peerj.4375',
        cited_by_count: 1200,
        publication_year: 2018,
      },
    };
    /** `/autocomplete…` path → q → results; a query not listed answers with no results. */
    const autocomplete: Record<string, Record<string, unknown[]>> = {
      '/autocomplete': {},
      '/autocomplete/keywords': { P53: [p53Keyword, tp53Keyword] },
      '/autocomplete/works': { P53: [p53Work] },
      '/autocomplete/publishers': {},
    };

    /** Route both service methods to the real service over a routed `fetch`. */
    async function useRealService(failing: Record<string, number> = {}) {
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        const path = url.pathname;
        if (url.hostname !== 'api.openalex.org') {
          return Promise.reject(new Error(`unmocked fetch: ${url.href}`));
        }
        const json = (body: unknown, status = 200) =>
          Promise.resolve(new Response(JSON.stringify(body), { status }));
        if (failing[path] !== undefined) {
          return json({ error: 'Upstream failure', message: 'Upstream failure' }, failing[path]);
        }
        if (path in byId) return json(byId[path]);
        const matches = autocomplete[path];
        if (matches) {
          const results = matches[url.searchParams.get('q') ?? ''] ?? [];
          return json({ meta: { count: results.length, per_page: 10 }, results });
        }
        if (
          /^\/(?:works|authors|sources|institutions|topics|publishers|funders)\/[^/]+$/.test(path)
        ) {
          return Promise.resolve(
            new Response('<!doctype html><title>404</title>', { status: 404 }),
          );
        }
        return Promise.reject(new Error(`unmocked fetch: ${path}`));
      });
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockResolveIdentifier.mockImplementation((...args: unknown[]) =>
        service.resolveIdentifier(...(args as Parameters<typeof service.resolveIdentifier>)),
      );
      mockAutocomplete.mockImplementation((...args: unknown[]) =>
        service.autocomplete(...(args as Parameters<typeof service.autocomplete>)),
      );
      /** Each request as `<path>?<params>`, in order — the credential and `select` params dropped. */
      const requests = () =>
        fetchMock.mock.calls.map(([input]) => {
          const url = new URL(String(input));
          for (const param of ['api_key', 'mailto', 'select']) url.searchParams.delete(param);
          return `${url.pathname}${url.search}`;
        });
      return { fetchMock, requests };
    }

    async function call(args: {
      query: string;
      entity_type?: AutocompleteEntityType;
      filters?: Record<string, string>;
    }) {
      const result = await runToolContract(resolveNameTool, args);
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as AutocompleteResult & { notice?: string };
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return { ids: structured.results.map((r) => r.id), notice: structured.notice, text };
    }

    it('searches a native-ID-shaped query as a keyword name under entity_type keywords', async () => {
      const { requests } = await useRealService();

      const { ids, notice, text } = await call({ query: 'P53', entity_type: 'keywords' });

      expect(ids).toEqual([
        'https://openalex.org/keywords/p53',
        'https://openalex.org/keywords/tp53',
      ]);
      expect(requests()).toEqual(['/autocomplete/keywords?q=P53']);
      expect(notice).toBeUndefined();
      expect(text).toContain('**p53** (keyword)');
    });

    it('runs the name search after the ID misses, and names both outcomes', async () => {
      const { requests } = await useRealService();

      const { ids, notice, text } = await call({ query: 'P53' });

      expect(ids).toEqual([]);
      expect(requests()).toEqual(['/publishers/P53', '/autocomplete?q=P53']);
      for (const surface of [notice ?? '', text]) {
        expect(surface).toContain('No publisher in OpenAlex for OpenAlex ID "P53"');
        expect(surface).toMatch(/as a name it matched nothing across all entity types/);
        expect(surface).toMatch(/pass entity_type to search one type/);
        expect(surface).not.toMatch(/check it for a typo/);
      }
    });

    it('returns the name matches the fallback finds under the caller entity_type', async () => {
      const { requests } = await useRealService();

      const { ids, notice, text } = await call({ query: 'P53', entity_type: 'works' });

      expect(ids).toEqual(['https://openalex.org/W1990130549']);
      expect(requests()).toEqual(['/publishers/P53', '/autocomplete/works?q=P53']);
      expect(notice).toBe(
        'No publisher in OpenAlex for OpenAlex ID "P53", so it was searched as a name among works instead.',
      );
      expect(text).toContain('**p53, the cellular gatekeeper for growth and division** (work)');
      expect(text).not.toMatch(/did not apply/);
    });

    it('applies filters to the fallback name search when entity_type is set', async () => {
      const { requests } = await useRealService();

      const { notice, text } = await call({
        query: 'P53',
        entity_type: 'publishers',
        filters: { country_codes: 'US' },
      });

      expect(requests()).toEqual([
        '/publishers/P53',
        '/autocomplete/publishers?q=P53&filter=country_codes%3AUS',
      ]);
      expect(notice).toContain(
        'as a name it matched nothing among publishers with filters={"country_codes":"US"}',
      );
      expect(notice).toMatch(/Loosen or drop filters/);
      expect(notice).not.toMatch(/omit entity_type/);
      expect(text).toContain(notice);
    });

    it('runs no name search when filters come without entity_type, and says how to run one', async () => {
      const { requests } = await useRealService();

      const { ids, notice, text } = await call({ query: 'P53', filters: { country_codes: 'US' } });

      expect(ids).toEqual([]);
      expect(requests()).toEqual(['/publishers/P53']);
      for (const surface of [notice ?? '', text]) {
        expect(surface).toContain('No publisher in OpenAlex for OpenAlex ID "P53"');
        expect(surface).toMatch(
          /pass entity_type to search one type by name with these filters, or drop filters/,
        );
      }
    });

    it('discloses a name search that failed upstream instead of hiding it', async () => {
      vi.useFakeTimers();
      try {
        const { requests } = await useRealService({ '/autocomplete/works': 503 });

        const pending = call({ query: 'P53', entity_type: 'works' });
        await vi.runAllTimersAsync();
        const { ids, notice, text } = await pending;

        expect(ids).toEqual([]);
        // One by-ID miss, then three attempts at the name search before it gives up.
        expect(requests()).toHaveLength(4);
        for (const surface of [notice ?? '', text]) {
          expect(surface).toContain('No publisher in OpenAlex for OpenAlex ID "P53"');
          expect(surface).toMatch(
            /name search it fell back to failed upstream \(reason upstream_unavailable\)/,
          );
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails the call when the fallback name search is rejected as a caller error', async () => {
      const { requests } = await useRealService({ '/autocomplete/works': 400 });

      const result = await runToolContract(resolveNameTool, {
        query: 'P53',
        entity_type: 'works',
        filters: { bogus_field: 'x' },
      });

      expect(result.isError).toBe(true);
      // The 400 is the caller's to fix, so it is neither retried nor folded into a notice.
      expect(requests()).toEqual([
        '/publishers/P53',
        '/autocomplete/works?q=P53&filter=bogus_field%3Ax',
      ]);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'upstream_invalid_params_other' },
        },
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(contentText(result)).toContain('(reason upstream_invalid_params_other');
    });

    it.each([
      ['W2741809807', '/works/W2741809807', 'https://openalex.org/W2741809807'],
      ['I241749', '/institutions/I241749', 'https://openalex.org/I241749'],
      ['T10159', '/topics/T10159', 'https://openalex.org/T10159'],
      ['10.7717/peerj.4375', '/works/doi:10.7717/peerj.4375', 'https://openalex.org/W2741809807'],
    ])('resolves %s by ID with one request and no name search', async (query, path, id) => {
      const { requests } = await useRealService();

      const { ids, notice } = await call({ query });

      expect(ids).toEqual([id]);
      expect(notice).toBeUndefined();
      expect(requests()).toEqual([path]);
    });

    it('documents that a bare ID shape which resolves nothing is searched as a name', () => {
      const query = resolveNameTool.input.shape.query.description ?? '';
      expect(query).toMatch(/P53/);
      expect(query).toMatch(/searched as a name/);
      const entityType = resolveNameTool.input.shape.entity_type.description ?? '';
      expect(entityType).toMatch(/keywords/);
      expect(resolveNameTool.description).toMatch(/searched as a name/);
    });
  });

  /**
   * A PMCID is still recognized and still forwarded, but OpenAlex indexes none, so it can only
   * come back empty. The generic identifier-miss notice ("check it for a typo") is the wrong
   * advice there — nothing about the identifier is wrong — so the PMCID case carries the
   * conversion guidance instead, on both client surfaces.
   */
  describe('PMCID queries (gh #67)', () => {
    const pmcQueries: [label: string, query: string][] = [
      ['a bare PMCID', 'PMC3084216'],
      ['a PMC URL', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/'],
      ['a legacy PMC URL', 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/'],
    ];

    it.each(pmcQueries)(
      'routes %s to the deterministic lookup as pmcid:PMC…',
      async (_label, query) => {
        mockResolveIdentifier.mockResolvedValue({ results: [] });
        const ctx = createMockContext();
        const input = resolveNameTool.input.parse({ query });

        await resolveNameTool.handler(input, ctx);

        expect(mockAutocomplete).not.toHaveBeenCalled();
        expect(mockResolveIdentifier).toHaveBeenCalledWith(
          expect.objectContaining({
            entityTypes: ['works'],
            id: 'pmcid:PMC3084216',
            scheme: 'pmcid',
          }),
          ctx,
          undefined,
          query,
        );
      },
    );

    it.each(pmcQueries)(
      'carries the conversion guidance on both client surfaces for %s',
      async (_label, query) => {
        mockResolveIdentifier.mockResolvedValue({ results: [] });

        const result = await runToolContract(resolveNameTool, { query });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          notice: expect.stringContaining('OpenAlex indexes no PMCIDs'),
        });
        const rendered = (result.content ?? [])
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n');
        expect(rendered).toContain('OpenAlex indexes no PMCIDs');
        expect(rendered).toContain('PMID');
        expect(rendered).toContain('https://www.ncbi.nlm.nih.gov/pmc/tools/idconv/');
        expect(rendered).not.toMatch(/check it for a typo/i);
      },
    );

    it('leaves the generic identifier-miss notice on every other scheme', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: '10.1038/thisdoesnotexist999999' });

      await resolveNameTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toMatch(/check it for a typo/i);
      expect(notice).not.toMatch(/PMCID/i);
    });

    it('no longer advertises PMCID as an identifier that resolves', () => {
      expect(resolveNameTool.description).toMatch(/OpenAlex indexes no PMCIDs/i);
      expect(resolveNameTool.description).toMatch(/PMID or DOI/i);

      const queryDescription = resolveNameTool.input.shape.query.description ?? '';
      expect(queryDescription).toMatch(/OpenAlex indexes no PMCIDs/i);
      expect(queryDescription).toMatch(/PMID or DOI/i);
    });
  });

  /**
   * The filter path is shared by every filter-taking tool; this proves the tool reaches it with
   * the caller's filters and that the autocomplete request carries what the service built, as
   * sent. The value table itself lives in the service suite.
   */
  describe('filters on the wire through the real service (gh #107, #101)', () => {
    it.each(['title.search', 'abstract.search.exact', 'type'])(
      'rejects an unmatched quote on %s before any request',
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
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        return url.hostname === 'api.openalex.org' && url.pathname === '/autocomplete/works'
          ? Promise.resolve(new Response(JSON.stringify({ results: [] })))
          : Promise.reject(new Error(`unmocked fetch: ${url.href}`));
      });
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<
        typeof import('@/services/openalex/openalex-service.js')
      >('@/services/openalex/openalex-service.js');
      actual.initOpenAlexService();
      const service = actual.getOpenAlexService();
      mockAutocomplete.mockImplementation((...args: unknown[]) =>
        service.autocomplete(...(args as Parameters<typeof service.autocomplete>)),
      );

      const result = await runToolContract(resolveNameTool, {
        entity_type: 'works',
        query: 'groundwater recharge',
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
      expect(sentFilter()).toBe('filter=authorships.institutions.country_code%3ADE+US');
    });

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
      const { notice } = result.structuredContent as { notice: string };
      expect(notice).toContain(JSON.stringify(filters));
      expect(textOf(result)).toContain(JSON.stringify(filters));
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
      expect(textOf(result)).toContain('"Narnia" is not a country code');
      expect(textOf(result)).toContain('invalid_country_code');
    });

    it('declares invalid_country_code as a service-thrown ValidationError', () => {
      const entry = resolveNameTool.errors?.find((e) => e.reason === 'invalid_country_code');
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
      expect(renderedText(textOf(result))).toContain('mixes "|" (OR) with an AND operator');
      expect(renderedText(textOf(result))).toContain('mixed_and_or_in_filter_value');
    });

    it('declares mixed_and_or_in_filter_value as a service-thrown ValidationError', () => {
      const entry = resolveNameTool.errors?.find(
        (e) => e.reason === 'mixed_and_or_in_filter_value',
      );
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });

    it('declares quote_in_filter_value as a service-thrown ValidationError', () => {
      const entry = resolveNameTool.errors?.find((e) => e.reason === 'quote_in_filter_value');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, thrownBy: 'service' });
    });
  });

  /**
   * A notice is authored Markdown: the framework quotes it into `content[]` and escapes nothing,
   * so every caller value a notice repeats is escaped in the handler. Both surfaces carry the
   * same string, the caller's text reads back exactly as sent, and authored code spans stay
   * live. (gh #127)
   */
  describe('caller text in notices (gh #127)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** The trailer's `>` lines, and the string they quote with the markers stripped. */
    const quotedNotice = (text: string) => {
      const lines = text.split('\n').filter((line) => line.startsWith('>'));
      return {
        markdown: lines.join('\n'),
        quoted: lines.map((line) => line.replace(/^> ?/, '')).join('\n'),
      };
    };

    /** Run `args`, then check the notice against `expected`, the text a reader must see. */
    async function expectNoticeReadsBack(
      args: { query: string } & Record<string, unknown>,
      expected: string,
      allowed: readonly string[] = [],
    ) {
      const result = await runToolContract(resolveNameTool, args as { query: string });
      expect(result.isError).toBeFalsy();
      const { notice } = result.structuredContent as { notice?: string };
      const { markdown, quoted } = quotedNotice(contentText(result));
      expect(quoted).toBe(notice);
      const markup = ['emphasis', 'strong', 'delete', 'html', 'inlineCode'].filter(
        (type) => !allowed.includes(type),
      );
      expect(nodeTypes(markdown).filter((t) => markup.includes(t))).toEqual([]);
      expect(nonAutolinks(markdown)).toEqual([]);
      expect(renderedText(markdown)).toBe(expected);
      return result;
    }

    const hostile = 'zqxjkvwq [x](https://evil.test) _emph_ <b>tag</b>';
    const filters = { 'display_name.search': '<i>a</i> *b* `c` ~d~' };
    const filtersEcho = '{"display_name.search":"<i>a</i> *b* `c` ~d~"}';
    const ror = 'https://ror.org/02jbv0t02 [x](https://evil.test) _emph_';

    it.each([
      [
        'a name miss',
        { query: hostile, entity_type: 'institutions', filters },
        { autocomplete: { results: [] } },
        `No matches for "${hostile}" among institutions with filters=${filtersEcho}. Loosen or drop filters first — they may exclude the match — then try a shorter name or alternate spelling.`,
      ],
      [
        'an identifier miss',
        { query: '10.9999/zq[x](https://evil.test)_emph_<b>t</b>' },
        { identifier: { results: [] } },
        'No work in OpenAlex for DOI "10.9999/zq[x](https://evil.test)_emph_<b>t</b>". An identifier either resolves or does not — check it for a typo, or search for the entity by name instead.',
      ],
      [
        'an identifier miss holding a URL',
        { query: 'https://doi.org/10.1002/a_b*c~d' },
        { identifier: { results: [] } },
        'No work in OpenAlex for DOI "https://doi.org/10.1002/a_b*c~d". An identifier either resolves or does not — check it for a typo, or search for the entity by name instead.',
      ],
      [
        'a bare-ID miss searched as a name under filters',
        { query: 'S999999999', entity_type: 'sources', filters },
        { identifier: { results: [], nameFallback: {} } },
        `No source in OpenAlex for OpenAlex ID "S999999999", and as a name it matched nothing among sources with filters=${filtersEcho}. Loosen or drop filters first — they may exclude the match — then try a shorter name or alternate spelling.`,
      ],
      [
        'the "Resolved … by" notice',
        { query: ror, filters: { country_code: 'US' } },
        { identifier: { results: [harvard] } },
        `Resolved "${ror}" by ROR — it identifies an institution, a funder, or a publisher directly, so filters did not apply.`,
      ],
      [
        'failed ROR lookups',
        { query: ror },
        { identifier: { results: [harvard], failedEntityTypes: ['funders', 'publishers'] } },
        `The funder and publisher lookups failed upstream, so any funder or publisher record for ROR "${ror}" is missing from these results — call again to complete them.`,
      ],
    ] as const)(
      'reads the caller text back as sent in %s',
      async (_label, args, reply, expected) => {
        // The table is `as const`, so its read-only reply is cast to the mutable result type.
        if ('autocomplete' in reply) {
          mockAutocomplete.mockResolvedValue(reply.autocomplete as unknown as AutocompleteResult);
        } else {
          mockResolveIdentifier.mockResolvedValue(
            reply.identifier as unknown as AutocompleteResult,
          );
        }

        await expectNoticeReadsBack(args, expected);
      },
    );

    /**
     * Awards have no autocomplete, and an award record carries none of the activity stats a
     * match reports, so an award ID or URL is never looked up — no request, no result, and a
     * notice naming the `openalex_search_entities` call that opens it. (gh #125)
     */
    describe('award IDs (gh #125)', () => {
      const openAward = 'openalex_search_entities {"entity_type":"awards","id":"G417894356"}';
      const g3Source = {
        id: 'https://openalex.org/S4210186826',
        external_id: 'https://portal.issn.org/resource/ISSN/2160-1836',
        display_name: 'G3 Genes Genomes Genetics',
        entity_type: 'source',
        cited_by_count: 120000,
        works_count: 4800,
        hint: 'Oxford University Press',
      };

      it.each([
        [{ query: 'G417894356' }],
        [{ query: 'https://openalex.org/G417894356' }],
        [{ query: 'https://openalex.org/awards/G417894356' }],
        [{ query: 'https://api.openalex.org/awards/G417894356' }],
        [{ query: 'https://openalex.org/awards/G417894356', entity_type: 'works' }],
        [{ query: 'G417894356', filters: { 'funder.id': 'F4320306076' } }],
      ] as const)(
        'sends no request for %o and points at openalex_search_entities',
        async (args) => {
          const { requests } = await routeToRealService(() => undefined);

          const result = await expectNoticeReadsBack(
            args,
            `"${args.query}" is an OpenAlex award ID; this tool resolves no awards — OpenAlex has no award autocomplete — so nothing was looked up. Open the award with ${openAward}; to find an award by title or grant number instead, call it with entity_type "awards" and a query or the funder_award_id filter, narrowed by funder.id.`,
            ['inlineCode'],
          );

          expect(requests()).toEqual([]);
          expect((result.structuredContent as AutocompleteResult).results).toEqual([]);
          expect(contentText(result)).toContain('No matches found.');
        },
      );

      it('keeps the authored call a code span, so it copies without escapes', async () => {
        await routeToRealService(() => undefined);
        const result = await runToolContract(resolveNameTool, { query: 'G417894356' });
        expect(contentText(result)).toContain(
          '`openalex_search_entities` `{"entity_type":"awards","id":"G417894356"}`',
        );
      });

      it('searches a bare G… shape under entity_type as a name of that type ("G3" is a journal)', async () => {
        const { requests } = await routeToRealService((url) =>
          url.pathname === '/autocomplete/sources' && url.searchParams.get('q') === 'G3'
            ? jsonResponse({ results: [g3Source] })
            : undefined,
        );

        const result = await runToolContract(resolveNameTool, {
          query: 'G3',
          entity_type: 'sources',
        });

        expect(result.isError).toBeFalsy();
        expect(requests()).toEqual(['/autocomplete/sources?q=G3']);
        const structured = result.structuredContent as AutocompleteResult & { notice?: string };
        expect(structured.results).toEqual([g3Source]);
        expect(structured.notice).toBeUndefined();
        expect(contentText(result)).toContain('**G3 Genes Genomes Genetics** (source)');
      });

      it('adds the award pointer when that name search misses', async () => {
        const { requests } = await routeToRealService((url) =>
          url.pathname === '/autocomplete/funders' ? jsonResponse({ results: [] }) : undefined,
        );

        await expectNoticeReadsBack(
          { query: 'G417894356', entity_type: 'funders' },
          `No matches for "G417894356" among funders. Try a shorter name, alternate spelling, or omit entity_type to search across all types. "G417894356" is also shaped like an OpenAlex award ID — open the award with ${openAward}.`,
          ['inlineCode'],
        );
        expect(requests()).toEqual(['/autocomplete/funders?q=G417894356']);
      });

      it('takes only the eight autocomplete entity types', () => {
        expect(
          resolveNameTool.input.safeParse({ query: 'groundwater', entity_type: 'awards' }).success,
        ).toBe(false);
        expect(z.toJSONSchema(resolveNameTool.input).properties?.entity_type).toMatchObject({
          enum: [
            'works',
            'authors',
            'sources',
            'institutions',
            'topics',
            'keywords',
            'publishers',
            'funders',
          ],
        });
      });
    });
  });

  describe('format', () => {
    const text = (result: AutocompleteResult) => {
      const blocks = resolveNameTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    it('formats results with hints', () => {
      const output = text(sampleResults);
      expect(output).toContain('Harvard University');
      expect(output).toContain('Cambridge, Massachusetts, USA');
    });

    it('formats results without hints', () => {
      const output = text({ results: [{ ...harvard, hint: null }] });
      expect(output).not.toContain('[');
    });

    it('returns "No matches" for empty results', () => {
      expect(text({ results: [] })).toBe('No matches found.');
    });

    it('prints no works count for a work, which carries none', () => {
      const output = text({
        results: [
          {
            id: 'https://openalex.org/W2741809807',
            display_name: 'The state of OA',
            entity_type: 'work',
            external_id: 'https://doi.org/10.7717/peerj.4375',
            cited_by_count: 1234,
            works_count: null,
            hint: 'Heather Piwowar, Jason Priem',
          },
        ],
      });
      expect(output).toContain(
        'https://openalex.org/W2741809807 | https://doi.org/10.7717/peerj.4375 | 1234 citations | Heather Piwowar, Jason Priem',
      );
      expect(output).not.toMatch(/works\b/);
    });

    it('labels an untitled record rather than printing null (gh #50)', () => {
      const output = text({ results: [{ ...harvard, display_name: null }] });
      expect(output).toContain('(untitled)');
      expect(output).not.toContain('null');
    });

    it('keeps a provider name and hint literal inside the bold wrapper (gh #76)', () => {
      const output = text({
        results: [
          {
            id: 'https://openalex.org/S1',
            display_name: '**Bold** &constructor; <genus> `x` [a](b)',
            entity_type: 'source',
            external_id: 'https://doi.org/10.1000/a_b_',
            cited_by_count: 1,
            works_count: 1,
            hint: 'Pub <genus> &lt; _x_ 5~10',
          },
          { ...harvard, display_name: 'Fish <Actinopterygii>' },
        ],
      });

      const allowed = new Set(['paragraph', 'text', 'strong', 'link']);
      expect(nodeTypes(output).filter((t) => !allowed.has(t))).toEqual([]);
      const rendered = renderedText(output);
      expect(rendered).toContain('**Bold** &constructor; <genus> `x` [a](b) (source)');
      expect(rendered).toContain(
        'https://openalex.org/S1 | https://doi.org/10.1000/a_b_ | 1 citations | 1 works | Pub <genus> &lt; _x_ 5~10',
      );
      expect(rendered).toContain('Fish <Actinopterygii> (institution)');
      // The identifier line reads byte-identical in the raw Markdown.
      expect(output).toContain('https://openalex.org/S1 | https://doi.org/10.1000/a_b_ |');
    });

    it('reads a multi-line or space-edged name and hint back intact on content[] (gh #128)', async () => {
      const results: AutocompleteResult['results'] = [
        {
          id: 'https://openalex.org/A5149007440',
          display_name: 'Wichmann, Arthur,\n    b. 1851.',
          entity_type: 'author',
          external_id: null,
          cited_by_count: 0,
          works_count: 3,
          hint: 'Line one\r\n- not a list\n# not a heading',
        },
        { ...harvard, display_name: ' Harvard University ' },
      ];
      mockAutocomplete.mockResolvedValue({ results });

      const result = await runToolContract(resolveNameTool, { query: 'Wichmann' });

      expect(result.structuredContent).toMatchObject({ results });
      const output = contentText(result);
      const allowed = new Set(['paragraph', 'text', 'strong', 'break', 'link']);
      expect(nodeTypes(output).filter((t) => !allowed.has(t))).toEqual([]);
      const rendered = renderedText(output);
      expect(rendered).toContain(
        'Wichmann, Arthur,\n    b. 1851. (author)\nhttps://openalex.org/A5149007440 | 0 citations | 3 works | Line one\n- not a list\n# not a heading',
      );
      expect(rendered).toContain(' Harvard University  (institution)');
    });
  });
});
