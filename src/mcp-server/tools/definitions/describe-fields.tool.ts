/**
 * @fileoverview Field discovery tool for OpenAlex valid filter, group_by, and select fields.
 * @module mcp-server/tools/definitions/describe-fields.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { rankFields } from '@/services/openalex/field-ranker.js';
import { getFieldCatalog } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

/** Contexts the caller can query; group_by resolves to the filter set upstream. */
const CONTEXTS = ['filter', 'group_by', 'select'] as const;
type FieldContext = (typeof CONTEXTS)[number];

/** Resolve group_by → the filter catalog key; the handler then prunes non-groupable fields. */
function resolveContext(context: FieldContext): 'filter' | 'select' {
  return context === 'select' ? 'select' : 'filter';
}

/** Raw date fields OpenAlex rejects as group_by targets — valid as filters, not as aggregation keys. */
const NON_GROUPABLE_DATE_FIELDS: ReadonlySet<string> = new Set([
  'publication_date',
  'created_date',
  'updated_date',
]);

/**
 * Whether a filter field is also a valid group_by target. group_by is a subset of filter:
 * OpenAlex rejects (HTTP 400) the `*.search`/`*.search.exact` text operators, the `from_*`/`to_*`
 * range-modifier directives, and the raw date fields — all valid as filters but not as aggregation
 * keys. Integer count fields ARE groupable (bucketed) and are intentionally kept.
 */
function isGroupableField(field: string): boolean {
  if (field.endsWith('.search') || field.endsWith('.search.exact')) return false;
  if (field.startsWith('from_') || field.startsWith('to_')) return false;
  return !NON_GROUPABLE_DATE_FIELDS.has(field);
}

export const describeFieldsTool = tool('openalex_describe_fields', {
  description:
    'List valid field names for an OpenAlex entity type and context (filter, group_by, or select). Use proactively before constructing a filter or group_by to avoid invalid-field 400 errors. Pass `query` to narrow the results by name similarity — useful when you have a partial or guessed field name.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/describe-fields.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    entity_type: z.enum(ENTITY_TYPES).describe('OpenAlex entity type to list fields for.'),
    context: z
      .enum(CONTEXTS)
      .describe(
        'Field usage context. "filter": fields accepted in the filter param. "group_by": fields accepted in group_by — a subset of the filter set (raw date and *.search fields are excluded; they cannot be grouped). "select": fields accepted in select.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Optional partial or guessed field name to rank results by similarity. Pass the field you tried (e.g. "funder") to get the closest matches first. Omit to return all fields for the entity_type + context.',
      ),
  }),
  output: z.object({
    entity_type: z.string().describe('Entity type queried.'),
    context: z.string().describe('Context queried (filter, group_by, or select).'),
    fields: z
      .array(z.string())
      .describe('Valid field names, ranked by similarity to query when provided.'),
    total: z.number().describe('Total number of valid fields for this entity_type + context.'),
  }),

  handler(input, ctx) {
    const catalog = getFieldCatalog();
    const catalogContext = resolveContext(input.context);
    const catalogPool = catalog[input.entity_type]?.[catalogContext] ?? [];
    // group_by accepts only a subset of the filter fields — drop the ones OpenAlex rejects as
    // aggregation keys so the tool never advertises a field analyze_trends will 400 on. filter
    // and select keep the full set (dates / *.search / range-modifiers are valid there).
    const pool = input.context === 'group_by' ? catalogPool.filter(isGroupableField) : catalogPool;

    const fields = input.query ? rankFields(input.query, pool, 20) : pool;

    ctx.log.info('Field catalog lookup', {
      entityType: input.entity_type,
      context: input.context,
      query: input.query,
      matchCount: fields.length,
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
    const note =
      result.fields.length < result.total
        ? `\n\n*(showing top ${result.fields.length} of ${result.total} by similarity)*`
        : '';
    return [{ type: 'text', text: `${header}:\n\n${list}${note}` }];
  },
});
