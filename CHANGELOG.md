# Changelog

## [Unreleased]

### Added

- `add-app-tool` skill for scaffolding MCP App tool/resource pairs with interactive UI guidance

### Changed

- Synced the project `skills/` directory with the latest framework and maintenance-skill guidance
- Refreshed scaffolding, testing, workers, field-test, docs-polish, and migration skills to match current `@cyanheads/mcp-ts-core` patterns
- Expanded skill guidance around content-complete `format()` output, MCP App UI packaging, and updated verification workflows

## [0.3.1] — 2026-03-30

### Changed

- Bumped `@cyanheads/mcp-ts-core` ^0.2.8 → ^0.2.10
- Bumped `@biomejs/biome` ^2.4.9 → ^2.4.10
- Added author email and funding links to package.json
- Added `remotes` array with public hosted server URL to server.json
- Updated `add-tool` skill (v1.1): expanded `format()` guidance, added Tool Response Design section (batch input, partial success, empty results, error classification, context budget)
- Updated `add-resource` skill (v1.1): added tool coverage guidance for resource-only data
- Updated `design-mcp-server` skill (v2.1): live API probing, tool-first design philosophy, batch input design, error design, convenience shortcuts, resilience planning
- Minor formatting fixes in `analyze-trends.tool.ts` and `search-entities.tool.ts`

## [0.3.0] — 2026-03-28

### Changed

- Bumped `@cyanheads/mcp-ts-core` ^0.2.3 → ^0.2.8

## [0.2.9] — 2026-03-28

### Added

- Rich structured markdown format output for `openalex_search_entities` — renders identifiers, metrics, open access status, topics, authors, abstracts, and institution affiliations in organized sections
- Rich structured format output for `openalex_resolve_name` — renders citations, works count, external IDs, and disambiguation hints
- `report-issue-framework` and `report-issue-local` skills for filing issues against the framework and server repos
- `LOGS_DIR` env var documented in README configuration table

### Changed

- `openalex_analyze_trends` format now shows key alongside display_name when they differ
- `polish-docs-meta` skill updated with GitHub repo metadata sync steps and description propagation guidance
- Bumped `@cyanheads/mcp-ts-core` ^0.1.28 → ^0.2.3
- Bumped `@biomejs/biome` ^2.4.8 → ^2.4.9, `vitest` ^4.1.1 → ^4.1.2
- Updated CLAUDE.md example code to reflect new format pattern with content-complete comments

## [0.2.8] — 2026-03-24

### Added

- Default `select` fields per entity type — search queries now return a curated subset of fields automatically, preventing 20-70KB-per-record responses from overwhelming context windows
- Source journal name (`primary_location.source.display_name`) included in `openalex_search_entities` formatted text output

### Changed

- `select` parameter description updated — searches apply sensible defaults; pass `select` to override. Single-entity lookups by ID still return full records unless `select` is specified.

## [0.2.7] — 2026-03-24

### Changed

- Unified package description across README, package.json, server.json, and Dockerfile to a shorter, consistent form

## [0.2.6] — 2026-03-24

### Changed

- Added `idempotentHint: true` annotation to all three tools — signals to clients that repeated calls with the same input produce the same result
- Added publishing section to CLAUDE.md with npm and GHCR release commands

## [0.2.5] — 2026-03-24

### Changed

- Clarified README storage backend description — notes framework capability without implying server usage
- Removed unused `STORAGE_PROVIDER_TYPE` env var from README configuration table
- Reformatted retryable status code condition in API client for readability

## [0.2.4] — 2026-03-24

### Improved

- API client retries transient failures (429, 500, 502, 503, 504) with exponential backoff — up to 3 attempts before surfacing the error

## [0.2.3] — 2026-03-24

### Improved

- `openalex_analyze_trends` format output now sorts groups by count descending and caps display at 50 with a truncation note
- `openalex_search_entities` exact search mode description clarified — notes quoted phrases for multi-word exact match
- `openalex_resolve_name` description narrowed to DOI-only direct lookup (removed incorrect ORCID/ROR claims)

### Fixed

- Cursor pagination only sent when explicitly provided — boolean `group_by` fields (`is_retracted`, `has_orcid`, etc.) reject cursor entirely
- Cross-entity autocomplete now filters results to known entity types — prevents unusable types (`country`, `license`, etc.) from reaching callers

## [0.2.2] — 2026-03-24

### Improved

- Literature review prompt now adapts search strategy based on scope (narrow vs broad)
- Research landscape prompt instructs agents to resolve funder IDs to human-readable names
- `openalex_analyze_trends` cursor description now notes that paginated groups are sorted by key, not by count
- `openalex_search_entities` format output includes publication year, citation count, and DOI when available

### Fixed

