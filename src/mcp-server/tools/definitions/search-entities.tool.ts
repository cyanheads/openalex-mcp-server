/**
 * @fileoverview Primary discovery and lookup tool for OpenAlex entities.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES, type EntityRecord } from '@/services/openalex/types.js';

const SEMANTIC_PER_PAGE_CAP = 50;
const SAMPLE_MAX = 100;

type SearchEchoInput = {
  entity_type: string;
  id?: string | undefined;
  query?: string | undefined;
  search_mode?: string | undefined;
  filters?: Record<string, string> | undefined;
  sort?: string | undefined;
  sample?: number | undefined;
  seed?: string | undefined;
};

/**
 * The parameters that shape a *list* query, each paired with its echo rendering. Ground truth
 * is `OpenAlexService.search()`: its `id` branch requests `/{entity_type}/{id}` with `select`
 * alone, so every parameter named here is dropped on that path — by OpenAlex itself, which
 * answers an entity-by-ID URL identically whether or not search params ride along.
 *
 * Pagination (`per_page`, `cursor`) is deliberately absent: a singleton lookup is one record by
 * definition, and `per_page` always carries its schema default, so a caller's intent there
 * cannot be told apart from the absence of one. Naming it would be noise, not a warning.
 */
function searchOnlyParams(input: SearchEchoInput): { name: string; rendered: string }[] {
  const parts: { name: string; rendered: string }[] = [];
  if (input.query) parts.push({ name: 'query', rendered: `query="${input.query}"` });
  if (input.search_mode && input.search_mode !== 'keyword') {
    parts.push({ name: 'search_mode', rendered: `search_mode=${input.search_mode}` });
  }
  if (input.filters && Object.keys(input.filters).length > 0) {
    parts.push({ name: 'filters', rendered: `filters=${JSON.stringify(input.filters)}` });
  }
  if (input.sort) parts.push({ name: 'sort', rendered: `sort=${input.sort}` });
  if (input.sample !== undefined) {
    parts.push({ name: 'sample', rendered: `sample=${input.sample}` });
  }
  if (input.seed !== undefined) parts.push({ name: 'seed', rendered: `seed=${input.seed}` });
  return parts;
}

/**
 * Echo the criteria that actually ran. An `id` lookup echoes `entity_type` and `id` only —
 * echoing a filter the singleton path never applied reads as confirmation that it did, which
 * is the one thing this field exists not to do.
 */
function buildSearchEcho(input: SearchEchoInput): string {
  const parts = [`entity_type=${input.entity_type}`];
  if (input.id) return [...parts, `id=${input.id}`].join(' | ');
  return [...parts, ...searchOnlyParams(input).map((part) => part.rendered)].join(' | ');
}

