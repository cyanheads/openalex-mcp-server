/**
 * @fileoverview One-hop citation graph traversal: cites / cited_by / related_to from a seed work.
 * @module mcp-server/tools/definitions/citation-graph.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';
import {
  fitRecordsToBudget,
  formatRecordPage,
  joinNotices,
  measurePageFrame,
  omittedOutputSchema,
  overBudgetOutputSchema,
  windowsOutputSchema,
} from '@/mcp-server/tools/response-budget.js';
import { quoteCallerText } from '@/services/openalex/filter-values.js';
import {
  buildSearchFilter,
  getOpenAlexService,
  translateFilterKey,
} from '@/services/openalex/openalex-service.js';

const OPENALEX_URL_PREFIX = 'https://openalex.org/';
/** What `meta.count` counts, in the rendered header. */
const EDGE_NOUN = 'edge(s)';

const DIRECTIONS = ['cites', 'cited_by', 'related_to'] as const;
type Direction = (typeof DIRECTIONS)[number];

const RESERVED_FILTER_KEYS: ReadonlySet<string> = new Set<string>(DIRECTIONS);

/** The request as one line: caller text is JSON-encoded, so a line break in it stays escaped. */
function buildCitationEcho(input: {
  seed_id: string;
  direction: Direction;
  filters?: Record<string, string> | undefined;
  sort?: string | undefined;
}): string {
  const parts = [`seed_id=${JSON.stringify(input.seed_id)}`, `direction=${input.direction}`];
  if (input.filters && Object.keys(input.filters).length > 0) {
    parts.push(`filters=${JSON.stringify(input.filters)}`);
  }
  if (input.sort) parts.push(`sort=${JSON.stringify(input.sort)}`);
  return parts.join(' | ');
}

