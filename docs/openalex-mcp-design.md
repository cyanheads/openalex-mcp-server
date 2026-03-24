# OpenAlex MCP Server -- Design

**Package:** `@cyanheads/openalex-mcp-server`

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openalex_search_entities` | Search, filter, sort, or retrieve by ID. Primary discovery and lookup tool. | `entity_type`, `id?`, `query?`, `search_mode?`, `filters?`, `sort?`, `select?`, `per_page?`, `cursor?` | `readOnlyHint`, `openWorldHint` |
| `openalex_analyze_trends` | Aggregate entities into groups by a field. Trend and distribution analysis. | `entity_type`, `group_by`, `filters?`, `include_unknown?`, `cursor?` | `readOnlyHint`, `openWorldHint` |
| `openalex_resolve_name` | Fast name-to-ID resolution. Always resolve names to IDs before filtering. | `entity_type?`, `query`, `filters?` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |

### Resources

None. Entity lookups require `select` for payload control (Works are ~70KB each), which makes a tool a better fit than a URI-addressed resource. The API is entirely read-only; there's no stable reference data (like a fixed taxonomy) small enough to be useful as injectable context.

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `openalex_literature_review` | Guides a systematic literature search: formulate query, search, filter, analyze citation network, synthesize findings. | `topic`, `scope?` |
| `openalex_research_landscape` | Analyzes the research landscape for a topic: volume trends, top authors/institutions, open access rates, funding sources. | `topic` |

---

## Overview

[OpenAlex](https://openalex.org) is a fully open catalog of the global research system -- 270M+ scholarly works, 90M+ authors, 100K+ sources, and their interconnections. CC0-licensed data, ~2x the coverage of Scopus/Web of Science, with strong non-English and Global South representation.

The MCP server wraps the OpenAlex REST API (`api.openalex.org`) to give LLM agents structured access to scholarly metadata: searching literature, profiling researchers, analyzing trends, traversing citation graphs, and resolving ambiguous names to stable IDs.

**Target users:** Researchers, research analysts, science journalists, grant writers, and any LLM workflow that needs to query the scholarly record.

**Read-only.** OpenAlex is a data catalog with no write operations.

---

## License & Deployability

| Aspect | Detail |
|:-------|:-------|
| **Data license** | CC0 (public domain). No restrictions on redistribution, commercial use, or derivative works. Attribution appreciated but not required. |
| **API access** | Free API key required (since Feb 2026). Sign up at openalex.org. |
| **Rate limits** | 100 req/s max. Free tier daily limits: singleton lookups unlimited, list/filter ~10K calls, search ~1K calls. |
| **Self-hosting OK?** | Yes. No terms prohibit proxying, caching, or rebroadcasting data. CC0 means zero legal constraints on the data itself. |
| **Operational notes** | Use `select` to minimize payload sizes. Prefer singleton lookups (free, unlimited) over list queries where possible. |

---

## Requirements

- Search works by keyword, exact phrase, boolean expressions, and semantic similarity
- Filter any entity type by 200+ fields (dates, counts, booleans, IDs, nested attributes)
- Resolve ambiguous names to OpenAlex IDs via autocomplete (critical first step)
- Retrieve full entity details by OpenAlex ID, DOI, ORCID, ROR, ISSN, or PMID
- Aggregate entities with `group_by` for trend/distribution analysis
- Traverse citation graphs: citing works, referenced works, semantically related works
- Control response size via `select` (sparse fieldsets) to avoid 70KB Work payloads
- Paginate large result sets via cursor
- Stay within free tier daily limits: singleton lookups unlimited, list/filter ~10K, search ~1K

---

## Domain Map

### Entities

| Entity | Description | Record count | Key IDs |
|:-------|:------------|:-------------|:--------|
| **Works** | Articles, books, datasets, theses | 270M+ | OpenAlex, DOI, PMID, PMCID |
| **Authors** | Disambiguated researcher profiles | 90M+ | OpenAlex, ORCID, Scopus |
| **Sources** | Journals, conferences, repositories | 100K+ | OpenAlex, ISSN |
| **Institutions** | Universities, organizations | 100K+ | OpenAlex, ROR |
| **Topics** | Hierarchical research classifications (domain > field > subfield > topic) | ~65K | OpenAlex |
| **Keywords** | Work-derived keyword tags | ~100K | OpenAlex |
| **Publishers** | Publishing organizations | ~10K | OpenAlex |
| **Funders** | Funding agencies | ~30K | OpenAlex |

### Operations per Entity

Every entity supports the same uniform API pattern:

| Operation | Endpoint | Parameters |
|:----------|:---------|:-----------|
| **List/filter** | `GET /{entities}?filter=...` | `filter`, `sort`, `per_page`, `cursor`, `select` |
| **Search** | `GET /{entities}?search=...` | `search` or `search.exact` or `search.semantic` |
| **Get one** | `GET /{entities}/{id}` | `select` |
| **Group by** | `GET /{entities}?group_by=...` | `group_by`, `filter` |
| **Autocomplete** | `GET /autocomplete/{entities}?q=...` | `q`, `filter` |

### Classification into MCP Primitives

| Operation | Primitive | Reasoning |
|:----------|:----------|:----------|
| Search + filter + sort + get by ID | **Tool** (`openalex_search_entities`) | Complex parameter combinations, LLM decisions about query strategy. ID lookup is a degenerate case (singleton). |
| Group-by aggregation | **Tool** (`openalex_analyze_trends`) | Distinct output shape (groups, not lists), analytical workflow |
| Autocomplete | **Tool** (`openalex_resolve_name`) | Name-to-ID resolution, critical first step in most workflows |
| Entity-by-ID (passive) | ~~Resource~~ skipped | `select` control not expressible in URI templates; tool is better fit |
| Literature review workflow | **Prompt** | Multi-step template the LLM follows |
| Research landscape workflow | **Prompt** | Analytical template using multiple tools |

---

## Tool Design

### Critical Workflow Pattern

The OpenAlex docs emphasize: **"Names are ambiguous. IDs are not."** The standard workflow is:

1. **Resolve** -- Use `openalex_resolve_name` to turn a name ("Harvard", "Yann LeCun") into a stable OpenAlex ID
2. **Discover** -- Use `openalex_search_entities` with the resolved ID as a filter to find related entities
3. **Inspect** -- Use `openalex_search_entities` with `id` to retrieve full details on specific results
4. **Analyze** -- Use `openalex_analyze_trends` to aggregate and understand distributions

Every tool description should reinforce this resolve-first pattern where relevant.

---

### `openalex_search_entities`

The primary discovery and lookup tool. Wraps list, filter, search, semantic search, and singleton retrieval into one interface. When `id` is provided, performs a direct lookup (free, unlimited); otherwise searches/filters.

```ts
input: z.object({
  entity_type: z.enum([
    'works', 'authors', 'sources', 'institutions',
    'topics', 'keywords', 'publishers', 'funders',
  ]).describe('Type of scholarly entity to search.'),

  id: z.string().optional()
    .describe('Retrieve a single entity by ID. Supports multiple formats: '
      + 'OpenAlex ID ("W2741809807" or "https://openalex.org/W2741809807"), '
      + 'DOI ("10.1038/nature12373" or "https://doi.org/10.1038/nature12373"), '
      + 'ORCID ("0000-0002-1825-0097"), '
      + 'ROR ("https://ror.org/00hx57361"), '
      + 'PMID ("12345678"), PMCID ("PMC1234567"), '
      + 'ISSN ("1234-5678"). '
      + 'When provided, other search/filter/sort params are ignored. '
      + 'Use openalex_resolve_name to find the ID if unknown.'),

  query: z.string().optional()
    .describe('Text search query. Supports boolean operators (AND, OR, NOT), '
      + 'quoted phrases ("exact match"), wildcards (machin*), '
      + 'fuzzy matching (machin~1), and proximity ("climate change"~5). '
      + 'Omit for filter-only queries.'),

  search_mode: z.enum(['keyword', 'exact', 'semantic']).default('keyword')
    .describe('Search strategy. '
      + '"keyword": stemmed full-text search (default). '
      + '"exact": no stemming, literal match only. '
      + '"semantic": AI embedding similarity (max 50 results, 1 req/sec).'),

  filters: z.record(z.string(), z.string()).optional()
    .describe('Filter criteria as field:value pairs. '
      + 'AND across fields (multiple keys). '
      + 'OR within field: pipe-separate values ("us|gb"). '
      + 'NOT: prefix value with "!" ("!us"). '
      + 'Range: "2020-2024". Comparison: ">100", "<50". '
      + 'AND within same field: "+"-separate ("us+gb"). '
      + 'Use OpenAlex IDs (not names) for entity filters -- '
      + 'resolve names via openalex_resolve_name first.'),

  sort: z.string().optional()
    .describe('Sort field. Prefix with "-" for descending. '
      + 'Common: "cited_by_count", "-publication_date", "relevance_score" (default when query present).'),

  select: z.array(z.string()).optional()
    .describe('Fields to return (reduces payload). Top-level fields only. '
      + 'STRONGLY RECOMMENDED for works -- full records are ~70KB each. '
      + 'Example: ["id", "doi", "display_name", "publication_year", "cited_by_count", "primary_topic"].'),

  per_page: z.number().int().min(1).max(100).default(25)
    .describe('Results per page (1-100). Default 25.'),

  cursor: z.string().optional()
    .describe('Pagination cursor from a previous response. Pass to get the next page.'),
})

