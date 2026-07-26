/**
 * @fileoverview Tool for resolving names to OpenAlex IDs via autocomplete.
 * @module mcp-server/tools/definitions/resolve-name.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenAlexService } from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES } from '@/services/openalex/types.js';

export const resolveNameTool = tool('openalex_resolve_name', {
  description:
    'Resolve a name or partial name to an OpenAlex ID. Returns up to 10 matches with disambiguation hints. ALWAYS use this before filtering by entity — names are ambiguous, IDs are not. Also accepts DOIs directly for quick lookup.',
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
        'Entity type to search. Omit for cross-entity search (useful when entity type is unknown).',
      ),
    query: z
      .string()
      .min(1)
      .describe('Name or partial name to resolve. Also accepts DOIs for quick lookup.'),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Narrow autocomplete results with filters. Example: restrict to a specific country or publication year range.',
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
            display_name: z.string().describe('Human-readable name.'),
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
                'Disambiguation context: author names (works), last institution (authors), host org (sources), location (institutions).',
              ),
          })
          .describe(
            'A single autocomplete match with its ID, name, entity type, activity stats, and a disambiguation hint.',
          ),
      )
      .describe('Autocomplete matches, up to 10.'),
  }),

  // Agent-facing success-path context — a notice when the query matched nothing so the
  // caller sees explicit guidance rather than a silent empty array.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no matches were found — echoes the query and suggests corrections. Absent when results are present.',
      ),
  },

  async handler(input, ctx) {
    const service = getOpenAlexService();
    const result = await service.autocomplete(
      {
        entityType: input.entity_type,
        query: input.query,
        filters: input.filters,
      },
      ctx,
    );

    ctx.log.info('Name resolved', {
      query: input.query,
      entityType: input.entity_type ?? 'all',
      matchCount: result.results.length,
    });

    if (result.results.length === 0) {
      const scope = input.entity_type ? ` among ${input.entity_type}` : '';
      ctx.enrich.notice(
        `No matches for "${input.query}"${scope}. Try a shorter name, alternate spelling, or omit entity_type to search across all types.`,
      );
    }

    return result;
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matches found.' }];
    }
    const lines: string[] = [];
    for (const r of result.results) {
      lines.push(`**${r.display_name}** (${r.entity_type})`);
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
