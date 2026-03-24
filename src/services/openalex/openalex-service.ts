/**
 * @fileoverview OpenAlex API client service. Handles all communication with the OpenAlex REST API.
 * @module services/openalex/openalex-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import type {
  AnalyzeParams,
  AnalyzeResult,
  AutocompleteParams,
  AutocompleteResult,
  EntityRecord,
  SearchParams,
  SearchResult,
} from './types.js';

/**
 * Build an OpenAlex filter string from a key-value record.
 * Input: { "cited_by_count": ">100", "is_oa": "true" }
 * Output: "cited_by_count:>100,is_oa:true"
 */
function buildFilterString(filters: Record<string, string>): string {
  return Object.entries(filters)
    .map(([key, value]) => `${key}:${value}`)
    .join(',');
}

/**
 * Detect ID format and return the API path segment.
 * "10.1038/nature12373" → "doi:10.1038/nature12373"
 * "https://doi.org/10.1038/nature12373" → "doi:10.1038/nature12373"
 * "0000-0002-1825-0097" → "orcid:0000-0002-1825-0097"
 * "https://ror.org/00hx57361" → "ror:https://ror.org/00hx57361"
 * "PMC1234567" → "pmcid:PMC1234567"
 * "W2741809807" → "W2741809807"
 */
function normalizeId(id: string): string {
  const trimmed = id.trim();

  // Full OpenAlex URL
  if (trimmed.startsWith('https://openalex.org/')) {
    return trimmed.replace('https://openalex.org/', '');
  }

  // DOI URL
  if (trimmed.startsWith('https://doi.org/')) {
    return `doi:${trimmed.replace('https://doi.org/', '')}`;
  }

  // DOI pattern (10.xxxx/...)
  if (/^10\.\d{4,}\//.test(trimmed)) {
    return `doi:${trimmed}`;
  }

  // ROR URL
  if (trimmed.startsWith('https://ror.org/')) {
    return `ror:${trimmed}`;
  }

  // ORCID pattern (0000-0000-0000-0000)
  if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(trimmed)) {
    return `orcid:${trimmed}`;
  }

  // ISSN pattern (0000-0000)
  if (/^\d{4}-\d{3}[\dX]$/i.test(trimmed)) {
    return `issn:${trimmed}`;
  }

  // PMCID
  if (/^PMC\d+$/i.test(trimmed)) {
    return `pmcid:${trimmed}`;
  }

  // Pure numeric → PMID
  if (/^\d{5,}$/.test(trimmed)) {
    return `pmid:${trimmed}`;
  }

  // OpenAlex ID or already prefixed — pass through
  return trimmed;
}

/**
 * Reconstruct abstract text from OpenAlex's inverted index format.
 * The API stores abstracts as { word: [position, ...] } — we reverse this to plaintext.
 */
function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(' ');
}

/**
 * Post-process entity records: reconstruct abstracts from inverted indices.
 */
function processResults(results: EntityRecord[]): EntityRecord[] {
  for (const record of results) {
    if (
      record.abstract_inverted_index &&
      typeof record.abstract_inverted_index === 'object' &&
      !Array.isArray(record.abstract_inverted_index)
    ) {
      record.abstract = reconstructAbstract(
        record.abstract_inverted_index as Record<string, number[]>,
      );
      delete record.abstract_inverted_index;
    }
  }
  return results;
}

class OpenAlexService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    const config = getServerConfig();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  /** Execute an HTTP request against the OpenAlex API. */
  private async request(
    path: string,
    params: Record<string, string>,
    ctx: Context,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }

    ctx.log.debug('OpenAlex request', { path, params: Object.keys(params) });

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: ctx.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw serviceUnavailable(`OpenAlex API error: ${response.status} ${response.statusText}`, {
        path,
        status: response.status,
        body,
      });
    }

    return response.json();
  }

  /** Search/filter/sort entities, or retrieve a single entity by ID. */
  async search(params: SearchParams, ctx: Context): Promise<SearchResult> {
    // Singleton lookup by ID
    if (params.id) {
      const normalizedId = normalizeId(params.id);
      const queryParams: Record<string, string> = {};
      if (params.select?.length) {
        queryParams.select = params.select.join(',');
      }

      const data = (await this.request(
        `/${params.entityType}/${normalizedId}`,
        queryParams,
        ctx,
      )) as EntityRecord;

      const results = processResults([data]);
      return {
        meta: { count: 1, per_page: 1, next_cursor: null },
        results,
      };
    }

    // Search/filter/list
    const queryParams: Record<string, string> = {};

    if (params.query) {
      const searchKey =
        params.searchMode === 'exact'
          ? 'search.exact'
          : params.searchMode === 'semantic'
            ? 'search.semantic'
            : 'search';
      queryParams[searchKey] = params.query;
    }

    if (params.filters && Object.keys(params.filters).length > 0) {
      queryParams.filter = buildFilterString(params.filters);
    }

    if (params.sort) {
      queryParams.sort = params.sort;
    }

    if (params.select?.length) {
      queryParams.select = params.select.join(',');
    }

    queryParams.per_page = String(params.perPage ?? 25);

    queryParams.cursor = params.cursor ?? '*';

    const data = (await this.request(`/${params.entityType}`, queryParams, ctx)) as {
      meta: SearchResult['meta'];
      results: EntityRecord[];
    };

    return {
      meta: data.meta,
      results: processResults(data.results),
    };
  }

  /** Group-by aggregation. */
  async analyze(params: AnalyzeParams, ctx: Context): Promise<AnalyzeResult> {
    const queryParams: Record<string, string> = {};

    queryParams.group_by = params.includeUnknown
      ? `${params.groupBy}:include_unknown`
      : params.groupBy;

    if (params.filters && Object.keys(params.filters).length > 0) {
      queryParams.filter = buildFilterString(params.filters);
    }

    if (params.cursor) {
      queryParams.cursor = params.cursor;
    }

    const data = (await this.request(`/${params.entityType}`, queryParams, ctx)) as {
      meta: { count: number; groups_count?: number | null };
      group_by: AnalyzeResult['groups'];
    };

    return {
      meta: {
        count: data.meta.count,
        groups_count: data.meta.groups_count ?? data.group_by?.length ?? null,
        next_cursor: null,
      },
      groups: data.group_by ?? [],
    };
  }

  /** Autocomplete name resolution. */
  async autocomplete(params: AutocompleteParams, ctx: Context): Promise<AutocompleteResult> {
    const path = params.entityType ? `/autocomplete/${params.entityType}` : '/autocomplete';

    const queryParams: Record<string, string> = {
      q: params.query,
    };

    if (params.filters && Object.keys(params.filters).length > 0) {
      queryParams.filter = buildFilterString(params.filters);
    }

    const data = (await this.request(path, queryParams, ctx)) as {
      results: AutocompleteResult['results'];
    };

    return { results: data.results };
  }
}

let _service: OpenAlexService | undefined;

export function initOpenAlexService(): void {
  _service = new OpenAlexService();
}

export function getOpenAlexService(): OpenAlexService {
  if (!_service)
    throw new Error('OpenAlexService not initialized — call initOpenAlexService() in setup()');
  return _service;
}
