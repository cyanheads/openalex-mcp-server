/**
 * @fileoverview OpenAlex API client service. Handles all communication with the OpenAlex REST API.
 * @module services/openalex/openalex-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  conflict,
  forbidden,
  invalidParams,
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  fetchWithTimeout,
  httpStatusToErrorCode,
  logger,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';

import {
  ARXIV_SOURCE_ID,
  type ArxivId,
  arxivDoi,
  arxivLandingPageUrls,
  parseArxivId,
} from './arxiv-id.js';
import { mergeUpstreamBudget, parseUpstreamBudget, type UpstreamBudget } from './budget.js';
import fieldCatalog from './field-catalog.json' with { type: 'json' };
import { rankFields } from './field-ranker.js';
import { quoteCallerText, quotedCommaValue, upstreamFilterValue } from './filter-values.js';
import { isGroupableField } from './groupable-fields.js';
import { normalizeProviderText, normalizeProviderValue } from './provider-text.js';
import {
  type AnalyzeParams,
  type AnalyzeResult,
  type ArxivResolution,
  AUTOCOMPLETE_ENTITY_TYPES,
  type AutocompleteEntityType,
  type AutocompleteParams,
  type AutocompleteRecord,
  type AutocompleteResult,
  DEFAULT_SELECT,
  ENTITY_TYPES,
  type EntityRecord,
  type EntityType,
  type GroupRecord,
  type SearchParams,
  type SearchResult,
} from './types.js';
import { redactUrlsInMessage } from './url-redaction.js';

/**
 * True/false group_by fields whose names carry no `is_`/`has_` segment. OpenAlex names every
 * other boolean field that way, on every entity type.
 */
const UNPREFIXED_BOOLEAN_GROUP_BY_FIELDS: ReadonlySet<string> = new Set([
  'mag_only',
  'open_access.any_repository_has_fulltext',
]);

/**
 * Whether this aggregation keeps count order, ignoring the native unknown-bucket suffix: a
 * true/false field, which never has more than two groups and whose `cursor=*` OpenAlex answers
 * with HTTP 400 ("Cannot use cursor pagination when grouping fields that return true or false.").
 *
 * A field is boolean when any dotted segment starts with `is_` or `has_` — the segment, not the
 * leaf, so `has_content.pdf` counts — or when it is one of the unprefixed fields above. That
 * covered every groupable boolean on every entity type in a live sweep (2026-10-28), and no
 * groupable field it matches is anything but true/false. The service (whether to send `cursor`)
 * and `openalex_analyze_trends` (the echoed order and the key-order notice) both read this one
 * predicate, so they cannot disagree about a field.
 */
export function isBooleanGroupBy(groupBy: string): boolean {
  const suffix = ':include_unknown';
  const baseField = groupBy.endsWith(suffix) ? groupBy.slice(0, -suffix.length) : groupBy;
  return (
    UNPREFIXED_BOOLEAN_GROUP_BY_FIELDS.has(baseField) ||
    baseField.split('.').some((segment) => segment.startsWith('is_') || segment.startsWith('has_'))
  );
}

/** One upstream filter clause: the canonical key and the value it constrains. */
type FilterClause = [key: string, value: string];

/**
 * Build an OpenAlex filter string from ordered key-value clauses.
 * Input: [["cited_by_count", ">100"], ["is_oa", "true"]]
 * Output: "cited_by_count:>100,is_oa:true"
 *
 * Clauses, not a record: OpenAlex ANDs a repeated key (`publication_year:2020,publication_year:2024`
 * matches works in both years, which is nothing), and two caller filters can resolve to one
 * canonical key. A record would hold only the last of them.
 *
 * Comma handling (commas collide with OpenAlex's filter clause separator):
 * - Free-text search keys (`title.search`, `abstract.search.exact`, `semantic.search`, …) and
 *   keys matched as whole text (`raw_affiliation_strings`, `display_name`, `geo.city`, …): the
 *   value goes out double-quoted as `quotedCommaValue()` writes it, so the comma stays part of the
 *   phrase. The quoted value is sent as written, `+` included.
 * - All other keys: throw a pre-flight validation error — OpenAlex OR-lists use `|`, not commas.
 *
 * Every other value goes out as `upstreamFilterValue()` writes it: country and `language` values
 * converted to the codes OpenAlex stores (a country segment that cannot be a code throws
 * `invalid_country_code`), a multi-word value on a key matched as whole text (`geo.city`,
 * `awards.funder_display_name`, …) double-quoted so OpenAlex reads it as one phrase, and the AND
 * operator — a `+`, or a space on a key where words mean AND — sent as the AND it spells. A value
 * that puts that operator beside a `|` throws `mixed_and_or_in_filter_value`, since OpenAlex drops
 * every `|` alternative that ANDs more than one value; a value sent double-quoted that carries a
 * `"` of its own throws `quote_in_filter_value`. A value left unquoted with an unmatched `"`
 * throws `unmatched_quote_in_filter_value`. On a numeric key, `>=N`, `<=N`, and `a..b` go out as
 * OpenAlex's hyphen ranges, and a range it cannot read (a negative bound, a reversed range, a
 * negated comparison or open range) throws `invalid_range_in_filter_value`. Every throw runs
 * before any request.
 * `autocomplete()` sends its filters without `translateFilters()`, so the conversion lives here
 * rather than there.
 *
 * Exported for the timing suite, which runs it on caller-sized keys and values.
 */
export function buildFilterString(filters: FilterClause[]): string {
  return filters
    .map(([key, value]) => {
      if (value.includes(',')) {
        const phrase = quotedCommaValue(key, value);
        if (phrase !== undefined) return `${key}:${phrase}`;
        throw invalidParams(
          `Filter ${quoteCallerText(key)} value contains a comma, which OpenAlex reads as a filter separator. Use \`|\` for OR (e.g. \`2020|2021\`); a free-text search filter (such as \`title.search\` or \`abstract.search.exact\`) or a field matched as whole text (such as \`raw_affiliation_strings\` or \`display_name\`) takes a phrase that holds a comma.`,
          { reason: 'comma_in_filter_value', filterKey: key },
        );
      }
      return `${key}:${upstreamFilterValue(key, value)}`;
    })
    .join(',');
}

/**
 * A bare ROR: a leading `0`, six base32 characters, then two check digits.
 *
 * The leading zero is what separates this from a PMID — PMIDs are assigned sequentially and
 * never carry one, so no value matching this pattern is a reachable PMID. All-digit RORs are
 * ordinary (Baylor `005781934`, Istanbul Technical `059636586`), which is why the pattern
 * must not additionally require a letter to be present.
 */
const BARE_ROR_PATTERN = /^0[0-9a-hj-km-np-tv-z]{6}\d{2}$/;

/**
 * A PubMed article URL. OpenAlex does not accept the bare URL as a work ID, but the numeric
 * article path is a PMID, so the URL carries exactly the same meaning as the bare form. The
 * host is anchored on both ends so a look-alike domain can never be read as PubMed.
 */
const PUBMED_URL_PATTERN = /^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?$/i;

/**
 * A PubMed Central article URL — the current `pmc.ncbi.nlm.nih.gov/articles/…` host and the
 * legacy `ncbi.nlm.nih.gov/pmc/articles/…` path alike. The article segment is a PMCID, so the
 * URL carries exactly the same meaning as the bare form; normalizing it is what makes the URL
 * resolve as the bare form does instead of being forwarded verbatim as a work ID. As with PubMed,
 * the host is anchored on both ends so a look-alike domain can never be read as PubMed Central.
 */
