<div align="center">
  <h1>@cyanheads/openalex-mcp-server</h1>
  <p><b>Access the OpenAlex academic research catalog - 270M+ publications through MCP. STDIO & Streamable HTTP.</b>
  <div>5 Tools &bull; 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openalex-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openalex-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openalex-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openalex-mcp-server/releases/latest/download/openalex-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openalex-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmFsZXgtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openalex-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/openalex-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openalex.caseyjhand.com/mcp](https://openalex.caseyjhand.com/mcp)

</div>

---

## Tools

Five tools for querying the [OpenAlex](https://openalex.org) academic research catalog:

| Tool Name | Description |
|:----------|:------------|
| `openalex_search_entities` | Search, filter, sort, or retrieve by ID across all 8 entity types. |
| `openalex_analyze_trends` | Group-by aggregation for trend and distribution analysis. |
| `openalex_resolve_name` | Resolve a name or partial name to an OpenAlex ID via autocomplete. |
| `openalex_get_citation_graph` | Walk the citation graph one hop from a seed work: cites, cited_by, or related_to. |
| `openalex_describe_fields` | List valid filter, group_by, and select field names for an entity type — call before building a query to avoid invalid-field errors. |

### `openalex_search_entities`

Primary discovery and lookup tool. Covers all OpenAlex entity types (works, authors, sources, institutions, topics, keywords, publishers, funders).

- Retrieve a single entity by ID (OpenAlex ID, DOI, ORCID, ROR, PMID, PMCID, ISSN)
- Keyword search with boolean operators, quoted phrases, wildcards, and fuzzy matching
- Exact and AI semantic search modes
- Rich filter syntax: AND across fields, OR within fields (`us|gb`), NOT (`!us`), ranges (`2020-2024`), comparisons (`>100`)
- Sensible default field selection per entity type, applied to both searches and ID lookups — prevents oversized responses; pass `select` to choose fields, or `["*"]` for the full record
- Invalid `select` field names produce an error listing the valid fields for that entity type
- Formatted MCP output is a generic markdown renderer — every returned field is surfaced without per-entity-type hard-coding
- Cursor pagination and up to 100 results per page; `sort` takes a single key or a comma-separated list, with the `-` descending prefix applied per key
- `display_name` is nullable — OpenAlex holds no title for paratext and other untitled records, which pass through instead of failing the whole page

---

### `openalex_analyze_trends`

Aggregate entities into groups and count them for trend, distribution, and comparative analysis.

- Group by any supported field (publication year, OA status, institution, country, topic, etc.)
- Combine with filters to scope the population before aggregation
- Up to 200 groups per page with cursor pagination
- Supports `include_unknown` to show entities with no value for the grouped field

---

### `openalex_resolve_name`

Name-to-ID resolution via autocomplete. **Always use this before filtering by entity** — names are ambiguous, IDs are not.

- Returns up to 10 matches with disambiguation hints
- Accepts partial names and DOIs for direct lookup
- Optional entity type filter and field-level filters
- ~200ms response time

---

### `openalex_get_citation_graph`

One-hop citation graph traversal from a seed work. Wraps the OpenAlex `cites`/`cited_by`/`related_to` filters behind an explicit `direction` argument so callers do not have to know the filter names.

- `cites`: works that cite the seed (incoming citations)
- `cited_by`: works the seed cites (its reference list)
- `related_to`: OpenAlex algorithmic "related works" (~8-30 typical, may be empty for less-cited seeds)
- Accepts OpenAlex IDs, DOIs, PMIDs, PMCIDs as `seed_id`; validates the seed via a singleton `/works/{id}` lookup before walking, so non-existent seeds surface as `NotFound`
- Stacks with `filters`/`sort`/`select` to narrow the graph (e.g., `publication_year=">2020"`, `is_oa="true"`)

---

### `openalex_describe_fields`

Discover valid field names before constructing a query — avoids invalid-field 400 errors. Backed by a catalog generated from OpenAlex's own field validation.

- List valid fields for any entity type and context (`filter`, `group_by`, or `select`)
- `group_by` returns the subset of the `filter` set OpenAlex can aggregate — raw date fields, `*.search` operators, and `from_*`/`to_*` range modifiers are excluded
- Pass `query` (a partial or guessed name) to rank results by name similarity — surfaces the right field when you only know roughly what you want
- Complements the ranked "did you mean" suggestions now appended to invalid-field errors on the search, trends, and citation-graph tools

## Prompts

| Prompt | Description |
|:-------|:------------|
| `openalex_literature_review` | Guides a systematic literature search: formulate query, search, filter, analyze citation network, synthesize findings. |
| `openalex_research_landscape` | Analyzes the research landscape for a topic: volume trends, top authors/institutions, open access rates, funding sources. |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends via the framework (not currently used by this server)
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or in Docker from the same codebase

OpenAlex-specific:

- Typed API client with automatic ID normalization (DOI, ORCID, ROR, PMID, PMCID, ISSN, OpenAlex URLs)
- Abstract reconstruction from inverted indices — plaintext instead of OpenAlex's position-keyed encoding
- HTTP status codes mapped to specific MCP error classes (400 → InvalidParams, 422 → ValidationError, 429 → RateLimited, etc.) with upstream messages surfaced
- Every API-calling tool reports what the call spent against the OpenAlex daily budget and what is left of it, so a paginated sweep can be priced before it runs instead of ending in a 429
- Timeout-aware request retries and cancellation support via `AbortSignal`

## Getting Started

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

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openalex-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openalex-mcp-server"],
      "env": {
        "OPENALEX_API_KEY": "your-openalex-api-key"
      }
    }
  }
}
```

`OPENALEX_API_KEY` is optional — set it to a free [OpenAlex account key](https://openalex.org/settings/api) for keyed rate limits and budget under OpenAlex's usage-based pricing, or omit it for anonymous access. Set `OPENALEX_MAILTO` to an email if you want to identify yourself to OpenAlex (the [polite pool](https://developers.openalex.org/guides/authentication)).

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (for development)

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

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `OPENALEX_API_KEY` | **Optional.** OpenAlex account API key, sent upstream as `api_key=` (free from [openalex.org/settings/api](https://openalex.org/settings/api)). Without it, anonymous rate limits apply. | — |
| `OPENALEX_MAILTO` | **Optional.** Email sent upstream as `mailto=` to identify yourself to OpenAlex (the [polite pool](https://developers.openalex.org/guides/authentication)). A courtesy identifier, separate from the API key. | — |
| `OPENALEX_BASE_URL` | OpenAlex API base URL. | `https://api.openalex.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_ALLOWED_ORIGINS` | Comma-separated allow-list of browser `Origin` headers for HTTP transport. Unset = loopback-only; set to `*` to disable. | _loopback only_ |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `debug` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

## Running the Server

### Local Development

- **Build and run the production version:**
  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker build -t openalex-mcp-server .
docker run -e OPENALEX_API_KEY=your-key -p 3010:3010 openalex-mcp-server
```

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`). |
| `src/services/openalex/` | OpenAlex API client service and domain types. |
| `src/config/` | Environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Always resolve names to IDs via `openalex_resolve_name` before using them in filters

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