output: z.object({
  meta: z.object({
    count: z.number().describe('Total results matching the query/filters.'),
    per_page: z.number(),
    next_cursor: z.string().nullable().describe('Cursor for next page. null if no more results.'),
  }),
  results: z.array(z.object({
    id: z.string().describe('OpenAlex ID (e.g., "W2741809807", "A1234567890").'),
    display_name: z.string().describe('Entity name or work title.'),
  }).passthrough().describe('Entity object. Additional fields depend on entity_type and select.')),
})
```

**Description:**
> Search, filter, sort, or retrieve by ID. Covers all OpenAlex entity types (works, authors, sources, institutions, topics, keywords, publishers, funders). Pass `id` to retrieve a single entity (free, unlimited API calls). Otherwise, use `query` and/or `filters` for discovery. Supports keyword search with boolean operators, exact phrase matching, and AI semantic search. Use openalex_resolve_name to resolve names to IDs before filtering. For works, use the `select` parameter to reduce payload size -- full records are ~70KB each.

**Key design decisions:**

- When `id` is provided, the handler normalizes it (strips URL prefixes, detects format) and routes to the singleton API path (`GET /{entities}/{id}`). All other search/filter/sort params are ignored. This keeps ID lookup as a free, unlimited operation.
- `filters` is a `Record<string, string>` rather than a raw filter string. The handler concatenates keys into OpenAlex filter syntax (`filter=key1:val1,key2:val2`). This is structured enough for the LLM to construct reliably while preserving the full expressiveness of the filter syntax (OR, NOT, ranges, comparisons live inside the value string).
- `search_mode` maps to `search`, `search.exact`, or `search.semantic` query params.
- Citation graph traversal is handled via filters: `{ "cited_by": "W2741809807" }` (works citing X), `{ "cites": "W2741809807" }` (works X cites), `{ "related_to": "W2741809807" }` (semantically related). No separate tool needed -- the filter descriptions cover this.
- Default `per_page: 25` balances context window usage with result coverage.

**Error messages:**
- Invalid filter field: `"Unknown filter 'foo' for entity type 'works'. See OpenAlex docs for available filters: https://developers.openalex.org/api-entities/works"`
- Semantic search limit: `"Semantic search returns a maximum of 50 results and is rate-limited to 1 req/sec. Use 'keyword' mode for larger result sets."`
- Name used as filter: `"Filter value 'Harvard University' looks like a name, not an ID. Resolve names to IDs first using openalex_resolve_name."`

---

### `openalex_analyze_trends`

Aggregation tool for trend and distribution analysis.

```ts
input: z.object({
  entity_type: z.enum([
    'works', 'authors', 'sources', 'institutions',
    'topics', 'keywords', 'publishers', 'funders',
  ]).describe('Entity type to aggregate.'),

  group_by: z.string()
    .describe('Field to group by. '
      + 'Works examples: "publication_year", "type", "oa_status", "primary_topic.field.id", '
      + '"authorships.institutions.country_code", "is_retracted". '
      + 'Authors examples: "last_known_institutions.country_code", "has_orcid". '
      + 'Sources examples: "type", "is_oa", "country_code". '
      + 'Not all fields support group_by -- check entity docs if unsure.'),

  filters: z.record(z.string(), z.string()).optional()
    .describe('Filter criteria (same syntax as openalex_search filters). '
      + 'Narrows the population before aggregation. '
      + 'Example: group works by year, filtered to a specific topic.'),

  include_unknown: z.boolean().default(false)
    .describe('Include a group for entities with no value for the grouped field. Hidden by default.'),

  cursor: z.string().optional()
    .describe('Pagination cursor from a previous response. '
      + 'Group-by returns max 200 groups per page. Pass cursor to get the next page of groups.'),
})

