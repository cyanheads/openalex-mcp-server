/**
 * @fileoverview Primary discovery and lookup tool for OpenAlex entities.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

type Scalar = string | number | boolean;
type SearchEntityRecord = {
  display_name: string;
  id: string;
} & Record<string, unknown>;

function toFieldLabel(field: string): string {
  return field
    .split(/[_\-.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isScalarOrNull(value: unknown): value is Scalar | null {
  return value === null || isScalar(value);
}

function formatScalar(value: Scalar): string {
  return typeof value === 'number' && Number.isInteger(value)
    ? value.toLocaleString()
    : String(value);
}

function renderJsonField(label: string, value: unknown): string {
  return `**${label}:**\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderField(field: string, value: unknown): string {
  const label = toFieldLabel(field);
  if (value == null) return `**${label}:** —`;
  if (isScalar(value)) return `**${label}:** ${formatScalar(value)}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `**${label}:** (empty)`;
    if (value.every(isScalarOrNull)) {
      return `**${label}:** ${value.map((item) => (item === null ? '—' : formatScalar(item))).join(', ')}`;
    }
  }

  return renderJsonField(label, value);
}

function renderRecord(record: SearchEntityRecord): string[] {
  const { id, display_name, ...rest } = record;
  const lines = ['', `### ${display_name || id}`, `**ID:** ${id}`];

  for (const [field, value] of Object.entries(rest)) {
    lines.push(renderField(field, value));
  }

  return lines;
}

export const searchEntitiesTool = tool('openalex_search_entities', {
  description:
    'Search, filter, sort, or retrieve by ID. Covers all OpenAlex entity types (works, authors, sources, institutions, topics, keywords, publishers, funders). Pass `id` to retrieve a single entity (free, unlimited API calls). Otherwise, use `query` and/or `filters` for discovery. Supports keyword search with boolean operators, exact phrase matching, and AI semantic search. Use openalex_resolve_name to resolve names to IDs before filtering. Searches return a curated set of fields by default; pass `select` to override with specific fields.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
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
        'Filter criteria as field:value pairs. AND across fields (multiple keys). OR within field: pipe-separate ("us|gb"). NOT: prefix "!" ("!us"). Range: "2020-2024". Comparison: ">100", "<50". AND within same field: "+"-separate. Use OpenAlex IDs (not names) for entity filters — resolve names first.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort field. Prefix with "-" for descending. Common: "cited_by_count", "-publication_date", "relevance_score" (default when query present).',
      ),
    select: z
      .array(z.string())
      .optional()
      .describe(
        'OpenAlex top-level field names to return. Searches apply a curated default per entity type; pass to override. Single-entity lookups (by `id`) return the full record unless set. Invalid field names produce an error listing the valid ones. Example: ["id", "doi", "display_name", "authorships", "primary_topic"].',
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
          .passthrough(),
      )
      .describe(
        'OpenAlex entity objects passed through unchanged. Additional fields depend on entity_type and select.',
      ),
  }),

  async handler(input, ctx) {
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

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const countLabel = `${result.meta.count} result(s) — ${result.meta.per_page} per page`;
    lines.push(
      result.meta.next_cursor
        ? `**${countLabel}** — next cursor: \`${result.meta.next_cursor}\``
        : `**${countLabel}**`,
    );

    if (result.results.length === 0) {
      lines.push('', 'No matches.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const record of result.results) {
      lines.push(...renderRecord(record as SearchEntityRecord));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
