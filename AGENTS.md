# Agent Protocol

**Server:** openalex-mcp-server
**Version:** 0.3.2
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/AGENTS.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

[OpenAlex](https://openalex.org) is a fully open catalog of the global research system — 270M+ works, 90M+ authors, 100K+ sources. CC0 data, free API key required.

**Entity types:** works, authors, sources, institutions, topics, keywords, publishers, funders. All share a uniform API (list/filter, search, get-by-ID, group-by, autocomplete).

**Critical workflow:** Names are ambiguous, IDs are not. Always resolve names to IDs first via `openalex_resolve_name` before using them in filters.

**Reference docs:** `README.md` covers the current tool and prompt surface; `docs/tree.md` shows the current repository layout.

### MCP Surface

| Type | Name | Purpose |
|:-----|:-----|:--------|
| Tool | `openalex_search_entities` | Search, filter, sort, or retrieve by ID |
| Tool | `openalex_analyze_trends` | Group-by aggregation for trends/distributions |
| Tool | `openalex_resolve_name` | Name-to-ID resolution via autocomplete |
| Prompt | `openalex_literature_review` | Guided systematic literature search workflow |
| Prompt | `openalex_research_landscape` | Quantitative research landscape analysis |

No resources — entity lookups need `select` for payload control, which fits tools better than URI templates.

### Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OPENALEX_API_KEY` | Yes | API key from openalex.org |
| `OPENALEX_BASE_URL` | No | Default: `https://api.openalex.org` |

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
2. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill
3. **Run `devcheck`** — lint, format, typecheck, and security audit
4. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
5. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

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

  // format() populates the MCP content[] array — this is what LLM clients inject into the
  // model's context. structuredContent (from output) is for programmatic use and is NOT
  // reliably forwarded to the model by most clients. Make format() content-complete.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matches found.' }];
    }
    const lines: string[] = [];
    for (const r of result.results) {
      lines.push(`**${r.display_name}** (${r.entity_type})`);
      const details: string[] = [r.id];
      if (r.external_id) details.push(r.external_id);
      details.push(`${r.cited_by_count.toLocaleString()} citations`);
      if (r.works_count !== null) details.push(`${r.works_count.toLocaleString()} works`);
      if (r.hint) details.push(r.hint);
      lines.push(details.join(' | '));
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
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
| `ctx.signal` | `AbortSignal` for cancellation. Passed to `fetch()` in the OpenAlex service. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Not currently used but available. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, validationError, forbidden, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework AGENTS.md for the full auto-classification table and all available factories.

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

**Agent skill directory:** Copy skills into the directory your agent discovers (Codex: `.Codex/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, re-copy to pick up changes.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Sync skills and dependencies after updates |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/prompt definitions |
| `bun run test` | Run tests |
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Publishing

After a version bump and final commit, publish to both npm and GHCR:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/openalex-mcp-server:<version> \
  -t ghcr.io/cyanheads/openalex-mcp-server:latest \
  --push .
```

Remind the user to run these after completing a release flow.

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
