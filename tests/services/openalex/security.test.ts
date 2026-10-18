/**
 * @fileoverview Security tests — verifies that the OpenAlex account API key (sent upstream
 * as api_key=), the mailto identifier, and other operator-injected credentials never appear
 * in tool outputs or error messages surfaced to MCP clients. Also covers injection attempts
 * in query/filter inputs, a by-ID `id` confined to its own request-path segment, provider text
 * reaching both response surfaces (entity lookups keyed
 * by prototype names, Markdown injection into content[]), and the running time of the text
 * scanners on adversarial input.
 * @module services/openalex/security.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeTypes, nonAutolinks, renderedText } from '../../helpers/markdown.js';

const API_KEY = 'operator@example.com';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiKey: API_KEY,
    baseUrl: 'https://api.openalex.org',
  }),
}));

describe('Security — API key and mailto non-leakage', () => {
  beforeEach(() => {
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

  it('sends the API key as api_key= upstream but never in successful output', async () => {
    const service = await getService();
    const result = await service.search({ entityType: 'works' }, createMockContext());
    // The credential is sent upstream as api_key= — verify it appeared in the outgoing URL.
    // fetchWithTimeout calls fetch() with a URL object, so we call .toString() to get the string.
    const call = vi.mocked(globalThis.fetch).mock.lastCall;
    expect(call).toBeDefined();
    const urlString = String(call![0]);
    expect(urlString).toContain('api_key=');
    // But it must not appear in the returned data
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain('api_key');
  });

  it('does not leak API key in a 400 error message', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid query.', message: 'abstract is not valid.' }), {
        status: 400,
        statusText: 'Bad Request',
      }),
    );
    const service = await getService();
    await expect(
      service.search({ entityType: 'works', select: ['abstract'] }, createMockContext()),
    ).rejects.toSatisfy((err: unknown) => {
      const msg = (err as Error).message;
      return !msg.includes(API_KEY) && !msg.includes('api_key');
    });
  });

  it('does not leak API key in a 404 error message', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'No entity found.' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    );
    const service = await getService();
    await expect(
      service.search({ entityType: 'works', id: 'W99999999999' }, createMockContext()),
    ).rejects.toSatisfy((err: unknown) => {
      const msg = (err as Error).message;
      return !msg.includes(API_KEY) && !msg.includes('api_key');
    });
  });

  it('does not leak API key in a 429 error message after retries', async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );
    const service = await getService();
    const promise = service.search({ entityType: 'works' }, createMockContext());
    const rejection = expect(promise).rejects.toSatisfy((err: unknown) => {
      const msg = (err as Error).message;
      return !msg.includes(API_KEY) && !msg.includes('api_key');
    });
    await vi.runAllTimersAsync();
    await rejection;
  });

  it('does not leak API key in a network/fetch-failure error', { timeout: 30_000 }, async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new TypeError(
        `Failed to fetch https://api.openalex.org/works?api_key=${API_KEY}&search=test`,
      ),
    );
    const service = await getService();
    await expect(
      service.search({ entityType: 'works', query: 'test' }, createMockContext()),
    ).rejects.toSatisfy((err: unknown) => {
      const msg = (err as Error).message;
      return !msg.includes(API_KEY);
    });
  });

  it('does not include the API key in structured error data', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'Bad filter.' }), {
        status: 400,
        statusText: 'Bad Request',
      }),
    );
    const service = await getService();
    await expect(service.search({ entityType: 'works' }, createMockContext())).rejects.toSatisfy(
      (err: unknown) => {
        const serialized = JSON.stringify((err as { data?: unknown }).data ?? {});
        return !serialized.includes(API_KEY) && !serialized.includes('api_key');
      },
    );
  });

  it('does not leak the API key when an over-long autocomplete 500 is relabelled (gh #81)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('<!doctype html>\n<title>500 Internal Server Error</title>', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );
    const service = await getService();
    await expect(
      service.autocomplete({ entityType: 'authors', query: 'a'.repeat(1001) }, createMockContext()),
    ).rejects.toSatisfy((err: unknown) => {
      const { message, data } = err as { message: string; data?: { reason?: string } };
      const serialized = `${message} ${JSON.stringify(data ?? {})}`;
      return (
        data?.reason === 'query_too_long' &&
        !serialized.includes(API_KEY) &&
        !serialized.includes('api_key')
      );
    });
  });

  it('keeps the credential out of a relabelled semantic embedding failure, and the embedder host out of its message (gh #96)', async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'Invalid query parameters error.',
            message:
              'Failed to embed query: 429 Client Error: Too Many Requests for url: https://embed.example.com/ai-gateway/mlflow/v1/embeddings',
          }),
          { status: 400, statusText: 'Bad Request' },
        ),
      ),
    );
    const service = await getService();
    const promise = service.search(
      { entityType: 'works', query: 'graph neural networks', searchMode: 'semantic' },
      createMockContext(),
    );
    const rejection = expect(promise).rejects.toSatisfy((err: unknown) => {
      const { message, data } = err as { message: string; data?: { reason?: string } };
      const serialized = `${message} ${JSON.stringify(data ?? {})}`;
      return (
        data?.reason === 'upstream_unavailable' &&
        !message.includes('embed.example.com') &&
        !serialized.includes(API_KEY) &&
        !serialized.includes('api_key')
      );
    });
    await vi.runAllTimersAsync();
    await rejection;
  });
});

describe('Security — injection attempts in query and filter inputs', () => {
  beforeEach(() => {
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

  function lastFetchUrl() {
    const call = vi.mocked(globalThis.fetch).mock.lastCall;
    if (!call) throw new Error('fetch was not called');
    return new URL(call[0] as string);
  }

  it('passes a query containing SQL-style injection through safely as a URL parameter', async () => {
    const injection = "'; DROP TABLE works; --";
    const service = await getService();
    await service.search({ entityType: 'works', query: injection }, createMockContext());
    const url = lastFetchUrl();
    // The query is forwarded as a URL search param — not interpreted
    expect(url.searchParams.get('search')).toBe(injection);
    // The path must not be modified by the query value
    expect(url.pathname).toBe('/works');
  });

  it('passes a query with URL-encoded path traversal characters safely', async () => {
    const injection = '../../admin/config';
    const service = await getService();
    await service.search({ entityType: 'works', query: injection }, createMockContext());
    const url = lastFetchUrl();
    // Must stay on /works path, not be modified by the traversal
    expect(url.pathname).toBe('/works');
    expect(url.searchParams.get('search')).toBe(injection);
  });

  it('passes filter values containing colons safely without breaking filter string structure', async () => {
    const service = await getService();
    await service.search(
      {
        entityType: 'works',
        filters: { 'primary_topic.field.id': 'F:injected:value' },
      },
      createMockContext(),
    );
    const url = lastFetchUrl();
    const filter = url.searchParams.get('filter') ?? '';
    // The whole value must appear in the filter (colons in value are passed through)
    expect(filter).toContain('primary_topic.field.id:F:injected:value');
  });

  it('passes an oversized query string without truncation or error', async () => {
    const oversizedQuery = 'a'.repeat(5000);
    const service = await getService();
    // Should not throw — forwarded to upstream which decides how to handle it
    await expect(
      service.search({ entityType: 'works', query: oversizedQuery }, createMockContext()),
    ).resolves.toBeDefined();
  });

  it('passes unicode and emoji in queries without corruption', async () => {
    const unicodeQuery = '量子力学 🧬 Ångström';
    const service = await getService();
    await service.search({ entityType: 'works', query: unicodeQuery }, createMockContext());
    const url = lastFetchUrl();
    expect(decodeURIComponent(url.searchParams.get('search') ?? '')).toBe(unicodeQuery);
  });

  it('passes filters with many keys without dropping any', async () => {
    const manyFilters: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      manyFilters[`field_${i}`] = `value_${i}`;
    }
    const service = await getService();
    await service.search({ entityType: 'works', filters: manyFilters }, createMockContext());
    const url = lastFetchUrl();
    const filter = url.searchParams.get('filter') ?? '';
    for (let i = 0; i < 20; i++) {
      expect(filter).toContain(`field_${i}:value_${i}`);
    }
  });

  it('does not include API key in successful result data regardless of upstream payload', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          meta: { count: 1, per_page: 1 },
          results: [{ id: 'W1', display_name: `Result mentioning ${API_KEY} in display name` }],
        }),
        { status: 200 },
      ),
    );
    // If upstream somehow echoes back our key, it should still pass through to structured
    // output (we don't scrub upstream content), but we verify the service itself doesn't
    // inject the key in any other field.
    const service = await getService();
    const result = await service.search({ entityType: 'works' }, createMockContext());
    // The meta and other service-added fields must not contain the key
    const metaStr = JSON.stringify(result.meta);
    expect(metaStr).not.toContain(API_KEY);
  });
});

describe('Security — env var non-leakage through tool layer', () => {
  it('never surfaces OPENALEX_API_KEY in the tool output enrichment', async () => {
    // Verify the format output (the part visible to MCP clients) never contains credentials.
    // The format() callbacks are pure functions — no service calls needed.
    const { analyzeTrendsTool } = await import(
      '@/mcp-server/tools/definitions/analyze-trends.tool.js'
    );
    type AnalyzeResult = Parameters<NonNullable<typeof analyzeTrendsTool.format>>[0];

    const fakeResult: AnalyzeResult = {
      meta: { count: 100, groups_count: 2, next_cursor: null },
      groups: [
        { key: '2024', key_display_name: '2024', count: 50 },
        { key: '2023', key_display_name: '2023', count: 50 },
      ],
    };

    const blocks = analyzeTrendsTool.format?.(fakeResult) ?? [];
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');

    // The format output must not expose any plausible credential pattern
    expect(text).not.toContain('@');
    expect(text).not.toContain('mailto');
    expect(text).not.toContain('api_key');
  });

  it('never surfaces OPENALEX_API_KEY in the search tool format output', async () => {
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    type SearchResult = Parameters<NonNullable<typeof searchEntitiesTool.format>>[0];

    const fakeResult: SearchResult = {
      meta: { count: 1, per_page: 25, next_cursor: null },
      results: [{ id: 'W001', display_name: 'Test Paper' }],
    };

    const blocks = searchEntitiesTool.format?.(fakeResult) ?? [];
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).not.toContain('mailto');
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('@example.com');
  });

  it('never surfaces OPENALEX_API_KEY in the resolve-name tool format output', async () => {
    const { resolveNameTool } = await import('@/mcp-server/tools/definitions/resolve-name.tool.js');
    type AutocompleteResult = Parameters<NonNullable<typeof resolveNameTool.format>>[0];

    const fakeResult: AutocompleteResult = {
      results: [
        {
          id: 'I1',
          display_name: 'MIT',
          entity_type: 'institution',
          external_id: null,
          cited_by_count: 100,
          works_count: 500,
          hint: 'Cambridge, MA',
        },
      ],
    };

    const blocks = resolveNameTool.format?.(fakeResult) ?? [];
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text).not.toContain('mailto');
    expect(text).not.toContain('api_key');
  });
});

/**
 * Identifier normalization rewrites what the caller typed into an upstream path segment,
 * so it is a place where caller input becomes part of a URL path. These cases pin the
 * blast radius: exactly one recognized scheme prefix is case-folded, and nothing else
 * about the caller's string — value casing, unknown prefixes, arbitrary text — is altered.
 */
