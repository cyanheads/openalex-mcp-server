/**
 * @fileoverview Tool for resolving a name or an identifier to an OpenAlex ID — names go to
 * autocomplete, identifiers to the deterministic by-ID lookup.
 * @module mcp-server/tools/definitions/resolve-name.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';
import { getOpenAlexService, inferIdentifier } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

export const resolveNameTool = tool('openalex_resolve_name', {
  description:
    'Resolve a name or an identifier to an OpenAlex ID. ALWAYS use this before filtering by entity — names are ambiguous, IDs are not. A name returns up to 10 autocomplete matches with disambiguation hints. An identifier — OpenAlex ID, DOI, ORCID, ROR, PMID, PMCID, or ISSN, bare or in URL form — resolves directly to the one record it addresses, and needs no entity_type.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/resolve-name.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAlex throttled the autocomplete request for exceeding its per-second ceiling (HTTP 429).',
      retryable: true,
      recovery:
        'Wait several seconds and retry; consider lowering request frequency for this caller.',
    },
    {
      reason: 'upstream_budget_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The OpenAlex daily usage budget is spent (HTTP 429).',
      retryable: false,
      recovery:
        'The daily budget refills at midnight UTC — retrying sooner will not succeed. Set OPENALEX_API_KEY to a free key (https://openalex.org/settings/api) for a larger daily budget than anonymous access, or wait for the reset.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAlex did not respond within the request deadline.',
      retryable: true,
      recovery:
        'Retry after a short delay; if timeouts persist, narrow the request with tighter filters to reduce upstream load.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAlex was unreachable or unusable — HTTP 503, a connection failure, or a body that was empty, HTML, or unparseable JSON.',
      retryable: true,
      recovery:
        'Wait and retry; check https://openalex.org for service status if the outage persists.',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAlex rejected the API key (HTTP 401).',
      recovery:
        'Check that OPENALEX_API_KEY is set to a valid OpenAlex account API key (free from https://openalex.org/settings/api).',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'OpenAlex denied access to autocomplete (HTTP 403).',
      recovery: 'Confirm the API key has access to autocomplete, then retry the request.',
    },
    {
      reason: 'comma_in_filter_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A `filters` value contains a comma, which collides with the OpenAlex filter separator.',
      recovery:
        'Use `|` for OR within a filter value (e.g. "2020|2021"), or move a free-text phrase containing commas into the `query` parameter.',
    },
    {
      reason: 'upstream_invalid_params',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected an invalid filter field name on the autocomplete query (HTTP 400).',
      recovery:
        'The upstream message names the rejected field and suggests close matches. Use openalex_describe_fields(entity_type, "filter") to browse valid filter fields, or drop `filters` entirely.',
    },
    {
      reason: 'upstream_invalid_id_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A `filters` entry expecting an entity ID received a value that is not an OpenAlex ID — usually a name (HTTP 400).',
      recovery:
        'Resolve that name to an OpenAlex ID first — run this tool without the ID-valued filter, take the `id` from a match, then re-run with the ID.',
    },
    {
      reason: 'upstream_invalid_params_other',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected the autocomplete request (HTTP 400) for a reason other than an invalid field name.',
      recovery:
        'Read the upstream message in the error above and adjust the request — trim the query, check filter value formats, and ensure entity_type is a supported value.',
    },
    {
      reason: 'upstream_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenAlex rejected the autocomplete request as semantically invalid (HTTP 422).',
      recovery:
        'Read the upstream message for the specific field, then adjust the request to satisfy validation.',
    },
  ],
  input: z.object({
    entity_type: z
      .enum(ENTITY_TYPES)
      .optional()
      .describe(
        'Entity type to search. Omit for cross-entity search (useful when entity type is unknown). Not applied when `query` is an identifier — an identifier determines its own entity type.',
      ),
    query: z
      .string()
      .min(1)
      .describe(
        'Name or partial name to resolve. Also accepts an identifier, bare or in URL form — OpenAlex ID ("W2741809807", "F4320332161"), DOI ("10.1038/nature12373"), ORCID ("0000-0002-1825-0097"), ROR ("https://ror.org/00hx57361"), PMID ("12345678"), PMCID ("PMC1234567"), ISSN ("1234-5678") — which resolves straight to that one record instead of running a name search.',
      ),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Narrow autocomplete results with filters. Example: restrict to a specific country or publication year range. Applies to name queries only — an identifier already addresses a single record.',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            id: z.string().describe('OpenAlex ID.'),
            external_id: z
              .string()
              .nullable()
              .describe('Canonical external ID (DOI, ORCID, ROR, ISSN).'),
            display_name: z
              .string()
              .nullable()
              .describe(
                'Human-readable name. null only for an identifier lookup that landed on a record OpenAlex holds no title for (paratext works and other untitled entries) — use `id` to identify it.',
              ),
            entity_type: z
              .string()
              .describe(
                'Entity type — one of: work, author, source, institution, topic, keyword, publisher, funder.',
              ),
            cited_by_count: z
              .number()
              .describe('Citation count (direct for works, aggregate for others).'),
            works_count: z
              .number()
              .nullable()
              .describe('Associated works. null for works themselves.'),
            hint: z
              .string()
              .nullable()
              .describe(
                'Disambiguation context — last institution (authors), host organization (sources), place or country (institutions); author names (works) from a name search, publication year from an identifier lookup. null when the record carries none.',
              ),
          })
          .describe(
            'A single autocomplete match with its ID, name, entity type, activity stats, and a disambiguation hint.',
          ),
      )
      .describe('Autocomplete matches, up to 10.'),
  }),

  // Agent-facing success-path context — a notice when the query matched nothing so the
  // caller sees explicit guidance rather than a silent empty array, plus the OpenAlex budget
  // reading. This tool is the documented first step of most workflows, so its trailer is
  // where a caller learns what today's budget looks like before committing to a sweep.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance notice. Set when nothing matched (echoes the query and suggests corrections) or when an identifier query was passed name-search parameters that do not apply to it. Absent otherwise.',
      ),
    budget: z
      .object({
        costUsd: z
          .number()
          .describe(
            'USD this call spent. Autocomplete is priced at the floor — resolving a name before filtering costs far less than the failed searches an ambiguous name causes.',
          ),
        remainingUsd: z.number().describe("USD left in today's OpenAlex budget after this call."),
        resetsInSeconds: z
          .number()
          .describe('Seconds until the daily budget refills (midnight UTC).'),
        prepaidRemainingUsd: z
          .number()
          .optional()
          .describe(
            'USD left in the prepaid balance — a separate pool OpenAlex draws on only after the daily allowance runs out, and which the daily reset does not refill. Add it to `remainingUsd` for the full spendable amount. Absent when the account holds no prepaid balance.',
          ),
      })
      .optional()
      .describe(
        'What this call cost against the OpenAlex daily budget and what is left of it. Read `remainingUsd` here to size the search or traversal this resolution feeds. Absent when OpenAlex omitted the accounting headers.',
      ),
  },

  enrichmentTrailer: {
    budget: { render: renderBudgetTrailer },
  },

  async handler(input, ctx) {
    const service = getOpenAlexService();
    // An identifier addresses one record and carries its own entity type, so it goes to the
    // deterministic by-ID lookup. Autocomplete only ever matched identifiers by accident — it
    // indexes the external-ID URL, so the bare forms and several native OpenAlex IDs miss.
    const identifier = inferIdentifier(input.query);

    const result = identifier
      ? await service.resolveIdentifier(identifier, ctx)
      : await service.autocomplete(
          {
            entityType: input.entity_type,
            query: input.query,
            filters: input.filters,
          },
          ctx,
        );

    ctx.log.info('Name resolved', {
      query: input.query,
      entityType: identifier?.entityType ?? input.entity_type ?? 'all',
      resolvedVia: identifier ? identifier.scheme : 'autocomplete',
      matchCount: result.results.length,
    });

    const notices: string[] = [];
    if (identifier) {
      const scheme =
        identifier.scheme === 'openalex' ? 'OpenAlex ID' : identifier.scheme.toUpperCase();
      const entity = identifier.entityType.replace(/s$/, '');
      const ignored: string[] = [];
      if (input.entity_type && input.entity_type !== identifier.entityType) {
        ignored.push(`entity_type="${input.entity_type}"`);
      }
      if (input.filters && Object.keys(input.filters).length > 0) ignored.push('filters');
      if (ignored.length > 0) {
        notices.push(
          `Resolved "${input.query}" by ${scheme} — it identifies one ${entity} directly, so ${ignored.join(' and ')} did not apply.`,
        );
      }
      if (result.results.length === 0) {
        notices.push(
          `No ${entity} in OpenAlex for ${scheme} "${input.query}". An identifier either resolves or does not — check it for a typo, or search for the entity by name instead.`,
        );
      }
    } else if (result.results.length === 0) {
      notices.push(
        `No matches for "${input.query}"${input.entity_type ? ` among ${input.entity_type}` : ''}. Try a shorter name, alternate spelling, or omit entity_type to search across all types.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return result;
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matches found.' }];
    }
    const lines: string[] = [];
    for (const r of result.results) {
      lines.push(`**${r.display_name ?? '(untitled)'}** (${r.entity_type})`);
      const details: string[] = [r.id];
      if (r.external_id) details.push(r.external_id);
      details.push(`${r.cited_by_count} citations`);
      details.push(r.works_count === null ? 'n/a works' : `${r.works_count} works`);
      if (r.hint) details.push(r.hint);
      lines.push(details.join(' | '));
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
