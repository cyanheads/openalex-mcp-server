/**
 * @fileoverview Tool for resolving names to OpenAlex IDs via autocomplete.
 * @module mcp-server/tools/definitions/resolve-name.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

export const resolveNameTool = tool('openalex_resolve_name', {
  description:
    'Resolve a name or partial name to an OpenAlex ID. Returns up to 10 matches with disambiguation hints. ALWAYS use this before filtering by entity — names are ambiguous, IDs are not. Also accepts DOIs directly for quick lookup. Response time ~200ms.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    entity_type: z
      .enum(ENTITY_TYPES)
      .optional()
      .describe(
        'Entity type to search. Omit for cross-entity search (useful when entity type is unknown).',
      ),
    query: z
      .string()
      .min(1)
      .describe('Name or partial name to resolve. Also accepts DOIs for quick lookup.'),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Narrow autocomplete results with filters. Example: restrict to a specific country or publication year range.',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z.object({
          id: z.string().describe('OpenAlex ID.'),
          external_id: z
            .string()
            .nullable()
            .describe('Canonical external ID (DOI, ORCID, ROR, ISSN).'),
          display_name: z.string().describe('Human-readable name.'),
          entity_type: z
            .string()
            .describe('Entity type (work, author, source, institution, etc.).'),
          cited_by_count: z
            .number()
            .describe('Citation count (direct for works, aggregate for others).'),
          works_count: z
            .number()
            .nullable()
            .describe('Associated works. null for works themselves.'),
          hint: z
            .string()
            .nullable()
            .describe(
              'Disambiguation context: author names (works), last institution (authors), host org (sources), location (institutions).',
            ),
        }),
      )
      .describe('Autocomplete matches, up to 10.'),
  }),

  async handler(input, ctx) {
    const service = getOpenAlexService();
    const result = await service.autocomplete(
      {
        entityType: input.entity_type,
        query: input.query,
        filters: input.filters,
      },
      ctx,
    );

    ctx.log.info('Name resolved', {
      query: input.query,
      entityType: input.entity_type ?? 'all',
      matchCount: result.results.length,
    });

    return result;
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matches found.' }];
    }
    const lines: string[] = [];
    for (const r of result.results) {
      lines.push(`**${r.display_name}** (${r.entity_type})`);
      const details: string[] = [r.id];
      if (r.external_id) details.push(r.external_id);
      details.push(`${r.cited_by_count} citations`);
      details.push(r.works_count === null ? 'n/a works' : `${r.works_count} works`);
      if (r.hint) details.push(r.hint);
      lines.push(details.join(' | '));
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
