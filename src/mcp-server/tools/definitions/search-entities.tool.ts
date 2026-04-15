/**
 * @fileoverview Primary discovery and lookup tool for OpenAlex entities.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

type ScalarValue = string | number | boolean | null;
type SearchEntityRecord = {
  display_name: string;
  id: string;
} & Record<string, unknown>;

const IDENTIFIER_FIELDS = [
  ['doi', 'DOI'],
  ['orcid', 'ORCID'],
  ['ror', 'ROR'],
  ['issn_l', 'ISSN'],
] as const;

const SUMMARY_FIELDS = [
  ['publication_year', 'Year'],
  ['type', 'Type'],
  ['country_code', 'Country'],
] as const;

const TOPIC_FIELDS = [
  ['domain', 'Domain'],
  ['field', 'Field'],
  ['subfield', 'Subfield'],
] as const;

function toFieldLabel(field: string): string {
  return field
    .split(/[_\-.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function isScalarValue(value: unknown): value is ScalarValue {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function markConsumed(consumed: Set<string>, ...fields: string[]): void {
  for (const field of fields) {
    consumed.add(field);
  }
}

function pushConsumedLine(
  lines: string[],
  consumed: Set<string>,
  field: string,
  content: string | null,
): void {
  if (!content) return;
  consumed.add(field);
  lines.push(content);
}

function formatScalarValue(value: string | number | boolean | null): string {
  if (value === null) return 'Not available';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function formatGenericValue(value: unknown): string {
  if (value === undefined) return 'Not available';

  if (isScalarValue(value)) {
    return formatScalarValue(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalarValue)) {
      return value.map((item) => formatScalarValue(item)).join(', ');
    }
  }

  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderGenericField(field: string, value: unknown): string {
  const formatted = formatGenericValue(value);
  return formatted.startsWith('\n')
    ? `**${toFieldLabel(field)}:**${formatted}`
    : `**${toFieldLabel(field)}:** ${formatted}`;
}

function formatRecord(record: SearchEntityRecord): string[] {
  const lines = [`## ${record.display_name}`, `**ID:** ${record.id}`];
  const consumed = new Set<string>(['id', 'display_name']);

  for (const [field, label] of IDENTIFIER_FIELDS) {
    const value = record[field];
    pushConsumedLine(lines, consumed, field, hasValue(value) ? `**${label}:** ${value}` : null);
  }

  for (const [field, label] of SUMMARY_FIELDS) {
    const value = record[field];
    pushConsumedLine(lines, consumed, field, hasValue(value) ? `**${label}:** ${value}` : null);
  }

  if (Array.isArray(record.country_codes) && record.country_codes.length > 0) {
    markConsumed(consumed, 'country_codes');
    lines.push(`**Countries:** ${(record.country_codes as string[]).join(', ')}`);
  }

  const metrics: string[] = [];
  if (typeof record.cited_by_count === 'number') {
    consumed.add('cited_by_count');
    metrics.push(`Citations: ${record.cited_by_count.toLocaleString()}`);
  }
  if (typeof record.works_count === 'number') {
    consumed.add('works_count');
    metrics.push(`Works: ${record.works_count.toLocaleString()}`);
  }
  if (metrics.length > 0) {
    lines.push(`**Metrics:** ${metrics.join(' | ')}`);
  }

  if (isRecord(record.open_access)) {
    consumed.add('open_access');
    const parts: string[] = [];
    if (hasValue(record.open_access.oa_status)) parts.push(String(record.open_access.oa_status));
    else if (typeof record.open_access.is_oa === 'boolean') {
      parts.push(record.open_access.is_oa ? 'open' : 'closed');
    }
    if (hasValue(record.open_access.oa_url)) parts.push(String(record.open_access.oa_url));
    if (parts.length > 0) lines.push(`**Open Access:** ${parts.join(' — ')}`);
  }
  if (typeof record.is_oa === 'boolean') {
    consumed.add('is_oa');
    lines.push(`**Open Access:** ${record.is_oa ? 'Yes' : 'No'}`);
  }

  if (isRecord(record.primary_location)) {
    consumed.add('primary_location');
    const source = isRecord(record.primary_location.source) ? record.primary_location.source : null;
    const sourceName = source?.display_name;
    if (hasValue(sourceName)) {
      lines.push(`**Source:** ${sourceName}`);
    }
  }
  pushConsumedLine(
    lines,
    consumed,
    'host_organization_name',
    hasValue(record.host_organization_name)
      ? `**Publisher:** ${record.host_organization_name}`
      : null,
  );

  if (isRecord(record.primary_topic)) {
    consumed.add('primary_topic');
    const hierarchy = [
      isRecord(record.primary_topic.domain) ? record.primary_topic.domain.display_name : undefined,
      isRecord(record.primary_topic.field) ? record.primary_topic.field.display_name : undefined,
      isRecord(record.primary_topic.subfield)
        ? record.primary_topic.subfield.display_name
        : undefined,
      record.primary_topic.display_name,
    ].filter(hasValue);
    if (hierarchy.length > 0) {
      lines.push(`**Topic:** ${hierarchy.join(' > ')}`);
    }
  }

  for (const [field, label] of TOPIC_FIELDS) {
    const value = record[field];
    if (!isRecord(value) || !hasValue(value.display_name)) continue;
    consumed.add(field);
    lines.push(`**${label}:** ${value.display_name}`);
  }

  pushConsumedLine(
    lines,
    consumed,
    'description',
    typeof record.description === 'string' ? `**Description:** ${record.description}` : null,
  );

  if (Array.isArray(record.keywords) && record.keywords.length > 0) {
    consumed.add('keywords');
    const keywords = (record.keywords as Array<Record<string, unknown> | string>)
      .map((keyword) => (typeof keyword === 'string' ? keyword : keyword.display_name))
      .filter(hasValue);
    if (keywords.length > 0) {
      lines.push(`**Keywords:** ${keywords.join(', ')}`);
    }
  }

  if (Array.isArray(record.last_known_institutions) && record.last_known_institutions.length > 0) {
    consumed.add('last_known_institutions');
    const institutions = (record.last_known_institutions as Array<Record<string, unknown>>)
      .map((institution) => institution.display_name)
      .filter(hasValue);
    if (institutions.length > 0) {
      lines.push(`**Institution(s):** ${institutions.join(', ')}`);
    }
  }

  if (isRecord(record.summary_stats)) {
    consumed.add('summary_stats');
    const parts: string[] = [];
    if (typeof record.summary_stats.h_index === 'number') {
      parts.push(`h-index: ${record.summary_stats.h_index}`);
    }
    if (typeof record.summary_stats.i10_index === 'number') {
      parts.push(`i10-index: ${record.summary_stats.i10_index}`);
    }
    if (typeof record.summary_stats['2yr_mean_citedness'] === 'number') {
      parts.push(`2yr mean citedness: ${record.summary_stats['2yr_mean_citedness'].toFixed(2)}`);
    }
    if (parts.length > 0) {
      lines.push(`**Stats:** ${parts.join(' | ')}`);
    }
  }

  if (Array.isArray(record.topics) && record.topics.length > 0) {
    consumed.add('topics');
    const topTopics = (record.topics as Array<Record<string, unknown>>)
      .slice(0, 5)
      .map((topic) => topic.display_name)
      .filter(hasValue);
    if (topTopics.length > 0) {
      lines.push(`**Top Topics:** ${topTopics.join(', ')}`);
    }
  }

  pushConsumedLine(
    lines,
    consumed,
    'abstract',
    typeof record.abstract === 'string' ? `**Abstract:** ${record.abstract}` : null,
  );

  if (Array.isArray(record.authorships) && record.authorships.length > 0) {
    consumed.add('authorships');
    const authors = (record.authorships as Array<Record<string, unknown>>).map((authorship) => {
      const author = isRecord(authorship.author) ? authorship.author : null;
      const institutions = Array.isArray(authorship.institutions)
        ? (authorship.institutions as Array<Record<string, unknown>>)
        : [];
      const institution = institutions[0]?.display_name;
      const name = author?.display_name ?? 'Unknown';
      return hasValue(institution) ? `${name} (${institution})` : String(name);
    });
    lines.push(`**Authors:** ${authors.join('; ')}`);
  }

  for (const [field, value] of Object.entries(record)) {
    if (consumed.has(field)) continue;
    lines.push(renderGenericField(field, value));
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
        'Fields to return. Top-level fields only. Searches apply sensible defaults per entity type; pass this to override. Single-entity lookups (by `id`) return the full record unless `select` is specified. Example: ["id", "doi", "display_name", "publication_year", "cited_by_count", "primary_topic"].',
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
      .describe('Entity objects. Additional fields depend on entity_type and select.'),
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
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No results found.' }];
    }
    const lines: string[] = [`**${result.meta.count.toLocaleString()} result(s)**`, ''];

    for (const r of result.results) {
      lines.push(...formatRecord(r as SearchEntityRecord));
      lines.push('');
    }

    if (result.meta.next_cursor) {
      lines.push('*More results available — pass cursor to paginate.*');
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
