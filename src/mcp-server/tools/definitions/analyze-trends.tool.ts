/**
 * @fileoverview Aggregation tool for trend and distribution analysis via OpenAlex group_by.
 * @module mcp-server/tools/definitions/analyze-trends.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

export const analyzeTrendsTool = tool('openalex_analyze_trends', {
  description:
    'Aggregate OpenAlex entities into groups and count them. Use for trend analysis (group works by publication_year), distribution analysis (group by oa_status, type, country), and comparative analysis (group by institution or topic). Combine with filters to scope the analysis. Returns up to 200 groups per page — use cursor pagination for fields with many distinct values.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/analyze-trends.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
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
      when: 'OpenAlex rejected the group_by or filter as malformed (HTTP 400).',
      recovery:
        'The upstream message names the rejected key in group_by or filters; the valid-fields list it appends may be truncated. Retry with a valid group_by field for the entity_type, or a valid filter key — for full-text inside filters use abstract.search, title.search, or default.search.',
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
    entity_type: z.enum(ENTITY_TYPES).describe('Entity type to aggregate.'),
    group_by: z
      .string()
      .describe(
        'Field to group by. Works examples: "publication_year", "type", "oa_status", "primary_topic.field.id", "authorships.institutions.country_code", "is_retracted". Authors: "last_known_institutions.country_code", "has_orcid". Sources: "type", "is_oa", "country_code". Not all fields support group_by — check entity docs if unsure.',
      ),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Filter criteria (same syntax as openalex_search_entities filters). Narrows the population before aggregation. For full-text within filters, use abstract.search, title.search, or default.search — there is no bare 'search' filter key. Example: group works by year filtered to a specific topic.",
      ),
    include_unknown: z
      .boolean()
      .default(false)
      .describe(
        'Include a group for entities with no value for the grouped field. Hidden by default.',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(200)
      .describe(
        'Maximum groups per page (1-200). Default 200 (the upstream cap). Reduce when only the top-N groups matter — same aggregation, smaller payload.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Pagination cursor from a previous response. Group-by returns max 200 groups per page. Pass cursor to get the next page. The first page is sorted by count descending; subsequent pages (cursor pages) are sorted by key, not by count.',
      ),
  }),
  output: z.object({
    meta: z
      .object({
        count: z.number().describe('Total entities matching the filters (before grouping).'),
        groups_count: z.number().nullable().describe('Number of groups on this page (max 200).'),
        next_cursor: z
          .string()
          .nullable()
          .describe('Cursor for next page of groups. null if no more groups.'),
      })
      .describe('Aggregation metadata.'),
    groups: z
      .array(
        z
          .object({
            key: z.string().describe('Group key (OpenAlex ID or raw value).'),
            key_display_name: z.string().describe('Human-readable group label.'),
            count: z.number().describe('Number of entities in this group.'),
          })
          .describe('A single aggregation group with its key, display label, and entity count.'),
      )
      .describe('Aggregation groups with counts.'),
  }),

  // Agent-facing context for the success path — the criteria as parsed, the entity
  // total, and recovery guidance for empty group results. Populated via ctx.enrich(...)
  // so it reaches structuredContent and content[] alike.
  enrichment: {
    echo: z
      .string()
      .describe(
        'Compact echo of the input criteria (entity_type, group_by, filters) — surfaces what was actually requested when no groups are returned.',
      ),
    entityTotal: z
      .number()
      .describe('Total entities matching the filters before grouping (across all pages).'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no groups are returned — echoes the criteria and suggests how to adjust. Absent when groups are present.',
      ),
  },

  enrichmentTrailer: {
    echo: { label: 'Query' },
    entityTotal: { label: 'Entity Total' },
  },

  async handler(input, ctx) {
    const service = getOpenAlexService();
    const result = await service.analyze(
      {
        entityType: input.entity_type,
        groupBy: input.group_by,
        filters: input.filters,
        includeUnknown: input.include_unknown,
        perPage: input.per_page,
        cursor: input.cursor,
      },
      ctx,
    );

    ctx.log.info('Trend analysis completed', {
      entityType: input.entity_type,
      groupBy: input.group_by,
      totalCount: result.meta.count,
      groupCount: result.groups.length,
    });

    const echo = buildAnalyzeEcho(input);
    ctx.enrich({ echo, entityTotal: result.meta.count });
    if (result.groups.length === 0) {
      ctx.enrich.notice(
        `No groups returned for ${echo}. Try removing filters or grouping by a different field.`,
      );
    }

    return {
      meta: {
        count: result.meta.count,
        groups_count: result.meta.groups_count,
        next_cursor: result.meta.next_cursor,
      },
      groups: result.groups,
    };
  },

  format: (result) => {
    const heading = `${result.meta.count} total entities across ${result.meta.groups_count ?? result.groups.length} groups on this page`;

    if (result.groups.length === 0) {
      return [
        {
          type: 'text',
          text: `No groups found. (count=${result.meta.count}, groups_count=${result.meta.groups_count ?? 0})`,
        },
      ];
    }

    // Time-series groupings are returned upstream in count-desc — useful for "top N years"
    // but jarring when reading a trend. Only the rendered text is reordered;
    // structuredContent stays in upstream order for callers that want it.
    const renderOrder = isTimeSeriesGrouping(result.groups)
      ? [...result.groups].sort((a, b) => a.key.localeCompare(b.key))
      : result.groups;

    const lines = renderOrder.map((g) => {
      const label =
        g.key === g.key_display_name ? g.key_display_name : `${g.key_display_name} (${g.key})`;
      return `${label}: ${g.count}`;
    });
    const footer = result.meta.next_cursor
      ? `\n\n*More groups available — next_cursor: \`${result.meta.next_cursor}\`*`
      : '';
    return [
      {
        type: 'text',
        text: `${heading}:\n\n${lines.join('\n')}${footer}`,
      },
    ];
  },
});

const YEAR_OR_DATE_PATTERN = /^\d{4}(-\d{2}-\d{2})?$/;

function isTimeSeriesGrouping(groups: ReadonlyArray<{ key: string }>): boolean {
  return groups.length > 1 && groups.every((g) => YEAR_OR_DATE_PATTERN.test(g.key));
}

function buildAnalyzeEcho(input: {
  entity_type: string;
  group_by: string;
  filters?: Record<string, string> | undefined;
  include_unknown?: boolean | undefined;
}): string {
  const parts = [`entity_type=${input.entity_type}`, `group_by=${input.group_by}`];
  if (input.filters && Object.keys(input.filters).length > 0) {
    parts.push(`filters=${JSON.stringify(input.filters)}`);
  }
  if (input.include_unknown) parts.push('include_unknown=true');
  return parts.join(' | ');
}