- 404 errors now throw `notFound()` instead of `serviceUnavailable()` — correct HTTP semantics
- Group-by queries always send cursor (defaults to `*` for first page) — fixes missing first-page results
- Updated test assertion to match revised error message format

### Changed

- Bumped dev dependencies: `@biomejs/biome` 2.4.8, `tsx` 4.21, `typescript` 6.0.2, `vitest` 4.1.1
- Fixed `bun test` → `bun run test` in CLAUDE.md commands table
- Updated `docs/tree.md` to reflect test file structure

## [0.2.1] — 2026-03-24

### Fixed

- Explicit 404 handling in API client — throws `serviceUnavailable` with path context instead of a generic error
- Sanitize non-JSON error response bodies — strip HTML tags and truncate to 200 chars
- Normalize `next_cursor` to `null` when missing from search results (prevents `undefined` leaking to callers)

## [0.2.0] — 2026-03-24

### Added

- Full test suite: unit tests for all 3 tools (`search-entities`, `analyze-trends`, `resolve-name`) and the OpenAlex service (ID normalization, filter building, abstract reconstruction, search modes, error handling)
- `OPENALEX_BASE_URL` env var declaration in `server.json` for both stdio and HTTP transports
- `.min(1)` validation on `openalex_resolve_name` query parameter

### Fixed

- Changed API auth parameter from `api_key` to `mailto` (OpenAlex polite pool convention)
- Sort direction translation: `-field` prefix now correctly maps to `field:desc` (OpenAlex API syntax)
- Semantic search no longer sends cursor pagination params (unsupported by the API)
- `openalex_analyze_trends` now surfaces `next_cursor` from the API response

### Changed

- Improved API error messages: parses JSON error bodies to surface the `message` field instead of raw status text
- Updated `openalex_search_entities` description and `select` guidance to call out institutions (~20KB) alongside works (~70KB) as large entities

## [0.1.1] — 2026-03-24

### Added

- README with full tool/prompt documentation, configuration reference, and getting started guide
- Apache 2.0 LICENSE file
- `bunfig.toml` for Bun runtime configuration
- `docs/tree.md` directory structure documentation

### Changed

- Filled in package.json metadata: description, mcpName, keywords, author, homepage, bugs, repository URL, bun engine requirement, packageManager field
- Updated server.json with name (`io.github.cyanheads/openalex-mcp-server`), description, repository URL, and `OPENALEX_API_KEY` env var declarations
- Updated CLAUDE.md examples to use real OpenAlex tool/prompt patterns instead of generic placeholders
- Updated Dockerfile OCI labels with description and source URL
- Updated `.env.example` with OpenAlex-specific environment variables
- Expanded devcheck.config.json ignore list (`tsx`, `depcheck`)
- Added `depcheck` to devDependencies

### Removed

- Placeholder echo test files (`echo.tool.test.ts`, `echo.prompt.test.ts`, `echo.resource.test.ts`)

## [0.1.0] — 2026-03-24

Initial release. MCP server for querying the [OpenAlex](https://openalex.org) academic research catalog (270M+ works, 90M+ authors, 100K+ sources).

### Added

- **`openalex_search_entities` tool** — Search, filter, sort, or retrieve by ID across all 8 entity types (works, authors, sources, institutions, topics, keywords, publishers, funders). Supports keyword, exact, and semantic search modes with boolean operators, wildcards, and cursor pagination. Field selection via `select` for payload control.
- **`openalex_analyze_trends` tool** — Group-by aggregation for trend and distribution analysis. Supports grouping by publication year, open access status, institution, country, topic, and other fields with optional filters.
- **`openalex_resolve_name` tool** — Name-to-OpenAlex-ID resolution via autocomplete. Returns up to 10 matches with disambiguation hints. Accepts partial names, DOIs, ORCIDs, and ROR IDs.
- **`openalex_literature_review` prompt** — Guided systematic literature search workflow: entity resolution, multi-strategy search, citation tracing, landscape analysis, and synthesis.
- **`openalex_research_landscape` prompt** — Quantitative research landscape analysis: volume trends, top contributors, open access rates, funding sources, and emerging fronts.
- **OpenAlex API service** — Typed client with automatic ID normalization (DOI, ORCID, ROR, PMID, PMCID, ISSN, OpenAlex URLs), abstract reconstruction from inverted indices, filter string building, and cancellation support via `AbortSignal`.
- **Server configuration** — Zod-validated config with `OPENALEX_API_KEY` (required) and `OPENALEX_BASE_URL` (optional, defaults to `https://api.openalex.org`).
- **Dual transport** — Stdio and streamable HTTP transports via `@cyanheads/mcp-ts-core`.
- **Docker support** — Multi-stage Dockerfile for containerized deployment.
- **Agent protocol** — `CLAUDE.md` with domain context, tool surface, patterns, and skills for AI agent integration.