describe('Security — identifier normalization never rewrites the caller value', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<Response>>().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'W1', display_name: 'Test' }), {
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

  async function pathForId(id: string): Promise<string> {
    const { initOpenAlexService, getOpenAlexService } = await import(
      '@/services/openalex/openalex-service.js'
    );
    initOpenAlexService();
    await getOpenAlexService().search({ entityType: 'works', id }, createMockContext());
    const call = vi.mocked(globalThis.fetch).mock.lastCall;
    if (!call) throw new Error('fetch was not called');
    return new URL(String(call[0])).pathname;
  }

  it.each([
    ['an unknown scheme keeps its case', 'X-Custom:AbC', '/works/X-Custom:AbC'],
    ['a scheme-shaped name is not folded', 'Nature:AWeeklyJournal', '/works/Nature:AWeeklyJournal'],
    [
      'an uppercase ORCID value survives',
      'ORCID:0000-0002-1825-009X',
      '/works/orcid:0000-0002-1825-009X',
    ],
    [
      'an uppercase ROR value survives',
      'ROR:https://ror.org/00HX57361',
      '/works/ror:https://ror.org/00HX57361',
    ],
    ['an uppercase DOI value survives', 'DOI:10.1136/BMJ.F5137', '/works/doi:10.1136/BMJ.F5137'],
    ['an ISSN value survives', 'ISSN:0028-083X', '/works/issn:0028-083X'],
  ])('%s (gh #66)', async (_label, id, expected) => {
    expect(await pathForId(id)).toBe(expected);
  });

  it('confines the PubMed URL branch to a numeric article path (gh #66)', async () => {
    expect(await pathForId('https://pubmed.ncbi.nlm.nih.gov/21491125')).toBe(
      '/works/pmid:21491125',
    );
    // A look-alike host must not be read as PubMed and rewritten into a pmid: lookup.
    expect(await pathForId('https://pubmed.ncbi.nlm.nih.gov.evil.test/21491125')).toBe(
      '/works/https://pubmed.ncbi.nlm.nih.gov.evil.test/21491125',
    );
  });

  it('confines the PubMed Central URL branch to the two real hosts (gh #67)', async () => {
    expect(await pathForId('https://pmc.ncbi.nlm.nih.gov/articles/PMC3084216/')).toBe(
      '/works/pmcid:PMC3084216',
    );
    expect(await pathForId('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3084216/')).toBe(
      '/works/pmcid:PMC3084216',
    );
  });

  /**
   * Suffix and prefix look-alikes both have to miss: the host is anchored on the left by the
   * scheme and on the right by the `/articles` (or `/pmc/articles`) path segment, so neither a
   * domain that merely ends with the real host nor one that merely starts with it is rewritten.
   */
  it.each([
    'https://pmc.ncbi.nlm.nih.gov.example/articles/PMC3084216/',
    'https://notpmc.ncbi.nlm.nih.gov/articles/PMC1/',
    'https://pmc.ncbi.nlm.nih.gov.evil.test/articles/PMC3084216/',
    'https://ncbi.nlm.nih.gov.evil.test/pmc/articles/PMC3084216/',
    'https://evil.test/pmc.ncbi.nlm.nih.gov/articles/PMC3084216/',
  ])('does not rewrite the PMC look-alike host %s (gh #67)', async (id) => {
    expect(await pathForId(id)).toBe(`/works/${id}`);
  });

  /**
   * The OpenAlex URL parse accepts three hosts and nothing that merely contains one: the host
   * has to open the value (after an optional `http(s)://`) and end at a `/`, `?`, `#`, or the end
   * of the value, so a credential, a port, a longer domain, or an OpenAlex URL nested in another
   * URL's path or query is never read as OpenAlex.
   */
  it.each([
    'https://openalex.org.evil.test/W2741809807',
    'openalex.org.evil.test/works/W2741809807',
    'https://openalex.org@evil.test/W2741809807',
    'https://evil.test/openalex.org/W2741809807',
    'https://evil.test/r/https://openalex.org/W2741809807',
    'https://notopenalex.org/works/W2741809807',
    'https://api.openalex.org.evil.test/works/W2741809807',
    'javascript://openalex.org/W2741809807',
  ])('does not rewrite the OpenAlex look-alike %s (gh #99)', async (id) => {
    expect(await pathForId(id)).toBe(`/works/${id}`);
  });
});

/**
 * A by-ID lookup puts the caller's `id` into the request path, and the request URL is then
 * parsed — so a `.`/`..` segment would resolve out of the path, `?` and `#` would start a query
 * or a fragment, `\` would split a segment, and a tab or line break would vanish and join its
 * neighbours. Each of those either fails before any request or reaches OpenAlex percent-encoded
 * inside `/<entity_type>/`. Dot segments are refused in their percent-encoded spellings too,
 * since encoding cannot confine them. (gh #109)
 */
