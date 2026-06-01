/**
 * @fileoverview Primary discovery and lookup tool for OpenAlex entities.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES, type EntityRecord } from '@/services/openalex/types.js';

const SEMANTIC_PER_PAGE_CAP = 50;
const SAMPLE_MAX = 100;

function buildSearchEcho(input: {
  entity_type: string;
  id?: string | undefined;
  query?: string | undefined;
  search_mode?: string | undefined;
  filters?: Record<string, string> | undefined;
  sort?: string | undefined;
  sample?: number | undefined;
  seed?: string | undefined;
}): string {
  const parts = [`entity_type=${input.entity_type}`];
  if (input.id) parts.push(`id=${input.id}`);
  if (input.query) parts.push(`query="${input.query}"`);
  if (input.search_mode && input.search_mode !== 'keyword') {
    parts.push(`search_mode=${input.search_mode}`);
  }
  if (input.filters && Object.keys(input.filters).length > 0) {
    parts.push(`filters=${JSON.stringify(input.filters)}`);
  }
  if (input.sort) parts.push(`sort=${input.sort}`);
  if (input.sample !== undefined) parts.push(`sample=${input.sample}`);
  if (input.seed !== undefined) parts.push(`seed=${input.seed}`);
  return parts.join(' | ');
}

export const searchEntitiesTool = tool('openalex_search_entities', {
  description:
    'Search, filter, sort, or retrieve by ID. Covers all OpenAlex entity types (works, authors, sources, institutions, topics, keywords, publishers, funders). Pass `id` to retrieve a single entity. Otherwise, use `query` and/or `filters` for discovery. Supports keyword search with boolean operators, exact phrase matching, and AI semantic search. Use openalex_resolve_name to resolve names to IDs before filtering. Searches return a curated set of fields by default; pass `select` to override with specific fields.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/search-entities.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'semantic_per_page_cap',
      code: JsonRpcErrorCode.ValidationError,
      when: `per_page exceeds the semantic-search cap of ${SEMANTIC_PER_PAGE_CAP}.`,
      recovery: `Reduce per_page to ${SEMANTIC_PER_PAGE_CAP} or less, or switch search_mode to keyword.`,
    },
    {
      reason: 'sample_with_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both `sample` and `cursor` were provided.',
      recovery: 'Sampling returns a single page only; remove `cursor` or remove `sample`.',
    },
    {
      reason: 'seed_without_sample',
      code: JsonRpcErrorCode.ValidationError,
      when: '`seed` was provided without `sample`.',
      recovery: 'Pass `sample` to enable random sampling, or remove `seed`.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Lookup by id matched no OpenAlex entity.',
      recovery: 'Verify the ID format or call openalex_resolve_name to find the correct ID.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAlex throttled the request (HTTP 429).',
      retryable: true,
      recovery:
        'Wait several seconds and retry; consider lowering request frequency for this caller.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAlex did not respond within the request deadline.',
      retryable: true,
      recovery:
        'Retry after a short delay; if timeouts persist, narrow the request with tighter filters to reduce upstream load.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAlex returned HTTP 503 (service unavailable).',
      retryable: true,
      recovery:
        'Wait and retry; check https://openalex.org for service status if the outage persists.',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAlex rejected the API key (HTTP 401).',
      recovery:
        'Check that OPENALEX_API_KEY is set to a valid email-format key registered with OpenAlex.',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'OpenAlex denied access to the requested resource (HTTP 403).',
      recovery:
        'Confirm the API key has access to this entity type or endpoint, then retry the request.',
    },
    {
      reason: 'upstream_invalid_params',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenAlex rejected the request as malformed (HTTP 400).',
      recovery:
        'The upstream message names the rejected field; the valid-fields list it appends may be truncated. Drop or correct that filter, sort, or select field — for select, retry without it to see the curated valid fields, then re-add corrected names.',
    },
    {
      reason: 'upstream_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenAlex rejected the request as semantically invalid (HTTP 422).',
      recovery:
        'Read the upstream message for the specific field, then adjust the request to satisfy validation.',
    },
  ],
  input: z.object({
    entity_type: z.enum(ENTITY_TYPES).describe('Type of scholarly entity to search.'),
    id: z
      .string()
      .optional()
      .describe(
        'Retrieve a single entity by ID. Supports: OpenAlex ID ("W2741809807"), DOI ("10.1038/nature12373"), ORCID ("0000-0002-1825-0097"), ROR ("https://ror.org/00hx57361"), PMID ("12345678"), PMCID ("PMC1234567"), ISSN ("1234-5678"). When provided, other search/filter/sort params are ignored. Use openalex_resolve_name to find the ID if unknown.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Text search query. Supports boolean operators (AND, OR, NOT), quoted phrases ("exact match"), wildcards (machin*), fuzzy matching (machin~1), and proximity ("climate change"~5). Omit for filter-only queries.',
      ),
    search_mode: z
      .enum(['keyword', 'exact', 'semantic'])
      .default('keyword')
      .describe(
        'Search strategy. "keyword": stemmed full-text (default). "exact": no stemming, matches individual words (use quoted phrases for multi-word exact match). "semantic": AI embedding similarity (max 50 results, 1 req/sec).',
      ),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Filter criteria as field:value pairs. AND across fields (multiple keys). OR within field: pipe-separate ("us|gb"). NOT: prefix "!" ("!us"). Range: "2020-2024". Comparison: ">100", "<50". AND within same field: "+"-separate. Use OpenAlex IDs (not names) for entity filters — resolve names first. Common keys: `openalex` (filter by entity ID, e.g. {"openalex": "W123|W456"}), `cites` (works citing a given work), `publication_year` (range "2020-2024"), `authorships.author.id`, `type`, `is_oa`.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort field. Prefix with "-" for descending. Common: "cited_by_count", "-publication_date", "-relevance_score" (default when query present). Note: when combined with a keyword query, an explicit sort overrides relevance ranking entirely — top results may be highly cited but only tangentially on-topic. Use "-relevance_score" or omit sort to keep the most relevant results first. "-relevance_score" requires an active search via "query" or a "filter:search" filter — passing it without one will fail.',
      ),
    select: z
      .array(z.string())
      .optional()
      .describe(
        'OpenAlex top-level field names to return. Always returned: `id`, `display_name` — additional fields you list are appended. Searches apply a curated default per entity type; pass to override. Single-entity lookups (by `id`) return the full record unless set. Invalid field names produce an error identifying the rejected field. Example: ["doi", "authorships", "primary_topic"].',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Results per page (1-100). Default 25. Semantic search caps at 50 — when search_mode="semantic", set per_page ≤ 50 (also subject to a 1 req/sec rate limit upstream).',
      ),
    cursor: z
      .string()
      .optional()
      .describe('Pagination cursor from a previous response. Pass to get the next page.'),
    sample: z
      .number()
      .int()
      .min(1)
      .max(SAMPLE_MAX)
      .optional()
      .describe(
        `Return a random sample of this many entities matching the filters (1-${SAMPLE_MAX}). Single page only — pagination via \`cursor\` is not supported with sampling. Overrides \`per_page\`. Useful for unbiased exploration: spot-checking filter correctness, stratified review prompts, or generating exploration sets without bias toward most-cited.`,
      ),
    seed: z
      .string()
      .optional()
      .describe(
        'Deterministic seed for `sample`. Same seed + same filters = same results — pass when reproducibility matters. Has no effect (and is rejected) without `sample`.',
      ),
  }),
  output: z.object({
    meta: z
      .object({
        count: z.number().describe('Total results matching the query/filters.'),
        per_page: z.number().describe('Results on this page.'),
        next_cursor: z
          .string()
          .nullable()
          .describe('Cursor for next page. null if no more results.'),
      })
      .describe('Result metadata including pagination.'),
    results: z
      .array(
        z
          .object({
            id: z.string().describe('OpenAlex ID (e.g., "W2741809807", "A1234567890").'),
            display_name: z.string().describe('Entity name or work title.'),
          })
          .passthrough()
          .describe(
            'A single OpenAlex entity record. Core `id` and `display_name` are guaranteed; additional fields vary by entity_type and `select`.',
          ),
      )
      .describe(
        'OpenAlex entity objects passed through unchanged. Additional fields depend on entity_type and select.',
      ),
  }),

  // Agent-facing context for the success path — the query/filters as parsed, the
  // total match count, and recovery guidance for empty results. Populated via
  // ctx.enrich(...) so it reaches structuredContent and content[] alike.
  enrichment: {
    echo: z
      .string()
      .describe(
        'Compact echo of the input criteria (entity_type, query, filters, sort, search_mode) — surfaces what was actually searched when results are empty.',
      ),
    totalCount: z.number().describe('Total results matching the query/filters across all pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when results are empty — echoes the criteria and suggests how to broaden. Absent on successful result pages.',
      ),
  },

  enrichmentTrailer: {
    echo: { label: 'Query' },
    totalCount: { label: 'Total' },
  },

  async handler(input, ctx) {
    if (input.search_mode === 'semantic' && input.per_page > SEMANTIC_PER_PAGE_CAP) {
      throw ctx.fail(
        'semantic_per_page_cap',
        `Semantic search supports at most ${SEMANTIC_PER_PAGE_CAP} results per page. Reduce per_page or switch search_mode.`,
        {
          ...ctx.recoveryFor('semantic_per_page_cap'),
          searchMode: input.search_mode,
          perPage: input.per_page,
          cap: SEMANTIC_PER_PAGE_CAP,
        },
      );
    }

    if (input.sample !== undefined && input.cursor !== undefined) {
      throw ctx.fail(
        'sample_with_cursor',
        'Sampling returns one page only — `sample` cannot be combined with `cursor` pagination.',
        { ...ctx.recoveryFor('sample_with_cursor'), sample: input.sample, cursor: input.cursor },
      );
    }

    if (input.seed !== undefined && input.sample === undefined) {
      throw ctx.fail(
        'seed_without_sample',
        '`seed` is only meaningful with `sample` — pass `sample` to enable random sampling.',
        { ...ctx.recoveryFor('seed_without_sample'), seed: input.seed },
      );
    }

    const service = getOpenAlexService();
    const result = await service.search(
      {
        entityType: input.entity_type,
        id: input.id,
        query: input.query,
        searchMode: input.search_mode,
        filters: input.filters,
        sort: input.sort,
        select: input.select,
        perPage: input.per_page,
        cursor: input.cursor,
        sample: input.sample,
        seed: input.seed,
      },
      ctx,
    );

    ctx.log.info('Search completed', {
      entityType: input.entity_type,
      id: input.id,
      query: input.query,
      resultCount: result.results.length,
      totalCount: result.meta.count,
    });

    const echo = buildSearchEcho(input);
    ctx.enrich({ echo, totalCount: result.meta.count });
    if (result.results.length === 0) {
      ctx.enrich.notice(
        `No matches for ${echo}. Try broadening the query, removing filters, or switching search_mode.`,
      );
    }

    return {
      meta: {
        count: result.meta.count,
        per_page: result.meta.per_page,
        next_cursor: result.meta.next_cursor,
      },
      results: result.results,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const countLabel = `${result.meta.count} result(s) — ${result.meta.per_page} per page`;
    const header = result.meta.next_cursor
      ? `**${countLabel}** — next cursor: \`${result.meta.next_cursor}\``
      : `**${countLabel}**`;
    lines.push(header);

    if (result.results.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const record of result.results) {
      lines.push(...renderEntityRecord(record as EntityRecord));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