output: z.object({
  meta: z.object({
    count: z.number().describe('Total entities matching the filters (before grouping).'),
    groups_count: z.number().nullable().describe('Number of groups on this page (max 200).'),
    next_cursor: z.string().nullable().describe('Cursor for next page of groups. null if no more groups.'),
  }),
  groups: z.array(z.object({
    key: z.string().describe('Group key (OpenAlex ID or raw value).'),
    key_display_name: z.string().describe('Human-readable group label.'),
    count: z.number().describe('Number of entities in this group.'),
  })),
})
```

**Description:**
> Aggregate OpenAlex entities into groups and count them. Use for trend analysis (group works by publication_year), distribution analysis (group by oa_status, type, country), and comparative analysis (group by institution or topic). Combine with filters to scope the analysis. Returns up to 200 groups per page — use cursor pagination for fields with many distinct values.

**Key design decisions:**
- Separate from `openalex_search_entities` because the output shape is fundamentally different (groups with counts, not entity lists) and the use case is analytical rather than discovery.
- `include_unknown` maps to the `:include_unknown` suffix on the API's `group_by` value.

---

### `openalex_resolve_name`

Fast name-to-ID resolution. This is the critical first step for most workflows.

```ts
input: z.object({
  entity_type: z.enum([
    'works', 'authors', 'sources', 'institutions',
    'topics', 'keywords', 'publishers', 'funders',
  ]).optional()
    .describe('Entity type to search. Omit for cross-entity search (useful when entity type is unknown).'),

  query: z.string()
    .describe('Name or partial name to resolve. Also accepts IDs directly '
      + '(DOI, ORCID, ROR) for quick lookup.'),

  filters: z.record(z.string(), z.string()).optional()
    .describe('Narrow autocomplete results with filters. '
      + 'Example: restrict to a specific country or publication year range.'),
})

