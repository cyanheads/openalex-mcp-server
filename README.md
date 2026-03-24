<div align="center">
  <h1>@cyanheads/openalex-mcp-server</h1>
  <p><b>MCP server for the OpenAlex academic research catalog. Search 270M+ works, 90M+ authors, 100K+ sources. Analyze trends, resolve entities, review literature. STDIO & Streamable HTTP.</b></p>
  <p><b>3 Tools &middot; 2 Prompts</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

## Tools

Three tools for querying the [OpenAlex](https://openalex.org) academic research catalog:

| Tool Name | Description |
|:----------|:------------|
| `openalex_search_entities` | Search, filter, sort, or retrieve by ID across all 8 entity types. |
| `openalex_analyze_trends` | Group-by aggregation for trend and distribution analysis. |
| `openalex_resolve_name` | Resolve a name or partial name to an OpenAlex ID via autocomplete. |

### `openalex_search_entities`

Primary discovery and lookup tool. Covers all OpenAlex entity types (works, authors, sources, institutions, topics, keywords, publishers, funders).

- Retrieve a single entity by ID (OpenAlex ID, DOI, ORCID, ROR, PMID, PMCID, ISSN)
- Keyword search with boolean operators, quoted phrases, wildcards, and fuzzy matching
- Exact and AI semantic search modes
- Rich filter syntax: AND across fields, OR within fields (`us|gb`), NOT (`!us`), ranges (`2020-2024`), comparisons (`>100`)
- Field selection via `select` to control payload size (full work records are ~70KB each)
- Cursor pagination, sorting, up to 100 results per page

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
- Abstract reconstruction from inverted indices
- Cancellation support via `AbortSignal`

## Getting Started

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openalex": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openalex-mcp-server"],
      "env": {
        "OPENALEX_API_KEY": "your-email@example.com"
      }
    }
  }
}
```

No API key needed — just provide your email to access the [polite pool](https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication#the-polite-pool) (10x faster rate limits).

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
| `OPENALEX_API_KEY` | **Required.** Email address for the OpenAlex [polite pool](https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication#the-polite-pool) (faster rate limits). | — |
| `OPENALEX_BASE_URL` | OpenAlex API base URL. | `https://api.openalex.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `debug` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

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
