/**
 * @fileoverview OpenAlex API client service. Handles all communication with the OpenAlex REST API.
 * @module services/openalex/openalex-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  conflict,
  forbidden,
  invalidParams,
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, httpStatusToErrorCode, withRetry } from '@cyanheads/mcp-ts-core/utils';

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
import { redactUrlsInMessage } from './url-redaction.js';

/**
 * OpenAlex group_by fields that produce only true/false groups and reject
 * cursor pagination (HTTP 400). These fields never have more than two groups,
 * so cursor-based paging is unnecessary and the upstream rejects `cursor=*`.
 */
const BOOLEAN_GROUP_BY_FIELDS = new Set([
  'is_retracted',
  'is_paratext',
  'is_oa',
  'has_orcid',
  'has_doi',
  'has_raw_affiliation_string',
  'open_access.is_oa',
  'apc_paid',
  'has_fulltext',
]);

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
export function normalizeId(id: string): string {
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
 * Works-only `select` field aliases. LLM callers reach for intuitive names that don't match
 * OpenAlex's vocabulary; renaming on the way out keeps tool ergonomics aligned with caller
 * priors. Pure key renames — no value transformation. Canonical names pass through unchanged.
 */
const SELECT_ALIASES_WORKS: Record<string, string> = {
  abstract: 'abstract_inverted_index',
  authors: 'authorships',
  year: 'publication_year',
};

/**
 * Works-only `filter` key aliases. Same shape as `SELECT_ALIASES_WORKS` — LLM callers reach
 * for `cited_works` (the semantic phrasing) and `year` (universal in REST), neither of which
 * upstream accepts. Renames are fail-open: misses pass through to upstream and surface its
 * helpful 400 with the valid-field list.
 */
const FILTER_ALIASES_WORKS: Record<string, string> = {
  cited_works: 'cites',
  year: 'publication_year',
};

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
  return withRequired.map((field) => SELECT_ALIASES_WORKS[field] ?? field);
}

/**
 * Match a single bare or URL-form OpenAlex ID. Combined with pipe-splitting in
 * `isOpenAlexFilterValue` to detect OR-joined ID lists.
 */
const OPENALEX_ID_VALUE_PATTERN = /^(?:https:\/\/openalex\.org\/)?[WAISTKPFCG]\d+$/;

/**
 * Detect a value the `id:` filter would carry — a bare or URL-form OpenAlex ID, optionally
 * pipe-joined for OR semantics. When matched, we rewrite `id` → `openalex` (the canonical
 * filter key); the URL form passes through unchanged because upstream accepts both.
 * Stricter than a single regex so a future generic upstream `id:` filter wouldn't be shadowed
 * by our rewrite — only values that look like OpenAlex IDs get redirected.
 */
function isOpenAlexFilterValue(value: string): boolean {
  return value.split('|').every((seg) => OPENALEX_ID_VALUE_PATTERN.test(seg));
}

/**
 * Rewrite caller-supplied filter keys to the upstream OpenAlex names. Works-only key map plus
 * a universal `id` → `openalex` rewrite when the value looks like an OpenAlex ID. Values pass
 * through unchanged. Misses fall through so upstream's 400 with the valid-field list still
 * fires for typos no map can preempt.
 */
function translateFilters(
  entityType: SearchParams['entityType'],
  filters: Record<string, string>,
): Record<string, string> {
  const aliases = entityType === 'works' ? FILTER_ALIASES_WORKS : undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(filters)) {
    const aliased = aliases?.[rawKey] ?? rawKey;
    const finalKey = aliased === 'id' && isOpenAlexFilterValue(value) ? 'openalex' : aliased;
    out[finalKey] = value;
  }
  return out;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const KNOWN_AUTOCOMPLETE_TYPES = new Set(ENTITY_TYPES.map((type) => type.replace(/s$/, '')));

type ErrorFactory = (
  message: string,
  data?: Record<string, unknown>,
  options?: ErrorOptions,
) => McpError;

/**
 * `JsonRpcErrorCode` → `{ factory, reason }` for shaping normalized OpenAlex throws.
 * Driven by `httpStatusToErrorCode` so the status-table stays in lockstep with the
 * framework. `reason` is the literal carried on `data.reason` and matched against
 * tool contracts via `ctx.recoveryFor`.
 */
const NORMALIZED_THROW_BY_CODE: Partial<
  Record<JsonRpcErrorCode, { factory: ErrorFactory; reason: string }>