output: z.object({
  results: z.array(z.object({
    id: z.string().describe('OpenAlex ID.'),
    external_id: z.string().nullable().describe('Canonical external ID (DOI, ORCID, ROR, ISSN).'),
    display_name: z.string().describe('Human-readable name.'),
    entity_type: z.string().describe('Entity type (work, author, source, institution, etc.).'),
    cited_by_count: z.number().describe('Citation count (direct for works, aggregate for others).'),
    works_count: z.number().nullable().describe('Associated works. null for works themselves.'),
    hint: z.string().nullable()
      .describe('Disambiguation context: author names (works), last institution (authors), '
        + 'host org (sources), location (institutions).'),
  })),
})
```

**Description:**
> Resolve a name or partial name to an OpenAlex ID. Returns up to 10 matches with disambiguation hints. ALWAYS use this before filtering by entity -- names are ambiguous, IDs are not. Also accepts IDs directly (DOI, ORCID, ROR) for quick entity type detection. Response time ~200ms.

---

## Prompt Design

### `openalex_literature_review`

```ts
args: z.object({
  topic: z.string().describe('Research topic or question to review.'),
  scope: z.enum(['narrow', 'broad']).default('narrow')
    .describe('"narrow": focused on specific question. "broad": survey of the field.'),
})

generate: (args) => [
  { role: 'user', content: { type: 'text', text:
    `Conduct a systematic literature review on: "${args.topic}"\n\n`
    + `Scope: ${args.scope}\n\n`
    + `Follow this workflow using the OpenAlex tools:\n\n`
    + `1. **Resolve entities** -- Use openalex_resolve_name to identify key authors, institutions, `
    + `or topics related to "${args.topic}". Collect their OpenAlex IDs.\n\n`
    + `2. **Search literature** -- Use openalex_search_entities to find relevant works. Try multiple queries:\n`
    + `   - Keyword search for the topic\n`
    + `   - Semantic search for conceptually related work\n`
    + `   - Filter by resolved topic/author/institution IDs\n`
    + `   Use select to keep payloads manageable.\n\n`
    + `3. **Identify key papers** -- Sort by cited_by_count to find landmark works. `
    + `Use openalex_search_entities with id to get full details on the most important ones.\n\n`
    + `4. **Trace citations** -- For key papers, search with the cited_by filter `
    + `to find subsequent work, and the cites filter to find foundational work.\n\n`
    + `5. **Analyze the landscape** -- Use openalex_analyze_trends to understand:\n`
    + `   - Publication volume over time (group_by: publication_year)\n`
    + `   - Top contributing institutions (group_by: authorships.institutions.id)\n`
    + `   - Open access availability (group_by: oa_status)\n\n`
    + `6. **Synthesize** -- Summarize findings: key themes, seminal papers, active research fronts, `
    + `gaps in the literature, and methodological trends.`
  }}
]
```

### `openalex_research_landscape`

```ts
args: z.object({
  topic: z.string().describe('Research area to analyze.'),
})

