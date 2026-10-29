<div align="center">
  <h1>@cyanheads/openalex-mcp-server</h1>
  <p><b>Access the OpenAlex academic research catalog — 270M+ publications — via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools &bull; 2 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.10.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openalex-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openalex-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openalex-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Scholarly catalog data from [OpenAlex](https://openalex.org) — 270M+ works, 90M+ authors, 100K+ sources, plus institutions, topics, keywords, publishers, funders, and awards. Search, filter, and aggregate across all nine entity types, resolve ambiguous names to canonical IDs, and walk the citation graph one hop at a time.

### Tools

| Tool | Description |
|:---|:---|
| `openalex_search_entities` | Search, filter, sort, or retrieve by ID across all 9 entity types |
| `openalex_analyze_trends` | Group-by aggregation for trend and distribution analysis |
| `openalex_resolve_name` | Resolve a name or an identifier (DOI, ORCID, ROR, PMID, ISSN, OpenAlex ID) to an OpenAlex ID |
| `openalex_get_citation_graph` | Walk the citation graph one hop from a seed work: `cites`, `cited_by`, or `related_to` |
| `openalex_describe_fields` | List valid filter, group_by, and select field names for an entity type |

### Prompts

| Prompt | Description |
|:-------|:------------|
| `openalex_literature_review` | Guides a systematic literature search: formulate query, search, filter, analyze citation network, synthesize findings |
| `openalex_research_landscape` | Analyzes the research landscape for a topic: volume trends, top authors/institutions, open access rates, funding sources |

The server also publishes an agent skill, `openalex-guide` (`skill://openalex-guide/SKILL.md`, source in `skills/openalex-guide/`): which filter key answers the question, how to read `group_by` counts, where each ID type comes from, and how to pin an author without picking a namesake. It ships in the npm package, the Docker image, the `.mcpb` bundle, and plugin installs.

## Capability reference

### `openalex_search_entities` <sub>tool</sub>

- Retrieve a single entity by `id`: an OpenAlex ID, DOI, ORCID, ROR, PMID, ISSN, or PMCID, bare or as a URL (OpenAlex record-page and API URLs such as `https://openalex.org/works/W2741809807` included), or a keyword by its slug or URL. Under `entity_type: "funders"`, a Crossref Funder Registry DOI (`10.13039/…`) also resolves
  - `id` takes precedence: search parameters passed alongside it are dropped, and the response names which ones
  - Lookups by ID are unbilled, except a keyword slug or URL, an `id` with characters past the identifier (`W2741809807#x` still returns W2741809807), and a funder DOI, which each bill as one list call
  - Fails before any request as `id_type_mismatch` (an OpenAlex ID of another entity type) or `id_dot_segment` (a `.` or `..` path segment); a `?`, `#`, `\`, tab, or line break inside an identifier is percent-encoded, so SICI DOIs ending in `#` resolve
  - A PMCID resolves nothing (OpenAlex indexes none); use the work's PMID or DOI
- `entity_type: "awards"` reaches grants (`G…` IDs), which `openalex_resolve_name` does not look up since OpenAlex has no award autocomplete
- Keyword search (boolean operators, quoted phrases, wildcards, fuzzy match) plus `exact` and `semantic` search modes — semantic ranks a query-dependent candidate set at ~1 req/sec (up to 50 per page), and its `meta.count` reports the candidate count rather than a match total
- `filters` accepts a record object or an unambiguous native string (`"issn:0920-8542"`), including through the `filter` alias. Conversion is disclosed in `notice`; commas outside paired double quotes separate clauses, and the first colon separates a key from its value, preserving DOI/URL colons and quoted comma phrases. Exact duplicate keys, bare fragments, and unmatched quotes are rejected with record-form recovery guidance. A record holds one value per key; distinct aliases of the same upstream field still AND together. Set `OPENALEX_FILTER_STRING_INPUT=false` to require record objects. Native strings apply only to this tool's filters, with the record form remaining the advertised schema
- Filter values sent unquoted must have paired double quotes on all four filter-taking tools (`unmatched_quote_in_filter_value`); citation filters are checked before the seed lookup. Balanced search phrases such as `"graph neural" networks` remain valid, including `.search.exact`. A value sent double-quoted still cannot contain its own interior double quote (`quote_in_filter_value`)
- Rich filter syntax: AND across fields, OR within a field (`|`), AND within a field (`+`), NOT (`!`), ranges, comparisons
  - One value cannot mix `|` with an AND (a `+`, or a space between IDs or codes): OpenAlex would silently drop the AND-ed alternatives, so `DE|FR+US` and `authorships.author.id: A1 A2|A3` fail as `mixed_and_or_in_filter_value` before any request. Put the AND in a second key instead (`institutions.country_code: US` beside `authorships.institutions.country_code: DE|FR` on works)
  - Fields OpenAlex matches as whole text (`display_name`, `awards.funder_display_name`, `awards.funder_award_id`, `geo.city`, `geo.region`, `raw_affiliation_strings`, `block_key`, `biblio` fields) are sent double-quoted, so a value with spaces or commas matches as one phrase (`awards.funder_display_name: National Science Foundation`). `!` and `|` still work (`geo.city: New York|Boston`); `+` cannot AND it with another value
  - A comma is allowed in `.search` values and whole-text fields; anywhere else it fails as `comma_in_filter_value` (use `|` for OR)
  - `+` is a literal character in `.search` values, DOIs, dates, URLs, exactly matched names (`C++`, `Erasmus+`), `biblio` fields (issue `1+2`), and `awards.funder_award_id`
  - A double quote inside a value sent quoted fails as `quote_in_filter_value`
- Country and language values are converted to the codes OpenAlex stores, in every tool that takes `filters`:
  - Country fields (keys ending in `country_code`, `country_codes`, or `countries`): ISO alpha-3 codes, numeric codes, and English names (ISO's or OpenAlex's own facet labels, such as `Ivory Coast`) become alpha-2 (`DEU`, `276`, `Germany` → `DE`; `UK` → `GB`). A value that cannot be a country (`Germanyy`, `999`, `DE US`) fails as `invalid_country_code` before any request
  - `language`: ISO 639-2 codes and English names become ISO 639-1 (`eng`, `English` → `en`; `Cebuano` → `ceb`)
  - Each `|`/`+` segment converts on its own (`South Korea|Japan` → `KR|JP`); anything else (`null`, `XK`, `zh-cn`, the `countries/DEU` path form) is sent as given
- `select` returns a curated per-entity-type default unless overridden, or `["*"]` for the full record; invalid field names error with the valid set. On works, `author_list` returns each author in authorship order as `{id, display_name, orcid}` — about a tenth the size of `authorships`, which adds institutions and affiliations — and is never part of the default or `["*"]`
- Cursor pagination for keyword and exact search, up to 100 results per page (default 25); semantic search walks its candidates with `page` (1-based) instead, up to 50 per page, and mixing either knob with the wrong `search_mode` is rejected before the upstream call
- `sample` (up to 10,000) plus a deterministic `seed` for reproducible random sampling; keyword and exact modes only, and never alongside `sort` or `cursor` — OpenAlex does not sample a semantic search and refuses a sorted sample, so those combinations are rejected before the upstream call. `per_page` defaults to `min(sample, 100)`, so a sample of 100 or fewer returns whole in one call; a larger one is walked with `page` and a `seed` (`sample_page_without_seed` without one), up to record 10,000 (`sample_page_too_deep` past it)
- A page is `per_page` records, whole, and an `id` lookup returns every selected array whole; `slice: {field, offset, limit}` on an `id` lookup pages one array by count (`limit` default 50, clamped to 5,000). A response over 8,000,000 bytes on either surface (`structuredContent`, or `content[]` text) fails as `response_too_large` and names a `per_page` or `slice.limit` that fits, or a narrower `select`
- A list record carrying exactly 100 `authorships` or `author_list` entries is flagged as possibly capped, with an `id` + `slice` call to retrieve more stored authors. Singleton lookups and snapshots retain at most 5,000 authorships per work; at that ceiling both author fields remain possibly capped on every slice. `total` counts stored entries rather than a complete byline, and `next` becomes null when those entries are exhausted. Another OpenAlex fetch or snapshot cannot recover authors beyond the storage ceiling
- Oversized positive integers clamp to their cap, with requested/applied sizes in `notice`, a log, and a counter: `per_page` above 100 (200 on analysis, 50 under semantic search), `slice.limit` above 5,000, and `sample` above 10,000. Set `OPENALEX_CLAMP_PER_PAGE=false` to reject each over its cap instead. Zero, negatives, and fractions always reject. An `id` ignores page size
- `display_name` is nullable for untitled records; every call reports OpenAlex daily-budget cost and remaining balance

---

### `openalex_analyze_trends` <sub>tool</sub>

- Group any supported field for trend, distribution, or comparative analysis; combine with `filters` to scope the population before aggregation
- Up to 200 groups per page (default). Without a cursor, `order: "count"` (default) returns the top-N by count with no further pages; `order: "key"` enumerates distinct values key-ascending with cursor pagination. Boolean fields keep count order even with `"key"` and do not support cursor pagination. A supplied `cursor` selects key order even when `order` is omitted or `"count"`. OpenAlex can wrap a key-ordered walk to earlier groups: stop when a page's first key repeats an earlier key, or when a page is short or empty, even if `next_cursor` is still present
- `include_unknown` (default `false`) adds a group for entities with no value for the grouped field, flagged `is_unknown: true` and labeled as unknown in the text output. The native `:include_unknown` suffix on `group_by` also enables it, even with an explicit `false`; passing both adds the suffix once. OpenAlex keys it `-111`/`-111.0` (numeric fields), `unknown` (text fields and `order: "key"`), or an ID ending in `/unknown`; the key is a sentinel, not a filter value. Boolean fields have no such group — a missing value counts as `false`
- `key_display_name` remains present but can be `null` when OpenAlex supplies no label; text output renders the group key in that case, including unknown buckets
- Not every field is groupable — raw date fields, `.search` operators, `from_*`/`to_*` range modifiers, decimal scores such as `fwci`, `display_name`, external-ID fields such as `doi`, and fields OpenAlex looks up from a related entity such as `primary_location.source.country_code` are rejected; `openalex_describe_fields(entity_type, "group_by")` lists the fields that group
- A works group_by on `authorships.countries` says in its notice that OpenAlex counts only each work's first 100 authorships for that field, and names `authorships.institutions.country_code` as the field that counts all of them
- `entity_type: "awards"` groups by fields such as `start_year`, `funder.id`, or `funding_type`; groups count awards and do not sum `amount_usd`
- Reports OpenAlex daily-budget cost and remaining balance — aggregation is priced far below paging the same entities

---

### `openalex_resolve_name` <sub>tool</sub>

- A name or partial name runs an autocomplete search over works, authors, sources, institutions, topics, keywords, publishers, and funders: up to 10 matches with disambiguation hints (last institution, host organization, place, etc.)
- An award ID (`G…`, bare or as an OpenAlex URL) sends no request: OpenAlex has no award autocomplete, so the response is empty with a notice naming the `openalex_search_entities` call that opens the award. Under an explicit `entity_type`, a bare `G…` is searched as a name of that type
- An identifier — OpenAlex ID, DOI, ORCID, ROR, PMID, ISSN, or keyword URL, bare or in URL form — resolves directly to the record it addresses, as the entity type it belongs to. A ROR can name an organization's institution, funder, and publisher records at once: with no `entity_type` (or any other type) all three are looked up in parallel as unbilled singleton fetches and every record found is returned, institution first; `entity_type` `institutions`, `funders`, or `publishers` narrows it to that one. A Crossref Funder Registry DOI (`10.13039/…`) resolves to the funder unless `entity_type` is `works`. A PMCID is recognized but resolves nothing — OpenAlex indexes none
- Short names share the bare OpenAlex ID shape (keyword `p53` reads as publisher `P53`), so a bare OpenAlex ID that resolves nothing is searched as a name next, under `entity_type` when given, and the notice names both outcomes; a real ID still resolves with its one request. Under `entity_type: "keywords"` the shape is searched as a keyword name from the start
- `filters` narrows autocomplete only and requires `entity_type` — a name query passing `filters` without it is rejected before any request (`filters_without_entity_type`). On an identifier lookup they're ignored and named in a notice; a name search that matches nothing under `filters` echoes them and suggests loosening them first
- With `entity_type` set, OpenAlex autocomplete fails on a name over 1,000 characters; that failure is reported once as `query_too_long` with advice to shorten the name, not retried as an outage
- Reports OpenAlex daily-budget cost and remaining balance

---

### `openalex_get_citation_graph` <sub>tool</sub>

- `direction` sets the edge: `cites` (works citing the seed), `cited_by` (the seed's own reference list), `related_to` (OpenAlex's algorithmic related works, ~8-30 typical, may be empty)
- `seed_id` accepts an OpenAlex work ID (bare, or its OpenAlex record-page or API URL), DOI, or PMID (PMCID recognized but resolves nothing); validated against a live lookup first, so a non-existent seed fails as `NotFound` rather than returning an empty graph, and the ID of another entity type fails as `id_type_mismatch` before any upstream call
- Stacks with `filters`/`sort`/`select` (`author_list` included) to narrow the graph; `filters` cannot set `cites`/`cited_by`/`related_to`, nor an alias of one such as `cited_works` — those keys are reserved for `direction`
- Cursor pagination, up to 100 results per page (default 25); a page is `per_page` works, whole
- The same 8,000,000-byte `response_too_large` failure (naming a `per_page` that fits) and 100-authorship cap disclosure as `openalex_search_entities`
- Reports OpenAlex daily-budget cost, covering both the seed-validation lookup and the graph page, plus remaining balance

---

### `openalex_describe_fields` <sub>tool</sub>

- Lists every valid field name for an entity type + context (`filter`, `group_by`, `select`) — the complete pool, never truncated
- `group_by` is the filter set minus what OpenAlex rejects as an aggregation key: raw date fields, `.search`/`.search.exact` operators, `from_*`/`to_*` range modifiers, and a per-entity-type set found by grouping every listed field against the live API — decimal scores such as `fwci`, several source year fields, `display_name`, and external-ID fields among them
- `created_date`, `updated_date`, and their `from_`/`to_` forms are listed filters that OpenAlex serves only on a paid plan; without one, a filter on them fails on its first request as `upstream_plan_required`, with no retry
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
- The funding step groups by `funders.id`, which counts every work that lists a funder and labels each group with the funder's name; for grants it groups the topic's works by `awards.id` and opens the top `G…` IDs on `entity_type: "awards"` for amounts and dates, since few awards carry a topic of their own

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenAlex-specific:

- Typed API client with automatic ID normalization (DOI, ORCID, ROR, PMID, PMCID, ISSN, OpenAlex record-page and API URLs over `http`, `https`, or no scheme, PubMed/PubMed Central URLs); a PMCID normalizes but resolves nothing since OpenAlex indexes none
- Keyless by default — an optional API key raises rate and daily-budget limits, and an optional `mailto` identifies the caller to OpenAlex's polite pool
- HTTP status codes mapped to specific MCP error classes (400 → InvalidParams, or ServiceUnavailable when a semantic search's query embedding failed upstream; 422 → ValidationError; 429 → RateLimited, or Forbidden when the 429 refuses a paid-plan filter) with upstream messages surfaced
- Timeout-aware request retries and cancellation support via `AbortSignal`

Agent-friendly output:

- Provenance — every API-calling tool reports OpenAlex daily-budget cost, remaining balance, and reset time (`budget.costUsd`, `remainingUsd`, `resetsInSeconds`)
- Effective-query echo — search, trends, and citation-graph responses echo the criteria that actually ran, so an empty result is diagnosable without re-reading the request
- Discriminated output contracts — typed error reasons (`entity_not_found`, `upstream_budget_exhausted`, `semantic_per_page_cap`, `reserved_filter_key`, and more) each carrying an explicit recovery hint
- Response shaping — abstracts are reconstructed from OpenAlex's inverted-index encoding into plaintext, and `display_name` stays `null` for untitled or paratext records instead of being backfilled
- Clean provider text — OpenAlex passes titles, abstracts, and names through unsanitized; HTML entities are decoded against the full WHATWG table, comments and HTML/JATS/MathML formatting tags are removed, CDATA wrappers and IOP's `<?CDATA …?>` math markers are unwrapped with their TeX kept, MathType equation blobs (`% MathType!MTEF!…!44A1!`) are removed while the TeX that restates them stays, and a double-escaped line break (a literal `\n`) becomes a space; literal text such as `A < B`, `95% CI`, and TeX such as `\nu` is kept. Identifier and URL fields (`id`, `doi`, `ids`, `orcid`, `ror`, `issn`, `*_url`, lineages) are returned exactly as OpenAlex stores them, so each one resolves when passed back. The text output escapes that text for Markdown, so a stray `*`, `<tag>`, or `[x](y)` renders as written, and line breaks, tabs, and leading or trailing spaces read back as the structured output holds them; a multi-line `display_name` renders on its own `**Display Name:**` line. Notices escape caller text the same way. IDs, and URLs that render as links, stay byte-identical

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http openalex-mcp-server https://openalex.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add openalex-mcp-server -- npx -y @cyanheads/openalex-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "openalex-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/openalex-mcp-server"]
    }
  }
}
```

An optional `OPENALEX_API_KEY` — a free [OpenAlex account key](https://openalex.org/settings/api) — raises the rate limits and daily budget over anonymous access; `OPENALEX_MAILTO` identifies you to OpenAlex's [polite pool](https://developers.openalex.org/guides/authentication). For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto` (resolves to `stateful`). The server declares `stateless` in code; an explicit value overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_ALLOWED_ORIGINS` | Comma-separated allow-list of browser `Origin` headers for HTTP transport. Unset = loopback-only; set to `*` to disable. | _loopback only_ |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `debug` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OPENALEX_API_KEY` | OpenAlex account API key, sent upstream as `api_key=` (free from [openalex.org/settings/api](https://openalex.org/settings/api)). Without it, anonymous rate limits apply. | — |
| `OPENALEX_MAILTO` | Email sent upstream as `mailto=` to identify yourself to OpenAlex (the "polite pool"); a courtesy identifier, separate from the API key. | — |
| `OPENALEX_BASE_URL` | OpenAlex API base URL. | `https://api.openalex.org` |
| `OPENALEX_FILTER_STRING_INPUT` | Accept unambiguous native filter strings on `openalex_search_entities`. Set `false` to require record objects; invalid boolean values fail startup. | `true` |
| `OPENALEX_CLAMP_PER_PAGE` | Clamp oversized positive integer `per_page` (100 search/citation, 50 semantic, 200 analysis), `slice.limit` (5,000), and `sample` (10,000) with a requested/applied notice. Set `false` to reject each over its cap; invalid boolean values fail startup. | `true` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/openalex-mcp-server.git
  cd openalex-mcp-server && bun install
  cp .env.example .env   # optionally set OPENALEX_API_KEY
  ```

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
docker run --rm -e OPENALEX_API_KEY=your-key -p 3010:3010 ghcr.io/cyanheads/openalex-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/openalex-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/openalex-mcp-server:latest"]`. To build locally, `docker build -t openalex-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and prompts. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`). |
| `src/services/openalex/` | OpenAlex API client, field catalog, and domain types. |
| `skills/` | The published `openalex-guide` agent skill, served over MCP and shipped with the package. |
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
