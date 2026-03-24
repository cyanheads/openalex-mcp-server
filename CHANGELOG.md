# Changelog

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
