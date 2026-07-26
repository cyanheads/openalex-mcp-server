/**
 * @fileoverview One-hop citation graph traversal: cites / cited_by / related_to from a seed work.
 * @module mcp-server/tools/definitions/citation-graph.tool
 */

import type { HandlerContext } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import type { EntityRecord } from '@/services/openalex/types.js';

const OPENALEX_URL_PREFIX = 'https://openalex.org/';

/**
 * Resolve any accepted seed identifier to a bare W-ID and confirm it exists. The graph
 * filters (`cites`/`cited_by`/`related_to`) themselves don't validate the seed — passing
 * a non-existent W-ID returns zero edges, indistinguishable from a valid seed with no
 * citations yet. A singleton `/works/{id}` lookup gates the query so bad seeds surface
 * as NotFound (bubbles via the service as `entity_not_found`) and good seeds with empty
 * graphs return honest empty results.
 */
async function resolveSeedToWorkId(
  service: ReturnType<typeof getOpenAlexService>,
  seedId: string,
  ctx: HandlerContext<'entity_not_found'>,
): Promise<string> {
  const lookup = await service.search({ entityType: 'works', id: seedId, select: ['id'] }, ctx);
  const record = lookup.results[0];
  if (!record?.id) {
    throw ctx.fail(
      'entity_not_found',
      `Could not resolve seed_id "${seedId}" to an OpenAlex work ID.`,
      { ...ctx.recoveryFor('entity_not_found'), seedId },
    );
  }
  return record.id.replace(OPENALEX_URL_PREFIX, '');
}

const DIRECTIONS = ['cites', 'cited_by', 'related_to'] as const;
type Direction = (typeof DIRECTIONS)[number];

const RESERVED_FILTER_KEYS: ReadonlySet<string> = new Set<string>(DIRECTIONS);

function buildCitationEcho(input: {
  seed_id: string;
  direction: Direction;
  filters?: Record<string, string> | undefined;
  sort?: string | undefined;
}): string {
  const parts = [`seed_id=${input.seed_id}`, `direction=${input.direction}`];
  if (input.filters && Object.keys(input.filters).length > 0) {
    parts.push(`filters=${JSON.stringify(input.filters)}`);
  }
  if (input.sort) parts.push(`sort=${input.sort}`);
  return parts.join(' | ');
}

