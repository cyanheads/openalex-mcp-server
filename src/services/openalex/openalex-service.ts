/**
 * @fileoverview OpenAlex API client service. Handles all communication with the OpenAlex REST API.
 * @module services/openalex/openalex-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  conflict,
  forbidden,
  invalidParams,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';

import {
  type AnalyzeParams,
  type AnalyzeResult,
  type AutocompleteParams,
  type AutocompleteResult,
  DEFAULT_SELECT,
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
 * Inverted indices are ~2x the token cost of plaintext for the same information, so
 * we collapse them when present and drop the raw index to keep responses lean.
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

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const MAX_UNICODE_CODE_POINT = 0x10ffff;

function codePointToString(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= MAX_UNICODE_CODE_POINT
    ? String.fromCodePoint(code)
    : fallback;
}

/**
 * Decode HTML entities that OpenAlex sometimes returns in `display_name` and similar fields
 * (e.g. `Nature Clinical Practice Gastroenterology &#38; Hepatology`). Handles numeric
 * (`&#38;`), hex (`&#x27E9;`), and the common named entities. The trailing semicolon is
 * optional — upstream sometimes drops it (`&#38 Hepatology`) and HTML5 parsers tolerate
 * this; matching strictly would leave malformed entities literal in the output. Unknown or
 * out-of-range entities pass through unchanged so we never silently corrupt data.
 */
function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;

  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      return codePointToString(Number.parseInt(lower.slice(2), 16), match);
    }
    if (lower.startsWith('#')) {
      return codePointToString(Number.parseInt(lower.slice(1), 10), match);
    }
    return NAMED_HTML_ENTITIES[lower] ?? match;
  });
}

/** Recursively decode HTML entities in every string leaf of a JSON value. */
function deepDecodeHtmlEntities<T>(value: T): T {
  if (typeof value === 'string') return decodeHtmlEntities(value) as T;
  if (Array.isArray(value)) return value.map(deepDecodeHtmlEntities) as T;
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = deepDecodeHtmlEntities(v);
    }
    return next as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasAbstractInvertedIndex(
  record: EntityRecord,
): record is EntityRecord & { abstract_inverted_index: Record<string, number[]> } {
  return isRecord(record.abstract_inverted_index);
}

function normalizeEntityRecord(record: EntityRecord): EntityRecord {
  if (!hasAbstractInvertedIndex(record)) return deepDecodeHtmlEntities(record);

  const { abstract_inverted_index, ...rest } = record;
  // Decode keys via the reconstructed abstract — `deepDecodeHtmlEntities` only walks
  // values, so entities living in inverted-index word keys (e.g. `"&amp;"`) would
  // otherwise survive into the plaintext output.
  return {
    ...deepDecodeHtmlEntities(rest),
    abstract: decodeHtmlEntities(reconstructAbstract(abstract_inverted_index)),
  };
}

function normalizeEntityRecords(results: EntityRecord[]): EntityRecord[] {
  return results.map(normalizeEntityRecord);
}

function normalizeAutocompleteRecords(
  results: AutocompleteResult['results'],
): AutocompleteResult['results'] {
  return results.map((r) => deepDecodeHtmlEntities(r));
}

/**
 * Fields the output schema declares as required on every result item. Always prepended
 * to caller-supplied `select` so the upstream projection can't drop them and break
 * output validation downstream of a successful API call.
 */
const REQUIRED_SEARCH_FIELDS = ['id', 'display_name'] as const;

/**
 * Translate caller-friendly aliases in `select` to the upstream OpenAlex field name and
 * guarantee the schema-required fields (`id`, `display_name`) are always projected.
 * `abstract` is reconstructed from `abstract_inverted_index` in the response — the API
 * itself only accepts the latter — so we accept either on input and forward the upstream
 * name. Keeps tool ergonomics symmetric with the response shape.
 */
