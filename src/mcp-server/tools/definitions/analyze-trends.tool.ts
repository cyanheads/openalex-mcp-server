/**
 * @fileoverview Aggregation tool for trend and distribution analysis via OpenAlex group_by.
 * @module mcp-server/tools/definitions/analyze-trends.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

export const analyzeTrendsTool = tool('openalex_analyze_trends', {
  description:
    'Aggregate OpenAlex entities into groups and count them. Use for trend analysis (group works by publication_year), distribution analysis (group by oa_status, type, country), and comparative analysis (group by institution or topic). Combine with filters to scope the analysis. Returns up to 200 groups per page — use cursor pagination for fields with many distinct values.',
  annotations: { readOnlyHint: true, openWorldHint: true },
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
        'Filter criteria (same syntax as openalex_search_entities filters). Narrows the population before aggregation. Example: group works by year, filtered to a specific topic.',
      ),
    include_unknown: z
      .boolean()
      .default(false)
      .describe(
        'Include a group for entities with no value for the grouped field. Hidden by default.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Pagination cursor from a previous response. Group-by returns max 200 groups per page. Pass cursor to get the next page. Note: paginated groups are sorted by key, not by count.',
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
        z.object({
          key: z.string().describe('Group key (OpenAlex ID or raw value).'),
          key_display_name: z.string().describe('Human-readable group label.'),
          count: z.number().describe('Number of entities in this group.'),
        }),
      )
      .describe('Aggregation groups with counts.'),
  }),

  async handler(input, ctx) {
    const service = getOpenAlexService();
    const result = await service.analyze(
      {
        entityType: input.entity_type,
        groupBy: input.group_by,
        filters: input.filters,
        includeUnknown: input.include_unknown,
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

    return result;
  },

  format: (result) => {
    if (result.groups.length === 0) {
      return [{ type: 'text', text: 'No groups found.' }];
    }
    const sorted = [...result.groups].sort((a, b) => b.count - a.count);
    const MAX_DISPLAY = 50;
    const display = sorted.slice(0, MAX_DISPLAY);
    const lines = display.map((g) => `${g.key_display_name}: ${g.count.toLocaleString()}`);
    const truncated =
      sorted.length > MAX_DISPLAY ? `\n\n...and ${sorted.length - MAX_DISPLAY} more groups` : '';
    return [
      {
        type: 'text',
        text: `${result.meta.count.toLocaleString()} total entities across ${result.groups.length} groups:\n\n${lines.join('\n')}${truncated}`,
      },
    ];
  },
});