generate: (args) => [
  { role: 'user', content: { type: 'text', text:
    `Analyze the research landscape for: "${args.topic}"\n\n`
    + `Use the OpenAlex tools to build a quantitative profile:\n\n`
    + `1. **Resolve** -- Use openalex_resolve_name to find the OpenAlex topic ID for "${args.topic}".\n\n`
    + `2. **Volume & trends** -- Use openalex_analyze_trends to group works by publication_year, `
    + `filtered to the resolved topic. Is the field growing, stable, or declining?\n\n`
    + `3. **Top contributors** -- Analyze by:\n`
    + `   - authorships.institutions.id (which institutions lead?)\n`
    + `   - authorships.institutions.country_code (geographic distribution)\n`
    + `   - primary_location.source.id (which journals publish most?)\n\n`
    + `4. **Open access** -- Group by oa_status. What fraction is freely available?\n\n`
    + `5. **Funding** -- Group by awards.funder_id to identify major funders.\n\n`
    + `6. **Impact** -- Search for the most-cited works (sort by -cited_by_count). `
    + `Get details on the top 5.\n\n`
    + `7. **Emerging fronts** -- Filter to the last 2 years, sort by -cited_by_count `
    + `to find rising papers. Compare topics to the broader field.\n\n`
    + `Present findings as a structured report with data tables and key takeaways.`
  }}
]
```

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenAlexService` | OpenAlex REST API (`api.openalex.org`) | All tools |

### `OpenAlexService`

Single service handling all API communication. Init/accessor pattern.

**Responsibilities:**
- Inject API key into all requests (`api_key` query parameter)
- Construct URLs from structured tool inputs (entity type, filters, sort, etc.)
- Convert `filters` record to OpenAlex filter string (`key1:val1,key2:val2`)
- Handle pagination (cursor pass-through)
- Parse responses, extract `meta`, `results`, `group_by`
- Map HTTP errors to descriptive `McpError`s
- Respect rate limits (semantic search: 1 req/sec)
- Reconstruct abstracts from `abstract_inverted_index` into plaintext (OpenAlex stores abstracts as inverted indices, not raw text)

**Methods:**

```ts
class OpenAlexService {
  /** Search/filter/sort entities, or retrieve a single entity by ID. */
  async search(params: SearchParams, ctx: Context): Promise<SearchResult>

  /** Group-by aggregation. */
  async analyze(params: AnalyzeParams, ctx: Context): Promise<AnalyzeResult>

  /** Autocomplete name resolution. */
  async autocomplete(params: AutocompleteParams, ctx: Context): Promise<AutocompleteResult>
}
```

**Filter construction:**

```ts
// Input: { "cited_by_count": ">100", "is_oa": "true", "publication_year": "2020-2024" }
// Output: "cited_by_count:>100,is_oa:true,publication_year:2020-2024"
function buildFilterString(filters: Record<string, string>): string {
  return Object.entries(filters)
    .map(([key, value]) => `${key}:${value}`)
    .join(',');
}
```