export const getCitationGraphTool = tool('openalex_get_citation_graph', {
  description:
    "Walk the citation graph one hop from a seed work. Direction picks the edge: incoming citations (`cites`), the seed's own references (`cited_by`), or OpenAlex's algorithmically-related works (`related_to`). Note: `direction` follows OpenAlex's filter convention, which inverts the common English reading — `cites` returns works that cite the seed; `cited_by` returns works the seed cites. Results use the works schema; combine with filters/sort to narrow further.",
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/citation-graph.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
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
      when: 'OpenAlex rejected an invalid filter or sort field name (HTTP 400).',
      recovery:
        'The upstream message names the rejected token and suggests close matches. Pass a valid OpenAlex work ID (W…), DOI, or PMID for seed_id, or use openalex_describe_fields(entity_type, "filter") to browse valid filter fields.',
    },
    {
      reason: 'upstream_invalid_id_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An entity-ID filter received a value that is not an OpenAlex ID — usually a name (HTTP 400).',
      recovery:
        'Call openalex_resolve_name to turn the name into an OpenAlex ID, then filter by that ID. Entity filters such as authorships.author.id and primary_topic.id accept IDs only.',
    },
    {
      reason: 'upstream_sort_requires_search',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'sort=-relevance_score was used but the citation-graph query has no active search (HTTP 400).',
      recovery:
        'Sorting by relevance_score requires an active search, which a citation-graph walk lacks — choose a concrete sort field such as -cited_by_count or -publication_date, or add a `*.search` filter.',
    },
    {
      reason: 'upstream_invalid_params_other',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected the request (HTTP 400) for a reason other than an invalid field name.',
      recovery:
        'Read the upstream message in the error above and adjust the request — check filter operators, value formats, and cursor/per_page bounds.',
    },
    {
      reason: 'reserved_filter_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filters contains cites/cited_by/related_to — the direction parameter reserves those keys.',
      recovery:
        'Remove the reserved key from filters, or restate the relationship through direction.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'OpenAlex has no work matching the seed_id.',
      recovery:
        'Verify seed_id with openalex_resolve_name, or pass a known OpenAlex work ID (W…), DOI, PMID, or PMCID.',
    },
  ],
  input: z.object({
    seed_id: z
      .string()
      .min(1)
      .describe(
        'Seed work identifier. Accepts OpenAlex ID ("W2741809807"), DOI ("10.1038/nature12373" or full URL), PMID, or PMCID. Use openalex_resolve_name first if you only have a title.',
      ),
    direction: z
      .enum(DIRECTIONS)
      .describe(
        '"cites": works that cite seed_id (incoming citations). "cited_by": works that seed_id cites (its reference list). "related_to": OpenAlex algorithmically-related works (~8-30 typical, may be empty for less-cited seeds).',
      ),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Additional filters to narrow the graph, same syntax as openalex_search_entities. Example: publication_year=">2020", is_oa="true". Do not include cites/cited_by/related_to — those are set by the `direction` parameter.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort field. Prefix with "-" for descending. Comma-separate for a multi-key sort, applied left to right, with the "-" prefix set per key ("-publication_year,cited_by_count" sorts by year descending, then citations ascending). Common: "cited_by_count", "-publication_date". Default is OpenAlex relevance.',
      ),
    select: z
      .array(z.string())
      .optional()
      .describe(
        'OpenAlex work field names to return. Always returned: id, display_name. Defaults to the curated works select if omitted.',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Results per page (1-100). Default 25.'),
    cursor: z
      .string()
      .optional()
      .describe('Pagination cursor from a previous response. Pass to get the next page.'),
  }),
  output: z.object({
    meta: z
      .object({
        count: z
          .number()
          .describe('Total edges from seed_id in this direction (across all pages).'),
        per_page: z.number().describe('Records on this page.'),
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
            id: z.string().describe('OpenAlex work ID.'),
            display_name: z
              .string()
              .nullable()
              .describe(
                'Work title. null when OpenAlex holds no title for the record (paratext works and other untitled entries) — use `id` to identify it.',
              ),
          })
          .passthrough()
          .describe(
            'A single OpenAlex work record on the citation graph. Additional fields vary by `select`.',
          ),
      )
      .describe('Works on the citation graph in this direction.'),
  }),

  // Agent-facing context for the success path — the query as parsed (seed + direction),
  // the total edge count, and recovery guidance for empty traversals. Populated via
  // ctx.enrich(...) so it reaches structuredContent and content[] alike.
  enrichment: {
    echo: z
      .string()
      .describe(
        'Compact echo of seed_id, direction, filters, sort — surfaces what was actually queried when no edges are returned.',
      ),
    totalCount: z.number().describe('Total edges from seed_id in this direction across all pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no edges are returned — suggests verifying the seed_id, broadening filters, or trying a different direction. Absent when results are present.',
      ),
    budget: z
      .object({
        costUsd: z
          .number()
          .describe(
            'USD this call spent, covering both upstream requests — the seed validation lookup (unbilled) and the graph page itself.',
          ),
        remainingUsd: z.number().describe("USD left in today's OpenAlex budget after this call."),
        resetsInSeconds: z
          .number()
          .describe('Seconds until the daily budget refills (midnight UTC).'),
      })
      .optional()
      .describe(
        'What this call cost against the OpenAlex daily budget and what is left of it. Price a full walk before committing to it: `totalCount` ÷ `per_page` × `costUsd` against `remainingUsd`. Absent when OpenAlex omitted the accounting headers.',
      ),
  },

  enrichmentTrailer: {
    echo: { label: 'Query' },
    totalCount: { label: 'Total Edges' },
    budget: { render: renderBudgetTrailer },
  },

  async handler(input, ctx) {
    if (input.filters) {
      const reserved = Object.keys(input.filters).find((key) => RESERVED_FILTER_KEYS.has(key));
      if (reserved !== undefined) {
        throw ctx.fail(
          'reserved_filter_key',
          `${reserved} cannot be passed in filters — direction reserves cites/cited_by/related_to.`,
          {
            ...ctx.recoveryFor('reserved_filter_key'),
            reservedKey: reserved,
            direction: input.direction,
          },
        );
      }
    }

    const service = getOpenAlexService();
    const workId = await resolveSeedToWorkId(service, input.seed_id, ctx);

    const mergedFilters: Record<string, string> = {
      ...(input.filters ?? {}),
      [input.direction]: workId,
    };

    const result = await service.search(
      {
        entityType: 'works',
        filters: mergedFilters,
        sort: input.sort,
        select: input.select,
        perPage: input.per_page,
        cursor: input.cursor,
      },
      ctx,
    );

    ctx.log.info('Citation graph fetched', {
      seedId: input.seed_id,
      direction: input.direction,
      resultCount: result.results.length,
      totalCount: result.meta.count,
    });

    const echo = buildCitationEcho(input);
    ctx.enrich({ echo, totalCount: result.meta.count });
    if (result.results.length === 0) {
      ctx.enrich.notice(
        `No edges for ${echo}. Verify the seed_id with openalex_resolve_name, broaden filters, or try a different direction.`,
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
    const countLabel = `${result.meta.count} edge(s) — ${result.meta.per_page} per page`;
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