const PMC_URL_PATTERN =
  /^https?:\/\/(?:www\.)?(?:pmc\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(PMC\d+)\/?$/i;

/**
 * The start of an OpenAlex URL — `openalex.org`, `www.openalex.org`, or `api.openalex.org`, with
 * an `http(s)://` scheme or none — gating the `URL` parse in `parseOpenAlexUrl()`. The lookahead
 * anchors the host on the right, so a look-alike that only starts with it (`openalex.org.example`,
 * `openalex.org:8443`) is never parsed, and the scheme anchors it on the left.
 */
const OPENALEX_URL_START = /^(?:https?:\/\/)?(?:www\.|api\.)?openalex\.org(?=[/?#]|$)/i;

/** A native OpenAlex ID — one letter, then digits (`W2741809807`, the legacy venue `V137773608`). */
const NATIVE_ID_PATTERN = /^[a-z]\d+$/i;

/** What an OpenAlex URL addresses: a native ID, or a keyword by its slug. */
interface OpenAlexUrlId {
  id: string;
  kind: 'native' | 'keyword';
}

/**
 * Read the one ID an OpenAlex URL carries — a record page (`https://openalex.org/works/W…`), an
 * API URL (`https://api.openalex.org/works/W…`), the short form (`https://openalex.org/W…`), or
 * a keyword's `…/keywords/<slug>` — over `http://`, `https://`, or no scheme, ignoring a trailing
 * `/`, the query string, and the fragment. The path must be `/<ID>` or `/<entity type>/<ID>`, a
 * slug under `/keywords/`; anything else returns undefined and is left as the caller wrote it.
 *
 * Keywords are the one entity type OpenAlex addresses by slug, so their URL is the only spelling
 * that identifies a keyword — and the entity-type segment has to go either way, since the request
 * path supplies it again. A native ID's letter is upper-cased: OpenAlex IDs are upper-case, and
 * the URL already says the value is one. A value with whitespace inside is refused before the
 * parse, which would otherwise drop tabs and line breaks and join the pieces into an ID.
 */
function parseOpenAlexUrl(value: string): OpenAlexUrlId | undefined {
  if (!OPENALEX_URL_START.test(value) || /\s/.test(value)) return;
  const { pathname } = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const [first = '', second, ...rest] = path.split('/').slice(1);
  if (rest.length > 0) return;
  if (second === undefined) {
    return NATIVE_ID_PATTERN.test(first) ? nativeId(first) : undefined;
  }
  const entityType = first.toLowerCase();
  if (!isEntityType(entityType)) return;
  if (entityType === 'keywords') return second ? { id: second, kind: 'keyword' } : undefined;
  return NATIVE_ID_PATTERN.test(second) ? nativeId(second) : undefined;
}

function nativeId(id: string): OpenAlexUrlId {
  return { id: `${id.charAt(0).toUpperCase()}${id.slice(1)}`, kind: 'native' };
}

function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Prefix `normalizeId()` emits → the entity types an identifier of that scheme can address, in
 * the order `inferIdentifier()` looks them up. Most schemes belong to one type. A ROR names an
 * organization, and OpenAlex keeps an organization's institution, funder, and publisher records
 * apart under the same ROR — NSF's `021nxhr62` is all three — so a ROR can address any of them.
 */
const ENTITY_TYPES_BY_ID_PREFIX: Record<string, readonly EntityType[]> = {
  doi: ['works'],
  issn: ['sources'],
  orcid: ['authors'],
  pmcid: ['works'],
  pmid: ['works'],
  ror: ['institutions', 'funders', 'publishers'],
};

/**
 * The Crossref Funder Registry's DOI prefix. Funders are keyed by these DOIs, which OpenAlex's
 * `/funders/doi:` path does not resolve — only the `ids.doi` filter matches them, with the bare
 * DOI. A few thousand works carry one too, by mis-attribution, so a funder DOI still reaches a
 * work when the caller asks for works.
 */
const FUNDER_REGISTRY_DOI_PREFIX = '10.13039/';

/**
 * A DOI the funder `ids.doi` filter can match as one literal value: a DOI shape with nothing in
 * it that filter syntax reads as structure — `|` (OR), `+` (AND), `,` (clause separator), or
 * whitespace. A leading `!`, `<`, or `>` fails the `10.` anchor.
 */
const FUNDER_DOI_FILTER_VALUE = /^10\.\d{4,}\/[^\s,|+]+$/;

/**
 * The filter clause that matches a funder by its bare DOI, or undefined for a value that clause
 * would read as more than one literal DOI — it could only match some other funder, or every one.
 */
export function funderDoiFilter(doi: string): string | undefined {
  return FUNDER_DOI_FILTER_VALUE.test(doi) ? `ids.doi:${doi}` : undefined;
}

/**
 * Detect ID format and return the API path segment.
 * "10.1038/nature12373" → "doi:10.1038/nature12373"
 * "https://doi.org/10.1038/nature12373" → "doi:10.1038/nature12373"
 * "0000-0002-1825-0097" → "orcid:0000-0002-1825-0097"
 * "https://orcid.org/0000-0002-1825-0097" → "orcid:https://orcid.org/0000-0002-1825-0097"
 * "https://ror.org/00hx57361" → "ror:https://ror.org/00hx57361"
 * "013meh722" → "ror:013meh722"
 * "PMC1234567" → "pmcid:PMC1234567"
 * "https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/" → "pmcid:PMC1234567"
 * "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/" → "pmcid:PMC1234567"
 * "https://pubmed.ncbi.nlm.nih.gov/21491125" → "pmid:21491125"
 * "PMID:21491125" → "pmid:21491125"
 * "https://openalex.org/works/W2741809807" → "W2741809807"
 * "https://api.openalex.org/keywords/groundwater" → "groundwater"
 * "W2741809807" → "W2741809807"
 */
export function normalizeId(id: string): string {
  const trimmed = id.trim();

  // OpenAlex URL → the bare ID or keyword slug it carries (see parseOpenAlexUrl)
  const openAlexId = parseOpenAlexUrl(trimmed);
  if (openAlexId) {
    return openAlexId.id;
  }

  // DOI URL
  if (trimmed.startsWith('https://doi.org/')) {
    return `doi:${trimmed.replace('https://doi.org/', '')}`;
  }

  // DOI pattern (10.xxxx/...)
  if (/^10\.\d{4,}\//.test(trimmed)) {
    return `doi:${trimmed}`;
  }

  // ORCID URL — upstream accepts the URL after the scheme prefix, as it does for ROR
  if (trimmed.startsWith('https://orcid.org/')) {
    return `orcid:${trimmed}`;
  }

  // ROR URL
  if (trimmed.startsWith('https://ror.org/')) {
    return `ror:${trimmed}`;
  }

  // Bare ROR — see BARE_ROR_PATTERN for why the leading zero settles the PMID overlap
  if (BARE_ROR_PATTERN.test(trimmed)) {
    return `ror:${trimmed}`;
  }

  // ORCID pattern (0000-0000-0000-0000)
  if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(trimmed)) {
    return `orcid:${trimmed}`;
  }

  // ISSN pattern (0000-0000)
  if (/^\d{4}-\d{3}[\dX]$/i.test(trimmed)) {
    return `issn:${trimmed}`;
  }

  // PMCID
  if (/^PMC\d+$/i.test(trimmed)) {
    return `pmcid:${trimmed}`;
  }

  // Pure numeric → PMID
  if (/^\d{5,}$/.test(trimmed)) {
    return `pmid:${trimmed}`;
  }

  // PubMed URL → the bare PMID form, matching the pure-numeric branch above. Runs after every
  // shape-matching branch so it can never shadow the bare ROR/PMID disambiguation.
  const pubmedPmid = PUBMED_URL_PATTERN.exec(trimmed)?.[1];
  if (pubmedPmid) {
    return `pmid:${pubmedPmid}`;
  }

  // PubMed Central URL → the bare PMCID form, matching the `PMC\d+` branch above. Placed with
  // the PubMed URL branch, after the shape-matching ones, for the same reason.
  const pmcId = PMC_URL_PATTERN.exec(trimmed)?.[1];
  if (pmcId) {
    return `pmcid:${pmcId}`;
  }

  // Already prefixed — OpenAlex's bare external-ID schemes are case-sensitive, so a caller's
  // `PMID:`/`DOI:` spelling 404s. Fold a recognized scheme to lower case and leave the value
  // exactly as given: DOIs and ORCIDs carry meaningful casing that is the caller's to set.
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const scheme = trimmed.slice(0, colon).toLowerCase();
    if (Object.hasOwn(ENTITY_TYPES_BY_ID_PREFIX, scheme)) {
      return `${scheme}${trimmed.slice(colon)}`;
    }
  }

  // OpenAlex ID or an unrecognized prefix — pass through
  return trimmed;
}

/** Native OpenAlex ID letter → entity type. */
const ENTITY_TYPE_BY_ID_LETTER: Record<string, EntityType> = {
  A: 'authors',
  F: 'funders',
  G: 'awards',
  I: 'institutions',
  P: 'publishers',
  S: 'sources',
  T: 'topics',
  W: 'works',
};

/**
 * Native OpenAlex IDs this server can route. Two letters `OPENALEX_ID_VALUE_PATTERN` accepts as
 * *filter values* are deliberately absent here. `C` (the deprecated Concepts entity) is not in
 * `ENTITY_TYPES`, so there is no endpoint to fetch one from. `K` is in `ENTITY_TYPES`, but
 * OpenAlex identifies keywords by slug and emits no numeric K-prefixed IDs, so routing that shape
 * addressed nothing — a keyword URL is the keyword identifier. Both fall through to autocomplete
 * rather than being routed to a path that would 404.
 */
const ROUTABLE_OPENALEX_ID = /^([AFGIPSTW])\d+$/;

/**
 * A native ID whose letter names the entity type that holds it — every routable letter plus `C`,
 * a concept ID, which names a type this server does not serve. Read case-insensitively: OpenAlex
 * answers a lower-case ID as it does the upper-case one. `V` (a legacy venue ID that still
 * resolves under `/sources/`) and `K` are absent, so `search()` checks neither.
 */
const LETTERED_OPENALEX_ID = /^([ACFGIPSTW])\d+$/i;

/**
 * Refuse a native ID whose letter names a different entity type than the lookup's. No record of
 * one type carries another type's letter and every cross-letter lookup 404s upstream, so the
 * request could only fail as a generic not-found; this names the type the ID belongs to instead.
 *
 * Keywords are exempt: their IDs are slugs, and real ones are shaped like native IDs (`P53`,
 * `F1`, `S1`, `A1`), so on a keyword lookup a letter names nothing.
 */
function assertIdMatchesEntityType(id: string, entityType: EntityType): void {
  const letter = entityType === 'keywords' ? undefined : LETTERED_OPENALEX_ID.exec(id)?.[1];
  if (letter === undefined) return;
  const idType = ENTITY_TYPE_BY_ID_LETTER[letter.toUpperCase()];
  if (idType === entityType) return;
  const requested = `it identifies no record among ${entityType}`;
  const shown = capIdEcho(id);
  throw validationError(
    idType
      ? `${shown} is an OpenAlex ${idType.replace(/s$/, '')} ID, which entity_type "${idType}" looks up — ${requested}.`
      : `${shown} is an OpenAlex concept ID — concepts are a deprecated OpenAlex entity type this server does not serve, so ${requested}.`,
    { reason: 'id_type_mismatch', id, entityType, ...(idType ? { idEntityType: idType } : {}) },
  );
}

/**
 * Characters a URL parse reads as structure rather than as part of a by-ID path's ID: `?` and
 * `#` end the path, `\` separates segments on an `https:` URL, and tab, line feed, and carriage
 * return are dropped outright, joining what they separated.
 */
const ID_PATH_STRUCTURE = /[?#\\\t\n\r]/g;

/** A `.` or `..` path segment in any spelling a URL parse resolves — `%2e` is a dot. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/** The most of a refused `id` an error message quotes; `data.id` keeps it whole. */
const ID_ECHO_MAX_CHARS = 200;

/** A refused `id` cut to `ID_ECHO_MAX_CHARS`, so a caller-sized one cannot bloat the message. */
function capIdEcho(id: string): string {
  return id.length > ID_ECHO_MAX_CHARS ? `${id.slice(0, ID_ECHO_MAX_CHARS)}…` : id;
}

/**
 * The by-ID request path for `id`: `/<entityType>/<id>`, with every character a URL parse would
 * read as structure percent-encoded so it stays part of the ID. OpenAlex decodes them back, so a
 * DOI that holds a `#` or `?` reaches the record it names instead of a truncated one.
 *
 * A `.` or `..` segment, plain or percent-encoded, is refused before any request, since encoding
 * cannot keep it inside the path. `/` is left as written, since DOIs carry it, and an encoded
 * `%2F` is one segment to both the parse and OpenAlex. The refusal quotes `callerId`, the
 * identifier as the caller wrote it, rather than the normalized `id` (`doi:…` for a DOI URL).
 */
export function byIdPath(entityType: EntityType, id: string, callerId = id): string {
  const encoded = id.replace(ID_PATH_STRUCTURE, encodeURIComponent);
  const dots = encoded.split('/').find((segment) => DOT_SEGMENT.test(segment));
  if (dots !== undefined) {
    throw validationError(
      `id ${JSON.stringify(capIdEcho(callerId))} holds a "${dots}" path segment, which a ${entityType} lookup by ID does not accept.`,
      { reason: 'id_dot_segment', id: callerId, entityType },
    );
  }
  return `/${entityType}/${encoded}`;
}

/** An identifier the deterministic by-ID path can resolve, with the scheme it was read as. */
export interface ResolvedIdentifier {
  /** The entity types to look the identifier up as, in the order their records are returned. */
  entityTypes: readonly EntityType[];
  /** The value in the form the OpenAlex path segment expects (`doi:10.1038/…`, `W2741809807`). */
  id: string;
  /**
   * Set on a bare native-ID shape, which short names share — keyword `p53` reads as publisher
   * `P53`, and `F1`, `S1`, and `A1` are keywords too — so a lookup that finds no record is no
   * sign the caller meant an ID, and the query is worth searching as a name next. A URL form
   * names its record outright and never carries it.
   */
  mayBeName?: true;
  /** Identifier scheme, for caller-facing messages: `doi`, `orcid`, `openalex`, … */
  scheme: string;
}

/** What `resolveIdentifier()` found. */
export interface IdentifierResolution extends AutocompleteResult {
  /** Set when an arXiv ID resolved to its work: how the lookup reached it. */
  arxiv?: ArxivResolution;
  /**
   * Set when an arXiv ID matched no work for more than the plain miss of both lookups: the works
   * its landing page matched (`candidates`), or the upstream failure that stopped that lookup.
   */
  arxivMiss?: { candidates: string[] } | { fallbackFailedReason: string };
  /** Entity types whose lookup failed upstream while another type returned a record. */
  failedEntityTypes?: EntityType[];
  /**
   * Set when every lookup found nothing and the query ran as a name search instead: `results`
   * then hold that search's matches. `failedReason` names the upstream failure that stopped the
   * search, with `results` empty.
   */
  nameFallback?: { failedReason?: string };
}

/**
 * Classify a query as an identifier, or return `undefined` for a name.
 *
 * `normalizeId()` already knows every shape the by-ID lookup accepts, bare and URL-form alike,
 * and stamps external ones with their scheme prefix — so detection reduces to reading back what
 * it produced. Names never survive that: a name with a colon in it yields a prefix that is in no
 * scheme table, and anything else fails the native-ID pattern.
 *
 * Keywords are the exception, and are read from the URL before it is reduced: their IDs are
 * slugs, so `normalizeId()` turns the URL into a bare word that no longer names an entity type.
 * The URL form is the only keyword spelling that identifies itself — a bare slug is
 * indistinguishable from any other name, and autocomplete is the right answer for it.
 *
 * `requested` (the caller's `entity_type`) narrows an identifier only among the types it can
 * address: a ROR to one of institutions, funders, and publishers, and a Funder Registry DOI to
 * works. Any other type leaves the identifier's own types in place — except `keywords`, under
 * which a bare native-ID shape is a name: keyword IDs are slugs, and `P53` is a keyword.
 *
 * An arXiv ID in any form `parseArxivId()` reads — its 10.48550 DOI included — is scheme `arxiv`,
 * a work under every `requested` type. It is read before `normalizeId()`, which would take the DOI
 * form for a plain DOI; the works lookup reads the arXiv forms itself (see `search()`).
 */
export function inferIdentifier(
  query: string,
  requested?: AutocompleteEntityType,
): ResolvedIdentifier | undefined {
  const trimmed = query.trim();
  const fromUrl = parseOpenAlexUrl(trimmed);
  if (fromUrl?.kind === 'keyword') {
    return { entityTypes: ['keywords'], id: fromUrl.id, scheme: 'openalex' };
  }
  if (fromUrl) return nativeIdentifier(fromUrl.id);

  const arxiv = parseArxivId(trimmed);
  if (arxiv) return { entityTypes: ['works'], id: `doi:${arxivDoi(arxiv.id)}`, scheme: 'arxiv' };

  const normalized = normalizeId(trimmed);

  const colon = normalized.indexOf(':');
  if (colon > 0) {
    const scheme = normalized.slice(0, colon).toLowerCase();
    const types = ownEntry(ENTITY_TYPES_BY_ID_PREFIX, scheme);
    if (!types) return;
    if (scheme === 'doi' && normalized.startsWith(FUNDER_REGISTRY_DOI_PREFIX, colon + 1)) {
      return { entityTypes: [requested === 'works' ? 'works' : 'funders'], id: normalized, scheme };
    }
    const entityTypes = requested !== undefined && types.includes(requested) ? [requested] : types;
    return { entityTypes, id: normalized, scheme };
  }

  if (requested === 'keywords') return;
  const native = nativeIdentifier(normalized);
  return native && { ...native, mayBeName: true };
}

/** A routable native OpenAlex ID as the identifier it is, or undefined for any other value. */
function nativeIdentifier(id: string): ResolvedIdentifier | undefined {
  const letter = ROUTABLE_OPENALEX_ID.exec(id)?.[1];
  const entityType = letter ? ENTITY_TYPE_BY_ID_LETTER[letter] : undefined;
  return entityType ? { entityTypes: [entityType], id, scheme: 'openalex' } : undefined;
}

/**
 * Reconstruct abstract text from OpenAlex's inverted index format.
 * The API stores abstracts as { word: [position, ...] } — we reverse this to plaintext.
 * Inverted indices are ~2x the token cost of plaintext for the same information, so
 * we collapse them when present and drop the raw index to keep responses lean.
 */
function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasAbstractInvertedIndex(
  record: EntityRecord,
): record is EntityRecord & { abstract_inverted_index: Record<string, number[]> } {
  return isRecord(record.abstract_inverted_index);
}

/**
 * Normalize provider text on one record, once, at the service boundary — both response surfaces
 * read the result, and nothing downstream normalizes again.
 */
function normalizeEntityRecord(record: EntityRecord): EntityRecord {
  if (!hasAbstractInvertedIndex(record)) return normalizeProviderValue(record);

  const { abstract_inverted_index, ...rest } = record;
  // Normalize the reconstructed abstract, not the index — `normalizeProviderValue` only walks
  // values, so entities and markup living in inverted-index word keys (`"&amp;"`, `"<!--"`)
  // would otherwise survive, and a tag split across words only exists once they are joined.
  return {
    ...normalizeProviderValue(rest),
    abstract: normalizeProviderText(reconstructAbstract(abstract_inverted_index)),
  };
}

/** A string field of `value`, or null when it is absent or not a string. */
function stringOrNull(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

/** One `author_list` entry: the authorship's author as `{id, display_name, orcid}`. */
function authorListEntry(authorship: unknown): Record<string, string | null> {
  const author = isRecord(authorship) && isRecord(authorship.author) ? authorship.author : {};
  return {
    id: stringOrNull(author, 'id'),
    display_name: stringOrNull(author, 'display_name'),
    orcid: stringOrNull(author, 'orcid'),
  };
}

/**
 * What a works request's `select` asks the server to derive from `authorships`: `author_list`,
 * and whether `authorships` itself was asked for too (by name, by its `authors` alias, by a
 * dotted `authorships.*` name, or by `*`) and so stays on the record. Read from the split names,
 * so `author_list` inside a comma-joined entry counts.
 */
interface AuthorListShape {
  keepAuthorships: boolean;
}

function authorListShape(
  entityType: SearchParams['entityType'],
  select: readonly string[] | undefined,
): AuthorListShape | undefined {
  if (entityType !== 'works' || !select) return;
  const names = selectNames(select);
  if (!names.includes(AUTHOR_LIST_FIELD)) return;
  return {
    keepAuthorships: names.some(
      (name) =>
        name === '*' ||
        (name !== AUTHOR_LIST_FIELD && translateSelectField('works', name) === 'authorships'),
    ),
  };
}

/**
 * Add `author_list` to a normalized works record, derived from its `authorships`, and drop
 * `authorships` unless the caller selected it too. A record OpenAlex returned without
 * `authorships` gets no `author_list` — there is nothing to derive it from.
 */
function withAuthorList(record: EntityRecord, shape: AuthorListShape): EntityRecord {
  const { authorships, ...rest } = record;
  if (!Array.isArray(authorships)) return record;
  return {
    ...(shape.keepAuthorships ? record : rest),
    [AUTHOR_LIST_FIELD]: authorships.map(authorListEntry),
  };
}

function normalizeEntityRecords(
  results: EntityRecord[],
  authorList?: AuthorListShape,
): EntityRecord[] {
  return results.map((record) => {
    const normalized = normalizeEntityRecord(record);
    return authorList ? withAuthorList(normalized, authorList) : normalized;
  });
}

function normalizeAutocompleteRecords(
  results: AutocompleteResult['results'],
): AutocompleteResult['results'] {
  return results.map((r) => normalizeProviderValue(r));
}

/**
 * Keys OpenAlex gives the missing-value bucket `:include_unknown` adds: `-111`/`-111.0` on
 * numeric fields in count order, `unknown` on string fields and under key-ascending traversal,
 * and `https://openalex.org/<type>/unknown` on ID fields.
 */
function isUnknownGroupKey(key: string): boolean {
  return key === '-111' || key === '-111.0' || key === 'unknown' || key.endsWith('/unknown');
}

/**
 * Normalize one aggregation group. `key` stays byte-identical to upstream — it is what a caller
 * matches and filters on — while the label is provider text. The unknown bucket is flagged only
 * when it was requested, since no other page can carry one.
 */
function normalizeGroup(group: GroupRecord, includeUnknown: boolean): GroupRecord {
  return {
    key: group.key,
    key_display_name: normalizeProviderValue(group.key_display_name),
    count: group.count,
    ...(includeUnknown && isUnknownGroupKey(group.key) ? { is_unknown: true as const } : {}),
  };
}

/** Entity type → the record field holding its canonical external identifier. */
const EXTERNAL_ID_FIELD: Partial<Record<EntityType, string>> = {
  authors: 'orcid',
  institutions: 'ror',
  sources: 'issn_l',
  works: 'doi',
};

function stringField(record: EntityRecord, field: string | undefined): string | null {
  const value = field === undefined ? undefined : record[field];
  return typeof value === 'string' ? value : null;
}

function numberField(record: EntityRecord, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' ? value : null;
}

/**
 * Autocomplete ships a one-line disambiguation hint that a singleton entity record has no field
 * for. Rebuild the closest equivalent from the curated default projection the lookup already
 * returns, so no extra field has to be requested. Types whose default projection carries nothing
 * comparable get `null` rather than a filler string — and losing the hint costs little here,
 * since an exact identifier leaves nothing to disambiguate.
 */
function deriveHint(entityType: EntityType, record: EntityRecord): string | null {
  switch (entityType) {
    case 'authors': {
      const institutions = record.last_known_institutions;
      const first = Array.isArray(institutions) ? institutions[0] : undefined;
      return isRecord(first) && typeof first.display_name === 'string' ? first.display_name : null;
    }
    case 'institutions':
      return stringField(record, 'country_code');
    case 'sources':
      return stringField(record, 'host_organization_name');
    case 'works': {
      const year = numberField(record, 'publication_year');
      return year === null ? null : String(year);
    }
    default:
      return null;
  }
}

/**
 * Shape a singleton entity record like an autocomplete match, so both resolution paths of
 * `openalex_resolve_name` return one result type. `entity_type` is singularized to match what
 * the autocomplete endpoint emits (`work`, not `works`), and `works_count` stays null on works —
 * a work has no works of its own, which is the same thing autocomplete reports.
 */
export function toAutocompleteRecord(
  entityType: EntityType,
  record: EntityRecord,
): AutocompleteRecord {
  return {
    cited_by_count: numberField(record, 'cited_by_count') ?? 0,
    display_name: record.display_name,
    entity_type: entityType.replace(/s$/, ''),
    external_id: stringField(record, EXTERNAL_ID_FIELD[entityType]),
    hint: deriveHint(entityType, record),
    id: record.id,
    works_count: numberField(record, 'works_count'),
  };
}

/**
 * Fields the output schema declares as required on every result item. Always prepended
 * to caller-supplied `select` so the upstream projection can't drop them and break
 * output validation downstream of a successful API call.
 */
const REQUIRED_SEARCH_FIELDS = ['id', 'display_name'] as const;

/**
 * The works `select` field the server derives rather than projects: each authorship's author as
 * `{id, display_name, orcid}`, from the `authorships` it requests in its place. Not an upstream
 * field, so it is never forwarded, and neither the default projection nor `*` includes it.
 */
export const AUTHOR_LIST_FIELD = 'author_list';

/**
 * Works-only `select` field aliases. LLM callers reach for intuitive names that don't match
 * OpenAlex's vocabulary; renaming on the way out keeps tool ergonomics aligned with caller
 * priors. Canonical names pass through unchanged. Two names arrive under another key:
 * `abstract`, reconstructed from `abstract_inverted_index`, and `author_list`, reduced from
 * `authorships` — every other alias is a pure key rename.
 */
const SELECT_ALIASES_WORKS: Record<string, string> = {
  abstract: 'abstract_inverted_index',
  [AUTHOR_LIST_FIELD]: 'authorships',
  authors: 'authorships',
  year: 'publication_year',
};

/**
 * Bibliometric leaves that live under `summary_stats` upstream. `select` projects top-level
 * fields only — OpenAlex rejects the bare leaf name — so a caller asking for `h_index` gets a
 * 400 listing 21 field names, none of which resemble what they asked for. Widening the leaf to
 * its parent makes the first call succeed and returns the requested metric inside the object it
 * actually lives in.
 */
const SELECT_ALIASES_SUMMARY_STATS: Record<string, string> = {
  '2yr_mean_citedness': 'summary_stats',
  h_index: 'summary_stats',
  i10_index: 'summary_stats',
};

/**
 * Sources-only `select` rename: OpenAlex names a journal's publisher `host_organization_name` —
 * for a repository it names the hosting institution — and token-overlap suggestions cannot reach
 * it from `publisher`. Select only: the filter, sort, and group_by sides have no single target
 * (`host_organization` and `host_organization_lineage` both read as "publisher"), so `publisher`
 * there keeps its 400.
 */
const SELECT_ALIASES_SOURCES: Record<string, string> = {
  publisher: 'host_organization_name',
};

/**
 * Works `select` leaves that live under `open_access` upstream. OpenAlex rejects each bare name
 * (`is_oa is not a valid select field. Did you mean: is_xpac, …`) with no suggestion pointing at
 * the parent, though its filter side takes `is_oa` and `oa_status` as aliases of their
 * `open_access.` forms. Works only: sources project `is_oa` as a top-level field of their own,
 * and the other OA leaves elsewhere have several possible parents or none.
 */
const SELECT_ALIASES_OPEN_ACCESS: Record<string, string> = {
  any_repository_has_fulltext: 'open_access',
  is_oa: 'open_access',
  oa_status: 'open_access',
  oa_url: 'open_access',
};

/**
 * Works-only `filter` key aliases. Same shape as `SELECT_ALIASES_WORKS` — LLM callers reach
 * for `cited_works` (the semantic phrasing) and `year` (universal in REST), neither of which
 * upstream accepts. Renames are fail-open: misses pass through to upstream and surface its
 * helpful 400 with the valid-field list.
 */
const FILTER_ALIASES_WORKS: Record<string, string> = {
  cited_works: 'cites',
  year: 'publication_year',
};

/** Per entity type, the `select` names that are another field's own name: renames. */
const SELECT_RENAMES: Partial<Record<EntityType, Record<string, string>>> = {
  works: SELECT_ALIASES_WORKS,
  sources: SELECT_ALIASES_SOURCES,
};

/**
 * Per entity type, the leaf names `select` answers with the top-level object holding them.
 * `summary_stats` exists on authors, sources, institutions, publishers, and funders, verified
 * against `api.openalex.org`; works, topics, keywords, and awards carry no such field and reject
 * it in `select`, so a bibliometric leaf there keeps its upstream 400.
 */
const SELECT_LEAF_PARENTS: Partial<Record<EntityType, Record<string, string>>> = {
  works: SELECT_ALIASES_OPEN_ACCESS,
  authors: SELECT_ALIASES_SUMMARY_STATS,
  sources: SELECT_ALIASES_SUMMARY_STATS,
  institutions: SELECT_ALIASES_SUMMARY_STATS,
  publishers: SELECT_ALIASES_SUMMARY_STATS,
  funders: SELECT_ALIASES_SUMMARY_STATS,
};

/**
 * Each entity type's top-level `select` fields as OpenAlex lists them (`field-catalog.json`). A
 * dotted name opening with one of them is answered with that field: `select` projects top-level
 * fields only, and OpenAlex rejects every dotted path.
 */
const TOP_LEVEL_SELECT_FIELDS: ReadonlyMap<EntityType, ReadonlySet<string>> = new Map(
  ENTITY_TYPES.map((entityType) => [
    entityType,
    new Set((fieldCatalog as FieldCatalog)[entityType].select),
  ]),
);

/** The upstream field one `select` name projects, and whether it holds the name (a widening). */
interface SelectProjection {
  field: string;
  widened: boolean;
}

/**
 * Project one caller `select` name. A rename is the same field under another name (`year` →
 * `publication_year`, `publisher` → `host_organization_name`, `authors` and `author_list` →
 * `authorships`). A widening answers a nested name with the top-level object holding it:
 * `h_index` → `summary_stats`, works `is_oa` → `open_access`, and a dotted name whose first
 * segment is a top-level select field of the entity type (`primary_location.source.display_name`
 * → `primary_location`). Any other name passes through, so upstream's 400 names it — a dotted
 * name opening with no select field (`foo.bar`, works `summary_stats.h_index`) included.
 */
function projectSelectName(entityType: SearchParams['entityType'], name: string): SelectProjection {
  const renamed = ownEntry(SELECT_RENAMES[entityType], name);
  if (renamed !== undefined) return { field: renamed, widened: false };
  const dot = name.indexOf('.');
  const head = dot > 0 ? name.slice(0, dot) : undefined;
  const parent =
    ownEntry(SELECT_LEAF_PARENTS[entityType], name) ??
    (head !== undefined && TOP_LEVEL_SELECT_FIELDS.get(entityType)?.has(head) ? head : undefined);
  return parent === undefined ? { field: name, widened: false } : { field: parent, widened: true };
}

/**
 * The names one caller `select` entry holds. An entry holding a comma is OpenAlex's own
 * comma-joined `select=` syntax: split on the commas, each piece trimmed, the empty ones dropped
 * (OpenAlex itself accepts `id,doi,,title` and `id, doi`). Any other entry is one name, as sent,
 * so every entry that worked unsplit sends the same request.
 */
export function splitSelectEntry(entry: string): string[] {
  if (!entry.includes(',')) return [entry];
  return entry
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Every name a caller's `select` holds, comma-joined entries split. */
function selectNames(select: readonly string[]): string[] {
  return select.flatMap(splitSelectEntry);
}

/**
 * Translate caller-friendly names in `select` to the upstream OpenAlex fields and guarantee the
 * schema-required fields (`id`, `display_name`) are always projected. `abstract` is
 * reconstructed from `abstract_inverted_index` in the response — the API itself only accepts
 * the latter — so we accept either on input and forward the upstream name. Keeps tool
 * ergonomics symmetric with the response shape.
 *
 * Translation is fail-open: an unmapped name passes through and surfaces upstream's 400 with
 * its valid-field list. Several names can share one upstream field (summary_stats leaves;
 * `author_list` beside `authorships`; `is_oa` beside `open_access`), so the list is deduped after
 * translation rather than before.
 */
function translateSelect(entityType: SearchParams['entityType'], names: string[]): string[] {
  const upstream = [...REQUIRED_SEARCH_FIELDS, ...names].map((name) =>
    translateSelectField(entityType, name),
  );
  return Array.from(new Set(upstream));
}

/** The upstream field one caller `select` name projects to (see `projectSelectName`). */
function translateSelectField(entityType: SearchParams['entityType'], field: string): string {
  return projectSelectName(entityType, field).field;
}

/** A comma-joined `select` entry and the names it split into. */
export interface SelectSplit {
  entry: string;
  names: string[];
}

/** A nested `select` name and the top-level field returned for it. */
export interface SelectWidening {
  field: string;
  name: string;
}

/** What the projection made of a caller's `select` beyond renames. */
export interface SelectReport {
  splits: SelectSplit[];
  widenings: SelectWidening[];
}

/**
 * Report what the projection made of a caller's `select` beyond renames, for the notices that
 * disclose it: each comma-joined entry and the names it split into, and each nested name
 * answered with the top-level field holding it. Mirrors `resolveSelect`: an omitted or empty
 * `select` takes the curated default, which names no nested field, and `*` projects nothing, so
 * it widens nothing. Renames stay unreported — the caller gets the field it named.
 */
export function reportSelect(
  entityType: SearchParams['entityType'],
  select: readonly string[] | undefined,
): SelectReport {
  if (!select?.length) return { splits: [], widenings: [] };
  const splits = new Map<string, string[]>();
  for (const entry of select) {
    if (entry.includes(',')) splits.set(entry, splitSelectEntry(entry));
  }
  const names = selectNames(select);
  const widenings = new Map<string, string>();
  if (!names.includes('*')) {
    for (const name of names) {
      const { field, widened } = projectSelectName(entityType, name);
      if (widened) widenings.set(name, field);
    }
  }
  return {
    splits: Array.from(splits, ([entry, split]) => ({ entry, names: split })),
    widenings: Array.from(widenings, ([name, field]) => ({ name, field })),
  };
}

/**
 * The record key one caller-supplied `select` name lands under: `author_list` keeps its own
 * name; any other name lands under the upstream field it projects (`authors` → `authorships`).
 * Exported so a tool can find the array a one-field projection returns.
 */
export function selectRecordKey(entityType: SearchParams['entityType'], field: string): string {
  return entityType === 'works' && field === AUTHOR_LIST_FIELD
    ? field
    : translateSelectField(entityType, field);
}

/**
 * A table's own entry for `key`, or undefined. The alias and scheme tables are plain object
 * literals, so a bracket read of a caller-supplied `constructor` or `__proto__` returns the
 * inherited `Object.prototype` member instead of missing.
 */
function ownEntry<V>(table: Record<string, V> | undefined, key: string): V | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Resolve the upstream `select` projection for an entity request — applied identically to
 * single-entity ID lookups and search/filter/list calls.
 *
 * - omitted or empty → the curated `DEFAULT_SELECT` for the entity type, keeping responses lean
 *   (full records run 20-70 KB);
 * - names `'*'` → the full record: returns `undefined` so the caller omits `select` entirely
 *   (OpenAlex has no `select=*` wildcard — the sentinel is consumed here, not forwarded);
 * - explicit field list → those fields, with `id`/`display_name` guaranteed and aliases
 *   translated.
 *
 * Comma-joined entries split after the default is decided, so `[","]` asks for `id` and
 * `display_name` alone, as `[""]` does, rather than for the default.
 */
function resolveSelect(
  entityType: SearchParams['entityType'],
  select: readonly string[] | undefined,
): string[] | undefined {
  const names = select?.length ? selectNames(select) : DEFAULT_SELECT[entityType];
  if (names.includes('*')) return;
  return translateSelect(entityType, names);
}

/**
 * A bare OpenAlex ID the `openalex` filter accepts as a value, in either case. Combined with
 * `parseOpenAlexUrl()` for the URL spellings and with pipe-splitting in `isOpenAlexFilterValue`
 * to detect OR-joined ID lists.
 */
const OPENALEX_ID_VALUE_PATTERN = /^[WAISTKPFCG]\d+$/i;

/** One `id` filter segment as the bare ID it names, or the segment itself when it is no URL. */
function filterSegmentId(segment: string): string {
  const trimmed = segment.trim();
  const fromUrl = parseOpenAlexUrl(trimmed);
  return fromUrl?.kind === 'native' ? fromUrl.id : trimmed;
}

/**
 * Detect a value the `id:` filter would carry — OpenAlex IDs, bare or in any URL spelling
 * `parseOpenAlexUrl()` reads, optionally pipe-joined for OR semantics. When matched, `id` is
 * rewritten to `openalex` (the canonical filter key) and the value is forwarded as written:
 * upstream accepts every one of those spellings, and the space around a `|`. Awards are the
 * exception (see `awardIdFilterValue`). Stricter than any value so a future generic upstream
 * `id:` filter wouldn't be shadowed — only values that read as OpenAlex IDs get redirected.
 * Exported for the timing suite, which runs it on caller-sized values.
 */
export function isOpenAlexFilterValue(value: string): boolean {
  return value
    .split('|')
    .every((segment) => OPENALEX_ID_VALUE_PATTERN.test(filterSegmentId(segment)));
}

/**
 * An `id` filter value for awards, which have no `openalex` filter (a 400) and whose `id` filter
 * matches only the `https://openalex.org/G…` URL — a bare `G…`, in either case, matches nothing
 * with no error. Each OR segment is rewritten to that URL, its letter upper-cased.
 */
function awardIdFilterValue(value: string): string {
  return value
    .split('|')
    .map((segment) => {
      const id = filterSegmentId(segment);
      return `https://openalex.org/${id.charAt(0).toUpperCase()}${id.slice(1)}`;
    })
    .join('|');
}

/**
 * Rewrite one caller-supplied filter key to the upstream OpenAlex name, before the
 * value-dependent `id` rewrite. Exported so the citation-graph tool can check a caller's key
 * against the ones `direction` reserves: checking the raw key alone let `cited_works` past the
 * guard, and it then aliased onto `cites` and collided with the direction's own value.
 *
 * Misses fall through unchanged so upstream's 400 with the valid-field list still fires for
 * typos no map can preempt.
 */
export function translateFilterKey(entityType: SearchParams['entityType'], key: string): string {
  return entityType === 'works' ? (ownEntry(FILTER_ALIASES_WORKS, key) ?? key) : key;
}

/**
 * Rewrite caller-supplied filter keys to the upstream OpenAlex names. Works-only key map plus
 * an `id` → `openalex` rewrite when the value looks like an OpenAlex ID, on every type but
 * awards, whose ID values stay under `id` in the URL form it matches (`awardIdFilterValue`).
 * Every other value passes through unchanged.
 *
 * Emits clauses rather than a record because an alias and its canonical name are two separate
 * constraints that resolve to one key — `{year: "2020", publication_year: "2024"}` is a request
 * for works in both years. A record kept only whichever came last, so JSON property order
 * silently decided the result set. Both are sent, matching OpenAlex's own repeated-key AND.
 * Clauses that resolve to an identical key *and* value are deduplicated: restating one
 * constraint changes nothing upstream.
 */
function translateFilters(
  entityType: SearchParams['entityType'],
  filters: Record<string, string>,
): FilterClause[] {
  const out: FilterClause[] = [];
  for (const [rawKey, rawValue] of Object.entries(filters)) {
    const aliased = translateFilterKey(entityType, rawKey);
    const openAlexIds = aliased === 'id' && isOpenAlexFilterValue(rawValue);
    const finalKey = openAlexIds && entityType !== 'awards' ? 'openalex' : aliased;
    const value = openAlexIds && entityType === 'awards' ? awardIdFilterValue(rawValue) : rawValue;
    if (out.some(([key, existing]) => key === finalKey && existing === value)) continue;
    out.push([finalKey, value]);
  }
  return out;
}

/**
 * The `filter` parameter a search or group_by over `filters` sends: keys translated, then each
 * clause built by `buildFilterString()`, whose pre-flight throws (`comma_in_filter_value`,
 * `invalid_country_code`, `invalid_range_in_filter_value`, `mixed_and_or_in_filter_value`,
 * `quote_in_filter_value`, `unmatched_quote_in_filter_value`) it shares.
 * Exported so a tool that spends a request before its search — the citation graph's seed lookup —
 * can run those checks first and fail without one.
 */
export function buildSearchFilter(
  entityType: SearchParams['entityType'],
  filters: Record<string, string>,
): string {
  return buildFilterString(translateFilters(entityType, filters));
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long an identifier lookup and the fallback it runs after a miss may take together, counted
 * from the start of the lookup — the name search `resolveIdentifier()` runs after a bare native-ID
 * miss, and the landing-page lookup and refetch an arXiv DOI miss leads to (`workByArxivId`). One
 * request's own worst case — three 10 s attempts and up to ~3.75 s of jittered backoff — is ~34 s,
 * so a lookup that misses inside its retry budget still leaves the fallback one full attempt, and
 * the call settles by 45 s, inside the 60 s an MCP client waits. A lookup that ran past it (a long
 * upstream `Retry-After`) leaves no time, and the fallback reports a timeout without being sent.
 */
const FALLBACK_DEADLINE_MS = 45_000;

/** The most landing-page rows an arXiv lookup reads; more than one counted row is already a tie. */
const ARXIV_LANDING_PAGE_ROWS = 25;

/** A work's OpenAlex ID as a list row carries it, with the bare `W…` ID captured. */
const OPENALEX_WORK_URL = /^https:\/\/openalex\.org\/(W\d+)$/;

/** The `retry_deadline_exceeded` reason `withRetry` gives a request its `deadlineMs` ran out on. */
const RETRY_DEADLINE_EXCEEDED = 'retry_deadline_exceeded';
const KNOWN_AUTOCOMPLETE_TYPES = new Set(
  AUTOCOMPLETE_ENTITY_TYPES.map((type) => type.replace(/s$/, '')),
);

type ErrorFactory = (
  message: string,
  data?: Record<string, unknown>,
  options?: ErrorOptions,
) => McpError;

/**
 * `JsonRpcErrorCode` → `{ factory, reason }` for shaping normalized OpenAlex throws.
 * Driven by `httpStatusToErrorCode` so the status-table stays in lockstep with the
 * framework. `reason` is the literal carried on `data.reason`; the framework matches it
 * against the calling tool's contract and fills that entry's recovery hint.
 */
const NORMALIZED_THROW_BY_CODE: Partial<
  Record<JsonRpcErrorCode, { factory: ErrorFactory; reason: string }>
> = {
  [JsonRpcErrorCode.InvalidParams]: { factory: invalidParams, reason: 'upstream_invalid_params' },
  [JsonRpcErrorCode.InvalidRequest]: {
    factory: invalidRequest,
    reason: 'upstream_invalid_request',
  },
  [JsonRpcErrorCode.Unauthorized]: { factory: unauthorized, reason: 'upstream_unauthorized' },
  [JsonRpcErrorCode.Forbidden]: { factory: forbidden, reason: 'upstream_forbidden' },
  [JsonRpcErrorCode.NotFound]: { factory: notFound, reason: 'entity_not_found' },
  [JsonRpcErrorCode.Timeout]: { factory: timeout, reason: 'upstream_timeout' },
  [JsonRpcErrorCode.Conflict]: { factory: conflict, reason: 'upstream_conflict' },
  [JsonRpcErrorCode.ValidationError]: {
    factory: validationError,
    reason: 'upstream_validation_failed',
  },
  [JsonRpcErrorCode.RateLimited]: { factory: rateLimited, reason: 'rate_limited' },
  [JsonRpcErrorCode.ServiceUnavailable]: {
    factory: serviceUnavailable,
    reason: 'upstream_unavailable',
  },
};

function hasEntries(record?: Record<string, string>): record is Record<string, string> {
  return record !== undefined && Object.keys(record).length > 0;
}

/**
 * Running budget total for one tool call, keyed by the request `Context` every request in
 * that call shares. A tool call can bill several upstream requests, and `ctx.enrich` is
 * last-wins per key, so the accumulator is what makes the reported cost the sum rather than
 * the final response's line item. Entries are collected with the context.
 */
const budgetByContext = new WeakMap<Context, UpstreamBudget>();

/**
 * Fold one response's accounting into the tool call's total and re-publish it as enrichment.
 * `ctx.enrich` is callable from the service layer and reaches `structuredContent` exactly as
 * if the handler had written it, so the four upstream-calling tools get the field by declaring
 * it — no per-handler plumbing, and multi-request tools report the true total.
 */
function recordBudget(budget: UpstreamBudget, ctx: Context): void {
  const total = mergeUpstreamBudget(budgetByContext.get(ctx), budget);
  budgetByContext.set(ctx, total);
  ctx.enrich({ budget: total });
}

/**
 * Write one `OpenAlex response metrics` record at `info` for a billed (2xx) response, so an
 * operator can see which tool calls spent the daily budget. The budget figures come from the
 * headers every response shape carries; `db_response_time_ms` has no header and lives in `meta`,
 * absent on singleton lookups (no `meta` wrapper) and on a body that failed to parse.
 *
 * It goes through the module `logger`, the process log only: `ctx.log` would also send it to the
 * client on every upstream request, repeating the result's `budget`. `withExtra(ctx, …)` keeps
 * the call's `requestId` and `toolName` on the record. The request is named by `route` and its
 * parameter names, never their values: the path and the values carry the caller's identifiers,
 * query text, and filter values.
 */
function logResponseMetrics(
  parsed: unknown,
  budget: UpstreamBudget | undefined,
  path: string,
  params: Record<string, string>,
  ctx: Context,
): void {
  const meta = isRecord(parsed) ? parsed.meta : undefined;
  const db =
    isRecord(meta) && typeof meta.db_response_time_ms === 'number'
      ? meta.db_response_time_ms
      : undefined;
  if (budget === undefined && db === undefined) return;

  logger.info(
    'OpenAlex response metrics',
    withExtra(ctx, {
      route: parseRequestPath(path).route,
      params: Object.keys(params),
      ...(budget !== undefined && {
        costUsd: budget.costUsd,
        budgetRemainingUsd: budget.remainingUsd,
        budgetResetsInSeconds: budget.resetsInSeconds,
      }),
      ...(db !== undefined && { dbResponseTimeMs: db }),
    }),
  );
}

/**
 * Permissive extractors for OpenAlex's `error` and `message` fields when the body
 * is truncated mid-string (framework caps `responseBody` at 500 bytes; OpenAlex
 * valid-fields listings exceed ~1 KB). The terminator `"|…|$` accepts a closing
 * quote, the framework's truncation ellipsis, or end of string — so whatever
 * survived the cap still gets extracted.
 */
const TRUNCATED_ERROR_FIELD_RE = /"error"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|…|$)/;
const TRUNCATED_MESSAGE_FIELD_RE = /"message"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|…|$)/;
const ELIDED_BODY_MARKER_RE = /…\[\d+ bytes? elided\]…/;

/**
 * Extract OpenAlex's `error` and `message` fields from a response body. JSON.parse
 * works for un-truncated bodies; falls back to regex so the useful prefix of the
 * upstream message still reaches the caller when the body was cut mid-string.
 * `truncated` distinguishes the two paths so downstream sanitization can act only
 * on bodies that were actually cut.
 */
function parseOpenAlexErrorBody(
  responseBody: unknown,
): { error?: string | undefined; message?: string | undefined; truncated: boolean } | null {
  if (typeof responseBody !== 'string') return null;

  try {
    const parsed = JSON.parse(responseBody);
    if (!isRecord(parsed)) return null;

    return {
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      truncated: ELIDED_BODY_MARKER_RE.test(responseBody),
    };
  } catch {
    const error = TRUNCATED_ERROR_FIELD_RE.exec(responseBody)?.[1];
    const message = TRUNCATED_MESSAGE_FIELD_RE.exec(responseBody)?.[1];
    if (error === undefined && message === undefined) return null;
    return { error, message, truncated: true };
  }
}

/**
 * OpenAlex 400 messages append an alphabetically-sorted enumeration of valid field
 * names ("Valid fields are: a, b, c, ..."). When the response body was truncated
 * mid-list the surviving prefix misleads agents into believing the early-alphabet
 * fields are the complete set. Strip the list when truncation occurred — the raw
 * upstream prefix stays available on `data.upstreamMessage` for debugging.
 */
const VALID_FIELDS_BOUNDARY_RE = /\s*Valid fields\b.*/is;
function stripTruncatedValidFieldsList(message: string): string {
  if (!VALID_FIELDS_BOUNDARY_RE.test(message)) return message;
  return `${message.replace(VALID_FIELDS_BOUNDARY_RE, '').trim()} (list of valid fields omitted — was truncated upstream; see OpenAlex docs)`;
}

/**
 * Regex to extract the rejected field name from an OpenAlex 400 message.
 * Matches patterns like:
 *   "funder is not a valid field for group_by"
 *   "totally_made_up_field is not a valid select field"
 *   "nonexistent_filter is not a valid field"
 * Capture group 1 = the rejected field name.
 */
const REJECTED_FIELD_RE = /^([a-z0-9_.]+)\s+is not a valid/i;

/**
 * OpenAlex 400 emitted when a relevance-score sort is requested without an active search
 * (no `query` and no `*.search` filter): "Must include a search query (such as ?search=…)
 * in order to sort by relevance_score." Names no rejected field, so `describe_fields` is the
 * wrong next move — the caller needs a search, not a corrected field name.
 */
const SORT_REQUIRES_SEARCH_RE = /must include a search query/i;

/**
 * OpenAlex 400 emitted when group_by targets a field it cannot aggregate — a raw date, a
 * float, or a `*.search` operator ("Cannot group by date, number, or search fields."), a
 * field it refuses by name ("Cannot group by display_name."), or one it has not built
 * ("Group by referenced_works is not supported at this time."). Either way the field name is
 * valid; the caller needs a groupable field, not a corrected name.
 */
const UNGROUPABLE_GROUP_BY_RE = /cannot group by|\bgroup by \S+ is not supported\b/i;

/**
 * OpenAlex 400 emitted when an entity-ID filter receives something that isn't an ID —
 * typically a name: "'Albert' is not a valid OpenAlex ID." (upstream splits the value on
 * whitespace before validating, so only the first token is named). The fix is to resolve
 * the name to an ID first, which no other 400 shape's recovery says. Capture group 1 is the
 * quoted value, when present — `isGroupByIdRejection` reads it.
 */
const INVALID_ID_VALUE_RE = /(?:'([^']*)'\s+)?is not a valid OpenAlex ID/i;

/**
 * The same invalid-ID 400 also answers a group_by upstream cannot aggregate: authors grouped
 * by `concepts.id`, `concept.id`, or `x_concepts.id` gets "'41008148' is not a valid OpenAlex
 * ID.", naming a concept ID from upstream's own aggregation. Upstream validates `filter` before
 * `group_by`, so a quoted value the request's filter carries is the caller's bad ID; anything
 * else on a group_by request — including a request with no filter at all — is the group_by.
 */
function isGroupByIdRejection(
  quotedValue: string | undefined,
  requestParams: Record<string, string>,
): boolean {
  if (!requestParams.group_by) return false;
  const filter = requestParams.filter;
  return !filter || (quotedValue !== undefined && !filter.includes(quotedValue));
}

/**
 * OpenAlex 400 emitted when the search text exceeds the length it accepts: the body's `error`
 * reads "Search query too long" and its `message` quotes both the submitted length and the
 * ceiling — "Your search is too long (1890 characters; the limit is 1500)." The bound is
 * upstream's to move (its docs still say 2,000 characters with truncation), so it is reported
 * from the message rather than pinned as a local `.max()` that would drift.
 */
const QUERY_TOO_LONG_RE = /\bsearch\b(?: query)?(?: is)? too long\b/i;

/**
 * OpenAlex 400 emitted when works search meets a `*` or `?` in stemmed text — `search=` (the
 * keyword `query`) or a `.search` filter that has a `.search.exact` form — in two wordings:
 * "Wildcards (* or ?) require exact (no-stem) search. …" and "Wildcards (* or ?) require the
 * exact (no-stem) field. "title.search" is stemmed, …". The message names the `.search.exact`
 * key to use instead.
 */
const WILDCARD_REQUIRES_EXACT_RE = /^Wildcards \(\* or \?\) require\b/;

/**
 * OpenAlex 400 emitted for a `*` with too few characters before it, in `query` (keyword or
 * exact) or any `.search` filter, on every entity type: "A * wildcard needs at least 3 leading
 * characters: "A*". …". No search mode lifts it.
 */
const WILDCARD_PREFIX_TOO_SHORT_RE = /^A \* wildcard needs at least \d+ leading characters\b/;

/**
 * A single upstream HTTP 400 spans several distinct failure shapes, each needing a different
 * caller recovery. Pick the declared tool reason from the message shape so the per-tool
 * `recovery` hint (filled by the framework from the reason) matches the actual failure instead of
 * always claiming a rejected field name. Ordering: the two wildcard checks run first — they are
 * anchored at the message start, and the requires-exact message ends by quoting the caller's
 * query, so a quote holding another shape's wording ("cannot group by micro*") must never reach
 * the unanchored probes below. The over-long-query and ID-value checks come next, the shapes
 * naming a concrete upstream concept; the field-name check is anchored at string start; the rest
 * are keyword probes; anything unmatched falls through to a neutral `_other` reason so no shape
 * inherits the field-name recovery by default. The invalid-ID shape alone also reads the
 * request's own `filter`/`group_by` params, because upstream sends it for two different mistakes.
 */
function classifyInvalidParamsReason(
  rawMessage: string | undefined,
  requestParams: Record<string, string>,
): string {
  if (rawMessage !== undefined) {
    if (WILDCARD_REQUIRES_EXACT_RE.test(rawMessage)) return 'upstream_wildcard_requires_exact';
    if (WILDCARD_PREFIX_TOO_SHORT_RE.test(rawMessage)) return 'upstream_wildcard_prefix_too_short';
    if (QUERY_TOO_LONG_RE.test(rawMessage)) return 'query_too_long';
    const invalidId = INVALID_ID_VALUE_RE.exec(rawMessage);
    if (invalidId) {
      return isGroupByIdRejection(invalidId[1], requestParams)
        ? 'upstream_ungroupable_group_by'
        : 'upstream_invalid_id_value';
    }
    if (REJECTED_FIELD_RE.test(rawMessage)) return 'upstream_invalid_params';
    if (SORT_REQUIRES_SEARCH_RE.test(rawMessage)) return 'upstream_sort_requires_search';
    if (UNGROUPABLE_GROUP_BY_RE.test(rawMessage)) return 'upstream_ungroupable_group_by';
  }
  return 'upstream_invalid_params_other';
}

/**
 * Longest `q`, in Unicode code points, that `/autocomplete/{entity_type}` answers. Past it, a
 * query holding an ASCII letter gets an HTML 500 on every attempt, on all eight typed endpoints;
 * cross-entity `/autocomplete` has no such bound. The bound is upstream's to move, so it only
 * relabels a 500 that already happened rather than rejecting input: if OpenAlex raises it, the
 * branch never fires; if it lowers it, the shorter failures stay `upstream_unavailable`.
 */
const AUTOCOMPLETE_QUERY_MAX_CODE_POINTS = 1000;

/**
 * The code-point length of a typed autocomplete `q` past `AUTOCOMPLETE_QUERY_MAX_CODE_POINTS` —
 * the one request shape whose HTTP 500 is a caller error rather than an outage — or undefined.
 * Counted in code points, as upstream counts: `length` would count an emoji twice.
 */
function overLongAutocompleteQuery(
  path: string,
  params: Record<string, string>,
): number | undefined {
  if (!path.startsWith('/autocomplete/') || params.q === undefined) return;
  const codePoints = [...params.q].length;
  return codePoints > AUTOCOMPLETE_QUERY_MAX_CODE_POINTS ? codePoints : undefined;
}

/**
 * The start of the HTTP 400 `message` OpenAlex sends when a semantic search's query-embedding
 * call fails for any reason but a timeout — `APIQueryParamsError(f"Failed to embed query: {e}")`
 * in ourresearch/openalex-elastic-api `core/semantic_search.py` (`embed_query`). The rest is the
 * embedding client's exception text: an HTTP error from the embedding service (its own 429 among
 * them, which is not this caller's rate), a connection failure, or a parse error — every one an
 * upstream fault, and one that names the embedding service's host.
 */
const SEMANTIC_EMBED_FAILURE_PREFIX = 'Failed to embed query:';

/**
 * The HTTP 400 `message` OpenAlex sends when its embedding service is not configured (same module,
 * `get_embedding_client`) — an upstream fault worded as a parameter error.
 */
const SEMANTIC_NOT_CONFIGURED_MESSAGE = 'Semantic search is not configured';

/**
 * Recovery for every `upstream_unavailable` failure of a semantic search — a relabelled embedding
 * failure, the 503 OpenAlex sends when the embedding timed out, or any other outage — since a
 * keyword search does not depend on the embedding service and can answer while it is down.
 */
export const SEMANTIC_UNAVAILABLE_HINT =
  'OpenAlex semantic search is failing upstream. Retry in a minute, or rerun with search_mode "keyword", which does not depend on it.';

/** Is this request a semantic search? `search.semantic` is the parameter only that mode sends. */
function isSemanticSearch(params: Record<string, string>): boolean {
  return params['search.semantic'] !== undefined;
}

/**
 * Did OpenAlex fail a semantic search's query embedding? Matched on the request mode and on the
 * whole `message` shape — anchored at its start — so no caller-error 400 (an unsupported semantic
 * filter, a missing query, two search methods at once) and no keyword-mode 400 ever matches.
 */
function isSemanticEmbedFailure(
  statusCode: number | undefined,
  rawMessage: string | undefined,
  params: Record<string, string>,
): boolean {
  return (
    statusCode === 400 &&
    isSemanticSearch(params) &&
    rawMessage !== undefined &&
    (rawMessage.startsWith(SEMANTIC_EMBED_FAILURE_PREFIX) ||
      rawMessage === SEMANTIC_NOT_CONFIGURED_MESSAGE)
  );
}

/** Reason for a 429 caused by daily-budget exhaustion rather than burst throttling. */
const BUDGET_EXHAUSTED_REASON = 'upstream_budget_exhausted';

/**
 * Recovery for a spent daily budget on a server that sends no API key. It runs on the smaller
 * anonymous budget, so a key is the one fix besides waiting. A keyed server's budget is already
 * the larger one, and a caller of a shared endpoint cannot set the server's environment, so that
 * case keeps the key-neutral recovery each tool's contract declares.
 */
export const BUDGET_EXHAUSTED_KEYLESS_HINT =
  "This server's daily OpenAlex budget is spent and refills at midnight UTC — retrying before then will not succeed. The server sends no OpenAlex API key, so it runs on the smaller anonymous budget; setting OPENALEX_API_KEY to a free key (https://openalex.org/settings/api) raises it.";

/**
 * The `error` field of the HTTP 429 OpenAlex answers a filter its paid plans gate with, observed
 * live (2026-10-18) for `created_date`, `updated_date`, and their `from_`/`to_` forms on works and
 * authors lists, a works group_by, and works autocomplete. Its `message` names the refused clause:
 * `The "from_created_date:2026-10-01" filter is part of daily sync, which comes with the Member+
 * and Partner plans. See https://help.openalex.org/access/sync/ for details.` It is a plan gate,
 * not a rate: no wait clears it.
 */
const PLAN_UPGRADE_REQUIRED_ERROR = 'Plan upgrade required';

/** The filter name opening a plan-gated 429's `message`: `The "<filter>:<value>" filter …`. */
const PLAN_GATED_FILTER_RE = /^The "([\w.]+):/;

/**
 * The server's own message for a plan-gated filter, naming the filter when the upstream message
 * opens with it. The name is read as a field-name run only, so caller text the upstream clause
 * echoes cannot carry markdown or a line break into the message.
 */
export function planGatedFilterMessage(upstreamMessage: string | undefined): string {
  const filter =
    upstreamMessage === undefined ? undefined : PLAN_GATED_FILTER_RE.exec(upstreamMessage)?.[1];
  const subject = filter === undefined ? 'A filter in this request' : `The \`${filter}\` filter`;
  return `${subject} needs a paid OpenAlex plan, which this server's OpenAlex access does not include.`;
}

/**
 * Besides a filter its paid plans gate (classified before this, on its body's `error`), OpenAlex
 * returns 429 for two unrelated conditions: bursting past its per-second ceiling, and spending
 * the daily usage budget. The recoveries are opposites — one clears in seconds, the other not
 * until the midnight-UTC reset — so they need separate reasons.
 *
 * The literal budget-exhaustion body is not published in OpenAlex's docs, so the match is
 * deliberately loose: several independent signals, none of them load-bearing on an exact
 * wording. The burst-throttle bodies carry none of these tokens.
 */
const BUDGET_EXHAUSTED_RE = /insufficient budget|resets at midnight|budget[^.]*remaining/i;

/** Discriminate the two upstream 429 shapes on the message; default to burst throttling. */
function classifyRateLimitReason(rawMessage: string | undefined): string {
  if (rawMessage !== undefined && BUDGET_EXHAUSTED_RE.test(rawMessage)) {
    return BUDGET_EXHAUSTED_REASON;
  }
  return 'rate_limited';
}

/**
 * Pick the reason for a normalized throw. Two upstream statuses carry several distinct
 * failure shapes under one error code — 400 (a wildcard in stemmed works search / a wildcard
 * with too short a prefix / over-long search text / non-ID filter value / rejected field /
 * relevance sort without a search / ungroupable group_by) and 429 (burst throttle vs. spent
 * daily budget) — and each shape needs its own caller recovery, so both discriminate on the
 * upstream message, and the 400 invalid-ID shape on the request params too. Every other code
 * maps to a single reason.
 */
function resolveThrowReason(
  code: JsonRpcErrorCode,
  mappedReason: string,
  rawMessage: string | undefined,
  requestParams: Record<string, string>,
): string {
  if (code === JsonRpcErrorCode.InvalidParams) {
    return classifyInvalidParamsReason(rawMessage, requestParams);
  }
  if (code === JsonRpcErrorCode.RateLimited) return classifyRateLimitReason(rawMessage);
  return mappedReason;
}

/**
 * Domain-language replacement for the framework's fetch-plumbing message on the failures
 * that never carry an HTTP status. `fetch GET <url> timed out.` describes this client, not
 * the upstream; the caller needs to read that OpenAlex did not answer.
 */
function domainMessageForFetchFailure(error: McpError, path: string): string | undefined {
  switch (error.data?.errorSource) {
    case 'FetchTimeout':
      return `OpenAlex did not respond within ${REQUEST_TIMEOUT_MS / 1000}s for ${path}`;
    case 'FetchNetworkError':
    case 'FetchNetworkErrorWrapper':
      return `Could not reach the OpenAlex API for ${path}`;
    default:
      return;
  }
}

/**
 * Which field list a rejected field belongs to. A select rejection says so ("… is not a valid
 * select field"). A rejected group_by key reads exactly like a rejected filter key ("… is not a
 * valid field."), so the request's own `group_by`, its `:include_unknown` suffix dropped, tells
 * the two apart: a group_by key is ranked against the groupable filter fields only, so no
 * suggestion names a field a group_by retry would fail on (`publication_dat` → `publication_date`,
 * a raw date).
 */
function inferContext(
  message: string,
  rejectedField: string,
  requestParams: Record<string, string>,
): 'filter' | 'group_by' | 'select' {
  if (/\bselect\b/i.test(message)) return 'select';
  return requestParams.group_by?.replace(/:include_unknown$/, '') === rejectedField
    ? 'group_by'
    : 'filter';
}

/**
 * What a request path addresses: the entity type it reads, and its `route` — the path with a
 * by-ID segment written as `{id}`, so a log record names the endpoint without the caller's DOI,
 * ID, or slug. The service builds four shapes: `/<entity_type>` (a list, filter, group_by,
 * sample, or funder-DOI request) and `/<entity_type>/<id>` (an ID that may hold `/`, as a DOI
 * does) read the first segment, `/autocomplete/<entity_type>` reads the one after it, and
 * cross-entity `/autocomplete` names no entity type. Exported for the timing suite, which runs it
 * on a caller-sized by-ID path.
 */
export function parseRequestPath(path: string): {
  entityType: EntityType | undefined;
  route: string;
} {
  const [first = '', second] = path.slice(1).split('/', 2);
  if (first === 'autocomplete') {
    return {
      entityType: second !== undefined && isEntityType(second) ? second : undefined,
      route: path,
    };
  }
  return {
    entityType: isEntityType(first) ? first : undefined,
    route: second === undefined ? path : `/${first}/{id}`,
  };
}

/**
 * Append ranked field suggestions and a describe_fields pointer to an
 * `upstream_invalid_params` error message when a rejected field name is
 * extractable from the upstream body.
 */
function appendFieldSuggestions(
  message: string,
  path: string,
  requestParams: Record<string, string>,
): string {
  const match = REJECTED_FIELD_RE.exec(message);
  if (!match?.[1]) return message;

  const rejectedField = match[1];
  const { entityType } = parseRequestPath(path);
  if (!entityType) return message;

  const context = inferContext(message, rejectedField, requestParams);
  const catalog = getFieldCatalog()[entityType];
  const pool =
    context === 'group_by'
      ? catalog.filter.filter((field) => isGroupableField(entityType, field))
      : catalog[context];
  const suggestions = rankFields(rejectedField, pool, 3);
  if (suggestions.length === 0) return message;

  const base = VALID_FIELDS_BOUNDARY_RE.test(message)
    ? message.replace(VALID_FIELDS_BOUNDARY_RE, '').trim()
    : message;

  return `${base} Did you mean: ${suggestions.join(', ')}? Browse all with openalex_describe_fields(entity_type, context).`;
}

function getSearchParamKey(searchMode?: SearchParams['searchMode']): string {
  switch (searchMode) {
    case 'exact':
      return 'search.exact';
    case 'semantic':
      return 'search.semantic';
    default:
      return 'search';
  }
}

/**
 * Translate one sort key to OpenAlex syntax: a leading `-` becomes a `:desc` suffix, and a
 * bare `relevance_score` is coerced to descending (ascending relevance is never the intent).
 * Anything else — including a key that already carries `:desc` — passes through.
 */
function normalizeSortKey(key: string): string {
  if (key.startsWith('-')) return `${key.slice(1)}:desc`;
  if (key === 'relevance_score') return 'relevance_score:desc';
  return key;
}

/**
 * OpenAlex accepts comma-separated sort keys (`publication_year:desc,cited_by_count`), so
 * each key is normalized independently. Treating the value as a single field moved the
 * descending marker onto the last key, silently flipping the dash-prefixed one to ascending.
 */
function normalizeSort(sort?: string): string | undefined {
  if (!sort) return;
  return sort
    .split(',')
    .map((key) => normalizeSortKey(key.trim()))
    .join(',');
}

/** Recovery for an arXiv miss whose landing page several works hold an arXiv location at. */
const ARXIV_CANDIDATES_HINT =
  'Retry with one of the OpenAlex work IDs in data.candidates in place of the arXiv ID; each holds an arXiv location at its landing page, so pick the one whose record matches the paper.';

/** Recovery for an arXiv miss whose landing-page lookup failed upstream. */
const ARXIV_FALLBACK_FAILED_HINT =
  'Retry the call: no work carries this arXiv DOI, and the landing-page lookup that finds an arXiv work without one failed upstream, so a retry may find the work.';

/** Recovery for an arXiv miss whose landing-page lookup was refused for a spent daily budget. */
const ARXIV_BUDGET_EXHAUSTED_HINT =
  "No work carries this arXiv DOI, and the landing-page lookup that finds an arXiv work without one was refused: this server's daily OpenAlex budget is spent. Retry after it refills at midnight UTC.";

/**
 * The reason to report a failed arXiv landing-page lookup under, or undefined for a failure to
 * throw as classified. A transient failure and a spent budget leave the DOI's miss standing, since
 * a later call can still find the work; a caller cancellation, and a request OpenAlex refused, are
 * not the lookup's to absorb.
 */
function landingPageFailureReason(error: unknown, signal: AbortSignal): string | undefined {
  if (signal.aborted || !(error instanceof McpError)) return;
  if (error.data?.reason === BUDGET_EXHAUSTED_REASON) return BUDGET_EXHAUSTED_REASON;
  return defaultIsTransient(error) ? NORMALIZED_THROW_BY_CODE[error.code]?.reason : undefined;
}

/**
 * The bare `W…` ID of a landing-page row that counts: one with a location at one of `urls` that
 * arXiv itself serves. Undefined for any other row, a malformed one included.
 */
function arxivLandingWorkId(row: unknown, urls: readonly string[]): string | undefined {
  if (!isRecord(row) || typeof row.id !== 'string' || !Array.isArray(row.locations)) return;
  const served = row.locations.some(
    (location) =>
      isRecord(location) &&
      typeof location.landing_page_url === 'string' &&
      urls.includes(location.landing_page_url) &&
      isRecord(location.source) &&
      location.source.id === ARXIV_SOURCE_ID,
  );
  return served ? OPENALEX_WORK_URL.exec(row.id)?.[1] : undefined;
}

/** The `arxivMiss` an arXiv lookup's `entity_not_found` carries, or undefined for a plain miss. */
function arxivMissDetail(error: McpError): IdentifierResolution['arxivMiss'] {
  const { candidates, fallbackFailedReason } = error.data ?? {};
  if (Array.isArray(candidates)) return { candidates: candidates.map(String) };
  if (typeof fallbackFailedReason === 'string') return { fallbackFailedReason };
  return;
}

class OpenAlexService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly mailto: string;

  constructor() {
    const config = getServerConfig();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.mailto = config.mailto;
  }

  /**
   * Execute an HTTP request against the OpenAlex API with retry on transient failures. With
   * `deadlineMs`, every attempt and backoff settles within that many milliseconds, after which
   * the request fails as `upstream_timeout`, the reason every tool's contract declares, in place
   * of the retry ladder's own `retry_deadline_exceeded`.
   */
  private request(
    path: string,
    params: Record<string, string>,
    ctx: Context,
    deadlineMs?: number,
  ): Promise<unknown> {
    const operation = `OpenAlex ${path}`;
    const url = new URL(`${this.baseUrl}${path}`);
    // OpenAlex usage-based pricing (Feb 2026): the account credential authenticates as
    // `api_key=`. `mailto=` is now only a courtesy identifier (no budget/rate effect), sent
    // independently when OPENALEX_MAILTO is set. Both are stripped from any URL that surfaces
    // in an error by the url-redaction allowlist (neither is a caller-controlled param).
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);
    if (this.mailto) url.searchParams.set('mailto', this.mailto);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }

    ctx.log.debug('OpenAlex request', { path, params: Object.keys(params) });

    return withRetry(
      async ({ signal }) => {
        try {
          const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, ctx, {
            headers: { Accept: 'application/json' },
            signal,
          });
          // Only 2xx responses reach here — `fetchWithTimeout` throws on anything else, so a
          // throttled or budget-exhausted call surfaces through the error contract instead.
          const budget = parseUpstreamBudget(response.headers);
          // Recorded and logged whether or not the body parses: OpenAlex bills a 200 whether
          // or not its payload survives (it truncates under load), and `parseResponse` throws
          // on a truncated body. Counting only parsed bodies would drop the cost of every
          // attempt that gets retried, so the call's total and its log records would
          // under-report its real spend.
          if (budget) recordBudget(budget, ctx);
          let parsed: unknown;
          try {
            parsed = this.parseResponse(await response.text(), path);
            return parsed;
          } finally {
            logResponseMetrics(parsed, budget, path, params, ctx);
          }
        } catch (error) {
          this.throwNormalizedRequestError(error, path, params);
        }
      },
      {
        operation,
        context: ctx,
        baseDelayMs: BASE_BACKOFF_MS,
        maxRetries: MAX_ATTEMPTS - 1,
        signal: ctx.signal,
        ...(deadlineMs !== undefined && { deadlineMs }),
      },
    ).catch((error: unknown) => {
      if (!(error instanceof McpError && error.data?.reason === RETRY_DEADLINE_EXCEEDED)) {
        throw error;
      }
      throw timeout(
        `OpenAlex did not answer ${path} before this call's deadline.`,
        { ...error.data, path, reason: 'upstream_timeout' },
        { cause: error },
      );
    });
  }

  private throwNormalizedRequestError(
    error: unknown,
    path: string,
    params: Record<string, string>,
  ): never {
    if (!(error instanceof McpError)) {
      throw error;
    }

    const statusCode =
      typeof error.data?.statusCode === 'number' ? error.data.statusCode : undefined;
    // `fetchWithTimeout` marks the captured body (`body`, `responseBody`) server-only: it reads
    // here and lands in the failure log, and the marker rides every `{ ...error.data }` below, so
    // no client envelope carries it. `upstreamError` and `upstreamMessage` are what the caller
    // sees of the body.
    const upstream = parseOpenAlexErrorBody(error.data?.responseBody);
    const rawMessage = upstream?.message ?? upstream?.error;
    const upstreamFields = {
      ...(upstream?.error ? { upstreamError: upstream.error } : {}),
      ...(upstream?.message ? { upstreamMessage: upstream.message } : {}),
    };

    // A typed autocomplete `q` past the bound 500s on every attempt, with an HTML body that
    // names nothing — read as ServiceUnavailable it would be retried and reported as an outage.
    // `retryable: false` keeps it out of `withRetry`, and the recovery says to shorten the name.
    const overLongQuery = statusCode === 500 ? overLongAutocompleteQuery(path, params) : undefined;
    if (overLongQuery !== undefined) {
      throw invalidParams(
        `OpenAlex autocomplete failed on a ${overLongQuery.toLocaleString('en-US')}-character query — ${path} accepts at most ${AUTOCOMPLETE_QUERY_MAX_CODE_POINTS.toLocaleString('en-US')} characters.`,
        { ...error.data, path, reason: 'query_too_long', retryable: false },
        { cause: error },
      );
    }
    // A semantic search whose query embedding failed upstream comes back as a 400, but the request
    // was valid and the fault is transient. Thrown as the outage it is, it is retried like one, and
    // its message is the server's own: the upstream one names the embedding service's host, and
    // reaches the caller only as `data.upstreamMessage`.
    if (isSemanticEmbedFailure(statusCode, rawMessage, params)) {
      throw serviceUnavailable(
        'OpenAlex could not embed the query for semantic search. The failure is upstream; the request itself is valid.',
        {
          ...error.data,
          path,
          reason: 'upstream_unavailable',
          recovery: { hint: SEMANTIC_UNAVAILABLE_HINT },
          ...upstreamFields,
        },
        { cause: error },
      );
    }
    // A filter OpenAlex serves only on a paid plan comes back as a 429, which reads as a throttle:
    // it would be retried and reported with wait-and-retry advice, yet no wait clears a plan gate.
    // `Forbidden` sits outside `withRetry`'s transient set, so the first request is the only one,
    // and `retryable: false` tells the caller the same over the 429 status left on `data`. The
    // message is the server's own; the upstream text rides `upstreamError` and `upstreamMessage`.
    if (statusCode === 429 && upstream?.error === PLAN_UPGRADE_REQUIRED_ERROR) {
      throw forbidden(
        planGatedFilterMessage(upstream.message),
        {
          ...error.data,
          path,
          reason: 'upstream_plan_required',
          retryable: false,
          ...upstreamFields,
        },
        { cause: error },
      );
    }
    // Status-mapped failures classify off the HTTP status. Everything else — the client-side
    // `REQUEST_TIMEOUT_MS` abort, DNS/connection failures, and the `parseResponse` throws
    // (empty body, HTML, invalid JSON) — never carries a status, so the error's own code is
    // the signal. Routing both through the same table means the transient paths, which are
    // the slowest to fail, arrive with the reason and recovery hint their contract declares
    // instead of an unclassified re-throw.
    const code = statusCode === undefined ? error.code : httpStatusToErrorCode(statusCode);
    const normalized = code === undefined ? undefined : NORMALIZED_THROW_BY_CODE[code];

    if (code === undefined || normalized === undefined) {
      // No mapped reason for this code (a caller-side abort — an upstream 500 now maps to
      // ServiceUnavailable above). Framework fetch errors format the message as `Fetch failed
      // for <URL>. Status: …` — the URL carries the `api_key` credential and the `mailto`
      // identifier. Redact before bubbling.
      throw new McpError(error.code, redactUrlsInMessage(error.message), error.data, {
        cause: error,
      });
    }

    const { factory } = normalized;
    const reason = resolveThrowReason(code, normalized.reason, rawMessage, params);
    // A truncated body's appended valid-fields list is misleading. For an invalid-field
    // 400, replace it with catalog-backed ranked suggestions; otherwise strip it. The two
    // are mutually exclusive — appendFieldSuggestions already drops the partial list, so it
    // must run on the raw message, not the stripped one.
    let sanitizedMessage = rawMessage;
    if (rawMessage !== undefined && upstream?.truncated) {
      const withSuggestions =
        code === JsonRpcErrorCode.InvalidParams
          ? appendFieldSuggestions(rawMessage, path, params)
          : rawMessage;
      sanitizedMessage =
        withSuggestions === rawMessage
          ? stripTruncatedValidFieldsList(rawMessage)
          : withSuggestions;
    }
    const message =
      sanitizedMessage ??
      domainMessageForFetchFailure(error, path) ??
      (code === JsonRpcErrorCode.NotFound
        ? `Entity not found at ${path}`
        : redactUrlsInMessage(error.message));

    const data = {
      ...error.data,
      path,
      reason,
      // `RateLimited` sits in the framework's transient set, so `withRetry` would spend the
      // full attempt budget against a budget wall that stays up until the daily reset. This
      // flag is the framework's per-error opt-out from that loop; the contract's own
      // `retryable` field only informs the client and cannot stop our own retries.
      ...(reason === BUDGET_EXHAUSTED_REASON ? { retryable: false } : {}),
      // Only a keyless server can raise its budget with a key; an explicit hint wins over the
      // key-neutral one the framework fills from the contract.
      ...(reason === BUDGET_EXHAUSTED_REASON && !this.apiKey
        ? { recovery: { hint: BUDGET_EXHAUSTED_KEYLESS_HINT } }
        : {}),
      // A keyword search can answer while semantic search is down, which the contract's generic
      // outage recovery cannot say; an explicit hint wins over it.
      ...(reason === 'upstream_unavailable' && isSemanticSearch(params)
        ? { recovery: { hint: SEMANTIC_UNAVAILABLE_HINT } }
        : {}),
      ...upstreamFields,
    };

    throw factory(message, data, { cause: error });
  }

  private parseResponse<T>(text: string, path: string): T {
    const trimmed = text.trim();
    const responsePreview = trimmed.slice(0, 200);

    if (!trimmed) {
      throw serviceUnavailable(`OpenAlex API returned an empty response for ${path}`, {
        path,
        reason: 'upstream_unavailable',
      });
    }

    if (/^<(!DOCTYPE\s+html|html[\s>])/i.test(trimmed)) {
      throw serviceUnavailable(`OpenAlex API returned HTML instead of JSON for ${path}`, {
        path,
        responsePreview,
        reason: 'upstream_unavailable',
      });
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      // Treated as ServiceUnavailable (not SerializationError) so withRetry's
      // transient set picks it up — OpenAlex truncates responses under load and
      // the next attempt usually succeeds.
      throw serviceUnavailable(
        `OpenAlex API returned invalid JSON for ${path}`,
        {
          path,
          responsePreview,
          reason: 'upstream_unavailable',
        },
        { cause: error },
      );
    }
  }

  /**
   * Search/filter/sort entities, or retrieve a single entity by ID. A works `id` that reads as an
   * arXiv ID is looked up through `workByArxivId`. `params.deadlineMs` bounds every request sent.
   */
  async search(params: SearchParams, ctx: Context): Promise<SearchResult> {
    // Singleton lookup by ID
    if (params.id) {
      const arxivId = params.entityType === 'works' ? parseArxivId(params.id) : undefined;
      if (arxivId) return this.workByArxivId(arxivId, params, ctx);

      const normalizedId = normalizeId(params.id);
      assertIdMatchesEntityType(normalizedId, params.entityType);
      const select = resolveSelect(params.entityType, params.select);

      if (params.entityType === 'funders' && normalizedId.startsWith('doi:')) {
        return this.funderByDoi(normalizedId.slice('doi:'.length), select, ctx);
      }

      const data = (await this.requestWithin(
        byIdPath(params.entityType, normalizedId, params.id),
        select ? { select: select.join(',') } : {},
        ctx,
        params.deadlineMs,
      )) as EntityRecord;

      return {
        meta: { count: 1, per_page: 1, next_cursor: null },
        results: normalizeEntityRecords([data], authorListShape(params.entityType, params.select)),
      };
    }

    // Search/filter/list
    const queryParams: Record<string, string> = {};

    if (params.query) {
      queryParams[getSearchParamKey(params.searchMode)] = params.query;
    }

    if (hasEntries(params.filters)) {
      queryParams.filter = buildSearchFilter(params.entityType, params.filters);
    }

    const sort = normalizeSort(params.sort);
    if (sort) {
      // Translate "-field" prefix to "field:desc" (OpenAlex API syntax)
      queryParams.sort = sort;
    }

    const select = resolveSelect(params.entityType, params.select);
    if (select) {
      queryParams.select = select.join(',');
    }

    // `per_page` sizes every page, a sample's included: OpenAlex draws `sample` records and
    // serves them `per_page` at a time, so a draw larger than one page is walked with `page`.
    queryParams.per_page = String(params.perPage ?? 25);
    if (params.sample !== undefined) {
      queryParams.sample = String(params.sample);
      if (params.seed !== undefined) queryParams.seed = params.seed;
    }

    // Semantic search and samples walk with `page` — OpenAlex answers `search.semantic` plus a
    // cursor with a 400, and pages a seeded draw by number. Every other listing walks by cursor.
    // The tool rejects `cursor` on either, `sample` under semantic mode (OpenAlex ignores it
    // there, and the population request below would pair `search.semantic` with `cursor=*`),
    // `sample` beside `sort` (OpenAlex refuses the pair), and `page` on an unseeded sample or
    // past the first 10,000 records of one (both 400s upstream), so none reaches this method.
    if (params.searchMode === 'semantic' || params.sample !== undefined) {
      if (params.page !== undefined) queryParams.page = String(params.page);
    } else {
      queryParams.cursor = params.cursor ?? '*';
    }

    const searchRequest = this.requestWithin(
      `/${params.entityType}`,
      queryParams,
      ctx,
      params.deadlineMs,
    ) as Promise<{
      meta: SearchResult['meta'];
      results: EntityRecord[];
    }>;

    // Sampling: OpenAlex returns the drawn size, min(sample, population), in `meta.count`, not
    // the population matching the filters. The output schema documents `count` as "Total
    // results matching the query/filters" — issue a parallel per_page=1 lookup without the
    // sample's own parameters to recover the true population and overwrite `count` with it.
    let populationRequest: Promise<{ meta: { count: number } }> | undefined;
    if (params.sample !== undefined) {
      const { sample: _sample, seed: _seed, page: _page, ...filterParams } = queryParams;
      populationRequest = this.requestWithin(
        `/${params.entityType}`,
        { ...filterParams, per_page: '1', cursor: '*' },
        ctx,
        params.deadlineMs,
      ) as Promise<{ meta: { count: number } }>;
    }

    const [data, populationData] = await Promise.all([searchRequest, populationRequest]);

    return {
      meta: {
        ...data.meta,
        ...(populationData !== undefined && { count: populationData.meta.count }),
        next_cursor: data.meta.next_cursor ?? null,
      },
      results: normalizeEntityRecords(
        data.results,
        authorListShape(params.entityType, params.select),
      ),
    };
  }

  /**
   * Look a funder up by its Crossref Funder Registry DOI. OpenAlex's `/funders/doi:` path
   * resolves nothing, so this is a one-result list request on the `ids.doi` filter, which OpenAlex
   * bills like any list request. A value the filter would read as more than one literal DOI fails
   * as not found without a request (see `funderDoiFilter`).
   */
  private async funderByDoi(
    doi: string,
    select: string[] | undefined,
    ctx: Context,
  ): Promise<SearchResult> {
    const missing = () =>
      notFound(`No funder in OpenAlex carries the DOI ${doi}.`, {
        reason: 'entity_not_found',
        path: '/funders',
      });
    const filter = funderDoiFilter(doi);
    if (!filter) throw missing();

    const data = (await this.request(
      '/funders',
      { filter, per_page: '1', ...(select ? { select: select.join(',') } : {}) },
      ctx,
    )) as { results: EntityRecord[] };
    const [record] = data.results;
    if (!record) throw missing();

    return {
      meta: { count: 1, per_page: 1, next_cursor: null },
      results: normalizeEntityRecords([record]),
    };
  }

  /**
   * Look a work up by arXiv ID (gh #137). OpenAlex has no arXiv-ID path, so it takes up to three
   * requests:
   *
   * 1. `/works/doi:10.48550/arXiv.<id>`, the DOI arXiv registers for every article — unbilled.
   *    A failure other than a 404 is thrown as any by-ID lookup's is.
   * 2. On that 404, one list request for works with a location at the arXiv landing page, billed
   *    as a list request. A row counts only when the location at that page is arXiv's own
   *    (`ARXIV_SOURCE_ID`): a repository record can carry the same URL on an unrelated work.
   * 3. On one counted row, that work by ID with the caller's `select` — unbilled, and a
   *    singleton, so its author arrays run to 5,000 rather than a list record's 100.
   *
   * Steps 2 and 3 get what is left of `FALLBACK_DEADLINE_MS` from the start of step 1, and of
   * `params.deadlineMs` when the caller set one. The landing-page lookup reads again an ID whose
   * DOI already missed, so none of its failures turns that miss into an outage: no counted row,
   * two or more (`data.candidates`), a transient failure, a spent budget, or no time left
   * (`data.fallbackFailedReason`) all fail as `entity_not_found`. A request OpenAlex refused
   * (400, 401, 403, …) is thrown as classified — the server built it — as are a caller
   * cancellation and any failure of step 3, whose work the list already found.
   */
  private async workByArxivId(
    arxiv: ArxivId,
    params: SearchParams,
    ctx: Context,
  ): Promise<SearchResult> {
    const startedAt = Date.now();
    const select = resolveSelect('works', params.select);
    const selectParams = select ? { select: select.join(',') } : {};
    const doi = arxivDoi(arxiv.id);
    const found = (record: EntityRecord, via: ArxivResolution['via']): SearchResult => ({
      meta: { count: 1, per_page: 1, next_cursor: null },
      results: normalizeEntityRecords([record], authorListShape('works', params.select)),
      arxiv: {
        arxivId: arxiv.id,
        ...(arxiv.version !== undefined && { droppedVersion: arxiv.version }),
        via,
      },
    });

    try {
      const record = await this.requestWithin(
        byIdPath('works', `doi:${doi}`),
        selectParams,
        ctx,
        params.deadlineMs,
      );
      return found(record as EntityRecord, 'doi');
    } catch (error) {
      if (!(error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)) throw error;
    }

    const timeLeft = () =>
      Math.min(FALLBACK_DEADLINE_MS, params.deadlineMs ?? Number.POSITIVE_INFINITY) -
      (Date.now() - startedAt);
    const urls = arxivLandingPageUrls(arxiv.id);
    const [, page] = urls;
    const miss = (detail: string, data: Record<string, unknown> = {}, cause?: unknown) =>
      notFound(
        `No work in OpenAlex carries the DOI ${doi}, and ${detail}`,
        { reason: 'entity_not_found', path: '/works', arxivId: arxiv.id, ...data },
        cause === undefined ? undefined : { cause },
      );
    const failedLookup = (fallbackFailedReason: string, cause?: unknown) => {
      ctx.log.notice('arXiv landing-page lookup failed upstream', {
        arxivId: arxiv.id,
        reason: fallbackFailedReason,
      });
      return miss(
        `the landing-page lookup that finds a work without it failed upstream (${fallbackFailedReason}).`,
        {
          fallbackFailedReason,
          recovery: {
            hint:
              fallbackFailedReason === BUDGET_EXHAUSTED_REASON
                ? ARXIV_BUDGET_EXHAUSTED_HINT
                : ARXIV_FALLBACK_FAILED_HINT,
          },
        },
        cause,
      );
    };

    let body: unknown;
    try {
      body = await this.requestWithin(
        '/works',
        {
          filter: `locations.landing_page_url:${urls.join('|')}`,
          select: 'id,locations',
          per_page: String(ARXIV_LANDING_PAGE_ROWS),
        },
        ctx,
        timeLeft(),
      );
    } catch (error) {
      const reason = landingPageFailureReason(error, ctx.signal);
      if (reason === undefined) throw error;
      throw failedLookup(reason, error);
    }

    const rows = isRecord(body) && Array.isArray(body.results) ? body.results : undefined;
    if (rows === undefined) throw failedLookup('upstream_unavailable');
    const candidates = rows.flatMap((row) => arxivLandingWorkId(row, urls) ?? []);
    const [candidate] = candidates;
    if (candidate === undefined) {
      throw miss(`none has an arXiv location at its landing page ${page}.`);
    }
    if (candidates.length > 1) {
      throw miss(
        `${candidates.length} works have an arXiv location at its landing page ${page}: ${candidates.join(', ')}.`,
        { candidates, recovery: { hint: ARXIV_CANDIDATES_HINT } },
      );
    }

    const record = await this.requestWithin(
      byIdPath('works', candidate),
      selectParams,
      ctx,
      timeLeft(),
    );
    return found(record as EntityRecord, 'landing_page');
  }

  /**
   * `request()` bounded by `deadlineMs`, what is left of a deadline spanning several requests. With
   * none left it fails as `upstream_timeout` before sending. Without `deadlineMs` it is
   * `request()` unchanged.
   */
  private async requestWithin(
    path: string,
    params: Record<string, string>,
    ctx: Context,
    deadlineMs: number | undefined,
  ): Promise<unknown> {
    if (deadlineMs !== undefined && deadlineMs <= 0) {
      throw timeout(`No time was left to ask OpenAlex for ${path} before this call's deadline.`, {
        path,
        reason: 'upstream_timeout',
      });
    }
    return await this.request(path, params, ctx, deadlineMs);
  }

  /** Group-by aggregation. */
  async analyze(params: AnalyzeParams, ctx: Context): Promise<AnalyzeResult> {
    const queryParams: Record<string, string> = {};

    const baseField = params.groupBy.replace(/:include_unknown$/, '');
    const includeUnknown = params.includeUnknown === true || baseField !== params.groupBy;
    queryParams.group_by = includeUnknown ? `${baseField}:include_unknown` : baseField;

    if (hasEntries(params.filters)) {
      queryParams.filter = buildSearchFilter(params.entityType, params.filters);
    }

    if (params.perPage !== undefined) {
      queryParams.per_page = String(params.perPage);
    }

    // Boolean group_by fields (see `isBooleanGroupBy`) only produce two groups (true/false) and
    // reject cursor pagination with a 400, so they keep count order even under order "key".
    //
    // For all other fields, cursor behaviour follows the sort order:
    //   - count-desc (default): omit cursor on the first page so OpenAlex returns groups
    //     count-descending. `next_cursor` will be null — count-desc has no next page.
    //   - key-asc (order: "key"): send cursor=* on the first page. OpenAlex returns groups
    //     in key-ascending order and emits a `next_cursor` for full enumeration.
    //   - subsequent pages: forward the caller-supplied cursor as-is.
    const keyAscOrder = !isBooleanGroupBy(baseField) && params.order === 'key';

    if (params.cursor) {
      queryParams.cursor = params.cursor;
    } else if (keyAscOrder) {
      queryParams.cursor = '*';
    }

    const path = `/${params.entityType}`;
    const data = (await this.request(path, queryParams, ctx)) as {
      meta: { count: number; groups_count?: number | null; next_cursor?: string | null };
      group_by?: AnalyzeResult['groups'] | undefined;
    };

    // No `group_by` key at all is OpenAlex's plain *list* shape — the aggregation never ran.
    // Defaulting it to `[]` reported a successful aggregation of nothing, which a caller reads
    // as "the filters matched no groups". A present-but-empty array is that honest answer and
    // passes through.
    if (data.group_by === undefined) {
      throw serviceUnavailable(
        `OpenAlex returned no group_by aggregation for ${path} (group_by=${params.groupBy})`,
        { path, reason: 'upstream_missing_group_by' },
      );
    }

    return {
      meta: {
        count: data.meta.count,
        groups_count: data.meta.groups_count ?? data.group_by.length,
        next_cursor: data.meta.next_cursor ?? null,
      },
      groups: data.group_by.map((group) => normalizeGroup(group, includeUnknown)),
    };
  }

  /**
   * Resolve an identifier to the entities it addresses, shaped as autocomplete matches — one
   * lookup per entity type in `identifier.entityTypes`, run in parallel, with the records found
   * returned in that order.
   *
   * Autocomplete matches on `display_name` and the external-ID URL, so whether an identifier
   * resolves through it depends on scheme, bare-vs-URL form, and entity type — a bare ORCID or
   * a funder's own OpenAlex ID find nothing, while the identical query on works succeeds. This
   * path goes to `/{entity_type}/{id}` instead, where every accepted shape resolves or does not,
   * with no in-between.
   *
   * A miss returns no results rather than throwing. Autocomplete answers an unmatched query with
   * an empty list, and routing identifiers through here is meant to make them behave *more* like
   * the front door, not to hand one class of query a hard failure the rest never sees.
   *
   * A lookup that fails for any other reason drops only its own type, named in
   * `failedEntityTypes`, while another type returned a record. With no record to return, or once
   * the caller has cancelled, the failure is thrown instead — an empty or partial answer there
   * would claim records do not exist when the lookup for them never finished.
   *
   * `nameSearch` is the autocomplete to run when every lookup finds nothing — for a query that
   * may be a name rather than an ID (`ResolvedIdentifier.mayBeName`). It runs only on that miss,
   * so an ID that resolves still costs its one request, and only within what is left of
   * `FALLBACK_DEADLINE_MS` from the start of this call (see `nameSearchAfterMiss`).
   *
   * An arXiv ID's lookup reports how it reached its work as `arxiv`, and a miss past the plain one
   * — several candidate works, or a failed landing-page lookup — as `arxivMiss`.
   *
   * `query` is the text `identifier` was read from, as the caller wrote it. The lookups are sent
   * that spelling, which `search()` normalizes back to `identifier.id`, so a lookup that refuses
   * the identifier quotes what the caller sent.
   */
  async resolveIdentifier(
    identifier: ResolvedIdentifier,
    ctx: Context,
    nameSearch?: AutocompleteParams,
    query: string = identifier.id,
  ): Promise<IdentifierResolution> {
    const startedAt = Date.now();
    const settled = await Promise.allSettled(
      identifier.entityTypes.map((entityType) => this.search({ entityType, id: query }, ctx)),
    );

    const results: AutocompleteRecord[] = [];
    const failed: { entityType: EntityType; error: unknown }[] = [];
    let arxiv: ArxivResolution | undefined;
    let arxivMiss: IdentifierResolution['arxivMiss'];
    settled.forEach((outcome, index) => {
      const entityType = identifier.entityTypes[index] as EntityType;
      if (outcome.status === 'fulfilled') {
        const [record] = outcome.value.results;
        if (record) results.push(toAutocompleteRecord(entityType, record));
        arxiv ??= outcome.value.arxiv;
      } else if (
        outcome.reason instanceof McpError &&
        outcome.reason.code === JsonRpcErrorCode.NotFound
      ) {
        ctx.log.debug('Identifier resolved to no entity', {
          identifier: identifier.id,
          entityType,
        });
        arxivMiss ??= arxivMissDetail(outcome.reason);
      } else {
        failed.push({ entityType, error: outcome.reason });
      }
    });

    const [firstFailure] = failed;
    if (firstFailure && (results.length === 0 || ctx.signal.aborted)) throw firstFailure.error;
    if (results.length === 0 && nameSearch) {
      return this.nameSearchAfterMiss(
        nameSearch,
        FALLBACK_DEADLINE_MS - (Date.now() - startedAt),
        ctx,
      );
    }
    return {
      results,
      ...(arxiv && { arxiv }),
      ...(arxivMiss && { arxivMiss }),
      ...(failed.length > 0 ? { failedEntityTypes: failed.map((f) => f.entityType) } : {}),
    };
  }

  /**
   * The name search an identifier lookup falls back to after finding nothing, bounded by the
   * `remainingMs` the lookup left of the call's deadline. It is a best-effort second reading of
   * the query, so a transient upstream failure — a timeout, the deadline running out, an outage,
   * a burst throttle — comes back as `nameFallback.failedReason` for the caller to see, beside
   * the lookup's own true miss. A caller cancellation, a request upstream rejected, a spent
   * budget, and anything unclassified are thrown: none of them is cured by calling again, and an
   * answer in their place would hide the error the caller needs to act on.
   */
  private async nameSearchAfterMiss(
    params: AutocompleteParams,
    remainingMs: number,
    ctx: Context,
  ): Promise<IdentifierResolution> {
    if (remainingMs <= 0) {
      return { results: [], nameFallback: { failedReason: 'upstream_timeout' } };
    }
    try {
      const { results } = await this.autocomplete(params, ctx, remainingMs);
      return { results, nameFallback: {} };
    } catch (error) {
      const reason =
        error instanceof McpError && defaultIsTransient(error)
          ? NORMALIZED_THROW_BY_CODE[error.code]?.reason
          : undefined;
      if (ctx.signal.aborted || reason === undefined) throw error;
      ctx.log.notice('Name search after an identifier miss failed upstream', {
        query: params.query,
        reason,
      });
      return { results: [], nameFallback: { failedReason: reason } };
    }
  }

  /**
   * Autocomplete name resolution. `deadlineMs` bounds the whole request, retries included (see
   * `request`).
   */
  async autocomplete(
    params: AutocompleteParams,
    ctx: Context,
    deadlineMs?: number,
  ): Promise<AutocompleteResult> {
    const path = params.entityType ? `/autocomplete/${params.entityType}` : '/autocomplete';

    const queryParams: Record<string, string> = {
      q: params.query,
    };

    if (hasEntries(params.filters)) {
      queryParams.filter = buildFilterString(Object.entries(params.filters));
    }

    const data = (await this.request(path, queryParams, ctx, deadlineMs)) as {
      results: AutocompleteResult['results'];
    };

    // Cross-entity autocomplete can return types not in our enum (country, license, etc.).
    // Filter to known entity types so callers can use results in other tools directly.
    const results = params.entityType
      ? data.results
      : data.results.filter((r) => KNOWN_AUTOCOMPLETE_TYPES.has(r.entity_type));

    return { results: normalizeAutocompleteRecords(results) };
  }
}