describe('Security — a by-ID id stays inside its own path segment (gh #109)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = new URL(String(input));
        return url.hostname === 'api.openalex.org'
          ? Promise.resolve(
              new Response(JSON.stringify({ id: 'https://openalex.org/W1', display_name: 'One' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          : Promise.reject(new Error(`unmocked fetch: ${url.href}`));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function search(entityType: 'works' | 'funders' | 'keywords', id: string) {
    const { initOpenAlexService, getOpenAlexService } = await import(
      '@/services/openalex/openalex-service.js'
    );
    initOpenAlexService();
    return getOpenAlexService().search({ entityType, id }, createMockContext());
  }

  it.each([
    ['works', '../authors/A5023888391'],
    ['works', '../works?search=graphene'],
    ['works', './W2741809807'],
    ['works', '..'],
    ['works', '.'],
    ['works', 'W2741809807/..'],
    ['works', '10.1000/x/./y'],
    ['works', 'doi:10.1000/../../authors/A5023888391'],
    ['works', 'https://doi.org/../../authors/A5023888391'],
    ['works', '%2e%2e/authors/A5023888391'],
    ['works', '%2E%2E/authors/A5023888391'],
    ['works', '.%2e/authors/A5023888391'],
    ['works', '%2e./authors/A5023888391'],
    ['works', '%2e/W2741809807'],
    ['funders', '../works?search=graphene'],
    ['keywords', '../authors/A5023888391'],
  ])('fails %s id %j as id_dot_segment before any request', async (entityType, id) => {
    await expect(search(entityType as 'works', id)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'id_dot_segment' },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /** [id, the path it reaches] — each one stays under /works/, its structure encoded. */
  it.each([
    ['W2741809807?search=graphene', '/works/W2741809807%3Fsearch=graphene'],
    ['W2741809807#x', '/works/W2741809807%23x'],
    ['?search=graphene', '/works/%3Fsearch=graphene'],
    ['#', '/works/%23'],
    ['..\\authors\\A5023888391', '/works/..%5Cauthors%5CA5023888391'],
    ['.\n./authors/A5023888391', '/works/.%0A./authors/A5023888391'],
    ['.\t./authors/A5023888391', '/works/.%09./authors/A5023888391'],
    ['.\r./authors/A5023888391', '/works/.%0D./authors/A5023888391'],
    ['..%2Fauthors%2FA5023888391', '/works/..%2Fauthors%2FA5023888391'],
    ['%252e%252e/authors/A5023888391', '/works/%252e%252e/authors/A5023888391'],
    ['...', '/works/...'],
    ['doi:10.1000/..x', '/works/doi:10.1000/..x'],
  ])('confines id %j to %s', async (id, path) => {
    await search('works', id);
    const url = new URL(String(vi.mocked(globalThis.fetch).mock.lastCall?.[0]));
    expect(url.pathname).toBe(path);
    expect([...url.searchParams.keys()]).toEqual(['api_key', 'select']);
    expect(url.hash).toBe('');
  });

  it('echoes the refused id JSON-encoded, so a line break cannot forge a heading', async () => {
    const error = await search('works', '../x\n# Injected').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ data: { reason: 'id_dot_segment' } });
    expect((error as Error).message).toContain('"../x\\n# Injected"');
    expect((error as Error).message).not.toContain('\n');
  });

  it('quotes at most 200 characters of a refused id in the message, and the whole id in data', async () => {
    const id = `../${'a'.repeat(80_000)}`;
    const error = await search('works', id).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ data: { reason: 'id_dot_segment', id } });
    const { message } = error as Error;
    expect(message).toContain(`"../${'a'.repeat(197)}…"`);
    expect(message.length).toBeLessThan(500);
  });

  it.each([
    ['a bare DOI', '10.1000/../x'],
    ['a DOI URL', 'https://doi.org/10.1000/../x'],
    ['an ORCID URL', 'https://orcid.org/../x'],
  ])('quotes %s as the caller wrote it, not in its normalized form', async (_label, id) => {
    const error = await search('works', id).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ data: { reason: 'id_dot_segment', id } });
    expect((error as Error).message).toContain(`id ${JSON.stringify(id)} holds`);
  });

  it('caps the caller-written id it quotes at 200 characters', async () => {
    const id = `https://doi.org/10.1000/../${'a'.repeat(400)}`;
    const error = await search('works', id).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain(`"${id.slice(0, 200)}…"`);
  });

  it('quotes an identifier query as the caller wrote it on the resolve path', async () => {
    const { initOpenAlexService, getOpenAlexService, inferIdentifier } = await import(
      '@/services/openalex/openalex-service.js'
    );
    initOpenAlexService();
    const query = 'https://doi.org/10.1000/../../authors/A5023888391';
    const identifier = inferIdentifier(query);
    if (!identifier) throw new Error('expected an identifier');
    const error = await getOpenAlexService()
      .resolveIdentifier(identifier, createMockContext(), undefined, query)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ data: { reason: 'id_dot_segment', id: query } });
    expect((error as Error).message).toContain(`id ${JSON.stringify(query)} holds`);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

/**
 * The search echo quotes caller text on the trailer's one line, so a line break in an `id` or a
 * `query` must stay escaped there — on structuredContent too, where the echo is the same string.
 */
describe('Security — the search echo keeps caller text on one line', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    ['id', { id: 'W2741809807\n# Injected id' }, 'id="W2741809807\\n# Injected id"'],
    ['query', { query: 'graphene\n# Injected query' }, 'query="graphene\\n# Injected query"'],
    [
      'sort',
      { sort: '-cited_by_count\r\n# Injected sort' },
      'sort="-cited_by_count\\r\\n# Injected sort"',
    ],
    ['seed', { sample: 5, seed: '42\n# Injected seed' }, 'seed="42\\n# Injected seed"'],
  ])('JSON-encodes the %s', async (_label, args, rendered) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        new URL(String(input)).hostname === 'api.openalex.org'
          ? Promise.resolve(
              new Response(
                JSON.stringify(
                  'id' in args
                    ? { id: 'https://openalex.org/W2741809807', display_name: 'One' }
                    : { meta: { count: 0, per_page: 25, next_cursor: null }, results: [] },
                ),
                { status: 200 },
              ),
            )
          : Promise.reject(new Error(`unmocked fetch: ${String(input)}`)),
      ),
    );
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );

    const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', ...args });

    const { echo } = result.structuredContent as { echo: string };
    expect(echo).toContain(rendered);
    expect(echo).not.toMatch(/[\r\n]/);
    const lines = (result.content ?? [])
      .map((b) => ('text' in b ? b.text : ''))
      .join('\n')
      .split(/\r?\n|\r/);
    expect(lines).toContain(`**Query:** ${echo}`);
    expect(lines.some((line) => line.trimStart().startsWith('# Injected'))).toBe(false);
  });
});

/**
 * The citation graph and trend echoes quote `seed_id`, `sort`, and `group_by` on the same one
 * trailer line, and repeat the echo in the empty-result notice; the refusals that quote an `id`,
 * a `seed_id`, or a `slice.field` put it in `content[]` too. Each stays JSON-encoded, so a line
 * break in it cannot start a heading.
 */
describe('Security — graph, trend, and refusal echoes keep caller text on one line', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Answer `/works/<id>` with `seed` and every other OpenAlex path with `list`. */
  function stubOpenAlex(seed: Record<string, unknown>, list: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = new URL(String(input));
        if (url.hostname !== 'api.openalex.org') {
          return Promise.reject(new Error(`unmocked fetch: ${url.href}`));
        }
        const body = url.pathname.startsWith('/works/') ? seed : list;
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
  }

  const textOf = (result: { content?: { type: string; text?: string }[] }) =>
    (result.content ?? []).map((b) => b.text ?? '').join('\n');
  const linesOf = (result: { content?: { type: string; text?: string }[] }) =>
    textOf(result).split(/\r?\n|\r/);
  const forgesHeading = (text: string) =>
    text.split(/\r?\n|\r/).some((line) => line.trimStart().startsWith('# Injected'));
  const emptyPage = { meta: { count: 0, per_page: 25, next_cursor: null }, results: [] };
  const seedWork = { id: 'https://openalex.org/W2741809807', display_name: 'Seed' };

  it.each([
    [
      'seed_id',
      { seed_id: 'W2741809807\n# Injected seed' },
      'seed_id="W2741809807\\n# Injected seed"',
    ],
    [
      'sort',
      { seed_id: 'W2741809807', sort: 'x\r\n# Injected sort' },
      'sort="x\\r\\n# Injected sort"',
    ],
  ])('citation graph: JSON-encodes the %s', async (_label, args, rendered) => {
    stubOpenAlex(seedWork, emptyPage);
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { getCitationGraphTool } = await import(
      '@/mcp-server/tools/definitions/citation-graph.tool.js'
    );

    const result = await runToolContract(getCitationGraphTool, { direction: 'cites', ...args });

    const { echo, notice } = result.structuredContent as { echo: string; notice: string };
    expect(echo).toContain(rendered);
    expect(echo).not.toMatch(/[\r\n]/);
    expect(notice).toContain(rendered);
    expect(linesOf(result)).toContain(`**Query:** ${echo}`);
    expect(forgesHeading(textOf(result))).toBe(false);
  });

  it('analyze trends: JSON-encodes the group_by', async () => {
    stubOpenAlex(seedWork, { meta: { count: 0 }, group_by: [] });
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { analyzeTrendsTool } = await import(
      '@/mcp-server/tools/definitions/analyze-trends.tool.js'
    );

    const result = await runToolContract(analyzeTrendsTool, {
      entity_type: 'works',
      group_by: 'type\n# Injected group_by',
    });

    const { echo, notice } = result.structuredContent as { echo: string; notice: string };
    expect(echo).toContain('group_by="type\\n# Injected group_by"');
    expect(echo).not.toMatch(/[\r\n]/);
    expect(notice).toContain('group_by="type\\n# Injected group_by"');
    expect(linesOf(result)).toContain(`**Query:** ${echo}`);
    expect(forgesHeading(textOf(result))).toBe(false);
  });

  it('citation graph: JSON-encodes the seed_id a seed lookup could not resolve', async () => {
    stubOpenAlex({ display_name: 'No ID' }, emptyPage);
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { getCitationGraphTool } = await import(
      '@/mcp-server/tools/definitions/citation-graph.tool.js'
    );
    const seedId = 'W2741809807\n# Injected seed';

    const result = await runToolContract(getCitationGraphTool, {
      seed_id: seedId,
      direction: 'cites',
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { message: string; data: Record<string, unknown> };
    };
    expect(error.message).toContain('"W2741809807\\n# Injected seed"');
    expect(error.data).toMatchObject({ reason: 'entity_not_found', seedId });
    expect(linesOf(result)).toContain(`Error: ${error.message}`);
    expect(forgesHeading(textOf(result))).toBe(false);
  });

  it('search: JSON-encodes the id and slice.field of a slice_field_not_array refusal', async () => {
    stubOpenAlex(seedWork, emptyPage);
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    const id = 'W2741809807\n# Injected id';
    const field = 'doi\r\n# Injected field';

    const result = await runToolContract(searchEntitiesTool, {
      entity_type: 'works',
      id,
      slice: { field, offset: 0 },
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { message: string; data: Record<string, unknown> };
    };
    expect(error.message).toContain('"doi\\r\\n# Injected field"');
    expect(error.message).toContain('"W2741809807\\n# Injected id"');
    expect(error.data).toMatchObject({ reason: 'slice_field_not_array', field, id });
    expect(linesOf(result)).toContain(`Error: ${error.message}`);
    expect(forgesHeading(textOf(result))).toBe(false);
  });
});

/**
 * `invalid_country_code` quotes the caller's key and the segment it refused. Both are
 * JSON-encoded, so a line break cannot forge a heading in `content[]`, and capped, so a
 * caller-sized value cannot bloat the message; `data` keeps them whole. (gh #101)
 */
describe('Security — a refused country segment stays quoted on one line (gh #101)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function refuse(filters: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => Promise.reject(new Error(`unmocked fetch: ${String(input)}`))),
    );
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', filters });
    expect(result.isError).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const { error } = result.structuredContent as {
      error: { message: string; data: Record<string, unknown> };
    };
    const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text.split('\n')).toContain(`Error: ${error.message}`);
    return { error, text };
  }

  it('JSON-encodes a segment holding a line break', async () => {
    const segment = 'Narnia\n# Injected heading';
    const { error, text } = await refuse({ 'authorships.institutions.country_code': segment });

    expect(error.message).toContain('"Narnia\\n# Injected heading"');
    expect(error.data).toMatchObject({ reason: 'invalid_country_code', segment });
    expect(text.split('\n').some((line) => line.trimStart().startsWith('# Injected'))).toBe(false);
  });

  it('JSON-encodes a key holding a line break', async () => {
    const key = 'x\n# Injected key.country_code';
    const { error, text } = await refuse({ [key]: 'Narnia' });

    expect(error.message).toContain('"x\\n# Injected key.country_code"');
    expect(error.data).toMatchObject({ filterKey: key });
    expect(text.split('\n').some((line) => line.trimStart().startsWith('# Injected'))).toBe(false);
  });

  it('caps a caller-sized segment in the message and keeps it whole in data', async () => {
    const segment = 'a'.repeat(80_000);
    const { error } = await refuse({ country_code: segment });

    expect(error.message).toContain(`"${'a'.repeat(200)}…"`);
    expect(error.message.length).toBeLessThan(700);
    expect(error.data).toMatchObject({ segment });
  });
});