function translateSelect(entityType: SearchParams['entityType'], fields: string[]): string[] {
  const withRequired = Array.from(new Set([...REQUIRED_SEARCH_FIELDS, ...fields]));
  if (entityType !== 'works') return withRequired;
  return withRequired.map((field) => (field === 'abstract' ? 'abstract_inverted_index' : field));
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const KNOWN_AUTOCOMPLETE_TYPES = new Set(ENTITY_TYPES.map((type) => type.replace(/s$/, '')));

function hasEntries(record?: Record<string, string>): record is Record<string, string> {
  return record !== undefined && Object.keys(record).length > 0;
}

function parseOpenAlexErrorBody(
  responseBody: unknown,
): { error?: string | undefined; message?: string | undefined } | null {
  if (typeof responseBody !== 'string') return null;

  try {
    const parsed = JSON.parse(responseBody);
    if (!isRecord(parsed)) return null;

    return {
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    };
  } catch {
    return null;
  }
}

function getSearchParamKey(searchMode?: SearchParams['searchMode']): string {
  switch (searchMode) {
    case 'exact':
      return 'search.exact';
    case 'semantic':
      return 'search.semantic';
    default:
      return 'search';
  }
}

function normalizeSort(sort?: string): string | undefined {
  if (!sort) return;
  return sort.startsWith('-') ? `${sort.slice(1)}:desc` : sort;
}

function toRequestContext(ctx: Context, operation: string): RequestContext {
  return {
    requestId: ctx.requestId,
    timestamp: ctx.timestamp,
    operation,
    ...(ctx.auth !== undefined && { auth: ctx.auth }),
    ...(ctx.spanId !== undefined && { spanId: ctx.spanId }),
    ...(ctx.tenantId !== undefined && { tenantId: ctx.tenantId }),
    ...(ctx.traceId !== undefined && { traceId: ctx.traceId }),
  };
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
  private request(path: string, params: Record<string, string>, ctx: Context): Promise<unknown> {
    const operation = `OpenAlex ${path}`;
    const requestContext = toRequestContext(ctx, operation);
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('mailto', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }

    ctx.log.debug('OpenAlex request', { path, params: Object.keys(params) });

    return withRetry(
      async () => {
        try {
          const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, requestContext, {
            headers: { Accept: 'application/json' },
            signal: ctx.signal,
          });
          const text = await response.text();
          return this.parseResponse(text, path);
        } catch (error) {
          this.throwNormalizedRequestError(error, path);
        }
      },
      {
        operation,
        context: requestContext,
        baseDelayMs: BASE_BACKOFF_MS,
        maxRetries: MAX_ATTEMPTS - 1,
        signal: ctx.signal,
      },
    );
  }

  private throwNormalizedRequestError(error: unknown, path: string): never {
    if (!(error instanceof McpError) || typeof error.data?.statusCode !== 'number') {
      throw error;
    }

    const statusCode = error.data.statusCode;
    const upstream = parseOpenAlexErrorBody(error.data.responseBody);
    const message = upstream?.message ?? error.message;
    const data = {
      ...error.data,
      path,
      ...(upstream?.error ? { upstreamError: upstream.error } : {}),
      ...(upstream?.message ? { upstreamMessage: upstream.message } : {}),
    };
    const rethrow = (factory: typeof invalidParams, nextMessage = message): never => {
      throw factory(nextMessage, data, { cause: error });
    };

    switch (statusCode) {
      case 400:
      case 422:
        return rethrow(invalidParams);
      case 401:
        return rethrow(unauthorized);
      case 403:
        return rethrow(forbidden);
      case 404:
        return rethrow(notFound, upstream?.message ?? `Entity not found at ${path}`);
      case 408:
        return rethrow(timeout);
      case 409:
        return rethrow(conflict);
      case 429:
        return rethrow(rateLimited);
      default:
        if (statusCode >= 400 && statusCode < 500) {
          return rethrow(invalidParams);
        }
        throw error;
    }
  }

  private parseResponse<T>(text: string, path: string): T {
    const trimmed = text.trim();
    const responsePreview = trimmed.slice(0, 200);

    if (!trimmed) {
      throw serviceUnavailable(`OpenAlex API returned an empty response for ${path}`, { path });
    }

    if (/^<(!DOCTYPE\s+html|html[\s>])/i.test(trimmed)) {
      throw serviceUnavailable(`OpenAlex API returned HTML instead of JSON for ${path}`, {
        path,
        responsePreview,
      });
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      throw serviceUnavailable(
        `OpenAlex API returned invalid JSON for ${path}`,
        {
          path,
          responsePreview,
        },
        { cause: error },
      );
    }
  }

  /** Search/filter/sort entities, or retrieve a single entity by ID. */
  async search(params: SearchParams, ctx: Context): Promise<SearchResult> {
    // Singleton lookup by ID
    if (params.id) {
      const normalizedId = normalizeId(params.id);
      const queryParams = params.select?.length
        ? { select: translateSelect(params.entityType, params.select).join(',') }
        : {};

      const data = (await this.request(
        `/${params.entityType}/${normalizedId}`,
        queryParams,
        ctx,
      )) as EntityRecord;

      return {
        meta: { count: 1, per_page: 1, next_cursor: null },
        results: normalizeEntityRecords([data]),
      };
    }

    // Search/filter/list
    const queryParams: Record<string, string> = {};

    if (params.query) {
      queryParams[getSearchParamKey(params.searchMode)] = params.query;
    }

    if (hasEntries(params.filters)) {
      queryParams.filter = buildFilterString(params.filters);
    }

    const sort = normalizeSort(params.sort);
    if (sort) {
      // Translate "-field" prefix to "field:desc" (OpenAlex API syntax)
      queryParams.sort = sort;
    }

    const select = translateSelect(
      params.entityType,
      params.select?.length ? params.select : DEFAULT_SELECT[params.entityType],
    );
    if (select.length > 0) {
      queryParams.select = select.join(',');
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
      results: normalizeEntityRecords(data.results),
    };
  }

  /** Group-by aggregation. */
  async analyze(params: AnalyzeParams, ctx: Context): Promise<AnalyzeResult> {
    const queryParams: Record<string, string> = {};

    queryParams.group_by = params.includeUnknown
      ? `${params.groupBy}:include_unknown`
      : params.groupBy;

    if (hasEntries(params.filters)) {
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
      groups: deepDecodeHtmlEntities(data.group_by ?? []),
    };
  }

  /** Autocomplete name resolution. */
  async autocomplete(params: AutocompleteParams, ctx: Context): Promise<AutocompleteResult> {
    const path = params.entityType ? `/autocomplete/${params.entityType}` : '/autocomplete';

    const queryParams: Record<string, string> = {
      q: params.query,
    };

    if (hasEntries(params.filters)) {
      queryParams.filter = buildFilterString(params.filters);
    }

    const data = (await this.request(path, queryParams, ctx)) as {
      results: AutocompleteResult['results'];
    };

    // Cross-entity autocomplete can return types not in our enum (country, license, etc.).
    // Filter to known entity types so callers can use results in other tools directly.
    const results = params.entityType
      ? data.results
      : data.results.filter((r) => KNOWN_AUTOCOMPLETE_TYPES.has(r.entity_type));

    return { results: normalizeAutocompleteRecords(results) };
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
