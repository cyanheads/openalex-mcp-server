# Agent Protocol

**Server:** openalex-mcp-server
**Version:** 0.6.18
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.16`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

[OpenAlex](https://openalex.org) is a fully open catalog of the global research system — 270M+ works, 90M+ authors, 100K+ sources. CC0 data, no API key required (email address optional for polite pool access).

**Entity types:** works, authors, sources, institutions, topics, keywords, publishers, funders. All share a uniform API (list/filter, search, get-by-ID, group-by, autocomplete).

**Critical workflow:** Names are ambiguous, IDs are not. Always resolve names to IDs first via `openalex_resolve_name` before using them in filters.

**Reference docs:** `README.md` covers the current tool and prompt surface; `docs/tree.md` shows the current repository layout.

### MCP Surface

| Type | Name | Purpose |
|:-----|:-----|:--------|
| Tool | `openalex_search_entities` | Search, filter, sort, or retrieve by ID |
| Tool | `openalex_analyze_trends` | Group-by aggregation for trends/distributions |
| Tool | `openalex_resolve_name` | Name-to-ID resolution via autocomplete |
| Tool | `openalex_get_citation_graph` | One-hop citation graph traversal (cites/cited_by/related_to) |
| Prompt | `openalex_literature_review` | Guided systematic literature search workflow |
| Prompt | `openalex_research_landscape` | Quantitative research landscape analysis |

No resources — entity lookups need `select` for payload control, which fits tools better than URI templates.

### Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OPENALEX_API_KEY` | No | Email for the OpenAlex polite pool (10x faster rate limits); omit for anonymous access |
| `OPENALEX_BASE_URL` | No | Default: `https://api.openalex.org` |

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

export const resolveNameTool = tool('openalex_resolve_name', {
  description: 'Resolve a name or partial name to an OpenAlex ID. Returns up to 10 matches with disambiguation hints.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    entity_type: z.enum(ENTITY_TYPES).optional().describe('Entity type to search. Omit for cross-entity search.'),
    query: z.string().describe('Name or partial name to resolve.'),
  }),
  output: z.object({
    results: z.array(z.object({
      id: z.string().describe('OpenAlex ID.'),
      display_name: z.string().describe('Human-readable name.'),
      entity_type: z.string().describe('Entity type.'),
    })).describe('Autocomplete matches, up to 10.'),
  }),

  async handler(input, ctx) {
    const service = getOpenAlexService();
    const result = await service.autocomplete({ entityType: input.entity_type, query: input.query }, ctx);
    ctx.log.info('Name resolved', { query: input.query, matchCount: result.results.length });
    return result;
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients forward different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every terminal field in `output` must appear in format()'s
  // rendered text via sentinel injection. The linter is locale-aware — digit-group
  // separators (commas, periods, spaces) are stripped before matching, so
  // `.toLocaleString()` is fine on linted numbers. Compact/scientific forms still fail.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matches found.' }];
    }
    const lines = result.results.map((r) => `**${r.display_name}** (${r.entity_type}) — ${r.id}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
```

### Prompt

```ts
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const researchLandscapePrompt = prompt('openalex_research_landscape', {
  description: 'Analyzes the research landscape for a topic: volume trends, top authors/institutions, open access rates.',
  args: z.object({
    topic: z.string().describe('Research area to analyze.'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Analyze the research landscape for: "${args.topic}"\n\nUse the OpenAlex tools to build a quantitative profile...` } },
  ],
});
```

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. Passed to `fetch()` in the OpenAlex service. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.fail` | Typed throw keyed by a declared `errors[]` contract — `ctx.fail(reason, msg?, data?)`. Auto-populates `data.reason` and resolves `code` from the contract. |
| `ctx.recoveryFor` | Opt-in resolver returning `{ recovery: { hint } }` for a declared reason. Spread into `data` at throw site to surface contract recovery on the wire. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | `'default'` for stdio and `MCP_AUTH_MODE=none` over HTTP; JWT `tid` claim for `MCP_AUTH_MODE=jwt`/`oauth`. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union — `ctx.fail('typo')` is a TS error, `data.reason` is auto-populated, and the linter enforces conformance against the handler. The `recovery` field is required (≥5 words). Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'semantic_per_page_cap', code: JsonRpcErrorCode.ValidationError,
    when: 'per_page exceeds the semantic-search cap',
    recovery: 'Reduce per_page to 50 or less, or switch search_mode to keyword.' },
],
async handler(input, ctx) {
  if (overCap) throw ctx.fail('semantic_per_page_cap', message, { ...ctx.recoveryFor('semantic_per_page_cap') });
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

The OpenAlex service throws factory errors (`notFound`, `rateLimited`, etc.) based on upstream status codes; those bubble through and are auto-classified. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely without needing to be declared on a contract.

**Fallback for ad-hoc throws:** error factories or plain `Error`.

```ts
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });
throw new Error('Item not found');           // → auto-classified to NotFound
```

See framework CLAUDE.md for the full auto-classification table and all available factories.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # OPENALEX_API_KEY, OPENALEX_BASE_URL
  services/
    openalex/
      openalex-service.ts               # API client (init/accessor pattern)
      types.ts                          # Domain types
  mcp-server/
    tools/definitions/
      search-entities.tool.ts           # openalex_search_entities
      analyze-trends.tool.ts            # openalex_analyze_trends
      resolve-name.tool.ts              # openalex_resolve_name
      citation-graph.tool.ts            # openalex_get_citation_graph
    prompts/definitions/
      literature-review.prompt.ts       # openalex_literature_review
      research-landscape.prompt.ts      # openalex_research_landscape
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-entities.tool.ts` |
| Tool/prompt names | snake_case with `openalex_` prefix | `openalex_search_entities` |
| Directories | kebab-case | `src/services/openalex/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of LLM-facing definition language (voice, leaks, recovery, sparsity, structure) across tools/resources/prompts |
| `security-pass` | Audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` |
| `report-issue-local` | File a bug or feature request against this server's own repo |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/prompt definitions |
| `bun run list-skills` | List available skills |
| `bun run test` | Run tests |
| `bun run start:stdio` | Production mode (stdio, after `rebuild`) |
| `bun run start:http` | Production mode (HTTP, after `rebuild`) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.6.x/0.6.12.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved. `CHANGELOG.md` is a **navigation index** regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

---

## Publishing

Run the `release-and-publish` skill — it runs the verification gate (`devcheck`, `rebuild`, `test`), pushes commits and tags, then publishes to every applicable destination. The full reference:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/openalex-mcp-server:<version> \
  -t ghcr.io/cyanheads/openalex-mcp-server:latest \
  --push .
```

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] `format()` renders every terminal field in `output` — enforced by `format-parity` linter via sentinel injection (locale-aware: digit-group separators stripped before matching)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] OpenAlex wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] OpenAlex wrapping: normalization and `format()` preserve uncertainty — do not fabricate facts from missing upstream data
- [ ] OpenAlex wrapping: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