/**
 * `comma_in_filter_value` quotes the caller's key the same way: JSON-encoded so a line break
 * cannot forge a heading in `content[]`, capped so a caller-sized key cannot bloat the message,
 * and whole in `data.filterKey`. (gh #113)
 */
describe('Security — a key refused for a comma stays quoted on one line (gh #113)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function refuse(filters: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => Promise.reject(new Error(`unmocked fetch: ${String(input)}`))),
    );
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', filters });
    expect(result.isError).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const { error } = result.structuredContent as {
      error: { message: string; data: Record<string, unknown> };
    };
    const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text.split('\n')).toContain(`Error: ${error.message}`);
    return { error, text };
  }

  it('JSON-encodes a key holding a line break', async () => {
    const key = 'x\n# Injected key';
    const { error, text } = await refuse({ [key]: 'a, b' });

    expect(error.message).toContain('"x\\n# Injected key"');
    expect(error.data).toMatchObject({ reason: 'comma_in_filter_value', filterKey: key });
    expect(text.split('\n').some((line) => line.trimStart().startsWith('# Injected'))).toBe(false);
  });

  it('caps a caller-sized key in the message and keeps it whole in data', async () => {
    const key = 'k'.repeat(80_000);
    const { error } = await refuse({ [key]: 'a, b' });

    expect(error.message).toContain(`"${'k'.repeat(200)}…"`);
    expect(error.message.length).toBeLessThan(700);
    expect(error.data).toMatchObject({ filterKey: key });
  });
});

/**
 * `mixed_and_or_in_filter_value` quotes the caller's key the same way, and never the value: a
 * line break in the key stays escaped, a caller-sized key is capped in the message, and
 * `data.filterKey` keeps it whole. (gh #107)
 */
describe('Security — a key refused for mixing "|" with "+" stays quoted on one line (gh #107)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function refuse(filters: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => Promise.reject(new Error(`unmocked fetch: ${String(input)}`))),
    );
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', filters });
    expect(result.isError).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const { error } = result.structuredContent as {
      error: { message: string; data: Record<string, unknown> };
    };
    const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text.split('\n')).toContain(`Error: ${error.message}`);
    return { error, text };
  }

  it('JSON-encodes a key holding a line break and leaves the value out', async () => {
    const key = 'x\n# Injected key';
    const value = 'a|b+c\n# Injected value';
    const { error, text } = await refuse({ [key]: value });

    expect(error.message).toContain('"x\\n# Injected key"');
    expect(text).not.toContain('Injected value');
    expect(error.data).toMatchObject({ reason: 'mixed_and_or_in_filter_value', filterKey: key });
    expect(text.split('\n').some((line) => line.trimStart().startsWith('# Injected'))).toBe(false);
  });

  it('caps a caller-sized key in the message and keeps it whole in data', async () => {
    const key = 'k'.repeat(80_000);
    const { error } = await refuse({ [key]: `${'a|'.repeat(40_000)}b+c` });

    expect(error.message).toContain(`"${'k'.repeat(200)}…"`);
    expect(error.message.length).toBeLessThan(700);
    expect(error.data).toMatchObject({ filterKey: key });
  });
});

/**
 * `quote_in_filter_value` echoes the key the same way and never the value: the refused value can
 * hold a line break of its own, but the message carries only the JSON-encoded key, so no caller
 * text forges a heading in `content[]`. (gh #113, #115)
 */
describe('Security — a value refused for a stray double quote never reaches the message (gh #113)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function refuse(filters: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => Promise.reject(new Error(`unmocked fetch: ${String(input)}`))),
    );
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    const result = await runToolContract(searchEntitiesTool, { entity_type: 'works', filters });
    expect(result.isError).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const { error } = result.structuredContent as {
      error: { message: string; data: Record<string, unknown> };
    };
    const text = (result.content ?? []).map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(text.split('\n')).toContain(`Error: ${error.message}`);
    return { error, text };
  }

  it('names the key and leaves the quote-bearing value out of the message', async () => {
    const key = 'raw_affiliation_strings';
    const value = 'a"\n# Injected value';
    const { error, text } = await refuse({ [key]: value });

    expect(error.message).toContain('"raw_affiliation_strings"');
    expect(text).not.toContain('Injected value');
    expect(error.data).toMatchObject({ reason: 'quote_in_filter_value', filterKey: key });
    expect(text.split('\n').some((line) => line.trimStart().startsWith('# Injected'))).toBe(false);
  });
});

/** Characters each timing sample processes, so the smallest size is not lost in timer resolution. */
const WORK_CHARS = 400_000;
const SAMPLES = 5;
/** Absolute per-call bound: CPU milliseconds per 1,000 input characters. */
const MS_PER_K_CHARS = 0.5;

/** This thread's CPU milliseconds per call of `fn` on `input`, the fastest of `SAMPLES` runs. */
function cpuMsPerCall(fn: (s: string) => unknown, input: string): number {
  const reps = Math.ceil(WORK_CHARS / input.length);
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = process.threadCpuUsage();
    for (let i = 0; i < reps; i++) fn(input);
    const used = process.threadCpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000 / reps);
  }
  return best;
}

