/**
 * @fileoverview Field discovery tool for OpenAlex valid filter, group_by, and select fields.
 * @module mcp-server/tools/definitions/describe-fields.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { rankAllFields } from '@/services/openalex/field-ranker.js';
import { getFieldCatalog } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES, type EntityType } from '@/services/openalex/types.js';

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
 * Filter fields OpenAlex answers with an HTTP 400 as a group_by target, beyond the rule-based
 * exclusions in `isGroupableField`. Taken from a live sweep that grouped every field this view
 * listed on all eight entity types (2026-09-23): "Cannot group by date, number, or search
 * fields." (decimal scores, several source year fields, `topics_count`), "Cannot group by
 * <field>." (`display_name`, external-ID and page fields), "Group by referenced_works is not
 * supported at this time.", and — for the three concept keys on authors — an invalid-ID 400.
 *
 * Keyed by entity type because the same name can group on one type and fail on another
 * (`concepts.id` fails on authors and groups on works). The catalog stores names only, and name
 * shape does not predict the outcome — `summary_stats.2yr_mean_citedness` and `publication_year`
 * group while `fwci` and sources' `first_publication_year` do not — so the sweep is the rule.
 * Re-run it after regenerating the field catalog.
 */
const GROUP_BY_REJECTED_FIELDS: Record<EntityType, ReadonlySet<string>> = {
  works: new Set([
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
  ]),
  authors: new Set(['concept.id', 'concepts.id', 'display_name', 'x_concepts.id']),
  sources: new Set([
    'apc_prices.price',
    'display_name',
    'first_publication_year',
    'ids.mag',
    'is_high_oa_rate_since_year',
    'is_in_doaj_since_year',
    'is_in_jstage_since_year',
    'last_publication_year',
    'oa_flip_year',
  ]),
  institutions: new Set(['display_name']),
  topics: new Set(['display_name']),
  keywords: new Set(['display_name']),
  publishers: new Set(['display_name']),
  funders: new Set(['display_name']),
};

/**
 * Fields OpenAlex lists as valid filters but answers with an HTTP 500 on every group_by attempt
 * — an upstream defect rather than a documented restriction. A 500 classifies as
 * ServiceUnavailable, whose recovery tells the caller to wait and retry, so advertising these as
 * groupable sends an agent into a loop that never clears. Fields that 500 only intermittently
 * and group on a retry (`openalex`, `authorships.author.id`) stay listed. Drop an entry once
 * upstream starts answering it.
 */
const GROUP_BY_UPSTREAM_FAILURES: Partial<Record<EntityType, ReadonlySet<string>>> = {
  works: new Set([
    'best_oa_location.raw_type',
    'cites',
    'has_embeddings',
    'locations.raw_type',
    'primary_location.raw_type',
  ]),
  sources: new Set(['is_preprint_repository']),
};

/**
 * Whether a filter field of `entityType` is also a valid group_by target. group_by is a subset of
 * filter: OpenAlex rejects (HTTP 400) the `*.search`/`*.search.exact` text operators, the
 * `from_*`/`to_*` range-modifier directives, the raw date fields, and the per-type sweep rejects
 * above — all valid as filters but not as aggregation keys. Most integer count fields ARE
 * groupable (bucketed) and are intentionally kept.
 */
function isGroupableField(entityType: EntityType, field: string): boolean {
  if (field.endsWith('.search') || field.endsWith('.search.exact')) return false;
  if (field.startsWith('from_') || field.startsWith('to_')) return false;
  if (NON_GROUPABLE_DATE_FIELDS.has(field)) return false;
  if (GROUP_BY_REJECTED_FIELDS[entityType].has(field)) return false;
  return !GROUP_BY_UPSTREAM_FAILURES[entityType]?.has(field);
}

export const describeFieldsTool = tool('openalex_describe_fields', {
  description:
    'List valid field names for an OpenAlex entity type and context (filter, group_by, or select). Use proactively before constructing a filter or group_by to avoid invalid-field 400 errors. Pass `query` to rank the list by name similarity — useful when you have a partial or guessed field name. Ranking never drops a field: the full list comes back either way.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/describe-fields.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    entity_type: z.enum(ENTITY_TYPES).describe('OpenAlex entity type to list fields for.'),
    context: z
      .enum(CONTEXTS)
      .describe(
        'Field usage context. "filter": fields accepted in the filter param. "group_by": fields accepted in group_by — a subset of the filter set that leaves out what OpenAlex refuses to aggregate (raw dates, *.search operators, decimal scores, display_name, and external-ID fields among them). "select": fields accepted in select.',
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

    const fields = input.query ? rankAllFields(input.query, pool) : pool;

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
