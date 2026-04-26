# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.6.2](changelog/0.6.x/0.6.2.md) — 2026-04-25

Framework bump to ^0.7.4 — fail-closed Origin guard for HTTP, framework-antipattern devcheck step, literal-variant linter exemption, issue templates

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-04-24

Framework bump to ^0.7.0 — flattened ZodError messages, locale-aware format-parity linter, devcheck crash fix on single-file changelog projects

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-04-24

Framework bump to ^0.6.17, directory-based changelog, cleaner field rendering in search_entities (no comma-years, uppercased acronyms), security-pass skill surfaced

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-04-23

Adds HTTP landing page and SEP-1649 Server Card via @cyanheads/mcp-ts-core 0.6.x, plus sourceUrl overrides; syncs skills and adds api-linter + release-and-publish

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-20

Framework bump to ^0.5.3; rewrites tool format() bodies to satisfy the new format-parity linter so content[] now carries every output-schema field

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-04-15

Generic field rendering in openalex_search_entities; abstracts returned as plaintext; OpenAlex 4xx responses now map to specific MCP error classes

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-04-14

Framework bump to ^0.3.5; retries empty/HTML/malformed JSON responses; analyze_trends paginates cleanly; adds add-app-tool skill

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-03-30

Framework bump to ^0.2.10; adds funding links and public hosted server URL; refreshes add-tool, add-resource, and design-mcp-server skills

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-03-28

Framework bump @cyanheads/mcp-ts-core ^0.2.3 → ^0.2.8

## [0.2.9](changelog/0.2.x/0.2.9.md) — 2026-03-28

Rich structured markdown output for openalex_search_entities and openalex_resolve_name; adds report-issue-framework and report-issue-local skills; framework bump to ^0.2.3

## [0.2.8](changelog/0.2.x/0.2.8.md) — 2026-03-24

Default select fields per entity type — searches now return curated subsets, preventing 20-70KB-per-record payloads from overwhelming context windows

## [0.2.7](changelog/0.2.x/0.2.7.md) — 2026-03-24

Unifies package description across README, package.json, server.json, and Dockerfile to a shorter consistent form

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-03-24

Adds idempotentHint: true to all three tools; adds publishing section to CLAUDE.md with npm and GHCR release commands

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-03-24

Clarifies README storage backend description; removes unused STORAGE_PROVIDER_TYPE env var; reformats retryable status code condition for readability

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-03-24

API client retries transient failures (429, 500, 502, 503, 504) with exponential backoff — up to 3 attempts before surfacing the error

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-03-24

openalex_analyze_trends sorts groups by count descending and caps display at 50; cursor pagination only sent when explicitly provided; cross-entity autocomplete filters to known entity types

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-03-24

Literature review prompt adapts strategy to scope; 404s throw notFound() instead of serviceUnavailable(); group-by queries always send cursor (defaults to * for first page)

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-03-24

Explicit 404 handling in API client; non-JSON error response bodies sanitized (HTML stripped, truncated to 200 chars); next_cursor normalized to null when missing

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-03-24

Full unit test suite for all three tools and the OpenAlex service; API auth changed from api_key to mailto (polite pool convention); sort direction syntax fixed

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-03-24

README, LICENSE, docs/tree.md; package.json metadata filled in; server.json OpenAlex env vars declared; Dockerfile OCI labels; echo placeholder tests removed

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-03-24

Initial release. MCP server for the OpenAlex academic research catalog (270M+ works, 90M+ authors, 100K+ sources) with 3 tools, 2 prompts, and dual stdio/HTTP transports