> = {
  [JsonRpcErrorCode.InvalidParams]: { factory: invalidParams, reason: 'upstream_invalid_params' },
  [JsonRpcErrorCode.InvalidRequest]: {
    factory: invalidRequest,
    reason: 'upstream_invalid_request',
  },
  [JsonRpcErrorCode.Unauthorized]: { factory: unauthorized, reason: 'upstream_unauthorized' },
  [JsonRpcErrorCode.Forbidden]: { factory: forbidden, reason: 'upstream_forbidden' },
  [JsonRpcErrorCode.NotFound]: { factory: notFound, reason: 'entity_not_found' },
  [JsonRpcErrorCode.Timeout]: { factory: timeout, reason: 'upstream_timeout' },
  [JsonRpcErrorCode.Conflict]: { factory: conflict, reason: 'upstream_conflict' },
  [JsonRpcErrorCode.ValidationError]: {
    factory: validationError,
    reason: 'upstream_validation_failed',
  },
  [JsonRpcErrorCode.RateLimited]: { factory: rateLimited, reason: 'rate_limited' },
  [JsonRpcErrorCode.ServiceUnavailable]: {
    factory: serviceUnavailable,
    reason: 'upstream_unavailable',
  },
};

function hasEntries(record?: Record<string, string>): record is Record<string, string> {
  return record !== undefined && Object.keys(record).length > 0;
}

/**
 * Surface OpenAlex's per-request cost and DB latency at debug level. Both live in
 * `meta` on every list/group/single-entity response and stay in the parsed payload
 * — they aren't stripped on the way out because the per-tool output schemas don't
 * declare them, so zod drops them at the MCP boundary regardless. Operators with
 * debug logging on get per-request observability without changing the wire shape.
 */
function logResponseMetrics(parsed: unknown, path: string, ctx: Context): void {
  if (!isRecord(parsed)) return;
  const meta = parsed.meta;
  if (!isRecord(meta)) return;

  const cost = typeof meta.cost_usd === 'number' ? meta.cost_usd : undefined;
  const db = typeof meta.db_response_time_ms === 'number' ? meta.db_response_time_ms : undefined;
  if (cost === undefined && db === undefined) return;

  ctx.log.debug('OpenAlex response metrics', {
    path,
    ...(cost !== undefined && { costUsd: cost }),
    ...(db !== undefined && { dbResponseTimeMs: db }),
  });
}

/**
 * Permissive extractors for OpenAlex's `error` and `message` fields when the body
 * is truncated mid-string (framework caps `responseBody` at 500 bytes; OpenAlex
 * valid-fields listings exceed ~1 KB). The terminator `"|…|$` accepts a closing
 * quote, the framework's truncation ellipsis, or end of string — so whatever
 * survived the cap still gets extracted.
 */
const TRUNCATED_ERROR_FIELD_RE = /"error"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|…|$)/;
const TRUNCATED_MESSAGE_FIELD_RE = /"message"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|…|$)/;

/**
 * Extract OpenAlex's `error` and `message` fields from a response body. JSON.parse
 * works for un-truncated bodies; falls back to regex so the useful prefix of the
 * upstream message still reaches the caller when the body was cut mid-string.
 * `truncated` distinguishes the two paths so downstream sanitization can act only
 * on bodies that were actually cut.
 */
function parseOpenAlexErrorBody(
  responseBody: unknown,
): { error?: string | undefined; message?: string | undefined; truncated: boolean } | null {
  if (typeof responseBody !== 'string') return null;

  try {
    const parsed = JSON.parse(responseBody);
    if (!isRecord(parsed)) return null;

    return {
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      truncated: false,
    };
  } catch {
    const error = TRUNCATED_ERROR_FIELD_RE.exec(responseBody)?.[1];
    const message = TRUNCATED_MESSAGE_FIELD_RE.exec(responseBody)?.[1];
    if (error === undefined && message === undefined) return null;
    return { error, message, truncated: true };
  }
}

/**
 * OpenAlex 400 messages append an alphabetically-sorted enumeration of valid field
 * names ("Valid fields are: a, b, c, ..."). When the response body was truncated
 * mid-list the surviving prefix misleads agents into believing the early-alphabet
 * fields are the complete set. Strip the list when truncation occurred — the raw
 * upstream prefix stays available on `data.upstreamMessage` for debugging.
 */
