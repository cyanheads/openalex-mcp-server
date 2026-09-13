<div align="center">
  <h1>@cyanheads/openalex-mcp-server</h1>
  <p><b>Access the OpenAlex academic research catalog - 270M+ publications through MCP. STDIO & Streamable HTTP.</b>
  <div>5 Tools &bull; 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.13-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openalex-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openalex-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openalex-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openalex-mcp-server/releases/latest/download/openalex-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openalex-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmFsZXgtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openalex-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/openalex-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openalex.caseyjhand.com/mcp](https://openalex.caseyjhand.com/mcp)

</div>

---

## Overview

An MCP server over the [OpenAlex](https://openalex.org) scholarly catalog — 270M+ works, 90M+ authors, 100K+ sources, plus institutions, topics, keywords, publishers, and funders. Search, filter, and aggregate across all eight entity types, resolve ambiguous names to canonical IDs, and walk the citation graph one hop at a time. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openalex_search_entities` | Search, filter, sort, or retrieve by ID across all 8 entity types |
| `openalex_analyze_trends` | Group-by aggregation for trend and distribution analysis |
| `openalex_resolve_name` | Resolve a name or an identifier (DOI, ORCID, ROR, PMID, ISSN, OpenAlex ID) to an OpenAlex ID |
| `openalex_get_citation_graph` | Walk the citation graph one hop from a seed work: `cites`, `cited_by`, or `related_to` |
| `openalex_describe_fields` | List valid filter, group_by, and select field names for an entity type |

### Prompts

| Prompt | Description |
|:-------|:------------|
| `openalex_literature_review` | Guides a systematic literature search: formulate query, search, filter, analyze citation network, synthesize findings |
| `openalex_research_landscape` | Analyzes the research landscape for a topic: volume trends, top authors/institutions, open access rates, funding sources |

## Capability reference

### `openalex_search_entities` <sub>tool</sub>

- Retrieve a single entity by ID — OpenAlex ID, DOI, ORCID, ROR, PMID, ISSN, or PMCID (bare or URL form). `id` takes precedence: search parameters passed alongside it are dropped, and the response names which ones. A PMCID resolves nothing (OpenAlex indexes none) — use the work's PMID or DOI instead
- Keyword search (boolean operators, quoted phrases, wildcards, fuzzy match) plus `exact` and `semantic` search modes — semantic caps at 50 results per page and ~1 req/sec
- Rich filter syntax: AND across fields, OR within a field (`|`), NOT (`!`), ranges, comparisons; a comma inside a filter value is rejected (use `|`, or a `.search` filter for free text)
- `select` returns a curated per-entity-type default unless overridden, or `["*"]` for the full record; invalid field names error with the valid set
- Cursor pagination, up to 100 results per page (default 25); `sample` (up to 100, single page only, no `cursor`) plus a deterministic `seed` for reproducible random sampling
- `display_name` is nullable for untitled records; every call reports OpenAlex daily-budget cost and remaining balance

---

### `openalex_analyze_trends` <sub>tool</sub>

- Group any supported field for trend, distribution, or comparative analysis; combine with `filters` to scope the population before aggregation
- Up to 200 groups per page (default). `order: "count"` (default) returns the top-N by count with no further pages; `order: "key"` enumerates all distinct values key-ascending with cursor pagination
- `include_unknown` (default `false`) adds a group for entities with no value for the grouped field
- Not every field is groupable — raw date fields, `.search` operators, and `from_*`/`to_*` range modifiers are rejected; check with `openalex_describe_fields(entity_type, "group_by")`
- Reports OpenAlex daily-budget cost and remaining balance — aggregation is priced far below paging the same entities

---

### `openalex_resolve_name` <sub>tool</sub>

- A name or partial name runs an autocomplete search: up to 10 matches with disambiguation hints (last institution, host organization, place, etc.)
- An identifier — OpenAlex ID, DOI, ORCID, ROR, PMID, or ISSN, bare or in URL form — resolves directly to the one record it addresses; no `entity_type` needed, since the identifier determines its own. A PMCID is recognized but resolves nothing — OpenAlex indexes none
- `filters` narrows autocomplete only; on an identifier lookup they're ignored and named in a notice
- Reports OpenAlex daily-budget cost and remaining balance

---

### `openalex_get_citation_graph` <sub>tool</sub>

- `direction` sets the edge: `cites` (works citing the seed), `cited_by` (the seed's own reference list), `related_to` (OpenAlex's algorithmic related works, ~8-30 typical, may be empty)
- `seed_id` accepts an OpenAlex ID, DOI, or PMID (PMCID recognized but resolves nothing); validated against a live lookup first, so a non-existent seed fails as `NotFound` rather than returning an empty graph
- Stacks with `filters`/`sort`/`select` to narrow the graph; `filters` cannot set `cites`/`cited_by`/`related_to` directly — those are reserved for `direction`
- Cursor pagination, up to 100 results per page (default 25)
- Reports OpenAlex daily-budget cost, covering both the seed-validation lookup and the graph page, plus remaining balance

---

### `openalex_describe_fields` <sub>tool</sub>

- Lists every valid field name for an entity type + context (`filter`, `group_by`, `select`) — the complete pool, never truncated
- `group_by` is the filter set minus raw date fields, `.search`/`.search.exact` operators, and `from_*`/`to_*` range modifiers, which OpenAlex rejects as aggregation keys
- Optional `query` reorders results by name similarity without dropping any field — a nested value's parent object stays reachable further down the list
- Backed by a generated field catalog — no live API calls

---

### `openalex_literature_review` <sub>prompt</sub>

- Arguments: `topic` required; `scope` (`narrow` / `broad`) optional, defaults to `narrow`
- Returns one user message walking a 6-step workflow: resolve entities, search literature, identify key papers, trace citations, analyze the landscape, synthesize findings
- `scope` changes the search step: `narrow` favors exact search with tight topic filters; `broad` adds semantic search across multiple related topic IDs

---

### `openalex_research_landscape` <sub>prompt</sub>

- Arguments: `topic` required
- Returns one user message walking a 7-step quantitative workflow: resolve the topic ID, volume trends, top contributors (institutions/countries/journals), open access rate, funding sources, most-cited works, emerging fronts
- The funding step groups by `awards.funder_id` (resolve names via `openalex_resolve_name`) or `awards.funder_display_name` for readable labels in a single hop

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenAlex-specific:

- Typed API client with automatic ID normalization (DOI, ORCID, ROR, PMID, PMCID, ISSN, OpenAlex and PubMed/PubMed Central URLs); a PMCID normalizes but resolves nothing since OpenAlex indexes none
- Keyless by default — an optional API key raises rate and daily-budget limits, and an optional `mailto` identifies the caller to OpenAlex's polite pool
- HTTP status codes mapped to specific MCP error classes (400 → InvalidParams, 422 → ValidationError, 429 → RateLimited) with upstream messages surfaced
- Timeout-aware request retries and cancellation support via `AbortSignal`

Agent-friendly output:

- Provenance — every API-calling tool reports OpenAlex daily-budget cost, remaining balance, and reset time (`budget.costUsd`, `remainingUsd`, `resetsInSeconds`)
- Effective-query echo — search, trends, and citation-graph responses echo the criteria that actually ran, so an empty result is diagnosable without re-reading the request
- Discriminated output contracts — typed error reasons (`entity_not_found`, `upstream_budget_exhausted`, `semantic_per_page_cap`, `reserved_filter_key`, and more) each carrying an explicit recovery hint
- Response shaping — abstracts are reconstructed from OpenAlex's inverted-index encoding into plaintext, and `display_name` stays `null` for untitled or paratext records instead of being backfilled

## Getting started

### Public Hosted Instance

A public instance is available at `https://openalex.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "openalex-mcp-server": {
      "type": "streamable-http",
      "url": "https://openalex.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "openalex-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openalex-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OPENALEX_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openalex-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openalex-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OPENALEX_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "openalex-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "OPENALEX_API_KEY=your-api-key",
        "ghcr.io/cyanheads/openalex-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 OPENALEX_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

`OPENALEX_API_KEY` is optional — set it to a free [OpenAlex account key](https://openalex.org/settings/api) for keyed rate limits and budget under OpenAlex's usage-based pricing, or omit it for anonymous access. Set `OPENALEX_MAILTO` to an email if you want to identify yourself to OpenAlex (the [polite pool](https://developers.openalex.org/guides/authentication)).

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: an [OpenAlex account API key](https://openalex.org/settings/api) for keyed rate limits and budget — omit for anonymous access.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openalex-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openalex-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set required vars
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto` (resolves to `stateful`). This server ships `stateless` (see Dockerfile and `.env.example`). | `auto` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_ALLOWED_ORIGINS` | Comma-separated allow-list of browser `Origin` headers for HTTP transport. Unset = loopback-only; set to `*` to disable. | _loopback only_ |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `debug` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OPENALEX_API_KEY` | OpenAlex account API key, sent upstream as `api_key=` (free from [openalex.org/settings/api](https://openalex.org/settings/api)). Without it, anonymous rate limits apply. | — |
| `OPENALEX_MAILTO` | Email sent upstream as `mailto=` to identify yourself to OpenAlex (the "polite pool"); a courtesy identifier, separate from the API key. | — |
| `OPENALEX_BASE_URL` | OpenAlex API base URL. | `https://api.openalex.org` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lints, formats, type-checks
  bun run test       # Runs the test suite
  ```

### Docker

```sh
docker build -t openalex-mcp-server .
docker run --rm -e OPENALEX_API_KEY=your-key -p 3010:3010 openalex-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/openalex-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and prompts. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`). |
| `src/services/openalex/` | OpenAlex API client, field catalog, and domain types. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Wrap OpenAlex responses: validate the raw payload → normalize to a domain type → return the output schema; never fabricate missing fields
- Always resolve names to IDs via `openalex_resolve_name` before filtering by entity

## Contributing

Issues are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