export const getCitationGraphTool = tool('openalex_get_citation_graph', {
  description:
    "Walk the citation graph one hop from a seed work. Direction picks the edge: incoming citations (`cites`), the seed's own references (`cited_by`), or OpenAlex's algorithmically-related works (`related_to`). Note: `direction` follows OpenAlex's filter convention, which inverts the common English reading — `cites` returns works that cite the seed; `cited_by` returns works the seed cites. Results use the works schema; combine with filters/sort to narrow further. Responses cap at 64,000 bytes per surface unless the least a call can return is larger (`over_budget`); `omitted` and `windows` give the openalex_search_entities calls that continue a cut.",
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/tools/definitions/citation-graph.tool.ts',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'OpenAlex throttled the request for exceeding its per-second ceiling (HTTP 429).',
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
      when: 'OpenAlex denied access to the requested resource (HTTP 403).',
      recovery:
        'Confirm the API key has access to this entity type or endpoint, then retry the request.',
      thrownBy: 'service',
    },
    {
      reason: 'comma_in_filter_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A filter value contains a comma, which collides with the OpenAlex filter separator, on a field that takes no phrase. Free-text search filters (any `.search` key, such as title.search or abstract.search.exact) and fields matched as whole text (display_name, awards.funder_display_name, awards.funder_award_id, authorships.institutions.geo.city, authorships.institutions.geo.region, raw_affiliation_strings, biblio fields) are exempt: a comma there is sent quoted, as part of the phrase.',
      recovery:
        'Use `|` for OR within a filter value (e.g. "2020|2021"), or move a phrase that contains commas into a free-text search filter such as title.search or raw_affiliation_strings.search.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_country_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A country filter (a key ending in country_code, country_codes, or countries) holds a segment that cannot be a country code, such as a misspelled name, an unassigned number, "unknown", or two codes joined by a space ("DE US").',
      recovery:
        'Pass the country as an ISO 3166-1 alpha-2 code such as DE, US, or GB (an alpha-3 code, numeric code, or English name is converted), or null for works with no country.',
      thrownBy: 'service',
    },
    {
      reason: 'mixed_and_or_in_filter_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter value puts "|" (OR) beside an AND operator — a "+", or a space on a field where words mean AND (on a country field a space is always part of a country name, and inside a language name it is part of the name). OpenAlex splits the value on "|" first and drops every alternative that ANDs more than one value, so no single value can carry both.',
      recovery:
        'Keep "|" and the AND operator in separate filter keys: OR the alternatives in this key and put the AND in a second key that reaches the same values — {"authorships.institutions.country_code": "DE|FR", "institutions.country_code": "US"} matches works with (DE or FR) and US. The filters object holds each key once, so where no second key fits, run one call per alternative instead.',
      thrownBy: 'service',
    },
    {
      reason: 'quote_in_filter_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter value sent to OpenAlex double-quoted holds a double quote inside its outer pair — a value the server quotes (a multi-word value on a field matched as whole text, or a value holding a comma on such a field or on a free-text search filter), or one the caller wrapped in double quotes on any filter but a free-text search.',
      recovery:
        'Remove the double quote from the value; a phrase is matched without quoting its own text.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_invalid_params',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected an invalid filter, select, or sort field name (HTTP 400).',
      recovery:
        'The upstream message names the rejected token and suggests close matches. Pass a valid OpenAlex work ID (W…), DOI, or PMID for seed_id, and browse the valid work fields with openalex_describe_fields("works", "filter") for filters or openalex_describe_fields("works", "select") for select.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_invalid_id_value',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An entity-ID filter received a value that is not an OpenAlex ID — usually a name (HTTP 400).',
      recovery:
        'Call openalex_resolve_name to turn the name into an OpenAlex ID, then filter by that ID. Entity filters such as authorships.author.id and primary_topic.id accept IDs only.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_sort_requires_search',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'sort=-relevance_score was used but the citation-graph query has no active search (HTTP 400).',
      recovery:
        'Sorting by relevance_score requires an active search, which a citation-graph walk lacks — choose a concrete sort field such as -cited_by_count or -publication_date, or add a `*.search` filter.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_invalid_params_other',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'OpenAlex rejected the request (HTTP 400) for a reason other than an invalid field name.',
      recovery:
        'Read the upstream message in the error above and adjust the request — check filter operators, value formats, and cursor/per_page bounds.',
      thrownBy: 'service',
    },
    {
      reason: 'reserved_filter_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filters contains cites/cited_by/related_to, or an alias of one such as cited_works — the direction parameter reserves those keys.',
      recovery:
        'Remove the reserved key from filters, or restate the relationship through direction.',
    },
    {
      reason: 'id_type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'seed_id is a native OpenAlex ID of another entity type — an author, source, institution, topic, publisher, funder, or concept ID rather than a work ID.',
      recovery:
        "seed_id must identify a work — pass the work's OpenAlex ID (W…), DOI, or PMID. To walk the works of an author or other entity, list them first with openalex_search_entities filters.",
      thrownBy: 'service',
    },
    {
      reason: 'id_dot_segment',
      code: JsonRpcErrorCode.ValidationError,
      when: 'seed_id holds a `.` or `..` path segment, written plainly or percent-encoded.',
      recovery:
        "Pass the work's identifier itself — its OpenAlex ID (W…), DOI, or PMID — with no relative path segments.",
      thrownBy: 'service',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'OpenAlex has no work matching the seed_id.',
      recovery:
        'Verify seed_id with openalex_resolve_name, or pass a known OpenAlex work ID (W…), DOI, or PMID. OpenAlex indexes no PMCIDs, so convert a PMCID to a PMID or DOI before passing it.',
    },
  ],
  inputAliases: { filter: 'filters' },
  input: z.object({
    seed_id: z
      .string()
      .min(1)
      .describe(
        'Seed work identifier. Accepts OpenAlex work ID ("W2741809807", or its OpenAlex record-page or API URL such as "https://openalex.org/works/W2741809807"), DOI ("10.1038/nature12373" or full URL), or PMID ("12345678" or "https://pubmed.ncbi.nlm.nih.gov/12345678"). A PMCID is recognized too, bare or as a PubMed Central URL, but OpenAlex indexes no PMCIDs, so it resolves nothing — pass the work\'s PMID or DOI instead. Use openalex_resolve_name first if you only have a title.',
      ),
    direction: z
      .enum(DIRECTIONS)
      .describe(
        '"cites": works that cite seed_id (incoming citations). "cited_by": works that seed_id cites (its reference list). "related_to": OpenAlex algorithmically-related works (~8-30 typical, may be empty for less-cited seeds).',
      ),
    filters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Additional filters to narrow the graph, same syntax as openalex_search_entities. Example: publication_year=">2020", is_oa="true". Country fields take ISO 3166-1 alpha-2 codes ("DE") and `language` takes ISO 639-1 codes ("en"); alpha-3, numeric, ISO 639-2, and English-name forms are converted — a multi-word name is one value, so "South Korea|Japan" ORs two countries — and a value that cannot be a country code is rejected. A multi-word value on a field matched as whole text (display_name, awards.funder_display_name, authorships.institutions.geo.city, raw_affiliation_strings) matches as one phrase ("National Science Foundation"; a comma, as in "University of California, Berkeley", is part of it, and it cannot contain a double quote of its own), "!" and "|" included, but cannot be ANDed with "+" in the same field. A value mixing "|" with an AND operator — a "+", or a space on a field where words mean AND — is rejected, since OpenAlex drops every "|" alternative that ANDs more than one value; put the AND in a second key instead. Do not include cites/cited_by/related_to, nor an alias of one such as cited_works — those keys are set by the `direction` parameter.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort field. Prefix with "-" for descending. Comma-separate for a multi-key sort, applied left to right, with the "-" prefix set per key ("-publication_year,cited_by_count" sorts by year descending, then citations ascending). Common: "cited_by_count", "-publication_date". Default is OpenAlex relevance.',
      ),
    select: z
      .array(z.string())
      .optional()
      .describe(
        'OpenAlex work field names to return. Always returned: id, display_name. Defaults to the curated works select if omitted. `author_list` returns each author in authorship order as `{id, display_name, orcid}` (`orcid` null when absent), a compact alternative to `authorships`, which also carries institutions and affiliations; neither the default nor `["*"]` includes it. Large projections may be cut to fit the response budget (`omitted`, `windows`).',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Results per page (1-100). Default 25. A budget-cut page returns fewer (`omitted`).',
      ),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Pagination cursor from a previous response. Pass to get the next page. Omit it on the first call — an empty string is rejected, since a supplied-but-blank cursor is a caller mistake rather than a request for the first page.',
      ),
  }),
  output: z.object({
    meta: z
      .object({
        count: z
          .number()
          .describe('Total edges from seed_id in this direction (across all pages).'),
        per_page: z
          .number()
          .describe(
            'Page size OpenAlex echoed for this request — the requested per_page, not the number of records returned. A short or exhausted page carries fewer records than this, as does a page the response budget cut (`omitted`).',
          ),
        next_cursor: z
          .string()
          .nullable()
          .describe(
            'Cursor for next page. null if no more results. Continues after the full upstream page, `omitted` works included.',
          ),
      })
      .describe('Result metadata including pagination.'),
    results: z
      .array(
        z
          .object({
            id: z.string().describe('OpenAlex work ID.'),
            display_name: z
              .string()
              .nullable()
              .describe(
                'Work title. null when OpenAlex holds no title for the record (paratext works and other untitled entries) — use `id` to identify it.',
              ),
          })
          .loose()
          .describe(
            'A single OpenAlex work record on the citation graph. Additional fields vary by `select`.',
          ),
      )
      .describe(
        'Works on the citation graph in this direction. Text values are plain text — HTML entities decoded, HTML/JATS/MathML markup removed — except identifier and URL fields such as `id`, `doi`, `ids`, and `*_url`, returned exactly as OpenAlex stores them; an abstract arrives reconstructed as `abstract`, and a selected `author_list` as one `{id, display_name, orcid}` entry per author. Works cut by the response budget are in `omitted`; partial or possibly capped arrays are in `windows`.',
      ),
    omitted: omittedOutputSchema,
    windows: windowsOutputSchema,
    over_budget: overBudgetOutputSchema,
  }),

  // Agent-facing context for the success path — the query as parsed (seed + direction),
  // the total edge count, and recovery guidance for empty traversals. Populated via
  // ctx.enrich(...) so it reaches structuredContent and content[] alike.
  enrichment: {
    echo: z
      .string()
      .describe(
        'Compact echo of seed_id, direction, filters, sort — surfaces what was actually queried when no edges are returned.',
      ),
    totalCount: z.number().describe('Total edges from seed_id in this direction across all pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance notice. Set when no edges are returned — a first call suggests verifying the seed_id, broadening filters, or trying a different direction; a `cursor` continuation says the walk is already past its last edge instead — when the response budget cut works, windowed an array, or ran over, and when a work carries exactly 100 authorships or author_list entries (possibly capped). Absent otherwise.',
      ),
    budget: z
      .object({
        costUsd: z
          .number()
          .describe(
            'USD this call spent, covering both upstream requests — the seed validation lookup and the graph page itself. The seed lookup is unbilled unless seed_id carries characters past the identifier itself (`W2741809807#x` still resolves to W2741809807), which OpenAlex bills like one list request.',
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
        'What this call cost against the OpenAlex daily budget and what is left of it. Price a full walk before committing to it: `totalCount` ÷ `per_page` × `costUsd` against `remainingUsd`. Absent when OpenAlex omitted the accounting headers.',
      ),
  },

  enrichmentTrailer: {
    echo: { label: 'Query' },
    totalCount: { label: 'Total Edges' },
    budget: { render: renderBudgetTrailer },
  },

  async handler(input, ctx) {
    /**
     * Reject a `filters` key that `direction` owns — merging it would silently overwrite one.
     * The check runs on the *translated* key, not the raw one: `cited_works` is an alias of
     * `cites`, so reading the caller's spelling alone let it past the guard and the collision
     * happened a layer down, where the direction won and the caller's filter disappeared.
     */
    const reserved = Object.keys(input.filters ?? {}).find((key) =>
      RESERVED_FILTER_KEYS.has(translateFilterKey('works', key)),
    );
    if (reserved !== undefined) {
      const upstreamKey = translateFilterKey('works', reserved);
      const resolution = upstreamKey === reserved ? '' : ` — it resolves to \`${upstreamKey}\``;
      throw ctx.fail(
        'reserved_filter_key',
        `${reserved} cannot be passed in filters${resolution}, and direction reserves cites/cited_by/related_to.`,
        { reservedKey: reserved, direction: input.direction },
      );
    }

    // A filter value the graph search would refuse fails here, before the seed lookup's request.
    if (input.filters) buildSearchFilter('works', input.filters);

    const service = getOpenAlexService();

    /**
     * Resolve any accepted seed identifier to a bare W-ID and confirm it exists. The graph
     * filters (`cites`/`cited_by`/`related_to`) themselves don't validate the seed — passing a
     * non-existent W-ID returns zero edges, indistinguishable from a valid seed with no citations
     * yet. A singleton `/works/{id}` lookup gates the query so bad seeds surface as NotFound
     * (a 404 bubbles from the service as `entity_not_found` too) and good seeds with empty graphs
     * return honest empty results.
     */
    const seedLookup = await service.search(
      { entityType: 'works', id: input.seed_id, select: ['id'] },
      ctx,
    );
    const seedRecord = seedLookup.results[0];
    if (!seedRecord?.id) {
      throw ctx.fail(
        'entity_not_found',
        `Could not resolve seed_id ${quoteCallerText(input.seed_id)} to an OpenAlex work ID.`,
        { seedId: input.seed_id },
      );
    }
    const workId = seedRecord.id.replace(OPENALEX_URL_PREFIX, '');

    const mergedFilters: Record<string, string> = {
      ...(input.filters ?? {}),
      [input.direction]: workId,
    };

    const result = await service.search(
      {
        entityType: 'works',
        filters: mergedFilters,
        sort: input.sort,
        select: input.select,
        perPage: input.per_page,
        cursor: input.cursor,
      },
      ctx,
    );

    ctx.log.info('Citation graph fetched', {
      seedId: input.seed_id,
      direction: input.direction,
      resultCount: result.results.length,
      totalCount: result.meta.count,
    });

    const echo = buildCitationEcho(input);
    ctx.enrich({ echo, totalCount: result.meta.count });
    // An empty page on a `cursor` continuation means the walk already returned every edge it
    // had, so the verify-the-seed advice would send the caller after a seed that is fine.
    const emptyNotice =
      result.results.length > 0
        ? undefined
        : input.cursor === undefined
          ? `No edges for ${echo}. Verify the seed_id with openalex_resolve_name, broaden filters, or try a different direction.`
          : `Pagination exhausted for ${echo} — the previous page held the last edge, so this one came back empty. Stop paging rather than broadening filters or changing direction.`;

    const meta = {
      count: result.meta.count,
      per_page: result.meta.per_page,
      next_cursor: result.meta.next_cursor,
    };
    const page = fitRecordsToBudget({
      records: result.results,
      entityType: 'works',
      path: 'list',
      select: input.select,
      measureFrame: (disclosure, budgetNotice) =>
        measurePageFrame({ meta, results: [], ...disclosure }, EDGE_NOUN, {
          echo,
          totalCount: result.meta.count,
          totalLabel: 'Total Edges',
          notice: joinNotices([emptyNotice, budgetNotice]),
        }),
    });

    const notice = joinNotices([emptyNotice, page.notice]);
    if (notice) ctx.enrich.notice(notice);

    return { meta, results: page.results, ...page.disclosure };
  },

  format: (result) => formatRecordPage(result, EDGE_NOUN),
});
