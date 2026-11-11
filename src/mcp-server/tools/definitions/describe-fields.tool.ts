/**
 * @fileoverview Field discovery tool for OpenAlex valid filter, group_by, and select fields.
 * @module mcp-server/tools/definitions/describe-fields.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { rankAllFields } from '@/services/openalex/field-ranker.js';
import { isGroupableField } from '@/services/openalex/groupable-fields.js';
import { getFieldCatalog } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

/** Contexts the caller can query; group_by resolves to the filter set upstream. */
const CONTEXTS = ['filter', 'group_by', 'select'] as const;
type FieldContext = (typeof CONTEXTS)[number];

/** Resolve group_by → the filter catalog key; the handler then prunes non-groupable fields. */
function resolveContext(context: FieldContext): 'filter' | 'select' {
  return context === 'select' ? 'select' : 'filter';
}

export const describeFieldsTool = tool('openalex_describe_fields', {
  description:
    'List valid field names for an OpenAlex entity type and context (filter, group_by, or select). Use proactively before constructing a filter or group_by to avoid invalid-field 400 errors. Pass `query` to rank the list by name similarity — useful when you have a partial or guessed field name. Ranking never drops a field: the full list comes back either way.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/describe-fields.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputAliases: { entity: 'entity_type' },
  input: z.object({
    entity_type: z.enum(ENTITY_TYPES).describe('OpenAlex entity type to list fields for.'),
    context: z
      .enum(CONTEXTS)
      .describe(
        'Field usage context. "filter": fields accepted in the filter param; created_date, updated_date, and their from_/to_ forms, where listed, are ones OpenAlex serves only on a paid plan, and a filter on one fails without it. "group_by": fields accepted in group_by — a subset of the filter set that leaves out what OpenAlex refuses to aggregate (raw dates, *.search operators, decimal scores, display_name, external-ID fields, and fields OpenAlex looks up from a related entity, such as primary_location.source.country_code, among them). "select": fields accepted in select.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Optional partial or guessed field name to sort results by similarity. Pass the field you tried (e.g. "funder") to get the closest matches first. The complete field list is returned either way — a query reorders it, it does not filter it, so a nested value\'s parent object (e.g. `summary_stats` for "h_index") is still reachable further down.',
      ),
  }),
  output: z.object({
    entity_type: z.string().describe('Entity type queried.'),
    context: z.string().describe('Context queried (filter, group_by, or select).'),
    fields: z
      .array(z.string())
      .describe(
        'Every valid field name for this entity_type + context — the complete pool, ranked by similarity when `query` is provided. Never truncated, so this always holds `total` entries.',
      ),
    total: z.number().describe('Total number of valid fields for this entity_type + context.'),
  }),

  handler(input, ctx) {
    const catalog = getFieldCatalog();
    const catalogContext = resolveContext(input.context);
    const catalogPool = catalog[input.entity_type]?.[catalogContext] ?? [];
    // group_by accepts only a subset of the filter fields — drop the ones OpenAlex rejects as
    // aggregation keys so the tool never advertises a field analyze_trends will 400 on. filter
    // and select keep the full set (dates / *.search / range-modifiers are valid there).
    const pool =
      input.context === 'group_by'
        ? catalogPool.filter((field) => isGroupableField(input.entity_type, field))
        : catalogPool;

    // A copy: `pool` is the shared catalog the "Did you mean" suggestions also read.
    const fields = input.query ? rankAllFields(input.query, pool) : [...pool];

    ctx.log.info('Field catalog lookup', {
      entityType: input.entity_type,
      context: input.context,
      query: input.query,
      totalFields: pool.length,
    });

    return {
      entity_type: input.entity_type,
      context: input.context,
      fields,
      total: pool.length,
    };
  },

  format: (result) => {
    const header = `**${result.entity_type}** / **${result.context}** — ${result.total} valid fields`;
    if (result.fields.length === 0) {
      return [{ type: 'text', text: `${header}\n\nNo matches.` }];
    }
    const list = result.fields.map((f) => `- ${f}`).join('\n');
    return [{ type: 'text', text: `${header}:\n\n${list}` }];
  },
});
