/**
 * @fileoverview OpenAlex API client service. Handles all communication with the OpenAlex REST API.
 * @module services/openalex/openalex-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

import { getServerConfig } from '@/config/server-config.js';

import {
  type AnalyzeParams,
  type AnalyzeResult,
  type AutocompleteParams,
  type AutocompleteResult,
  ENTITY_TYPES,
  type EntityRecord,
  type SearchParams,
  type SearchResult,
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

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class OpenAlexService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    const config = getServerConfig();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  /** Execute an HTTP request against the OpenAlex API with retry on transient failures. */
  private async request(
    path: string,
    params: Record<string, string>,
    ctx: Context,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('mailto', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }

    ctx.log.debug('OpenAlex request', { path, params: Object.keys(params) });

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: ctx.signal,
      });

      if (response.ok) return response.json();

      if (response.status === 404) {
        throw notFound(`Entity not found at ${path}`, { path, status: 404 });
      }

      const retryable = response.status === 429 || response.status === 500 ||
        response.status === 502 || response.status === 503 || response.status === 504;
      if (retryable && attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }

      const body = await response.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(body);
        detail = parsed.message ?? '';
      } catch {
        detail = body
          .replace(/<[^>]*>/g, '')
          .trim()
          .slice(0, 200);
      }
      const message = detail
        ? `OpenAlex API error (${response.status}): ${detail}`
        : `OpenAlex API error: ${response.status} ${response.statusText}`;
      throw serviceUnavailable(message, { path, status: response.status });
    }

    throw serviceUnavailable(`OpenAlex API request failed after ${MAX_RETRIES} attempts`, { path });
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
      // Translate "-field" prefix to "field:desc" (OpenAlex API syntax)
      queryParams.sort = params.sort.startsWith('-') ? `${params.sort.slice(1)}:desc` : params.sort;
    }

    if (params.select?.length) {
      queryParams.select = params.select.join(',');
    }

    queryParams.per_page = String(params.perPage ?? 25);

    // Semantic search doesn't support cursor pagination — use page/per_page only
    if (params.searchMode !== 'semantic') {
      queryParams.cursor = params.cursor ?? '*';
    }

    const data = (await this.request(`/${params.entityType}`, queryParams, ctx)) as {
      meta: SearchResult['meta'];
      results: EntityRecord[];
    };

    return {
      meta: {
        ...data.meta,
        next_cursor: data.meta.next_cursor ?? null,
      },
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

    // Only send cursor when explicitly provided — boolean group_by fields
    // (is_retracted, has_orcid, etc.) reject cursor pagination entirely.
    if (params.cursor) {
      queryParams.cursor = params.cursor;
    }

    const data = (await this.request(`/${params.entityType}`, queryParams, ctx)) as {
      meta: { count: number; groups_count?: number | null; next_cursor?: string | null };
      group_by: AnalyzeResult['groups'];
    };

    return {
      meta: {
        count: data.meta.count,
        groups_count: data.meta.groups_count ?? data.group_by?.length ?? null,
        next_cursor: data.meta.next_cursor ?? null,
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

    // Cross-entity autocomplete can return types not in our enum (country, license, etc.).
    // Filter to known entity types so callers can use results in other tools directly.
    const knownTypes = new Set<string>(ENTITY_TYPES.map((t) => t.replace(/s$/, '')));
    const results = params.entityType
      ? data.results
      : data.results.filter((r) => knownTypes.has(r.entity_type));

    return { results };
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
