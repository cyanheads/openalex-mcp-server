/**
 * @fileoverview Domain types for OpenAlex API interactions.
 * @module services/openalex/types
 */

export const ENTITY_TYPES = [
  'works',
  'authors',
  'sources',
  'institutions',
  'topics',
  'keywords',
  'publishers',
  'funders',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Default `select` fields applied to search queries (not single-entity lookups) when the caller
 * doesn't specify `select`. Prevents 20-70KB-per-record responses from blowing up context windows.
 */
export const DEFAULT_SELECT: Record<EntityType, string[]> = {
  works: [
    'id',
    'doi',
    'display_name',
    'publication_year',
    'type',
    'cited_by_count',
    'open_access',
    'primary_topic',
    'primary_location',
  ],
  authors: [
    'id',
    'display_name',
    'orcid',
    'works_count',
    'cited_by_count',
    'last_known_institutions',
    'summary_stats',
    'topics',
  ],
  institutions: [
    'id',
    'display_name',
    'ror',
    'country_code',
    'type',
    'works_count',
    'cited_by_count',
  ],
  sources: [
    'id',
    'display_name',
    'issn_l',
    'type',
    'is_oa',
    'works_count',
    'cited_by_count',
    'host_organization_name',
  ],
  topics: [
    'id',
    'display_name',
    'description',
    'keywords',
    'subfield',
    'field',
    'domain',
    'works_count',
    'cited_by_count',
  ],
  keywords: ['id', 'display_name', 'works_count', 'cited_by_count'],
  publishers: ['id', 'display_name', 'works_count', 'cited_by_count', 'country_codes'],
  funders: ['id', 'display_name', 'works_count', 'cited_by_count', 'country_code'],
};

export interface SearchParams {
  cursor?: string | undefined;
  entityType: EntityType;
  filters?: Record<string, string> | undefined;
  id?: string | undefined;
  perPage?: number | undefined;
  query?: string | undefined;
  searchMode?: 'keyword' | 'exact' | 'semantic' | undefined;
  select?: string[] | undefined;
  sort?: string | undefined;
}

export interface SearchResult {
  meta: {
    count: number;
    per_page: number;
    next_cursor: string | null;
  };
  results: EntityRecord[];
}

export interface AnalyzeParams {
  cursor?: string | undefined;
  entityType: EntityType;
  filters?: Record<string, string> | undefined;
  groupBy: string;
  includeUnknown?: boolean | undefined;
}

export interface AnalyzeResult {
  groups: GroupRecord[];
  meta: {
    count: number;
    groups_count: number | null;
    next_cursor: string | null;
  };
}

export interface AutocompleteParams {
  entityType?: EntityType | undefined;
  filters?: Record<string, string> | undefined;
  query: string;
}

export interface AutocompleteResult {
  results: AutocompleteRecord[];
}

export interface EntityRecord {
  display_name: string;
  id: string;
  [key: string]: unknown;
}

export interface GroupRecord {
  count: number;
  key: string;
  key_display_name: string;
}

export interface AutocompleteRecord {
  cited_by_count: number;
  display_name: string;
  entity_type: string;
  external_id: string | null;
  hint: string | null;
  id: string;
  works_count: number | null;
}
