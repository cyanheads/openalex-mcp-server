/**
 * @fileoverview Primary discovery and lookup tool for OpenAlex entities.
 * @module mcp-server/tools/definitions/search-entities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

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
      const rec = r as Record<string, unknown>;
      lines.push(`## ${r.display_name}`);
      lines.push(`**ID:** ${r.id}`);

      // Identifiers
      if (rec.doi) lines.push(`**DOI:** ${rec.doi}`);
      if (rec.orcid) lines.push(`**ORCID:** ${rec.orcid}`);
      if (rec.ror) lines.push(`**ROR:** ${rec.ror}`);
      if (rec.issn_l) lines.push(`**ISSN:** ${rec.issn_l}`);

      // Classification
      if (rec.publication_year) lines.push(`**Year:** ${rec.publication_year}`);
      if (rec.type) lines.push(`**Type:** ${rec.type}`);
      if (rec.country_code) lines.push(`**Country:** ${rec.country_code}`);
      if (Array.isArray(rec.country_codes) && rec.country_codes.length)
        lines.push(`**Countries:** ${(rec.country_codes as string[]).join(', ')}`);

      // Metrics
      const metrics: string[] = [];
      if (typeof rec.cited_by_count === 'number')
        metrics.push(`Citations: ${rec.cited_by_count.toLocaleString()}`);
      if (typeof rec.works_count === 'number')
        metrics.push(`Works: ${rec.works_count.toLocaleString()}`);
      if (metrics.length) lines.push(`**Metrics:** ${metrics.join(' | ')}`);

      // Open access
      if (rec.open_access && typeof rec.open_access === 'object') {
        const oa = rec.open_access as Record<string, unknown>;
        const parts: string[] = [];
        if (oa.oa_status) parts.push(String(oa.oa_status));
        else if (typeof oa.is_oa === 'boolean') parts.push(oa.is_oa ? 'open' : 'closed');
        if (oa.oa_url) parts.push(String(oa.oa_url));
        if (parts.length) lines.push(`**Open Access:** ${parts.join(' — ')}`);
      }
      if (typeof rec.is_oa === 'boolean') lines.push(`**Open Access:** ${rec.is_oa ? 'Yes' : 'No'}`);

      // Location / source
      if (rec.primary_location && typeof rec.primary_location === 'object') {
        const loc = rec.primary_location as Record<string, unknown>;
        const source = loc.source as Record<string, unknown> | undefined;
        if (source?.display_name) lines.push(`**Source:** ${source.display_name}`);
      }
      if (rec.host_organization_name) lines.push(`**Publisher:** ${rec.host_organization_name}`);

      // Topic hierarchy (works)
      if (rec.primary_topic && typeof rec.primary_topic === 'object') {
        const t = rec.primary_topic as Record<string, unknown>;
        const hierarchy = [
          (t.domain as Record<string, unknown> | undefined)?.display_name,
          (t.field as Record<string, unknown> | undefined)?.display_name,
          (t.subfield as Record<string, unknown> | undefined)?.display_name,
          t.display_name,
        ].filter(Boolean);
        if (hierarchy.length) lines.push(`**Topic:** ${hierarchy.join(' > ')}`);
      }

      // Topic entity fields (domain/field/subfield at top level)
      if (rec.domain && typeof rec.domain === 'object') {
        const d = rec.domain as Record<string, unknown>;
        if (d.display_name) lines.push(`**Domain:** ${d.display_name}`);
      }
      if (rec.field && typeof rec.field === 'object') {
        const f = rec.field as Record<string, unknown>;
        if (f.display_name) lines.push(`**Field:** ${f.display_name}`);
      }
      if (rec.subfield && typeof rec.subfield === 'object') {
        const s = rec.subfield as Record<string, unknown>;
        if (s.display_name) lines.push(`**Subfield:** ${s.display_name}`);
      }
      if (typeof rec.description === 'string') lines.push(`**Description:** ${rec.description}`);
      if (Array.isArray(rec.keywords) && rec.keywords.length > 0) {
        const kws = (rec.keywords as Array<Record<string, unknown> | string>)
          .map((k) => (typeof k === 'string' ? k : k.display_name))
          .filter(Boolean);
        if (kws.length) lines.push(`**Keywords:** ${kws.join(', ')}`);
      }

      // Author affiliations
      if (Array.isArray(rec.last_known_institutions) && rec.last_known_institutions.length > 0) {
        const insts = (rec.last_known_institutions as Array<Record<string, unknown>>)
          .map((i) => i.display_name)
          .filter(Boolean);
        if (insts.length) lines.push(`**Institution(s):** ${insts.join(', ')}`);
      }

      // Author summary stats
      if (rec.summary_stats && typeof rec.summary_stats === 'object') {
        const stats = rec.summary_stats as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof stats.h_index === 'number') parts.push(`h-index: ${stats.h_index}`);
        if (typeof stats.i10_index === 'number') parts.push(`i10-index: ${stats.i10_index}`);
        if (typeof stats['2yr_mean_citedness'] === 'number')
          parts.push(`2yr mean citedness: ${(stats['2yr_mean_citedness'] as number).toFixed(2)}`);
        if (parts.length) lines.push(`**Stats:** ${parts.join(' | ')}`);
      }

      // Author top topics
      if (Array.isArray(rec.topics) && rec.topics.length > 0) {
        const topTopics = (rec.topics as Array<Record<string, unknown>>)
          .slice(0, 5)
          .map((t) => t.display_name)
          .filter(Boolean);
        if (topTopics.length) lines.push(`**Top Topics:** ${topTopics.join(', ')}`);
      }

      // Full-record fields (single entity lookups)
      if (typeof rec.abstract === 'string') lines.push(`**Abstract:** ${rec.abstract}`);
      if (Array.isArray(rec.authorships) && rec.authorships.length > 0) {
        const authors = (rec.authorships as Array<Record<string, unknown>>).map((a) => {
          const author = a.author as Record<string, unknown> | undefined;
          const name = author?.display_name ?? 'Unknown';
          const insts = a.institutions as Array<Record<string, unknown>> | undefined;
          const inst = insts?.[0]?.display_name;
          return inst ? `${name} (${inst})` : String(name);
        });
        lines.push(`**Authors:** ${authors.join('; ')}`);
      }

      lines.push('');
    }

    if (result.meta.next_cursor) {
      lines.push('*More results available — pass cursor to paginate.*');
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