**ID normalization:**

```ts
// Detect ID format and construct the correct API path
// "10.1038/nature12373" → "/works/doi:10.1038/nature12373"
// "0000-0002-1825-0097" → "/authors/orcid:0000-0002-1825-0097"
// "W2741809807" → "/works/W2741809807"
// "https://doi.org/10.1038/nature12373" → "/works/doi:10.1038/nature12373"
```

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OPENALEX_API_KEY` | Yes | API key from openalex.org/settings/api. Required for all queries. |
| `OPENALEX_BASE_URL` | No | API base URL. Default: `https://api.openalex.org` |

---

## API Reference

### Base URL

```
https://api.openalex.org
```

### Authentication

API key as query parameter: `?api_key=YOUR_KEY`

### Free Tier Daily Limits

| Operation | Daily limit |
|:----------|:------------|
| Singleton lookup (`/{entity}/{id}`) | Unlimited |
| List/filter (`/{entity}?filter=...`) | ~10,000 |
| Search (`/{entity}?search=...`) | ~1,000 |

### Pagination

- `per_page`: 1-100 (default varies by endpoint)
- `cursor=*` for first page, then pass returned `next_cursor`
- Page-based (`page=N`) also supported but cursor is preferred for large sets

### Filter Syntax

```
filter=field1:value1,field2:value2          # AND across fields
filter=field:value1|value2                  # OR within field (max 100 values)
filter=field:!value                         # NOT
filter=field:>100                           # Greater than
filter=field:<50                            # Less than
filter=field:2020-2024                      # Range
filter=field:value1+value2                  # AND within same field
```

### Search Modes

| Mode | Parameter | Notes |
|:-----|:----------|:------|
| Keyword (stemmed) | `search=query` | Boolean ops, wildcards, fuzzy, proximity |
| Exact (unstemmed) | `search.exact=query` | Literal matching only |
| Semantic (embeddings) | `search.semantic=query` | Max 50 results, 1 req/sec |

### Search Syntax

```
search=climate AND change                   # Boolean AND (default)
search="exact phrase"                       # Phrase match
search=(elmo AND "sesame street") NOT cookie # Boolean expression
search=machin*                              # Wildcard (min 3 chars before *)
search=machin~1                             # Fuzzy (0-2 edit distance)
search="climate change"~5                   # Proximity (words within 5 positions)
```

### Group By

```
GET /works?group_by=publication_year&filter=topics.id:T12345
```

Returns `{ key, key_display_name, count }` groups. Max 200 per page. Append `:include_unknown` to include null-value groups.

### Select (Sparse Fieldsets)

```
GET /works?select=id,doi,display_name,cited_by_count
```

Top-level fields only. No nested field selection. Works on list and singleton endpoints.

### External ID Paths

```
/works/doi:10.1038/nature12373
/works/pmid:12345678
/authors/orcid:0000-0002-1825-0097
/institutions/ror:https://ror.org/00hx57361
/sources/issn:1234-5678
```

### Autocomplete

```
GET /autocomplete/authors?q=yann+lecun
```

~200ms response. Returns 10 results with `id`, `display_name`, `hint`, `external_id`, `cited_by_count`, `works_count`.

### Key Entity Fields

#### Works (selected)

| Field | Description |
|:------|:------------|
| `id` | OpenAlex ID |
| `doi` | DOI |
| `display_name` | Title |
| `publication_date` / `publication_year` | Publication timing |
| `type` | Work type (article, book, dataset, etc.) |
| `cited_by_count` | Total citations |
| `is_oa` / `oa_status` | Open access status (gold, green, hybrid, bronze, closed) |
| `fwci` | Field-Weighted Citation Impact |
| `primary_location` | Primary hosting source (journal, repo) |
| `authorships` | Authors with affiliations and institutions |
| `primary_topic` | Most relevant topic (with domain/field/subfield hierarchy) |
| `referenced_works` | Works cited in references |
| `abstract_inverted_index` | Abstract as inverted index (handler reconstructs to plaintext automatically) |
| `sustainable_development_goals` | SDG relevance scores |

