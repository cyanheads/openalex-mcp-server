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

/** Resolve group_by → filter for catalog lookup (they share the same valid-field set). */
function resolveContext(context: FieldContext): 'filter' | 'select' {
  return context === 'select' ? 'select' : 'filter';
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
        'Field usage context. "filter": fields accepted in the filter param. "group_by": fields accepted in group_by (same valid set as filter). "select": fields accepted in select.',
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
    const pool = catalog[input.entity_type]?.[catalogContext] ?? [];

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
