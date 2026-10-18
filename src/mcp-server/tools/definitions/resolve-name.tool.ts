/**
 * @fileoverview Tool for resolving a name or an identifier to an OpenAlex ID — names go to
 * autocomplete, identifiers to the deterministic by-ID lookup.
 * @module mcp-server/tools/definitions/resolve-name.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdown } from '@/mcp-server/tools/escape-markdown.js';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';
import {
  getOpenAlexService,
  type IdentifierResolution,
  inferIdentifier,
  PMCID_NOT_INDEXED_HINT,
} from '@/services/openalex/openalex-service.js';
import { ENTITY_TYPES, type EntityType } from '@/services/openalex/types.js';

/** The singular noun for an entity type, as a record of it is named: `funders` → `funder`. */
function entityNoun(entityType: EntityType): string {
  return entityType.replace(/s$/, '');
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** `a`, `a or b`, `a, b, or c`. */
function orList(words: string[]): string {
  return words.length < 3
    ? words.join(' or ')
    : `${words.slice(0, -1).join(', ')}, or ${words.at(-1)}`;
}

interface NameSearchInput {
  entity_type?: EntityType | undefined;
  filters?: Record<string, string> | undefined;
}

function hasFilters(input: NameSearchInput): input is NameSearchInput & {
  filters: Record<string, string>;
} {
  return input.filters !== undefined && Object.keys(input.filters).length > 0;
}

/**
 * Where a name search looked: ` among institutions with filters={…}`, or ` across all entity
 * types`. The filters are JSON-encoded, the form the search tools echo them in, so a quote or
 * line break in a value cannot leave the notice's line.
 */
function nameSearchScope(input: NameSearchInput): string {
  const types = input.entity_type ? ` among ${input.entity_type}` : ' across all entity types';
  return hasFilters(input) ? `${types} with filters=${JSON.stringify(input.filters)}` : types;
}

/**
 * What to try after a name search matched nothing. Filters come first when they applied, since
 * one may exclude the match; omitting entity_type is never offered alongside them, as filters
 * apply to a name search only with entity_type. With no entity_type, a typed search is the
 * suggestion: cross-type autocomplete misses names a one-type search finds (`p53` among keywords).
 */
function nameMissAdvice(input: NameSearchInput): string {
  if (hasFilters(input)) {
    return 'Loosen or drop filters first — they may exclude the match — then try a shorter name or alternate spelling.';
  }
  return input.entity_type
    ? 'Try a shorter name, alternate spelling, or omit entity_type to search across all types.'
    : 'Try a shorter name or alternate spelling, or pass entity_type to search one type — a one-type search can find names the cross-type search misses.';
}

/**
 * The notice for a bare OpenAlex ID that resolved nothing (`missed` names that), followed by
 * what its name search did: the matches it found, nothing, a failure upstream — or, with
 * `filters` and no entity_type, no name search at all.
 */
function idMissNotice(
  missed: string,
  nameFallback: IdentifierResolution['nameFallback'],
  matched: number,
  input: NameSearchInput,
): string {
  if (!nameFallback) {
    return `${missed}. It was not searched as a name: filters apply to a name search only with entity_type — pass entity_type to search one type by name with these filters, or drop filters to search every type.`;
  }
  if (nameFallback.failedReason !== undefined) {
    return `${missed}, and the name search it fell back to failed upstream (reason ${nameFallback.failedReason}) — call again to complete it.`;
  }
  return matched > 0
    ? `${missed}, so it was searched as a name${nameSearchScope(input)} instead.`
    : `${missed}, and as a name it matched nothing${nameSearchScope(input)}. ${nameMissAdvice(input)}`;
}

export const resolveNameTool = tool('openalex_resolve_name', {
  description:
    "Resolve a name or an identifier to an OpenAlex ID. ALWAYS use this before filtering by entity — names are ambiguous, IDs are not. A name returns up to 10 autocomplete matches with disambiguation hints. An identifier — OpenAlex ID, DOI, ORCID, ROR, PMID, or ISSN, bare or in URL form — resolves directly to the record it addresses instead of running a name search. Short names share the bare OpenAlex ID shape (keyword p53 reads as publisher ID P53), so a bare OpenAlex ID that resolves nothing is searched as a name next. Two identifiers can address more than one entity type: a ROR names an organization's institution, funder, and publisher records alike, so it returns each one that exists (institution first) unless entity_type picks one of those three; and a Crossref Funder Registry DOI (10.13039/…) resolves to the funder unless entity_type is works. A PMCID is recognized as well, bare or as a PubMed Central URL, but OpenAlex indexes no PMCIDs, so it resolves nothing — pass the work's PMID or DOI instead.",
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/resolve-name.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'filters_without_entity_type',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A name `query` passed `filters` without `entity_type`. Filter fields belong to one entity type, and a name search across every type takes no filters.',
      recovery:
        'Add entity_type naming the type the filter fields belong to, or drop `filters` to search every entity type by name.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAlex throttled the autocomplete request for exceeding its per-second ceiling (HTTP 429).',
      retryable: true,
      recovery:
        'Wait several seconds and retry; consider lowering request frequency for this caller.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_budget_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The OpenAlex daily usage budget is spent (HTTP 429).',
      retryable: false,
      recovery:
        "This server's daily OpenAlex budget is spent and refills at midnight UTC — retrying before then will not succeed.",
      thrownBy: 'service',
    },
    {
      reason: 'upstream_plan_required',
      code: JsonRpcErrorCode.Forbidden,
      when: 'A filter is one OpenAlex serves only on a paid plan — created_date, updated_date, or a from_/to_ form of either (HTTP 429 "Plan upgrade required").',
      retryable: false,
      recovery:
        'Drop the plan-gated filter and rerun; retrying it unchanged will not succeed. To bound works by date, filter on publication_date, from_publication_date, or to_publication_date, which need no paid plan.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'OpenAlex did not respond within the request deadline.',
      retryable: true,
      recovery:
        'Retry after a short delay; if timeouts persist, narrow the request with tighter filters to reduce upstream load.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OpenAlex was unreachable or unusable — HTTP 503, a connection failure, or a body that was empty, HTML, or unparseable JSON.',
      retryable: true,
      recovery:
        'Wait and retry; check https://openalex.org for service status if the outage persists.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'OpenAlex rejected the API key (HTTP 401).',
      recovery:
        'Check that OPENALEX_API_KEY is set to a valid OpenAlex account API key (free from https://openalex.org/settings/api).',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'OpenAlex denied access to autocomplete (HTTP 403).',
      recovery: 'Confirm the API key has access to autocomplete, then retry the request.',
      thrownBy: 'service',
    },
    {
      reason: 'id_dot_segment',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An identifier `query` holds a `.` or `..` path segment, written plainly or percent-encoded.',
      recovery:
        'Pass the identifier itself — an OpenAlex ID, DOI, ORCID, ROR, PMID, or ISSN — with no relative path segments, or pass a name to search for instead.',
      thrownBy: 'service',
    },
    {
      reason: 'comma_in_filter_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A `filters` value contains a comma, which collides with the OpenAlex filter separator, on a field that takes no phrase. Free-text search filters (any `.search` key, such as display_name.search) and fields matched as whole text (display_name, awards.funder_display_name, awards.funder_award_id, geo.city, geo.region, raw_affiliation_strings, block_key, parsed_longest_name, biblio fields) are exempt: a comma there is sent quoted, as part of the phrase.',
      recovery:
        'Use `|` for OR within a filter value (e.g. "2020|2021"), or move a free-text phrase containing commas into the `query` parameter.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_country_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A country filter (a key ending in country_code, country_codes, or countries) holds a segment that cannot be a country code, such as a misspelled name, an unassigned number, "unknown", or two codes joined by a space ("DE US").',
      recovery:
        'Pass the country as an ISO 3166-1 alpha-2 code such as DE, US, or GB (an alpha-3 code, numeric code, or English name is converted), or null for records with no country.',
      thrownBy: 'service',
    },
    {
      reason: 'mixed_and_or_in_filter_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A `filters` value puts "|" (OR) beside an AND operator — a "+", or a space on a field where words mean AND (a space inside a country or language name is part of the name). OpenAlex splits the value on "|" first and drops every alternative that ANDs more than one value, so no single value can carry both.',
      recovery:
        'Keep "|" and the AND operator in separate filter keys: OR the alternatives in this key and put the AND in a second key that reaches the same values — on works, {"authorships.institutions.country_code": "DE|FR", "institutions.country_code": "US"} matches (DE or FR) and US. The filters object holds each key once, so where no second key fits, run one call per alternative instead.',
      thrownBy: 'service',
    },
    {
      reason: 'quote_in_filter_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A `filters` value sent to OpenAlex as a quoted phrase — a free-text search filter, or a field matched as whole text — carries a double quote of its own, beyond an outer pair the caller wrapped the value in.',
      recovery:
        'Remove the double quote from the value; a phrase is matched without quoting its own text.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_invalid_params',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected an invalid filter field name on the autocomplete query (HTTP 400).',
      recovery:
        'The upstream message names the rejected field and suggests close matches. Use openalex_describe_fields(entity_type, "filter") to browse valid filter fields, or drop `filters` entirely.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_invalid_id_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A `filters` entry expecting an entity ID received a value that is not an OpenAlex ID — usually a name (HTTP 400).',
      recovery:
        'Resolve that name to an OpenAlex ID first — run this tool without the ID-valued filter, take the `id` from a match, then re-run with the ID.',
      thrownBy: 'service',
    },
    {
      reason: 'query_too_long',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex autocomplete failed (HTTP 500) on a `query` longer than the 1,000 characters it accepts when entity_type is set.',
      retryable: false,
      recovery:
        'Shorten `query` to 1,000 characters or fewer — pass the name itself, not a citation or abstract — and call again with the shorter text.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_invalid_params_other',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected the autocomplete request (HTTP 400) for a reason other than an invalid field name.',
      recovery:
        'Read the upstream message in the error above and adjust the request — trim the query, check filter value formats, and ensure entity_type is a supported value.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OpenAlex rejected the autocomplete request as semantically invalid (HTTP 422).',
      recovery:
        'Read the upstream message for the specific field, then adjust the request to satisfy validation.',
      thrownBy: 'service',
    },
  ],
  inputAliases: { name: 'query', filter: 'filters' },
  input: z.object({
    entity_type: z
      .enum(ENTITY_TYPES)
      .optional()
      .describe(
        'Entity type to search. Omit for cross-entity search (useful when entity type is unknown). With an identifier `query` it narrows only an identifier that can address more than one type: a ROR to institutions, funders, or publishers (omit it to get every one of the three that exists), and a Funder Registry DOI (10.13039/…) to works instead of the funder. Every other identifier resolves as the type it belongs to, whatever this names — except under keywords, where a bare OpenAlex ID shape ("P53") is searched as a keyword name, since keyword IDs are slugs.',
      ),
    query: z
      .string()
      .min(1)
      .describe(
        'Name or partial name to resolve. Also accepts an identifier, bare or in URL form — OpenAlex ID ("W2741809807", "F4320332161", or an OpenAlex record-page or API URL such as "https://openalex.org/works/W2741809807"), DOI ("10.1038/nature12373", or a funder\'s Funder Registry DOI such as "10.13039/100000001"), ORCID ("0000-0002-1825-0097"), ROR ("https://ror.org/00hx57361"), PMID ("12345678" or "https://pubmed.ncbi.nlm.nih.gov/12345678"), ISSN ("1234-5678") — which resolves straight to the record it addresses, or for a ROR up to three (see entity_type), instead of running a name search. A bare OpenAlex ID that resolves nothing is then searched as a name — under entity_type when given, and not at all when filters come without entity_type — since short names share its shape ("P53" is a keyword); under entity_type keywords it is searched as a name from the start. A keyword URL ("https://openalex.org/keywords/groundwater") resolves the same way; a bare keyword slug reads as a name and runs a name search, which finds it too. A PMCID ("PMC1234567" or a PubMed Central URL) is recognized but OpenAlex indexes no PMCIDs, so it resolves nothing — pass the work\'s PMID or DOI instead.',
      ),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Narrow autocomplete results with filters, in the openalex_search_entities filter syntax. Example: restrict to a specific country or publication year range. Country fields take ISO 3166-1 alpha-2 codes ({"country_code": "DE"} on institutions) and `language` takes ISO 639-1 codes ("en"); alpha-3, numeric, ISO 639-2, and English-name forms are converted — a multi-word name is one value, so "South Korea|Japan" ORs two countries — and a value that cannot be a country code is rejected. A multi-word value on a field matched as whole text (display_name, geo.city, geo.region, awards.funder_display_name) matches as one phrase ({"geo.city": "New York"} on institutions; a comma, as in "University of California, Berkeley", is part of it, and it cannot contain a double quote of its own), "!" and "|" included, but cannot be ANDed with "+" in the same field. A value mixing "|" with an AND operator — a "+", or a space on a field where words mean AND — is rejected, since OpenAlex drops every "|" alternative that ANDs more than one value; put the AND in a second key instead. Requires entity_type — filter fields belong to one entity type, so a name search across every type takes none, and a name query passing filters without entity_type is rejected. Applies to name queries only — an identifier lookup returns the records it addresses regardless.',
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
                'Human-readable name as plain text, with HTML entities decoded and markup removed. null only for an identifier lookup that landed on a record OpenAlex holds no title for (paratext works and other untitled entries) — use `id` to identify it.',
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
                'Disambiguation context as plain text — last institution (authors), host organization (sources), place or country (institutions); author names (works) from a name search, publication year from an identifier lookup. null when the record carries none.',
              ),
          })
          .describe(
            'A single autocomplete match with its ID, name, entity type, activity stats, and a disambiguation hint.',
          ),
      )
      .describe(
        'Matches: up to 10 autocomplete matches for a name; for an identifier, the record it addresses — for a ROR, up to three, institution then funder then publisher — or none.',
      ),
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
        'Guidance notice. Set when nothing matched (echoes the query, and the filters when a name search applied them, and suggests corrections), when a bare OpenAlex ID resolved nothing and the query was searched as a name instead (names both outcomes, or why the name search did not run or finish), when an identifier query was passed name-search parameters that do not apply to it, or when one of the lookups for a ROR failed upstream (names the entity type whose record may be missing). Absent otherwise.',
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
    // An identifier addresses its own record, so it goes to the deterministic by-ID lookup.
    // Autocomplete only ever matched identifiers by accident — it indexes the external-ID URL,
    // so the bare forms and several native OpenAlex IDs miss.
    const identifier = inferIdentifier(input.query, input.entity_type);
    const nameSearch = {
      entityType: input.entity_type,
      query: input.query,
      filters: input.filters,
    };
    // JSON-encoded so a line break in the query cannot start a heading or end a blockquote.
    const query = JSON.stringify(input.query);

    if (!identifier) {
      // Cross-entity autocomplete rejects `filter` outright, so this pair can only fail upstream.
      if (hasFilters(input) && !input.entity_type) {
        throw ctx.fail(
          'filters_without_entity_type',
          '`filters` applies to a name search only with entity_type — filter fields belong to one entity type, and a search across every type takes none.',
        );
      }
      const result = await service.autocomplete(nameSearch, ctx);
      ctx.log.info('Name resolved', {
        query: input.query,
        entityType: input.entity_type ?? 'all',
        resolvedVia: 'autocomplete',
        matchCount: result.results.length,
      });
      if (result.results.length === 0) {
        ctx.enrich.notice(
          `No matches for ${query}${nameSearchScope(input)}. ${nameMissAdvice(input)}`,
        );
      }
      return result;
    }

    // A bare OpenAlex ID shape is also a short name's, so one that resolves nothing is searched
    // as a name next — unless filters came without entity_type, which no name search takes.
    const canSearchByName =
      identifier.mayBeName === true && (input.entity_type !== undefined || !hasFilters(input));
    const { results, failedEntityTypes, nameFallback } = await service.resolveIdentifier(
      identifier,
      ctx,
      canSearchByName ? nameSearch : undefined,
      input.query,
    );
    ctx.log.info('Name resolved', {
      query: input.query,
      entityType: identifier.entityTypes.join(','),
      resolvedVia: nameFallback ? 'autocomplete' : identifier.scheme,
      matchCount: results.length,
    });

    const scheme =
      identifier.scheme === 'openalex' ? 'OpenAlex ID' : identifier.scheme.toUpperCase();
    const nouns = identifier.entityTypes.map(entityNoun);
    const missed = `No ${orList(nouns)} in OpenAlex for ${scheme} ${query}`;

    // A bare ID that missed was read as a name next, so its notice covers both readings.
    if (identifier.mayBeName && (nameFallback || results.length === 0)) {
      ctx.enrich.notice(idMissNotice(missed, nameFallback, results.length, input));
      return { results };
    }

    const notices: string[] = [];

    const ignored: string[] = [];
    if (input.entity_type && !identifier.entityTypes.includes(input.entity_type)) {
      ignored.push(`entity_type="${input.entity_type}"`);
    }
    if (hasFilters(input)) ignored.push('filters');
    if (ignored.length > 0) {
      const addressed = nouns.length === 1 ? `one ${nouns[0]}` : orList(nouns.map(withArticle));
      notices.push(
        `Resolved ${query} by ${scheme} — it identifies ${addressed} directly, so ${ignored.join(' and ')} did not apply.`,
      );
    }

    if (results.length === 0) {
      if (identifier.scheme === 'pmcid') {
        // A PMCID is the one identifier whose miss says nothing about the identifier: it is
        // well formed and OpenAlex still holds no record for it, so "check it for a typo"
        // sends the caller to re-check something that was never wrong.
        notices.push(`${missed}. ${PMCID_NOT_INDEXED_HINT}`);
      } else if (identifier.scheme === 'ror' && input.entity_type && nouns.length === 1) {
        notices.push(
          `${missed} under entity_type="${input.entity_type}". One ROR can name an institution, a funder, and a publisher — omit entity_type to look up all three.`,
        );
      } else {
        notices.push(
          `${missed}. An identifier either resolves or does not — check it for a typo, or search for the entity by name instead.`,
        );
        if (identifier.scheme === 'doi' && identifier.entityTypes[0] === 'funders') {
          notices.push(
            'Some works carry a Funder Registry DOI too — pass entity_type="works" to look it up as a work.',
          );
        }
      }
    }

    if (failedEntityTypes) {
      const failed = failedEntityTypes.map(entityNoun);
      const lookups = failed.length === 1 ? 'lookup' : 'lookups';
      notices.push(
        `The ${failed.join(' and ')} ${lookups} failed upstream, so any ${orList(failed)} record for ${scheme} ${query} is missing from these results — call again to complete them.`,
      );
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return { results };
  },

  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No matches found.' }];
    }
    const lines: string[] = [];
    for (const r of result.results) {
      // Trimmed inside the bold wrapper: `**` next to a space no longer opens or closes it.
      const name = r.display_name === null ? '(untitled)' : escapeMarkdown(r.display_name.trim());
      lines.push(`**${name}** (${escapeMarkdown(r.entity_type)})`);
      const details: string[] = [escapeMarkdown(r.id, 'line-start')];
      if (r.external_id) details.push(escapeMarkdown(r.external_id));
      details.push(`${r.cited_by_count} citations`);
      if (r.works_count !== null) details.push(`${r.works_count} works`);
      if (r.hint) details.push(escapeMarkdown(r.hint));
      lines.push(details.join(' | '));
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
