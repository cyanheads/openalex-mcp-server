/**
 * @fileoverview Tests for openalex_describe_fields tool.
 * @module mcp-server/tools/definitions/describe-fields.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the service module so tests don't need a live OpenAlex connection.
// The describe-fields tool uses getFieldCatalog() from the service, so we
// forward the real field catalog from the JSON source file.
import fieldCatalog from '@/services/openalex/field-catalog.json' with { type: 'json' };

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getFieldCatalog: () => fieldCatalog,
}));

const { describeFieldsTool } = await import(
  '@/mcp-server/tools/definitions/describe-fields.tool.js'
);

describe('describeFieldsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('catalog lookup', () => {
    it('returns filter fields for works without a query', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.entity_type).toBe('works');
      expect(result.context).toBe('filter');
      expect(result.fields.length).toBeGreaterThan(0);
      expect(result.total).toBe(result.fields.length);
      // works filter pool is large (200+ fields)
      expect(result.total).toBeGreaterThan(100);
    });

    it('returns select fields for works without a query', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'select',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.context).toBe('select');
      expect(result.total).toBeGreaterThan(0);
      // works select pool (~58) is far smaller than the filter pool (206)
      expect(result.total).toBeLessThan(100);
      expect(result.fields).toContain('id');
      expect(result.fields).toContain('display_name');
    });

    it('excludes non-groupable fields from group_by — a strict subset of filter (gh #42)', async () => {
      const ctx = createMockContext();
      const filterInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
      });
      const groupByInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'group_by',
      });

      const filterResult = await describeFieldsTool.handler(filterInput, ctx);
      const groupByResult = await describeFieldsTool.handler(groupByInput, ctx);

      // group_by is a strict subset of filter — the non-groupable fields are pruned.
      expect(groupByResult.total).toBeLessThan(filterResult.total);
      expect(groupByResult.fields.length).toBeLessThan(filterResult.fields.length);
      for (const field of groupByResult.fields) {
        expect(filterResult.fields).toContain(field);
      }

      // Concrete traps removed: raw date fields, *.search operators, from_*/to_* range modifiers.
      for (const excluded of [
        'publication_date',
        'created_date',
        'updated_date',
        'default.search',
        'title.search',
        'abstract.search.exact',
        'from_publication_date',
        'to_publication_date',
        'to_updated_date',
      ]) {
        expect(filterResult.fields).toContain(excluded);
        expect(groupByResult.fields).not.toContain(excluded);
      }

      // Groupable fields kept: year, categorical, and integer-count fields.
      for (const kept of [
        'publication_year',
        'type',
        'oa_status',
        'cited_by_count',
        'awards.funder_id',
      ]) {
        expect(groupByResult.fields).toContain(kept);
      }
    });

    it('surfaces the recovered catalog fields in filter and select (gh #56)', async () => {
      const ctx = createMockContext();
      const sourcesFilter = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'sources', context: 'filter' }),
        ctx,
      );
      const sourcesSelect = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'sources', context: 'select' }),
        ctx,
      );
      const authorsFilter = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'authors', context: 'filter' }),
        ctx,
      );

      expect(sourcesFilter.fields).toContain('is_preprint_repository');
      expect(sourcesFilter.fields).toContain('text.search');
      expect(sourcesSelect.fields).toContain('is_preprint_repository');
      expect(authorsFilter.fields).toContain('last_known_authorships.institutions.lineage');
    });

    it('keeps is_preprint_repository out of group_by, where upstream 500s on it (gh #56)', async () => {
      // Valid as a filter and a select field, but grouping by it answers HTTP 500 — which
      // classifies as ServiceUnavailable and tells the caller to retry, forever.
      const ctx = createMockContext();
      const groupBy = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({ entity_type: 'sources', context: 'group_by' }),
        ctx,
      );

      expect(groupBy.fields).not.toContain('is_preprint_repository');
      // The sibling booleans still group fine and must stay.
      expect(groupBy.fields).toContain('is_oa');
    });

    /**
     * A live sweep grouped every field the group_by view listed, on all eight entity types
     * (2026-09-23). These are the ones OpenAlex refused: a 400 ("Cannot group by …", "Group by
     * referenced_works is not supported at this time.", or — for the authors concept keys — an
     * invalid-ID 400), or a 500 on every attempt. Each stays a valid filter. (gh #86)
     */
    const SWEEP_REJECTS: Record<string, string[]> = {
      works: [
        'biblio.first_page',
        'biblio.last_page',
        'citation_normalized_percentile.value',
        'cited_by',
        'display_name',
        'doi',
        'fwci',
        'ids.mag',
        'ids.pmcid',
        'ids.pmid',
        'mag',
        'pmcid',
        'pmid',
        'referenced_works',
        'related_to',
        'sustainable_development_goals.score',
        'topics_count',
        // HTTP 500 on every probe
        'best_oa_location.raw_type',
        'cites',
        'has_embeddings',
        'locations.raw_type',
        'primary_location.raw_type',
      ],
      authors: ['concept.id', 'concepts.id', 'display_name', 'x_concepts.id'],
      sources: [
        'apc_prices.price',
        'display_name',
        'first_publication_year',
        'ids.mag',
        'is_high_oa_rate_since_year',
        'is_in_doaj_since_year',
        'is_in_jstage_since_year',
        'last_publication_year',
        'oa_flip_year',
      ],
      institutions: ['display_name'],
      topics: ['display_name'],
      keywords: ['display_name'],
      publishers: ['display_name'],
      funders: ['display_name'],
    };

    /** Fields the same sweep grouped successfully, including the near neighbours of rejects. */
    const SWEEP_GROUPED: Record<string, string[]> = {
      works: [
        'publication_year',
        'cited_by_count',
        'authors_count',
        'referenced_works_count',
        'concepts_count',
        'locations_count',
        'apc_list.value',
        'cited_by_percentile_year.min',
        'citation_normalized_percentile.is_in_top_1_percent',
        'concepts.id',
        'authorships.author.id',
        'openalex',
        'ids.openalex',
        'raw_affiliation_strings',
      ],
      authors: ['works_count', 'summary_stats.2yr_mean_citedness', 'orcid', 'id', 'has_orcid'],
      sources: ['works_count', 'issn', 'concepts.id', 'x_concepts.id', 'apc_prices.currency'],
      institutions: ['x_concepts.id', 'ror', 'summary_stats.h_index'],
      topics: ['id', 'works_count'],
      keywords: ['id', 'cited_by_count'],
      publishers: ['ids.ror', 'country_codes'],
      funders: ['awards_count', 'ror'],
    };

    /** group_by view size per entity type after the sweep — every other listed field grouped. */
    const GROUP_BY_TOTALS: Record<string, number> = {
      works: 160,
      authors: 33,
      sources: 32,
      institutions: 28,
      topics: 9,
      keywords: 4,
      publishers: 19,
      funders: 20,
    };

    it.each(Object.entries(SWEEP_REJECTS))(
      'drops the fields OpenAlex refuses to group %s by, keeping them as filters (gh #86)',
      async (entityType, rejects) => {
        const ctx = createMockContext();
        const [filter, groupBy] = await Promise.all(
          (['filter', 'group_by'] as const).map((context) =>
            describeFieldsTool.handler(
              describeFieldsTool.input.parse({ entity_type: entityType, context }),
              ctx,
            ),
          ),
        );

        for (const field of rejects) {
          expect(filter?.fields, `${field} left the ${entityType} filter view`).toContain(field);
          expect(groupBy?.fields, `${field} still listed for ${entityType} group_by`).not.toContain(
            field,
          );
        }
        for (const field of SWEEP_GROUPED[entityType] ?? []) {
          expect(groupBy?.fields, `${field} groups today but was dropped`).toContain(field);
        }
        expect(groupBy?.total).toBe(GROUP_BY_TOTALS[entityType]);
        expect(groupBy?.fields).toHaveLength(GROUP_BY_TOTALS[entityType] ?? -1);
      },
    );

    it('keeps a field rejected on one entity type listed where it groups (gh #86)', async () => {
      // concepts.id 400s as an authors group_by key but groups works, sources, and institutions.
      const ctx = createMockContext();
      const view = (entity_type: string) =>
        describeFieldsTool.handler(
          describeFieldsTool.input.parse({ entity_type, context: 'group_by' }),
          ctx,
        );

      expect((await view('authors')).fields).not.toContain('concepts.id');
      for (const entityType of ['works', 'sources', 'institutions']) {
        expect((await view(entityType)).fields).toContain('concepts.id');
      }
    });

    it('renders the pruned group_by view in content[] too (gh #86)', async () => {
      const ctx = createMockContext();
      const result = await describeFieldsTool.handler(
        describeFieldsTool.input.parse({
          entity_type: 'works',
          context: 'group_by',
          query: 'fwci',
        }),
        ctx,
      );
      const text = (describeFieldsTool.format?.(result) ?? [])
        .map((b) => ('text' in b ? b.text : ''))
        .join('\n');

      expect(text).toContain('**works** / **group_by** — 160 valid fields');
      expect(text).not.toMatch(/^- fwci$/m);
      expect(text).toMatch(/^- publication_year$/m);
    });

    it('does not surface publication_date when querying the group_by context (gh #42 repro)', async () => {
      const ctx = createMockContext();
      const groupByInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'group_by',
        query: 'publication_date',
      });
      const filterInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
        query: 'publication_date',
      });

      const groupByResult = await describeFieldsTool.handler(groupByInput, ctx);
      const filterResult = await describeFieldsTool.handler(filterInput, ctx);

      // The repro: publication_date must NOT appear in the group_by view (analyze_trends 400s on it)…
      expect(groupByResult.fields).not.toContain('publication_date');
      // …but publication_year, its groupable sibling, still ranks in.
      expect(groupByResult.fields).toContain('publication_year');
      // filter context legitimately still surfaces publication_date.
      expect(filterResult.fields).toContain('publication_date');
    });

    it('returns funders filter fields', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'funders',
        context: 'filter',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.total).toBeGreaterThan(0);
      expect(result.fields).toContain('display_name');
    });
  });

  describe('query ranking', () => {
    it('ranks awards.funder_id near the top for query "funder" on works/group_by', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'group_by',
        query: 'funder',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields.slice(0, 5)).toContain('awards.funder_id');
      // A query ranks the pool; it does not remove members of it.
      expect(result.fields.length).toBe(result.total);
    });

    /**
     * Was "returns fewer results when query is specific" — the cap it encoded is what hid
     * `summary_stats` from the caller looking for `h_index`. A query now reorders the same
     * pool, so the two calls return the same fields in a different order. (gh #63)
     */
    it('returns the same field set with or without a query — ranking, not filtering', async () => {
      const ctx = createMockContext();
      const allInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
      });
      const queriedInput = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
        query: 'funder',
      });

      const allResult = await describeFieldsTool.handler(allInput, ctx);
      const queriedResult = await describeFieldsTool.handler(queriedInput, ctx);

      expect(queriedResult.total).toBe(allResult.total);
      expect(queriedResult.fields.length).toBe(allResult.fields.length);
      expect(new Set(queriedResult.fields)).toEqual(new Set(allResult.fields));
      // …but ranked, so the query's best match moved to the front.
      expect(queriedResult.fields[0]).not.toBe(allResult.fields[0]);
    });

    /**
     * The reported repro: `h_index` is real author data living at `summary_stats.h_index`, and
     * asking where it lives returned every authors/select field except the one that holds it.
     */
    it('returns summary_stats for query "h_index" on authors/select (gh #63)', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'authors',
        context: 'select',
        query: 'h_index',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields).toContain('summary_stats');
      expect(result.fields.length).toBe(result.total);
    });

    it('returns id for query "summary_stats" on authors/select (gh #63)', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'authors',
        context: 'select',
        query: 'summary_stats',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields).toContain('id');
      expect(result.fields[0]).toBe('summary_stats');
      expect(result.fields.length).toBe(result.total);
    });

    it('withholds nothing from the 206-field works/filter pool (gh #63)', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'works',
        context: 'filter',
        query: 'funder',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.total).toBeGreaterThan(200);
      expect(result.fields.length).toBe(result.total);
    });

    it('leaves the no-query path unranked and complete', async () => {
      const ctx = createMockContext();
      const input = describeFieldsTool.input.parse({
        entity_type: 'authors',
        context: 'select',
      });

      const result = await describeFieldsTool.handler(input, ctx);

      expect(result.fields.length).toBe(result.total);
      expect(result.fields).toContain('summary_stats');
    });
  });

  describe('format()', () => {
    it('renders a header with entity_type, context, and total count', () => {
      const content =
        describeFieldsTool.format?.({
          entity_type: 'works',
          context: 'filter',
          fields: ['publication_year', 'type', 'is_oa'],
          total: 206,
        }) ?? [];

      expect(content).toHaveLength(1);
      const text = content[0]?.type === 'text' ? content[0].text : '';
      expect(text).toContain('works');
      expect(text).toContain('filter');
      expect(text).toContain('206');
      expect(text).toContain('publication_year');
    });

    it('renders every ranked field with no truncation note (gh #63)', () => {
      const content =
        describeFieldsTool.format?.({
          entity_type: 'authors',
          context: 'select',
          fields: ['summary_stats', 'id', 'display_name'],
          total: 3,
        }) ?? [];

      const text = content[0]?.type === 'text' ? content[0].text : '';
      expect(text).toContain('summary_stats');
      expect(text).toContain('display_name');
      expect(text).not.toContain('showing top');
    });

    it('renders "No matches." when fields is empty', () => {
      const content =
        describeFieldsTool.format?.({
          entity_type: 'authors',
          context: 'select',
          fields: [],
          total: 21,
        }) ?? [];
      const text = content[0]?.type === 'text' ? content[0].text : '';
      expect(text).toContain('No matches.');
    });
  });
});