let _service: OpenAlexService | undefined;

export function initOpenAlexService(): void {
  _service = new OpenAlexService();
}

export function getOpenAlexService(): OpenAlexService {
  if (!_service)
    throw new Error('OpenAlexService not initialized — call initOpenAlexService() in setup()');
  return _service;
}

type FieldCatalog = Record<EntityType, { filter: string[]; select: string[] }>;

/**
 * The field catalog: OpenAlex's valid-field lists as `scripts/generate-field-catalog.ts` writes
 * them to `field-catalog.json`, plus the select fields this server derives itself
 * (`author_list` on works), which no upstream list names and the generator would drop.
 */
const FIELD_CATALOG: FieldCatalog = {
  ...(fieldCatalog as FieldCatalog),
  works: { ...fieldCatalog.works, select: [...fieldCatalog.works.select, AUTHOR_LIST_FIELD] },
};

/**
 * Return the typed field catalog keyed by entity type → context → field list.
 * Only `filter` and `select` arrays are stored. `group_by` resolves to the `filter` key here;
 * the describe-fields handler then prunes the fields group_by cannot target (raw dates,
 * `*.search` operators, `from_*`/`to_*` range modifiers, and a per-type set from a live sweep).
 */
export function getFieldCatalog(): FieldCatalog {
  return FIELD_CATALOG;
}