const VALID_FIELDS_BOUNDARY_RE = /\s*Valid fields\b.*/is;
function stripTruncatedValidFieldsList(message: string): string {
  if (!VALID_FIELDS_BOUNDARY_RE.test(message)) return message;
  return `${message.replace(VALID_FIELDS_BOUNDARY_RE, '').trim()} (list of valid fields omitted — was truncated upstream; see OpenAlex docs)`;
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
  if (sort.startsWith('-')) return `${sort.slice(1)}:desc`;
  if (sort === 'relevance_score') return 'relevance_score:desc';
  return sort;
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
    if (this.apiKey) url.searchParams.set('mailto', this.apiKey);
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
          const parsed = this.parseResponse(text, path);
          logResponseMetrics(parsed, path, ctx);
          return parsed;
        } catch (error) {
          this.throwNormalizedRequestError(error, path, ctx);
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

  private throwNormalizedRequestError(error: unknown, path: string, ctx: Context): never {
    if (!(error instanceof McpError)) {
      throw error;
    }

    const statusCode =
      typeof error.data?.statusCode === 'number' ? error.data.statusCode : undefined;
    const code = statusCode === undefined ? undefined : httpStatusToErrorCode(statusCode);
    const normalized = code === undefined ? undefined : NORMALIZED_THROW_BY_CODE[code];

    if (normalized === undefined) {
      // Framework fetch errors (network, timeout, unmapped status) format the message as
      // `Fetch failed for <URL>. Status: …` — the URL carries the polite-pool `mailto`
      // and any future internal params. Redact before bubbling.
      throw new McpError(error.code, redactUrlsInMessage(error.message), error.data, {
        cause: error,
      });
    }

    const { factory, reason } = normalized;
    const upstream = parseOpenAlexErrorBody(error.data?.responseBody);
    const rawMessage = upstream?.message ?? upstream?.error;
    const sanitizedMessage =
      rawMessage !== undefined && upstream?.truncated
        ? stripTruncatedValidFieldsList(rawMessage)
        : rawMessage;
    const message =
      sanitizedMessage ??
      (code === JsonRpcErrorCode.NotFound
        ? `Entity not found at ${path}`
        : redactUrlsInMessage(error.message));

    const data = {
      ...error.data,
      path,
      reason,
      ...ctx.recoveryFor(reason),
      ...(upstream?.error ? { upstreamError: upstream.error } : {}),
      ...(upstream?.message ? { upstreamMessage: upstream.message } : {}),
    };

    throw factory(message, data, { cause: error });
  }

  private parseResponse<T>(text: string, path: string): T {
    const trimmed = text.trim();
    const responsePreview = trimmed.slice(0, 200);

    if (!trimmed) {
      throw serviceUnavailable(`OpenAlex API returned an empty response for ${path}`, {
        path,
        reason: 'upstream_unavailable',
      });
    }

    if (/^<(!DOCTYPE\s+html|html[\s>])/i.test(trimmed)) {
      throw serviceUnavailable(`OpenAlex API returned HTML instead of JSON for ${path}`, {
        path,
        responsePreview,
        reason: 'upstream_unavailable',
      });
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      // Treated as ServiceUnavailable (not SerializationError) so withRetry's
      // transient set picks it up — OpenAlex truncates responses under load and
      // the next attempt usually succeeds.
      throw serviceUnavailable(
        `OpenAlex API returned invalid JSON for ${path}`,
        {
          path,
          responsePreview,
          reason: 'upstream_unavailable',
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
      queryParams.filter = buildFilterString(translateFilters(params.entityType, params.filters));
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

    // Sampling overrides per_page — upstream truncates results at per_page even when
    // sample is larger, which silently drops samples the caller asked for. Aligning the
    // two means callers get exactly `sample` results in a single page.
    if (params.sample !== undefined) {
      queryParams.sample = String(params.sample);
      queryParams.per_page = String(params.sample);
      if (params.seed !== undefined) queryParams.seed = params.seed;
    } else {
      queryParams.per_page = String(params.perPage ?? 25);
    }

    // Semantic search doesn't support cursor pagination — use page/per_page only.
    // Sampling returns one page only — cursor is mutually exclusive (enforced at the tool
    // layer; the service never sends both).
    if (params.searchMode !== 'semantic' && params.sample === undefined) {
      queryParams.cursor = params.cursor ?? '*';
    }

    const searchRequest = this.request(`/${params.entityType}`, queryParams, ctx) as Promise<{
      meta: SearchResult['meta'];
      results: EntityRecord[];
    }>;

    // Sampling: OpenAlex returns the sample size in `meta.count`, not the population
    // matching the filters. The output schema documents `count` as "Total results
    // matching the query/filters" — issue a parallel per_page=1 lookup without
    // `sample` to recover the true population and overwrite `count` with it.
    let populationRequest: Promise<{ meta: { count: number } }> | undefined;
    if (params.sample !== undefined) {
      const { sample: _sample, seed: _seed, ...filterParams } = queryParams;
      populationRequest = this.request(
        `/${params.entityType}`,
        { ...filterParams, per_page: '1', cursor: '*' },
        ctx,
      ) as Promise<{ meta: { count: number } }>;
    }

    const [data, populationData] = await Promise.all([searchRequest, populationRequest]);

    return {
      meta: {
        ...data.meta,
        ...(populationData !== undefined && { count: populationData.meta.count }),
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
      queryParams.filter = buildFilterString(translateFilters(params.entityType, params.filters));
    }

    if (params.perPage !== undefined) {
      queryParams.per_page = String(params.perPage);
    }

    // Boolean group_by fields (is_retracted, has_orcid, etc.) only produce
    // two groups (true/false) and reject cursor pagination with a 400.
    // All other fields require cursor=* on the first request to enable
    // cursor-based pagination — without it, next_cursor is never returned.
    const baseField = params.groupBy.replace(/:include_unknown$/, '');
    const isBooleanGroupBy = BOOLEAN_GROUP_BY_FIELDS.has(baseField);

    if (params.cursor) {
      queryParams.cursor = params.cursor;
    } else if (!isBooleanGroupBy) {
      queryParams.cursor = '*';
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
