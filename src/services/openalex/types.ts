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
