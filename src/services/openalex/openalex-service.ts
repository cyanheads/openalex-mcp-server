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

import { mergeUpstreamBudget, parseUpstreamBudget, type UpstreamBudget } from './budget.js';
import fieldCatalog from './field-catalog.json' with { type: 'json' };
import { rankFields } from './field-ranker.js';
import {
  type AnalyzeParams,
  type AnalyzeResult,
  type AutocompleteParams,
  type AutocompleteResult,
  DEFAULT_SELECT,
  ENTITY_TYPES,
  type EntityRecord,
  type EntityType,
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
 *
 * Comma handling (commas collide with OpenAlex's filter clause separator):
 * - `*.search` keys: wrap the value in double quotes for faithful phrase passthrough
 *   (skip if already quoted).
 * - All other keys: throw a pre-flight validation error — OpenAlex OR-lists use `|`, not commas.
 */
function buildFilterString(filters: Record<string, string>, ctx: Context): string {
  return Object.entries(filters)
    .map(([key, value]) => {
      if (value.includes(',')) {
        if (key.endsWith('.search')) {
          // Phrase passthrough: double-quote wrapping preserves the comma as free-text.
          const quoted = value.startsWith('"') && value.endsWith('"') ? value : `"${value}"`;
          return `${key}:${quoted}`;
        }
        // Non-search key: comma is a caller error — OpenAlex uses | for OR, not comma.
        throw invalidParams(
          `Filter \`${key}\` value contains a comma, which OpenAlex reads as a filter separator. Use \`|\` for OR (e.g. \`2020|2021\`), or a \`.search\` filter or the \`query\` parameter for free text.`,
          {
            ...ctx.recoveryFor('comma_in_filter_value'),
            reason: 'comma_in_filter_value',
            filterKey: key,
          },
        );
      }
      return `${key}:${value}`;
    })
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
 * Resolve the upstream `select` projection for an entity request — applied identically to
 * single-entity ID lookups and search/filter/list calls.
 *
 * - omitted or empty → the curated `DEFAULT_SELECT` for the entity type, keeping responses lean
 *   (full records run 20-70 KB);
 * - contains `'*'` → the full record: returns `undefined` so the caller omits `select` entirely
 *   (OpenAlex has no `select=*` wildcard — the sentinel is consumed here, not forwarded);
 * - explicit field list → those fields, with `id`/`display_name` guaranteed and works aliases
 *   translated.
 */
function resolveSelect(
  entityType: SearchParams['entityType'],
  select: string[] | undefined,
): string[] | undefined {
  if (select?.includes('*')) return;
  return translateSelect(entityType, select?.length ? select : DEFAULT_SELECT[entityType]);
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
 * Running budget total for one tool call, keyed by the request `Context` every request in
 * that call shares. A tool call can bill several upstream requests, and `ctx.enrich` is
 * last-wins per key, so the accumulator is what makes the reported cost the sum rather than
 * the final response's line item. Entries are collected with the context.
 */
const budgetByContext = new WeakMap<Context, UpstreamBudget>();

/**
 * Fold one response's accounting into the tool call's total and re-publish it as enrichment.
 * `ctx.enrich` is callable from the service layer and reaches `structuredContent` exactly as
 * if the handler had written it, so the four upstream-calling tools get the field by declaring
 * it — no per-handler plumbing, and multi-request tools report the true total.
 */
function recordBudget(budget: UpstreamBudget, ctx: Context): void {
  const total = mergeUpstreamBudget(budgetByContext.get(ctx), budget);
  budgetByContext.set(ctx, total);
  ctx.enrich({ budget: total });
}

/**
 * Surface OpenAlex's per-request budget accounting and DB latency at debug level, so
 * operators get per-request observability alongside what the caller sees. `db_response_time_ms`
 * has no header equivalent and lives in `meta` — absent on singleton lookups, which carry no
 * `meta` wrapper — while the budget figures come from the headers, which every shape carries.
 */
function logResponseMetrics(
  parsed: unknown,
  budget: UpstreamBudget | undefined,
  path: string,
  ctx: Context,
): void {
  const meta = isRecord(parsed) ? parsed.meta : undefined;
  const db =
    isRecord(meta) && typeof meta.db_response_time_ms === 'number'
      ? meta.db_response_time_ms
      : undefined;
  if (budget === undefined && db === undefined) return;

  ctx.log.debug('OpenAlex response metrics', {
    path,
    ...(budget !== undefined && {
      costUsd: budget.costUsd,
      budgetRemainingUsd: budget.remainingUsd,
      budgetResetsInSeconds: budget.resetsInSeconds,
    }),
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

/**
 * Regex to extract the rejected field name from an OpenAlex 400 message.
 * Matches patterns like:
 *   "funder is not a valid field for group_by"
 *   "totally_made_up_field is not a valid select field"
 *   "nonexistent_filter is not a valid field"
 * Capture group 1 = the rejected field name.
 */
const REJECTED_FIELD_RE = /^([a-z0-9_.]+)\s+is not a valid/i;

/**
 * OpenAlex 400 emitted when a relevance-score sort is requested without an active search
 * (no `query` and no `*.search` filter): "Must include a search query (such as ?search=…)
 * in order to sort by relevance_score." Names no rejected field, so `describe_fields` is the
 * wrong next move — the caller needs a search, not a corrected field name.
 */
const SORT_REQUIRES_SEARCH_RE = /must include a search query/i;

/**
 * OpenAlex 400 emitted when group_by targets a field it cannot aggregate — a raw date, a
 * float, or a `*.search` operator: "Cannot group by date, number, or search fields." Names
 * no rejected field; the caller needs a categorical/year field, not a corrected name.
 */
const UNGROUPABLE_GROUP_BY_RE = /cannot group by/i;

/**
 * OpenAlex 400 emitted when an entity-ID filter receives something that isn't an ID —
 * typically a name: "'Albert' is not a valid OpenAlex ID." (upstream splits the value on
 * whitespace before validating, so only the first token is named). The fix is to resolve
 * the name to an ID first, which no other 400 shape's recovery says.
 */
const INVALID_ID_VALUE_RE = /is not a valid OpenAlex ID/i;

/**
 * A single upstream HTTP 400 spans several distinct failure shapes, each needing a different
 * caller recovery. Pick the declared tool reason from the message shape so the per-tool
 * `recovery` hint (resolved via `ctx.recoveryFor`) matches the actual failure instead of
 * always claiming a rejected field name. Ordering: the ID-value check runs first because it
 * is the only shape naming a concrete upstream concept; the field-name check is anchored at
 * string start; the rest are keyword probes; anything unmatched falls through to a neutral
 * `_other` reason so no shape inherits the field-name recovery by default.
 */
function classifyInvalidParamsReason(rawMessage: string | undefined): string {
  if (rawMessage !== undefined) {
    if (INVALID_ID_VALUE_RE.test(rawMessage)) return 'upstream_invalid_id_value';
    if (REJECTED_FIELD_RE.test(rawMessage)) return 'upstream_invalid_params';
    if (SORT_REQUIRES_SEARCH_RE.test(rawMessage)) return 'upstream_sort_requires_search';
    if (UNGROUPABLE_GROUP_BY_RE.test(rawMessage)) return 'upstream_ungroupable_group_by';
  }
  return 'upstream_invalid_params_other';
}

/** Reason for a 429 caused by daily-budget exhaustion rather than burst throttling. */
const BUDGET_EXHAUSTED_REASON = 'upstream_budget_exhausted';

/**
 * OpenAlex returns 429 for two unrelated conditions: bursting past its per-second ceiling,
 * and spending the daily usage budget. The recoveries are opposites — one clears in seconds,
 * the other not until the midnight-UTC reset — so they need separate reasons.
 *
 * The literal budget-exhaustion body is not published in OpenAlex's docs, so the match is
 * deliberately loose: several independent signals, none of them load-bearing on an exact
 * wording. The burst-throttle bodies carry none of these tokens.
 */
const BUDGET_EXHAUSTED_RE = /insufficient budget|resets at midnight|budget[^.]*remaining/i;

/** Discriminate the two upstream 429 shapes on the message; default to burst throttling. */
function classifyRateLimitReason(rawMessage: string | undefined): string {
  if (rawMessage !== undefined && BUDGET_EXHAUSTED_RE.test(rawMessage)) {
    return BUDGET_EXHAUSTED_REASON;
  }
  return 'rate_limited';
}

/**
 * Pick the reason for a normalized throw. Two upstream statuses carry several distinct
 * failure shapes under one error code — 400 (rejected field / relevance sort without a
 * search / ungroupable group_by / non-ID filter value) and 429 (burst throttle vs. spent
 * daily budget) — and each shape needs its own caller recovery, so both discriminate on the
 * upstream message. Every other code maps to a single reason.
 */
function resolveThrowReason(
  code: JsonRpcErrorCode,
  mappedReason: string,
  rawMessage: string | undefined,
): string {
  if (code === JsonRpcErrorCode.InvalidParams) return classifyInvalidParamsReason(rawMessage);
  if (code === JsonRpcErrorCode.RateLimited) return classifyRateLimitReason(rawMessage);
  return mappedReason;
}

/**
 * Domain-language replacement for the framework's fetch-plumbing message on the failures
 * that never carry an HTTP status. `fetch GET <url> timed out.` describes this client, not
 * the upstream; the caller needs to read that OpenAlex did not answer.
 */
function domainMessageForFetchFailure(error: McpError, path: string): string | undefined {
  switch (error.data?.errorSource) {
    case 'FetchTimeout':
      return `OpenAlex did not respond within ${REQUEST_TIMEOUT_MS / 1000}s for ${path}`;
    case 'FetchNetworkError':
    case 'FetchNetworkErrorWrapper':
      return `Could not reach the OpenAlex API for ${path}`;
    default:
      return;
  }
}

/**
 * Context keywords in the upstream 400 message mapped to the catalog lookup key.
 * OpenAlex uses "filter" and "group_by" / "select" in its messages.
 */
function inferContext(message: string): 'filter' | 'select' {
  return /\bselect\b/i.test(message) ? 'select' : 'filter';
}

/**
 * Derive the entity type from the API path (e.g., "/works" → "works").
 * Falls back to undefined when the path doesn't match a known entity type.
 */
function entityTypeFromPath(path: string): EntityType | undefined {
  const segment = path.replace(/^\//, '').split('/')[0];
  return ENTITY_TYPES.includes(segment as EntityType) ? (segment as EntityType) : undefined;
}

/**
 * Append ranked field suggestions and a describe_fields pointer to an
 * `upstream_invalid_params` error message when a rejected field name is
 * extractable from the upstream body.
 */
function appendFieldSuggestions(message: string, path: string): string {
  const match = REJECTED_FIELD_RE.exec(message);
  if (!match?.[1]) return message;

  const rejectedField = match[1];
  const entityType = entityTypeFromPath(path);
  if (!entityType) return message;

  const context = inferContext(message);
  const catalogEntry = (fieldCatalog as Record<string, { filter: string[]; select: string[] }>)[
    entityType
  ];
  if (!catalogEntry) return message;

  const pool = catalogEntry[context];
  const suggestions = rankFields(rejectedField, pool, 3);
  if (suggestions.length === 0) return message;

  const base = VALID_FIELDS_BOUNDARY_RE.test(message)
    ? message.replace(VALID_FIELDS_BOUNDARY_RE, '').trim()
    : message;

  return `${base} Did you mean: ${suggestions.join(', ')}? Browse all with openalex_describe_fields(entity_type, context).`;
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

/**
 * Translate one sort key to OpenAlex syntax: a leading `-` becomes a `:desc` suffix, and a
 * bare `relevance_score` is coerced to descending (ascending relevance is never the intent).
 * Anything else — including a key that already carries `:desc` — passes through.
 */
function normalizeSortKey(key: string): string {
  if (key.startsWith('-')) return `${key.slice(1)}:desc`;
  if (key === 'relevance_score') return 'relevance_score:desc';
  return key;
}

/**
 * OpenAlex accepts comma-separated sort keys (`publication_year:desc,cited_by_count`), so
 * each key is normalized independently. Treating the value as a single field moved the
 * descending marker onto the last key, silently flipping the dash-prefixed one to ascending.
 */
function normalizeSort(sort?: string): string | undefined {
  if (!sort) return;
  return sort
    .split(',')
    .map((key) => normalizeSortKey(key.trim()))
    .join(',');
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
  private readonly mailto: string;

  constructor() {
    const config = getServerConfig();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.mailto = config.mailto;
  }

  /** Execute an HTTP request against the OpenAlex API with retry on transient failures. */
  private request(path: string, params: Record<string, string>, ctx: Context): Promise<unknown> {
    const operation = `OpenAlex ${path}`;
    const requestContext = toRequestContext(ctx, operation);
    const url = new URL(`${this.baseUrl}${path}`);
    // OpenAlex usage-based pricing (Feb 2026): the account credential authenticates as
    // `api_key=`. `mailto=` is now only a courtesy identifier (no budget/rate effect), sent
    // independently when OPENALEX_MAILTO is set. Both are stripped from any URL that surfaces
    // in an error by the url-redaction allowlist (neither is a caller-controlled param).
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    if (this.mailto) url.searchParams.set('mailto', this.mailto);
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
          // Only 2xx responses reach here — `fetchWithTimeout` throws on anything else, so a
          // throttled or budget-exhausted call surfaces through the error contract instead.
          const budget = parseUpstreamBudget(response.headers);
          // Recorded before the body is parsed: OpenAlex bills a 200 whether or not its
          // payload survives (it truncates under load), and `parseResponse` throws on a
          // truncated body. Recording after would drop the cost of every attempt that
          // gets retried, under-reporting the call's real spend.
          if (budget) recordBudget(budget, ctx);
          const text = await response.text();
          const parsed = this.parseResponse(text, path);
          logResponseMetrics(parsed, budget, path, ctx);
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
    // Status-mapped failures classify off the HTTP status. Everything else — the client-side
    // `REQUEST_TIMEOUT_MS` abort, DNS/connection failures, and the `parseResponse` throws
    // (empty body, HTML, invalid JSON) — never carries a status, so the error's own code is
    // the signal. Routing both through the same table means the transient paths, which are
    // the slowest to fail, arrive with the reason and recovery hint their contract declares
    // instead of an unclassified re-throw.
    const code = statusCode === undefined ? error.code : httpStatusToErrorCode(statusCode);
    const normalized = code === undefined ? undefined : NORMALIZED_THROW_BY_CODE[code];

    if (code === undefined || normalized === undefined) {
      // No mapped reason for this code (a caller-side abort, an upstream 500). Framework
      // fetch errors format the message as `Fetch failed for <URL>. Status: …` — the URL
      // carries the `api_key` credential and the `mailto` identifier. Redact before bubbling.
      throw new McpError(error.code, redactUrlsInMessage(error.message), error.data, {
        cause: error,
      });
    }

    const { factory } = normalized;
    const upstream = parseOpenAlexErrorBody(error.data?.responseBody);
    const rawMessage = upstream?.message ?? upstream?.error;
    const reason = resolveThrowReason(code, normalized.reason, rawMessage);
    // A truncated body's appended valid-fields list is misleading. For an invalid-field
    // 400, replace it with catalog-backed ranked suggestions; otherwise strip it. The two
    // are mutually exclusive — appendFieldSuggestions already drops the partial list, so it
    // must run on the raw message, not the stripped one.
    let sanitizedMessage = rawMessage;
    if (rawMessage !== undefined && upstream?.truncated) {
      const withSuggestions =
        code === JsonRpcErrorCode.InvalidParams
          ? appendFieldSuggestions(rawMessage, path)
          : rawMessage;
      sanitizedMessage =
        withSuggestions === rawMessage
          ? stripTruncatedValidFieldsList(rawMessage)
          : withSuggestions;
    }
    const message =
      sanitizedMessage ??
      domainMessageForFetchFailure(error, path) ??
      (code === JsonRpcErrorCode.NotFound
        ? `Entity not found at ${path}`
        : redactUrlsInMessage(error.message));

    const data = {
      ...error.data,
      path,
      reason,
      ...ctx.recoveryFor(reason),
      // `RateLimited` sits in the framework's transient set, so `withRetry` would spend the
      // full attempt budget against a budget wall that stays up until the daily reset. This
      // flag is the framework's per-error opt-out from that loop; the contract's own
      // `retryable` field only informs the client and cannot stop our own retries.
      ...(reason === BUDGET_EXHAUSTED_REASON ? { retryable: false } : {}),
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
      const select = resolveSelect(params.entityType, params.select);

      const data = (await this.request(
        `/${params.entityType}/${normalizedId}`,
        select ? { select: select.join(',') } : {},
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
      queryParams.filter = buildFilterString(
        translateFilters(params.entityType, params.filters),
        ctx,
      );
    }

    const sort = normalizeSort(params.sort);
    if (sort) {
      // Translate "-field" prefix to "field:desc" (OpenAlex API syntax)
      queryParams.sort = sort;
    }

    const select = resolveSelect(params.entityType, params.select);
    if (select) {
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
      queryParams.filter = buildFilterString(
        translateFilters(params.entityType, params.filters),
        ctx,
      );
    }

    if (params.perPage !== undefined) {
      queryParams.per_page = String(params.perPage);
    }

    // Boolean group_by fields (is_retracted, has_orcid, etc.) only produce
    // two groups (true/false) and reject cursor pagination with a 400.
    //
    // For all other fields, cursor behaviour follows the sort order:
    //   - count-desc (default): omit cursor on the first page so OpenAlex returns groups
    //     count-descending. `next_cursor` will be null — count-desc has no next page.
    //   - key-asc (order: "key"): send cursor=* on the first page. OpenAlex returns groups
    //     in key-ascending order and emits a `next_cursor` for full enumeration.
    //   - subsequent pages: forward the caller-supplied cursor as-is.
    const baseField = params.groupBy.replace(/:include_unknown$/, '');
    const isBooleanGroupBy = BOOLEAN_GROUP_BY_FIELDS.has(baseField);
    const keyAscOrder = !isBooleanGroupBy && params.order === 'key';

    if (params.cursor) {
      queryParams.cursor = params.cursor;
    } else if (keyAscOrder) {
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
      queryParams.filter = buildFilterString(params.filters, ctx);
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

/**
 * Return the typed field catalog keyed by entity type → context → field list.
 * Only `filter` and `select` arrays are stored. `group_by` resolves to the `filter` key here;
 * the describe-fields handler then prunes the fields group_by cannot target (raw dates,
 * `*.search` operators, and `from_*`/`to_*` range modifiers).
 */
export function getFieldCatalog(): Record<EntityType, { filter: string[]; select: string[] }> {
  return fieldCatalog as Record<EntityType, { filter: string[]; select: string[] }>;
}
