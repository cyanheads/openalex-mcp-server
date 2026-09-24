/**
 * @fileoverview Security tests — verifies that the OpenAlex account API key (sent upstream
 * as api_key=), the mailto identifier, and other operator-injected credentials never appear
 * in tool outputs or error messages surfaced to MCP clients. Also covers injection attempts
 * in query/filter inputs, provider text reaching both response surfaces (entity lookups keyed
 * by prototype names, Markdown injection into content[]), and the running time of the text
 * scanners on adversarial input.
 * @module services/openalex/security.test
 */

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

  it('does not leak API key in a network/fetch-failure error', async () => {
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
    landing_page_url: 'http://e.x/F?func=service&copy=1&lang=de&not=2&para=3',
    raw_source_name: 'Revision of Genus',
    raw_author_name: 'Radović Vesela',
    institution: '**Inst** [x](y) &toString;',
    script: '<script>alert(1)</script> <img src=x onerror=y>',
    abstract: '[Ir(tpy)(ppy)H](+) complexes (*plastic) `code` 5~10 &constructor;  x',
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
    expect(record.primary_location.landing_page_url).toBe(NORMALIZED.landing_page_url);
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
    expect(markdown).toContain(`landing_page_url: ${NORMALIZED.landing_page_url}`);
    expect(markdown).not.toContain('function Object()');
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
   * Seconds to process one input of `size` characters, taken as the best of three trials, each
   * repeating the call until `WORK_CHARS` characters have been processed so small sizes are not
   * lost in timer noise. Linear growth keeps t(80k)/t(5k) near 16; quadratic reaches 256.
   */
  const WORK_CHARS = 1_600_000;
  function perCallMs(fn: (s: string) => unknown, input: string): number {
    const reps = Math.max(1, Math.ceil(WORK_CHARS / input.length));
    let best = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < 3; trial++) {
      const start = performance.now();
      for (let i = 0; i < reps; i++) fn(input);
      best = Math.min(best, (performance.now() - start) / reps);
    }
    return best;
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

  it.each(NORMALIZER_CASES)('normalizeProviderText: %s', async (_label, make) => {
    const { normalizeProviderText } = await import('@/services/openalex/provider-text.js');
    const t5k = perCallMs(normalizeProviderText, make(5_000));
    const t80k = perCallMs(normalizeProviderText, make(80_000));
    expect(t80k / t5k).toBeLessThan(64);
    expect(t80k).toBeLessThan(100);
  });

  it.each(ESCAPE_CASES)('escapeMarkdown: %s', async (_label, make) => {
    const { escapeMarkdown } = await import('@/mcp-server/tools/escape-markdown.js');
    for (const position of ['inline', 'line-start', 'heading'] as const) {
      const run = (s: string) => escapeMarkdown(s, position);
      const t5k = perCallMs(run, make(5_000));
      const t80k = perCallMs(run, make(80_000));
      expect(t80k / t5k).toBeLessThan(64);
      expect(t80k).toBeLessThan(100);
    }
  });
});