/** `unit` repeated to exactly `size` characters. */
function build(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

/**
 * Time a shape in this thread's own CPU time at every doubling of its size, from `from` to 64×
 * it. Each size is checked against an absolute bound before the next size runs, so super-linear
 * growth fails at the size where it starts instead of hanging the suite; across the full 64×
 * span the time must grow by less than 256× (linear grows ~64×, quadratic ~4096×).
 */
function expectLinearCpuTime(from: number, msAt: (size: number) => number): void {
  let first = 0;
  let last = 0;
  for (let size = from; size <= from * 64; size *= 2) {
    const ms = msAt(size);
    expect(ms, `${size} characters`).toBeLessThan((size / 1000) * MS_PER_K_CHARS);
    if (size === from) first = ms;
    last = ms;
  }
  expect(last / first).toBeLessThan(256);
}

/**
 * The OpenAlex URL parse runs on every `id`, `seed_id`, and `resolve_name` query, and on each
 * `|` segment of an `id` filter value — all caller-sized text — so each shape is timed with
 * `expectLinearCpuTime`. Every shape but the digit run stays at or below 80k characters, where
 * Bun's regex engine can switch modes; the digit run carries the span to 320k. (gh #99)
 */
describe('Security — OpenAlex URL parsing runs in linear time (gh #99)', () => {
  /** [label, input of a given size, smallest size] — each shape doubles six times (64×). */
  const URL_SHAPES: [string, (size: number) => string, number][] = [
    ['a long digit run', (n) => `https://openalex.org/works/W${'1'.repeat(n)}`, 5_000],
    ['repeated scheme-less hosts', (n) => build('openalex.org/', n), 1_250],
    ['slash runs', (n) => `https://openalex.org${'/'.repeat(n)}`, 1_250],
    ['backslash runs', (n) => `https://openalex.org/${'\\'.repeat(n)}`, 1_250],
    ['entity-type segment runs', (n) => `https://openalex.org/${build('works/', n)}`, 1_250],
    ['a long keyword slug', (n) => `https://openalex.org/keywords/${'a'.repeat(n)}`, 1_250],
    ['percent runs', (n) => `https://openalex.org/works/${'%'.repeat(n)}`, 1_250],
    ['query-string runs', (n) => `https://openalex.org/W1?${build('a=b&', n)}`, 1_250],
    ['interleaved line breaks', (n) => `${build('§1 x', n)}\ny`, 1_250],
    ['line breaks after an OpenAlex host', (n) => `openalex.org/${build('§1 x\n', n)}y`, 1_250],
    ['blank and CRLF runs', (n) => build('  \r\n', n), 1_250],
    [
      'blank and CRLF runs between an OpenAlex URL and text',
      (n) => `https://openalex.org/W1${build('  \r\n', n)}x`,
      1_250,
    ],
    [
      'pipe-joined URL IDs',
      (n) =>
        Array.from(
          { length: Math.ceil(n / 39) },
          () => 'https://openalex.org/works/W12345678',
        ).join('|'),
      1_250,
    ],
  ];

  const CASES = (['normalizeId', 'inferIdentifier', 'isOpenAlexFilterValue'] as const).flatMap(
    (fn) => URL_SHAPES.map(([label, make, from]) => [fn, label, make, from] as const),
  );

  it.each(CASES)('%s: %s', { timeout: 60_000 }, async (fnName, _label, make, from) => {
    const service = await import('@/services/openalex/openalex-service.js');
    const fn = service[fnName] as (s: string) => unknown;
    expectLinearCpuTime(from, (size) => cpuMsPerCall(fn, make(size)));
  });

  /**
   * A funder's DOI is checked against filter syntax before it becomes an `ids.doi` filter value
   * — the same caller-sized `id`, timed the same way. Each shape but the line-break ones fails or
   * matches the check at its far end, so the whole value is scanned; the check refuses any
   * whitespace, so a line-break shape fails at its first blank. (gh #98)
   */
  const FUNDER_DOI_SHAPES: [string, (size: number) => string, number][] = [
    ['a registrant code that never reaches its slash', (n) => `10.${'1'.repeat(n)}`, 5_000],
    ['a long suffix ending in a comma', (n) => `10.13039/${'1'.repeat(n)},`, 5_000],
    ['a long suffix ending in whitespace', (n) => `10.13039/${build('a-1.', n)} `, 1_250],
    ['repeated DOI prefixes', (n) => build('10.13039/', n), 1_250],
    ['repeated registrant openers', (n) => `${build('10.', n)}/x`, 1_250],
    ['interleaved line breaks', (n) => `10.13039/${build('§1 x', n)}\ny`, 1_250],
    ['blank and CRLF runs', (n) => `10.13039/${build('  \r\n', n)}`, 1_250],
  ];

  /**
   * Every by-ID `id` is encoded and split into path segments before the request — none of these
   * shapes is refused, so each is scanned end to end. (gh #109)
   */
  const ID_PATH_SHAPES: [string, (size: number) => string, number][] = [
    ['a long DOI digit run', (n) => `doi:10.1000/${'1'.repeat(n)}`, 5_000],
    ['slash runs', (n) => '/'.repeat(n), 1_250],
    ['structural character runs', (n) => build('?#\\\t\n\r', n), 1_250],
    ['near-miss dot segments', (n) => build('x.%2e/', n), 1_250],
    ['one segment of dots', (n) => '.'.repeat(n), 1_250],
    ['one segment of encoded dots', (n) => build('%2e', n), 1_250],
    ['interleaved line breaks', (n) => `${build('§1 x', n)}\ny`, 1_250],
    ['blank and CRLF runs', (n) => build('  \r\n', n), 1_250],
  ];

  it.each(ID_PATH_SHAPES)(
    'byIdPath: %s (gh #109)',
    { timeout: 60_000 },
    async (_label, make, from) => {
      const { byIdPath } = await import('@/services/openalex/openalex-service.js');
      const pathFor = (id: string) => byIdPath('works', id);
      expectLinearCpuTime(from, (size) => cpuMsPerCall(pathFor, make(size)));
    },
  );

  it.each(FUNDER_DOI_SHAPES)(
    'funderDoiFilter: %s (gh #98)',
    { timeout: 60_000 },
    async (_label, make, from) => {
      const { funderDoiFilter } = await import('@/services/openalex/openalex-service.js');
      expectLinearCpuTime(from, (size) => cpuMsPerCall(funderDoiFilter, make(size)));
    },
  );
});

/**
 * Every filter key and value a caller passes is rewritten clause by clause before the request —
 * the key classified (country, `language`, literal-`+` field, exact-match text field), a country
 * or language value split into `|`/`+` segments that are trimmed and looked up, a multi-word
 * exact-match value or one holding a comma trimmed and quoted, the value checked for a `|` beside
 * an AND operator (`+` or a space in a `|` alternative) and, when it is sent quoted, for a stray
 * double quote, and the value's `+` turned into the AND upstream reads — so both are caller-sized
 * text. Timed the same way as the URL parse above (`expectLinearCpuTime`); only the digit run
 * passes 80k characters. Each shape's outcome — the clause sent, or refused as
 * `comma_in_filter_value`, `invalid_country_code`, `mixed_and_or_in_filter_value`, or
 * `quote_in_filter_value` — is checked at every size, so the path a shape is named for is the
 * one timed; a refused one is timed through the throw, message included. (gh #107, #101, #115)
 */
describe('Security — filter clauses are rewritten in linear time (gh #107, #101, #115)', () => {
  /** What `buildFilterString()` does with a clause: send it, or refuse it for this reason. */
  type ClauseOutcome =
    | 'sent'
    | 'comma_in_filter_value'
    | 'invalid_country_code'
    | 'mixed_and_or_in_filter_value'
    | 'quote_in_filter_value';

  /**
   * [label, the clause for an input of a given size, smallest size, its outcome] — six doublings
   * (64×).
   */
  const CLAUSE_SHAPES: [string, (size: number) => [string, string], number, ClauseOutcome][] = [
    ['a long digit run', (n) => ['publication_year', '1'.repeat(n)], 5_000, 'sent'],
    ['a "+" run', (n) => ['authorships.institutions.country_code', '+'.repeat(n)], 1_250, 'sent'],
    ['AND-joined segments', (n) => ['authorships.author.id', build('A1+', n)], 1_250, 'sent'],
    ['a key of near-miss .search fragments', (n) => [build('.searc', n), 'x+y'], 1_250, 'sent'],
    [
      'a comma phrase in a .search.exact value',
      (n) => ['title.search.exact', build('a, b ', n)],
      1_250,
      'sent',
    ],
    [
      'a refused comma under a key of .searchx runs',
      (n) => [build('.searchx', n), 'a,b'],
      1_250,
      'comma_in_filter_value',
    ],
    ['a key of repeated _date segments', (n) => [build('x_date.', n), 'x+y'], 1_250, 'sent'],
    ['a long has_…_url leaf', (n) => [`has_${'a'.repeat(n)}_url`, 'x+y'], 1_250, 'sent'],
    [
      'a "+" run in a timestamp',
      (n) => ['from_created_date', `2026-01-01${'+'.repeat(n)}`],
      1_250,
      'sent',
    ],
    ['a key of repeated .doi segments', (n) => [build('.doi', n), 'x+y'], 1_250, 'sent'],
    [
      'a key of near-miss starts_with tails',
      (n) => [build('doi_starts_wit', n), 'x+y'],
      1_250,
      'sent',
    ],
    ['interleaved line breaks', (n) => ['type', `${build('§1 x+', n)}\ny`], 1_250, 'sent'],
    ['blank and CRLF runs', (n) => ['type', build('  \r\n', n)], 1_250, 'sent'],
    ['OR-joined alpha-3 countries', (n) => ['country_code', build('DEU|', n)], 1_250, 'sent'],
    [
      'AND-joined negated countries',
      (n) => ['country_code', Array.from({ length: Math.ceil(n / 7) }, () => '!FRA').join(' + ')],
      1_250,
      'sent',
    ],
    [
      'OR-joined country names',
      (n) => [
        'country_code',
        Array.from({ length: Math.ceil(n / 12) }, () => 'South Korea').join('|'),
      ],
      1_250,
      'sent',
    ],
    [
      'OR-joined spaced codes refused as one segment',
      (n) => ['country_code', build('DE US|', n)],
      1_250,
      'invalid_country_code',
    ],
    [
      'a whitespace run before a code',
      (n) => ['country_code', `${' '.repeat(n)}DE`],
      1_250,
      'sent',
    ],
    [
      'blank and CRLF runs before a code',
      (n) => ['country_code', `${build('  \r\n', n)}DE`],
      1_250,
      'sent',
    ],
    [
      'a negation run',
      (n) => ['country_code', `${'!'.repeat(n)}DE`],
      1_250,
      'invalid_country_code',
    ],
    [
      'a long rejected country',
      (n) => ['country_code', 'a'.repeat(n)],
      1_250,
      'invalid_country_code',
    ],
    [
      'a rejected country of line breaks',
      (n) => ['country_code', build('\n# x', n)],
      1_250,
      'invalid_country_code',
    ],
    ['OR-joined language names', (n) => ['language', build('English|', n)], 1_250, 'sent'],
    [
      'OR-joined multi-word language names',
      (n) => [
        'language',
        Array.from({ length: Math.ceil(n / 16) }, () => 'Scottish Gaelic').join('|'),
      ],
      1_250,
      'sent',
    ],
    ['a long unknown language', (n) => ['language', 'x'.repeat(n)], 1_250, 'sent'],
    [
      'language segments with line breaks',
      (n) => ['language', `${build('§1 x|', n)}\ny`],
      1_250,
      'mixed_and_or_in_filter_value',
    ],
    [
      'a key of repeated country suffixes',
      (n) => [`${build('countries.', n)}country_code`, 'DEU'],
      1_250,
      'sent',
    ],
    ['a multi-word name', (n) => ['display_name', build('ab ', n)], 1_250, 'sent'],
    [
      'a whitespace run before a name',
      (n) => ['geo.city', `${' '.repeat(n)}New York`],
      1_250,
      'sent',
    ],
    [
      'a negated quoted name',
      (n) => ['awards.funder_display_name', `!"${build('a ', n)}"`],
      1_250,
      'sent',
    ],
    [
      '"+"-joined words under an AND key',
      (n) => ['raw_affiliation_strings', build('a b+', n)],
      1_250,
      'sent',
    ],
    ['a key of repeated .city segments', (n) => [build('.city', n), 'a b'], 1_250, 'sent'],
    ['a name with line breaks', (n) => ['display_name', `${build('§1 x', n)}\ny`], 1_250, 'sent'],
    [
      'OR-joined countries refused for a trailing "+"',
      (n) => ['authorships.institutions.country_code', `${build('DE|', n)}+US`],
      1_250,
      'mixed_and_or_in_filter_value',
    ],
    [
      'a "+" run refused for a trailing "|"',
      (n) => ['authorships.author.id', `${'+'.repeat(n)}|`],
      1_250,
      'mixed_and_or_in_filter_value',
    ],
    [
      'a refused "|"/"+" value with line breaks',
      (n) => ['raw_affiliation_strings', `${build('§1 x|', n)}+\ny`],
      1_250,
      'mixed_and_or_in_filter_value',
    ],
    [
      'a quoted phrase holding "|" and "+"',
      (n) => ['geo.city', `"${build('a|b+', n)}"`],
      1_250,
      'sent',
    ],
    [
      'a comma phrase in a raw_affiliation_strings value',
      (n) => ['raw_affiliation_strings', build('a, b+', n)],
      1_250,
      'sent',
    ],
    [
      'whitespace runs around a comma phrase',
      (n) => ['geo.city', `${' '.repeat(n)}a, b${' '.repeat(n)}`],
      1_250,
      'sent',
    ],
    [
      'blank and CRLF runs before a comma phrase',
      (n) => ['geo.city', `${build('  \r\n', n)}a, b`],
      1_250,
      'sent',
    ],
    [
      'a comma phrase with line breaks',
      (n) => ['display_name', `${build('§1 x,', n)}\ny`],
      1_250,
      'sent',
    ],
    [
      'a key of repeated .city segments with a comma',
      (n) => [build('.city', n), 'a, b'],
      1_250,
      'sent',
    ],
    [
      'a space-AND value beside a "|"',
      (n) => ['authorships.author.id', build('A1 A2|', n)],
      1_250,
      'mixed_and_or_in_filter_value',
    ],
    [
      'a space-AND value beside a "|" with line breaks',
      (n) => ['authorships.author.id', `${build('A1 A2|', n)}\ny`],
      1_250,
      'mixed_and_or_in_filter_value',
    ],
    [
      'a stray quote in a comma phrase',
      (n) => ['raw_affiliation_strings', build('a, b" ', n)],
      1_250,
      'quote_in_filter_value',
    ],
    [
      'a stray quote in a multi-word phrase',
      (n) => ['geo.city', build('a b" ', n)],
      1_250,
      'quote_in_filter_value',
    ],
    [
      'a stray quote in a phrase with line breaks',
      (n) => ['raw_affiliation_strings', `${build('§1 x" ', n)}\ny`],
      1_250,
      'quote_in_filter_value',
    ],
  ];

  it.each(CLAUSE_SHAPES)(
    'buildFilterString: %s',
    { timeout: 60_000 },
    async (_label, make, from, expected) => {
      const { buildFilterString } = await import('@/services/openalex/openalex-service.js');
      const outcome = (clause: [string, string]): string => {
        try {
          buildFilterString([clause]);
          return 'sent';
        } catch (error) {
          return (error as { data?: { reason?: string } }).data?.reason ?? String(error);
        }
      };
      expectLinearCpuTime(from, (size) => {
        const clause = make(size);
        expect(outcome(clause), `${size} characters`).toBe(expected);
        return cpuMsPerCall(() => outcome(clause), clause.join(''));
      });
    },
  );
});

/**
 * A plan-gated filter's HTTP 429 names the refused clause — `The "<filter>:<value>" filter is
 * part of daily sync…` — and that clause is the caller's own filter key and value, so the read
 * that takes the filter name off it runs on caller-sized text. Timed the same way as the scanners
 * above (`expectLinearCpuTime`); only the digit run passes 80k characters. (gh #114)
 */
describe('Security — a plan-gated filter is named in linear time (gh #114)', () => {
  /** [label, upstream message of a given size, smallest size] — six doublings (64×). */
  const MESSAGE_SHAPES: [string, (size: number) => string, number][] = [
    ['a digit run that never reaches its colon', (n) => `The "${'1'.repeat(n)}" filter`, 5_000],
    ['a long matched name', (n) => `The "${'a'.repeat(n)}:2026-10-01" filter`, 1_250],
    [
      'a long value after the name',
      (n) => `The "from_created_date:${build('2026-10-01|', n)}"`,
      1_250,
    ],
    ['dot runs ending in a quote', (n) => `The "${'.'.repeat(n)}"`, 1_250],
    ['repeated openers', (n) => build('The "', n), 1_250],
    ['interleaved line breaks', (n) => `The "${build('§1 x', n)}\ny`, 1_250],
    ['blank and CRLF runs', (n) => `The "${build('  \r\n', n)}"`, 1_250],
  ];

  it.each(MESSAGE_SHAPES)(
    'planGatedFilterMessage: %s',
    { timeout: 60_000 },
    async (_label, make, from) => {
      const { planGatedFilterMessage } = await import('@/services/openalex/openalex-service.js');
      expectLinearCpuTime(from, (size) => cpuMsPerCall(planGatedFilterMessage, make(size)));
    },
  );
});

/**
 * OpenAlex passes provider text through unsanitized. These cases drive each tool end to end —
 * the real service with only `fetch` stubbed, the real `format()`, and the enrichment trailer
 * the framework appends — and read `content[]` through a CommonMark + GFM parser.
 */
describe('Security — provider text reaching both surfaces (gh #76)', () => {
  const WORK = {
    id: 'https://openalex.org/W1',
    display_name: 'Proto &constructor; | A &lt; B',
    doi: 'https://doi.org/10.1002/(sici)1097-4636(199604)30:4<521::aid-jbm11>3.0.co;2-u',
    primary_location: {
      landing_page_url: 'http://e.x/F?func=service&copy=1&lang=de&not=2&amp;para=3',
      raw_source_name: 'Revision of &lt;i&gt;Genus&lt;/i&gt;',
    },
    keywords: [
      {
        id: 'https://openalex.org/keywords/fish-actinopterygii',
        display_name: 'Fish <Actinopterygii>',
        score: 0.33,
      },
    ],
    authorships: [
      {
        raw_author_name: 'Radovi&cacute; Vesela',
        institutions: [{ display_name: '**Inst** [x](y) &toString;' }],
      },
      { raw_author_name: '&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=y&gt;' },
    ],
    abstract_inverted_index: {
      '[Ir(tpy)(ppy)H](+)': [0],
      complexes: [1],
      '(*plastic)': [2],
      '`code`': [3],
      '5~10': [4],
      '&constructor;': [5],
      '<!--': [6],
      hidden: [7],
      '-->': [8],
      '<jats:italic>x</jats:italic>': [9],
    },
  };

  const NORMALIZED = {
    display_name: 'Proto &constructor; | A < B',
    raw_source_name: 'Revision of Genus',
    raw_author_name: 'Radović Vesela',
    institution: '**Inst** [x](y) &toString;',
    script: '<script>alert(1)</script> <img src=x onerror=y>',
    abstract: '[Ir(tpy)(ppy)H](+) complexes (*plastic) `code` 5~10 &constructor;  x',
  };

  /** W1484087699's abstract around its MathType blob, shortened (gh #92). */
  const MTEF_ABSTRACT =
    'the unit ball % MathType!MTEF!2!1!+- % feaagCart1ev2aqatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn % aWJaaGymaaaa!44A1!]] <![CDATA[$${\\left| {{z_1}} \\right|^2} < 1$$ (see Yau [31])';
  const MTEF_INVERTED_INDEX: Record<string, number[]> = {};
  for (const [position, word] of MTEF_ABSTRACT.split(' ').entries()) {
    MTEF_INVERTED_INDEX[word] = [...(MTEF_INVERTED_INDEX[word] ?? []), position];
  }
  const MTEF_WORK = {
    id: 'https://openalex.org/W2',
    display_name: 'Lines % MathType!MTEF!2!1!+- % aB9+-!37A1! $x$ and surfaces',
    abstract_inverted_index: MTEF_INVERTED_INDEX,
  };

  function route(url: URL): unknown {
    if (url.searchParams.has('group_by')) {
      return {
        meta: { count: 3, groups_count: 3 },
        group_by: [
          {
            key: 'https://openalex.org/S1',
            key_display_name: '# Journal &constructor; *Ann* <genus>',
            count: 2,
          },
          { key: 'https://openalex.org/S2', key_display_name: '- Listy Source', count: 1 },
          { key: 'https://openalex.org/S3', key_display_name: '[ref]: http://x.test', count: 1 },
        ],
      };
    }
    if (url.pathname.startsWith('/autocomplete')) {
      return {
        results: [
          {
            id: 'https://openalex.org/S1',
            display_name: '**Bold** &constructor;',
            entity_type: 'source',
            cited_by_count: 1,
            works_count: 1,
            external_id: null,
            hint: 'Pub <genus> &amp;lt;',
          },
        ],
      };
    }
    if (url.pathname === '/works/W1') return WORK;
    if (url.pathname === '/works/W2') return MTEF_WORK;
    return { meta: { count: 1, per_page: 25, next_cursor: null }, results: [WORK] };
  }

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: URL | string) =>
        Promise.resolve(
          new Response(JSON.stringify(route(new URL(String(input)))), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
    initOpenAlexService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const ALLOWED_NODES = new Set([
    'heading',
    'paragraph',
    'text',
    'strong',
    'list',
    'listItem',
    'link',
  ]);

  /** Every text block of `content[]`, joined the way a client shows them. */
  function contentText(result: { content: unknown[] }): string {
    return result.content
      .map((block) => (block as { type: string; text?: string }).text ?? '')
      .join('\n\n');
  }

  /** Parse-level checks shared by every tool: nothing but text structure, links only autolinks. */
  function expectInertMarkdown(markdown: string) {
    expect(nodeTypes(markdown).filter((t) => !ALLOWED_NODES.has(t))).toEqual([]);
    expect(nonAutolinks(markdown)).toEqual([]);
  }

  it('search: structuredContent carries decoded text; content[] reads it back literally', async () => {
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    const result = await runToolContract(searchEntitiesTool, {
      entity_type: 'works',
      id: 'W1',
      select: ['*'],
    });
    expect(result.isError).toBeFalsy();

    const record = (result.structuredContent as { results: Record<string, unknown>[] })
      .results[0] as Record<string, any>;
    expect(record.display_name).toBe(NORMALIZED.display_name);
    // Identifiers and URLs pass through byte-identical to upstream (gh #94).
    expect(record.doi).toBe(WORK.doi);
    expect(record.primary_location.landing_page_url).toBe(WORK.primary_location.landing_page_url);
    expect(record.primary_location.raw_source_name).toBe(NORMALIZED.raw_source_name);
    expect(record.authorships[0].raw_author_name).toBe(NORMALIZED.raw_author_name);
    expect(record.authorships[0].institutions[0].display_name).toBe(NORMALIZED.institution);
    expect(record.authorships[1].raw_author_name).toBe(NORMALIZED.script);
    expect(record.abstract).toBe(NORMALIZED.abstract);
    expect(record.keywords[0].display_name).toBe('Fish <Actinopterygii>');

    const markdown = contentText(result);
    expectInertMarkdown(markdown);
    const rendered = renderedText(markdown);
    expect(rendered).toContain(`\n${NORMALIZED.display_name}\n`);
    expect(rendered).toContain(`display_name: Fish <Actinopterygii>`);
    expect(rendered).toContain(`raw_source_name: ${NORMALIZED.raw_source_name}`);
    expect(rendered).toContain(`raw_author_name: ${NORMALIZED.raw_author_name}`);
    expect(rendered).toContain(`display_name: ${NORMALIZED.institution}`);
    // A decoded script tag is structuredContent text; in content[] it cannot become live markup.
    expect(rendered).toContain(`raw_author_name: ${NORMALIZED.script}`);
    expect(markdown).toContain('\\<script>alert(1)\\</script> \\<img src=x onerror=y>');
    expect(rendered).toContain(`Abstract: ${NORMALIZED.abstract}`);
    // URL leaves render byte-identical in the raw Markdown.
    expect(markdown).toContain(`**DOI:** ${WORK.doi}`);
    expect(markdown).toContain(`landing_page_url: ${WORK.primary_location.landing_page_url}`);
    expect(markdown).not.toContain('function Object()');
  });

  it('search: a MathType blob leaves both surfaces and its TeX stays (gh #92)', async () => {
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    const result = await runToolContract(searchEntitiesTool, {
      entity_type: 'works',
      id: 'W2',
      select: ['display_name', 'abstract'],
    });
    expect(result.isError).toBeFalsy();

    const abstract = 'the unit ball $${\\left| {{z_1}} \\right|^2} < 1$$ (see Yau [31])';
    const record = (result.structuredContent as { results: Record<string, unknown>[] })
      .results[0] as Record<string, unknown>;
    expect(record.display_name).toBe('Lines $x$ and surfaces');
    expect(record.abstract).toBe(abstract);

    const markdown = contentText(result);
    expect(markdown).not.toContain('MathType');
    expectInertMarkdown(markdown);
    const rendered = renderedText(markdown);
    expect(rendered).toContain('\nLines $x$ and surfaces\n');
    expect(rendered).toContain(`Abstract: ${abstract}`);
  });

  it('citation graph: the same record renders inert through the graph tool', async () => {
    const { getCitationGraphTool } = await import(
      '@/mcp-server/tools/definitions/citation-graph.tool.js'
    );
    const result = await runToolContract(getCitationGraphTool, {
      seed_id: 'W1',
      direction: 'cites',
      select: ['display_name', 'abstract', 'keywords'],
    });
    expect(result.isError).toBeFalsy();
    const record = (result.structuredContent as { results: Record<string, unknown>[] })
      .results[0] as Record<string, unknown>;
    expect(record.display_name).toBe(NORMALIZED.display_name);
    expect(record.abstract).toBe(NORMALIZED.abstract);

    const markdown = contentText(result);
    expectInertMarkdown(markdown);
    const rendered = renderedText(markdown);
    expect(rendered).toContain(`\n${NORMALIZED.display_name}\n`);
    expect(rendered).toContain(`Abstract: ${NORMALIZED.abstract}`);
  });

  it('resolve_name: a bold-wrapped provider name and hint stay literal', async () => {
    const { resolveNameTool } = await import('@/mcp-server/tools/definitions/resolve-name.tool.js');
    const result = await runToolContract(resolveNameTool, {
      query: 'bold',
      entity_type: 'sources',
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { results: unknown[] }).results[0]).toMatchObject({
      display_name: '**Bold** &constructor;',
      hint: 'Pub <genus> &lt;',
    });

    const markdown = contentText(result);
    expectInertMarkdown(markdown);
    const rendered = renderedText(markdown);
    expect(rendered).toContain('**Bold** &constructor; (source)');
    expect(rendered).toContain('| Pub <genus> &lt;');
  });

  it('analyze_trends: labels at the line start stay text; keys stay byte-identical', async () => {
    const { analyzeTrendsTool } = await import(
      '@/mcp-server/tools/definitions/analyze-trends.tool.js'
    );
    const result = await runToolContract(analyzeTrendsTool, {
      entity_type: 'works',
      group_by: 'primary_location.source.id',
    });
    expect(result.isError).toBeFalsy();
    const groups = (result.structuredContent as { groups: { key: string }[] }).groups;
    expect(groups.map((g) => g.key)).toEqual([
      'https://openalex.org/S1',
      'https://openalex.org/S2',
      'https://openalex.org/S3',
    ]);

    const markdown = contentText(result);
    expectInertMarkdown(markdown);
    const rendered = renderedText(markdown);
    expect(rendered).toContain(
      '# Journal &constructor; *Ann* <genus> (https://openalex.org/S1): 2',
    );
    expect(rendered).toContain('- Listy Source (https://openalex.org/S2): 1');
    expect(rendered).toContain('[ref]: http://x.test (https://openalex.org/S3): 1');
  });
});

describe('Security — text scanners run in linear time (gh #76)', () => {
  /**
   * Milliseconds per call on a 5k and an 80k input. Each sample repeats the call until
   * `WORK_CHARS` characters have been processed, so the small size is not lost in timer noise.
   * The two sizes alternate sample by sample, so load from other processes lands on both, and
   * each keeps its fastest of `SAMPLES`, which a burst of load cannot inflate. Linear growth
   * keeps t(80k)/t(5k) near 16; quadratic reaches 256.
   */
  const WORK_CHARS = 400_000;
  const SAMPLES = 7;
  function msPerCall(fn: (s: string) => unknown, input: string): number {
    const reps = Math.ceil(WORK_CHARS / input.length);
    const start = performance.now();
    for (let i = 0; i < reps; i++) fn(input);
    return (performance.now() - start) / reps;
  }
  function perCallMs(fn: (s: string) => unknown, make: (size: number) => string) {
    const small = make(5_000);
    const large = make(80_000);
    let t5k = Number.POSITIVE_INFINITY;
    let t80k = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < SAMPLES; sample++) {
      t5k = Math.min(t5k, msPerCall(fn, small));
      t80k = Math.min(t80k, msPerCall(fn, large));
    }
    return { t5k, t80k };
  }

  function build(unit: string, size: number): string {
    return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  }

  const NORMALIZER_CASES: [string, (size: number) => string][] = [
    ['unclosed <!-- repeated', (n) => build('<!--', n)],
    ['unterminated <tag attr', (n) => build('<span class="a ', n)],
    ['unterminated <i without >', (n) => build('<i ', n)],
    ['a long & run', (n) => build('&', n)],
    ['&name runs without ;', (n) => build('&amp', n)],
    ['numeric &# runs', (n) => build('&#1', n)],
    ['nested re-forming tags', (n) => `${'<'.repeat(n / 2)}${'i>'.repeat(n / 4)}`],
    ['nested openers <a<a<a…>>>', (n) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`],
    ['nested allowlisted openers <i<i<i…>>>', (n) => `${'<i'.repeat(n / 4)}${'>'.repeat(n / 2)}`],
    ['nested openers with attributes', (n) => `${'<span a '.repeat(n / 16)}${'>'.repeat(n / 2)}`],
    ['nested re-forming comments', (n) => `${build('<!-', n / 2)}${build('-->', n / 2)}`],
    ['a lone < before a long tail of >', (n) => `<${'>'.repeat(n - 1)}`],
    ['< runs then > runs', (n) => `${'<'.repeat(n / 2)}${'>'.repeat(n / 2)}`],
    ['block tags', (n) => build('<p>x', n)],
    // gh #89 delimiters
    ['unterminated <![CDATA[ runs', (n) => build('<![CDATA[', n)],
    ['<![CDA + TA[ re-forming across a removed tag', (n) => build('<![CDA<i></i>TA[x]]>', n)],
    ['] runs inside one section', (n) => `<![CDATA[${']'.repeat(n - 9)}`],
    [']] runs inside a section a final ]]> closes', (n) => `<![CDATA[${build(']] ', n - 12)}]]>`],
    ['sections holding ]] before their ]]>', (n) => build('<![CDATA[a]] b]]>', n)],
    [']] closers before openers', (n) => build(']] <![CDATA[x', n)],
    ['empty sections', (n) => build('<![CDATA[]]>', n)],
    [']]> runs with no opener', (n) => `<${build(']]>', n - 1)}`],
    ['<?CDATA without ?>', (n) => build('<?CDATA ', n)],
    ['<?MML without ?>', (n) => build('<?MML ', n)],
    ['<?MML left literal by another <?', (n) => build('<?MML <?', n)],
    ['stray ?> runs after a literal <?MML', (n) => `<?MML <?x ${build('?>', n - 10)}`],
    ['<?MML spans past the cap', (n) => build(`<?MML ${'x'.repeat(130)} ?>`, n)],
    ['<!--inline-formula> runs', (n) => build('<!--inline-formula>', n)],
    ['<!--inline-formula runs without >', (n) => build('<!--inline-formula', n)],
    [
      '<!--inline-formula> runs inside an unclosed comment',
      (n) => `<!-- ${build('<!--inline-formula>', n - 5)}`,
    ],
    ['literal \\n runs', (n) => build('\\n', n)],
    ['literal \\n + blank runs', (n) => build('\\n   ', n)],
    ['backslash runs', (n) => `${'\\'.repeat(n - 1)}n`],
  ];

  const ESCAPE_CASES: [string, (size: number) => string][] = [
    ['underscore runs', (n) => build('_', n)],
    ['entity-like & runs', (n) => build('&amp', n)],
    ['< before letters', (n) => build('<a', n)],
    ['](  pairs', (n) => build('](', n)],
    ['backslash runs', (n) => build('\\', n)],
    ['URL-like runs', (n) => build('https://', n)],
    ['URLs whose trailing _ keeps them unlinked', (n) => build('http://a.co/_(', n)],
    ['URLs inside an open [', (n) => build('[http://a.co ', n)],
    ['URL prefixes inside email literals', (n) => build('a@b.co-http://', n)],
    ['URL prefixes inside an unlinked URL', (n) => `http://a.co/${'http://'.repeat(n / 7)}_`],
    ['whitespace runs', (n) => build(' \n\t', n)],
    ['[ runs ahead of a final ](', (n) => `${'['.repeat(n - 2)}](`],
    ['trailing # runs', (n) => `x ${'#'.repeat(n - 2)}`],
  ];

  it.each(NORMALIZER_CASES)(
    'normalizeProviderText: %s',
    { timeout: 30_000 },
    async (_label, make) => {
      const { normalizeProviderText } = await import('@/services/openalex/provider-text.js');
      const { t5k, t80k } = perCallMs(normalizeProviderText, make);
      expect(t80k / t5k).toBeLessThan(64);
      expect(t80k).toBeLessThan(100);
    },
  );

  it.each(ESCAPE_CASES)('escapeMarkdown: %s', { timeout: 30_000 }, async (_label, make) => {
    const { escapeMarkdown } = await import('@/mcp-server/tools/escape-markdown.js');
    for (const position of ['inline', 'line-start', 'heading'] as const) {
      const { t5k, t80k } = perCallMs((s) => escapeMarkdown(s, position), make);
      expect(t80k / t5k).toBeLessThan(64);
      expect(t80k).toBeLessThan(100);
    }
  });
});

/**
 * MathType blobs, instruction targets ended by any whitespace, `<?MML` spans measured as the
 * output reads them, and the constructs a removal joins all run through `normalizeProviderText`
 * on provider text of any length, so each shape is timed with `expectLinearCpuTime` from 1,250 to
 * 80k characters. (gh #92, #110, #111, #112)
 */
describe('Security — provider-text removals run in linear time (gh #92, #110, #111, #112)', () => {
  const SHAPES: [string, (size: number) => string][] = [
    // gh #92 MathType MTEF blobs
    ['MTEF header runs, no terminator', (n) => build('% MathType!MTEF!2!1!+- ', n)],
    ['glued MTEF header runs, no terminator', (n) => build('%MathType!MTEF!2!1!+-', n)],
    [
      'one MTEF header, then data lines with no terminator',
      (n) =>
        `% MathType!MTEF!2!1!+- ${build('% feaagCart1ev2aqatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn ', n - 23)}`,
    ],
    [
      'MTEF data lines split by newlines',
      (n) =>
        `% MathType!MTEF!2!1!+-\n${build('% hiov2DGi1BTfMBaeXatLxBI9gBaerbd9wDYLwzYbItLDharqqtubsr\n', n - 23)}`,
    ],
    [
      'MTEF data lines split by literal \\n',
      (n) => `% MathType!MTEF!2!1!+-\\n${build('% hiov2DGi1BTfMBaeX\\n', n - 24)}`,
    ],
    [
      'MTEF Translator lines with no header after them',
      (n) => build('% MathType!Translator!2!1!AMS LaTeX.tdl!TeX -- AMS-LaTeX! ', n),
    ],
    ['MTEF near-terminator runs', (n) => build('% MathType!MTEF!2!1!+- % a!ABC ', n)],
    ['MTEF End-line runs', (n) => build('% MathType!End!2!1! ', n)],
    [
      'bare % runs before an MTEF header',
      (n) => `${build('% ', n - 33)}% MathType!MTEF!2!1!+- % a!ABCD!`,
    ],
    ['back-to-back MTEF blobs', (n) => build('% MathType!MTEF!2!1!+- % aaaa!ABCD! ', n)],
    [
      'MTEF headers re-forming across a removed blob',
      (n) => {
        const depth = Math.floor((n - 33) / 32);
        return `${'% Math'.repeat(depth)}% MathType!MTEF!2!1!+- % a!ABCD!${'Type!MTEF!2!1!+- % a!ABCD!'.repeat(depth)}`;
      },
    ],
    // gh #110: any whitespace ends an instruction target
    ['<?CDATA + no-break space + block tag runs', (n) => build('<?CDATA <br/>', n)],
    ['<?MML + no-break space runs', (n) => build('<?MML ', n)],
    ['non-ASCII text through the scanner', (n) => `<i>${build('Ωμέγα 数据 ', n - 3)}`],
    // gh #111: an <?MML span measured as the output reads it
    [
      '<?MML spans holding long blank runs around a block tag',
      (n) => build(`<?MML x${' '.repeat(200)}<br/>${' '.repeat(200)}?>`, n),
    ],
    [
      'stray ?> runs pairing across one long blank run',
      (n) => `<?MML <?CDATA b?>${' '.repeat(n / 2)}<br/>${build(' ?>', n / 2 - 23)}`,
    ],
    [
      '<?MML spans past the cap holding a block tag',
      (n) => build(`<?MML ${'x'.repeat(130)}<br/>?>`, n),
    ],
    ['<?MML spans across literal blank lines', (n) => build('<?MML x\n\n \n\n x ?>', n)],
    ['literal <?MML, <?, blank line, ?> runs', (n) => build('<?MML <? \n\n?>', n)],
    ['blank and CRLF runs inside an <?MML span', (n) => `<?MML ${build('  \r\n', n)}?>`],
    // gh #112: a removal takes away the > or ?> that settled what comes before it
    [
      'a long tag opener reopened by each removed MTEF blob holding a >',
      (n) => `<a ${'x'.repeat(n / 2)}${'%MathType!MTEF!>%!ABCD'.repeat(Math.floor(n / 44))}>`,
    ],
    [
      'a tag opener reopened by each removed <?MML holding a >',
      (n) => `<i${'<?MML >?>'.repeat(Math.floor(n / 9))}>`,
    ],
    [
      'nested tag openers, each reopened by a removed <?MML',
      (n) => `${'<b'.repeat(n / 12)}${'<?MML >?>>'.repeat(n / 12)}`,
    ],
    [
      'an <?MML span past the cap remeasured after each removed comment',
      (n) => `<?MML ${'x'.repeat(130)}${'<!-- ?> -->'.repeat(Math.floor(n / 11))} ?>`,
    ],
    // Line breaks through the paragraph trim
    ['interleaved line breaks in a block', (n) => `<p>${build('§1 x', n)}\ny`],
    ['blank and CRLF runs before a block tag', (n) => `${build('  \r\n', n)}<br/>x`],
  ];

  it.each(SHAPES)('normalizeProviderText: %s', { timeout: 60_000 }, async (_label, make) => {
    const { normalizeProviderText } = await import('@/services/openalex/provider-text.js');
    expectLinearCpuTime(1_250, (size) => cpuMsPerCall(normalizeProviderText, make(size)));
  });
});
