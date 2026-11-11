/**
 * @fileoverview Which filter fields OpenAlex also accepts as a group_by target. Read by
 * `openalex_describe_fields` (its group_by list) and by the service's invalid-field suggestions
 * for a rejected group_by key, so neither ever names a field a group_by request would fail on.
 * @module services/openalex/groupable-fields
 */

import type { EntityType } from './types.js';

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
 * fields." (decimal scores, several source year fields), "Cannot group by
 * <field>." (`display_name`, external-ID and page fields), "Group by referenced_works is not
 * supported at this time.", and — for the three concept keys on authors — an invalid-ID 400.
 *
 * Keyed by entity type because the same name can group on one type and fail on another
 * (`concepts.id` fails on authors and groups on works). The catalog stores names only, and name
 * shape does not predict the outcome — `summary_stats.2yr_mean_citedness` and `publication_year`
 * group while `fwci` and sources' `first_publication_year` do not — so the sweep is the rule.
 *
 * The fields the 2026-10-18 catalog regeneration added were each grouped once: the lookup fields
 * below answered "Cannot group by <field>: it is looked up from the related <entity> at query
 * time.", and the rest grouped. The split is per field, not per prefix —
 * `primary_location.source.listed_in` groups while `primary_location.source.is_ojs` does not, and
 * institutions' own `geo.city` groups while works' `authorships.institutions.geo.city` does not.
 * Probe each new field after regenerating the field catalog; the generator rewrites only the JSON,
 * so these exclusions survive it.
 *
 * The 2026-10-28 regeneration added awards, whose 56 non-search filter fields were swept the same
 * way, and two institutions count fields, each grouped once. Sources' `is_in_jstage` matches the
 * filter it names but answers "Cannot group by is_in_jstage: OpenAlex doesn't record which sources
 * are in J-STAGE."
 *
 * The 2026-11-10 regeneration added five fields, each grouped once (works `is_traditional`,
 * authors' and institutions' `awards_count`, awards `investigators.author.id` and
 * `lead_investigator.author.id`). Works `topics_count` and sources `is_in_jstage_since_year` left
 * the catalog, since OpenAlex now refuses both as filters too, so neither needs an entry here.
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
    // looked up from a related entity at query time (2026-10-18)
    'authorships.institutions.geo.city',
    'authorships.institutions.geo.region',
    'funders.country_code',
    'primary_location.source.country_code',
    'primary_location.source.host_organization.country_code',
    'primary_location.source.is_global_south',
    'primary_location.source.is_high_oa_rate',
    'primary_location.source.is_ojs',
    'primary_location.source.is_preprint_repository',
    'primary_location.source.summary_stats.2yr_mean_citedness',
    'primary_location.source.summary_stats.h_index',
  ]),
  authors: new Set([
    'concept.id',
    'concepts.id',
    'display_name',
    'x_concepts.id',
    // looked up from a related entity at query time (2026-10-18)
    'last_known_institutions.geo.city',
    'last_known_institutions.geo.region',
  ]),
  sources: new Set([
    'apc_prices.price',
    'display_name',
    'first_publication_year',
    'ids.mag',
    'is_high_oa_rate_since_year',
    'is_in_doaj_since_year',
    'is_in_jstage',
    'last_publication_year',
    'oa_flip_year',
    // looked up from a related entity at query time (2026-10-18)
    'host_organization.country_code',
  ]),
  institutions: new Set([
    'display_name',
    'works_count_with_children',
    'works_count_with_children_and_predecessors',
  ]),
  topics: new Set(['display_name']),
  keywords: new Set(['display_name']),
  publishers: new Set(['display_name']),
  funders: new Set(['display_name']),
  awards: new Set([
    'amount',
    'amount_usd',
    'doi',
    'funded_outputs_count',
    'sub_awards_count',
    // looked up from a related entity at query time
    'funder.country_code',
  ]),
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
  awards: new Set([
    'lead_investigator.affiliation.name',
    'lead_investigator.family_name',
    'lead_investigator.given_name',
  ]),
};

/**
 * Whether a filter field of `entityType` is also a valid group_by target. group_by is a subset of
 * filter: OpenAlex rejects (HTTP 400) the `*.search`/`*.search.exact` text operators, the
 * `from_*`/`to_*` range-modifier directives, the raw date fields, and the per-type sweep rejects
 * above — all valid as filters but not as aggregation keys. Most integer count fields ARE
 * groupable (bucketed) and are intentionally kept.
 */
export function isGroupableField(entityType: EntityType, field: string): boolean {
  if (field.endsWith('.search') || field.endsWith('.search.exact')) return false;
  if (field.startsWith('from_') || field.startsWith('to_')) return false;
  if (NON_GROUPABLE_DATE_FIELDS.has(field)) return false;
  if (GROUP_BY_REJECTED_FIELDS[entityType].has(field)) return false;
  return !GROUP_BY_UPSTREAM_FAILURES[entityType]?.has(field);
}
