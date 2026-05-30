/**
 * @fileoverview Security tests — verifies that API keys, email addresses (mailto),
 * and other operator-injected credentials never appear in tool outputs or error messages
 * surfaced to MCP clients. Also covers injection attempts in query/filter inputs.
 * @module services/openalex/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('includes mailto in the outgoing URL (polite pool) but not in successful output', async () => {
    const service = await getService();
    const result = await service.search({ entityType: 'works' }, createMockContext());
    // The mailto is sent upstream — verify it appeared in the outgoing URL.
    // fetchWithTimeout calls fetch() with a URL object, so we call .toString() to get the string.
    const call = vi.mocked(globalThis.fetch).mock.lastCall;
    expect(call).toBeDefined();
    const urlString = String(call![0]);
    expect(urlString).toContain('mailto=');
    // But it must not appear in the returned data
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain('mailto');
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
      return !msg.includes(API_KEY) && !msg.includes('mailto');
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
      return !msg.includes(API_KEY) && !msg.includes('mailto');
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
      return !msg.includes(API_KEY) && !msg.includes('mailto');
    });
    await vi.runAllTimersAsync();
    await rejection;
  });

  it('does not leak API key in a network/fetch-failure error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new TypeError(`Failed to fetch https://api.openalex.org/works?mailto=${API_KEY}&search=test`),
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
        return !serialized.includes(API_KEY) && !serialized.includes('mailto');
      },
    );
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
    type AnalyzeResult = Parameters<typeof analyzeTrendsTool.format>[0];

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
    type SearchResult = Parameters<typeof searchEntitiesTool.format>[0];

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
    type AutocompleteResult = Parameters<typeof resolveNameTool.format>[0];

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