#### Works -- Notable Filters

| Filter | Description | Use case |
|:-------|:------------|:---------|
| `cited_by` | Works that cite a given work ID | Forward citation traversal |
| `cites` | Works that a given work cites | Backward citation traversal |
| `related_to` | Semantically related works | Discovery of similar research |
| `fwci` | Field-Weighted Citation Impact | Impact filtering (>1.0 = above average) |
| `citation_normalized_percentile.is_in_top_1_percent` | Top 1% by citations | High-impact paper identification |
| `is_retracted` | Retraction status | Quality control |
| `has_fulltext` | Fulltext indexed | Content availability |

#### Authors (selected)

| Field | Description |
|:------|:------------|
| `id` | OpenAlex ID |
| `orcid` | ORCID identifier |
| `display_name` | Author name |
| `works_count` | Total works |
| `cited_by_count` | Total citations |
| `summary_stats.h_index` | h-index |
| `summary_stats.i10_index` | i10-index |
| `last_known_institutions` | Current affiliations |
| `topics` | Research topics |

#### Topics

4-level hierarchy: **domain** (4) > **field** (~20) > **subfield** (~250) > **topic** (~65K)

Filterable at any level: `primary_topic.domain.id`, `primary_topic.field.id`, `primary_topic.subfield.id`, `primary_topic.id`.

---

## Implementation Order

1. **Config** -- `OPENALEX_API_KEY`, `OPENALEX_BASE_URL` in server config Zod schema
2. **OpenAlexService** -- API client with filter builder, ID normalizer, request/response handling
3. **`openalex_resolve_name`** -- Simplest tool, validates service works, enables all other workflows
4. **`openalex_search_entities`** -- Primary discovery tool with all search modes, filters, and ID lookup
5. **`openalex_analyze_trends`** -- Group-by aggregation
6. **Prompts** -- `openalex_literature_review`, `openalex_research_landscape`
7. **`devcheck`** + smoke test

Each step is independently testable.

---

## Workflow Examples

### "Find the most-cited papers on CRISPR gene editing from 2020-2024"

```
1. openalex_search_entities({
     entity_type: "works",
     query: "CRISPR gene editing",
     filters: { "publication_year": "2020-2024" },
     sort: "-cited_by_count",
     select: ["id", "doi", "display_name", "publication_year", "cited_by_count", "authorships"],
     per_page: 10,
   })
```

### "What institution publishes the most AI research?"

```
1. openalex_resolve_name({ query: "artificial intelligence", entity_type: "topics" })
   → T12345

2. openalex_analyze_trends({
     entity_type: "works",
     group_by: "authorships.institutions.id",
     filters: { "primary_topic.id": "T12345" },
   })
```

### "Show me Yann LeCun's recent high-impact papers"

```
1. openalex_resolve_name({ query: "Yann LeCun", entity_type: "authors" })
   → A1234567890

2. openalex_search_entities({
     entity_type: "works",
     filters: { "authorships.author.id": "A1234567890", "publication_year": "2022-2026" },
     sort: "-cited_by_count",
     select: ["id", "doi", "display_name", "publication_year", "cited_by_count", "primary_topic"],
     per_page: 10,
   })
```

### "What papers cite this landmark paper, and what topics do they cover?"

```
1. openalex_search_entities({
     entity_type: "works",
     filters: { "cited_by": "W2741809807" },
     select: ["id", "display_name", "publication_year", "primary_topic"],
     per_page: 50,
   })

2. openalex_analyze_trends({
     entity_type: "works",
     group_by: "primary_topic.field.id",
     filters: { "cited_by": "W2741809807" },
   })
```

### "How has open access publishing changed over time in Nature journals?"

```
1. openalex_resolve_name({ query: "Nature", entity_type: "sources" })
   → S1234567

2. openalex_analyze_trends({
     entity_type: "works",
     group_by: "publication_year",
     filters: { "primary_location.source.id": "S1234567", "is_oa": "true" },
   })

3. openalex_analyze_trends({
     entity_type: "works",
     group_by: "oa_status",
     filters: { "primary_location.source.id": "S1234567", "publication_year": "2015-2025" },
   })
```