export const searchEntitiesTool = tool('openalex_search_entities', {
  description:
    'Search, filter, sort, or retrieve by ID. Covers all OpenAlex entity types (works, authors, sources, institutions, topics, keywords, publishers, funders). Pass `id` to retrieve a single entity. Otherwise, use `query` and/or `filters` for discovery. Supports keyword search with boolean operators, exact phrase matching, and AI semantic search. Use openalex_resolve_name to resolve names to IDs before filtering. Searches and ID lookups return a curated set of fields by default; pass `select` to override with specific fields, or `["*"]` for the full record.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/search-entities.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'semantic_per_page_cap',
      code: JsonRpcErrorCode.ValidationError,
      when: `A search (no \`id\`) set per_page above the semantic-search cap of ${SEMANTIC_PER_PAGE_CAP}.`,
      recovery: `Reduce per_page to ${SEMANTIC_PER_PAGE_CAP} or less, or switch search_mode to keyword.`,
    },
    {
      reason: 'sample_with_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A search (no `id`) provided both `sample` and `cursor`.',
      recovery: 'Sampling returns a single page only; remove `cursor` or remove `sample`.',
    },
    {
      reason: 'seed_without_sample',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A search (no `id`) provided `seed` without `sample`.',
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
      when: 'OpenAlex throttled the request for exceeding its per-second ceiling (HTTP 429).',
      retryable: true,
      recovery:
        'Wait several seconds and retry; consider lowering request frequency for this caller.',
    },
    {
      reason: 'upstream_budget_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The OpenAlex daily usage budget is spent (HTTP 429).',
      retryable: false,
      recovery:
        'The daily budget refills at midnight UTC — retrying sooner will not succeed. Set OPENALEX_API_KEY to a free key (https://openalex.org/settings/api) for a larger daily budget than anonymous access, or wait for the reset.',
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
      when: 'OpenAlex was unreachable or unusable — HTTP 503, a connection failure, or a body that was empty, HTML, or unparseable JSON.',
      retryable: true,
      recovery:
        'Wait and retry; check https://openalex.org for service status if the outage persists.',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAlex rejected the API key (HTTP 401).',
      recovery:
        'Check that OPENALEX_API_KEY is set to a valid OpenAlex account API key (free from https://openalex.org/settings/api).',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'OpenAlex denied access to the requested resource (HTTP 403).',
      recovery:
        'Confirm the API key has access to this entity type or endpoint, then retry the request.',
    },
    {
      reason: 'comma_in_filter_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A filter value contains a comma, which collides with the OpenAlex filter separator.',
      recovery:
        'Use `|` for OR within a filter value (e.g. "2020|2021"), or use a `.search` filter or the `query` parameter for free-text phrases that contain commas.',
    },
    {
      reason: 'upstream_invalid_params',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected an invalid filter, select, or sort field name (HTTP 400).',
      recovery:
        'The upstream message names the rejected field and suggests close matches. Use openalex_describe_fields(entity_type, context) to browse all valid fields for the given entity type and context.',
    },
    {
      reason: 'upstream_invalid_id_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An entity-ID filter received a value that is not an OpenAlex ID — usually a name (HTTP 400).',
      recovery:
        'Call openalex_resolve_name to turn the name into an OpenAlex ID, then filter by that ID. Entity filters such as authorships.author.id, primary_topic.id, and cites accept IDs only.',
    },
    {
      reason: 'upstream_sort_requires_search',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'sort=-relevance_score was used without an active search (HTTP 400).',
      recovery:
        'Sorting by relevance_score requires an active search — add a `query` or a `*.search` filter (e.g. title.search), or choose a concrete sort field such as -cited_by_count or -publication_date.',
    },
    {
      reason: 'upstream_invalid_params_other',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected the request (HTTP 400) for a reason other than an invalid field name.',
      recovery:
        'Read the upstream message in the error above and adjust the request — check filter operators, value formats, and cursor/per_page bounds.',
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
        'Retrieve a single entity by ID. Supports: OpenAlex ID ("W2741809807"), DOI ("10.1038/nature12373"), ORCID ("0000-0002-1825-0097"), ROR ("https://ror.org/00hx57361"), PMID ("12345678"), PMCID ("PMC1234567"), ISSN ("1234-5678"). When provided, `query`, `search_mode`, `filters`, `sort`, `sample`, and `seed` are not applied — the returned record is the entity at that ID regardless of them, and the response `notice` names any you passed. `select` still applies: the curated per-entity-type default is returned unless you pass `select` (use `["*"]` for the complete record). To filter, drop `id` and search. Use openalex_resolve_name to find the ID if unknown.',
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
        'Sort field. Prefix with "-" for descending. Comma-separate for a multi-key sort, applied left to right, with the "-" prefix set per key ("-publication_year,cited_by_count" sorts by year descending, then citations ascending). Common: "cited_by_count", "-publication_date", "-relevance_score" (default when query present). Note: when combined with a keyword query, an explicit sort overrides relevance ranking entirely — top results may be highly cited but only tangentially on-topic. Use "-relevance_score" or omit sort to keep the most relevant results first. "-relevance_score" requires an active search via "query" or a "filter:search" filter — passing it without one will fail.',
      ),
    select: z
      .array(z.string())
      .optional()
      .describe(
        'OpenAlex top-level field names to return. Always returned: `id`, `display_name` — additional fields you list are appended. A curated default per entity type applies to both searches and single-entity (`id`) lookups; pass field names to override it, or `["*"]` to retrieve the complete record (every field). Invalid field names produce an error identifying the rejected field. Example: ["doi", "authorships", "primary_topic"].',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Results per page (1-100). Default 25. Semantic search caps at 50 — when search_mode="semantic", set per_page ≤ 50 (also subject to a 1 req/sec rate limit upstream). The cap applies to searches only; an `id` lookup returns its one record regardless of both.',
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
        'Deterministic seed for `sample`. Same seed + same filters = same results — pass when reproducibility matters. Has no effect without `sample`, and a search that passes it alone is rejected.',
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
            display_name: z
              .string()
              .nullable()
              .describe(
                'Entity name or work title. null when OpenAlex holds no title for the record (paratext works and other untitled entries) — use `id` to identify it.',
              ),
          })
          .passthrough()
          .describe(
            'A single OpenAlex entity record. `id` is always present and `display_name` is always returned (though it may be null); additional fields vary by entity_type and `select`.',
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
        'Compact echo of the criteria that actually ran (entity_type, query, filters, sort, search_mode) — surfaces what was searched when results are empty. An `id` lookup echoes entity_type and id alone, because the search criteria are not applied on that path.',
      ),
    totalCount: z.number().describe('Total results matching the query/filters across all pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance notice. Set when results are empty (echoes the criteria and suggests how to broaden) or when an `id` lookup was passed search criteria it does not apply (names them). Absent otherwise.',
      ),
    budget: z
      .object({
        costUsd: z
          .number()
          .describe(
            'USD this call spent. 0 for an `id` lookup — OpenAlex does not bill single-entity fetches, so batching known IDs beats paging a filtered list.',
          ),
        remainingUsd: z.number().describe("USD left in today's OpenAlex budget after this call."),
        resetsInSeconds: z
          .number()
          .describe('Seconds until the daily budget refills (midnight UTC).'),
        prepaidRemainingUsd: z
          .number()
          .optional()
          .describe(
            'USD left in the prepaid balance — a separate pool OpenAlex draws on only after the daily allowance runs out, and which the daily reset does not refill. Add it to `remainingUsd` for the full spendable amount. Absent when the account holds no prepaid balance.',
          ),
      })
      .optional()
      .describe(
        'What this call cost against the OpenAlex daily budget and what is left of it. Price a full traversal before committing to it: `totalCount` ÷ `per_page` × `costUsd` against `remainingUsd`. Absent when OpenAlex omitted the accounting headers.',
      ),
  },

  enrichmentTrailer: {
    echo: { label: 'Query' },
    totalCount: { label: 'Total' },
    budget: { render: renderBudgetTrailer },
  },

  async handler(input, ctx) {
    /**
     * All three checks below constrain a *list* query. `id` takes the singleton path in
     * `OpenAlexService.search()`, which reads only `entity_type`, `id`, and `select` — so
     * search_mode, per_page, cursor, sample, and seed are unread there, and rejecting an ID
     * lookup over how they relate to each other fails it on constraints it never met. The
     * dropped-parameter notice below reports them instead. The `id` predicate is truthiness,
     * not `!== undefined`, to match the service branch: an empty-string `id` parses and lists.
     */
    if (!input.id) {
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

    // An `id` lookup always returns its one record or throws, so it never reaches the
    // empty-results notice — the two branches are exclusive, and the dropped-parameter
    // warning is the more useful of the two on that path.
    const ignored = input.id ? searchOnlyParams(input).map((part) => part.name) : [];
    if (ignored.length > 0) {
      const [verb, pronoun] = ignored.length === 1 ? ['was', 'it'] : ['were', 'them'];
      ctx.enrich.notice(
        `\`id\` takes precedence — ${ignored.join(', ')} ${verb} not applied, and the record below is the entity at that ID regardless of ${pronoun}. Drop \`id\` to run ${pronoun} as a search.`,
      );
    } else if (result.results.length === 0) {
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
