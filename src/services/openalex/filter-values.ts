/**
 * @fileoverview A filter value in the form OpenAlex reads: country and `language` values
 * converted to the codes OpenAlex stores; a value with spaces or a comma on a key OpenAlex matches
 * as whole text — a name, city, region, raw affiliation string, award number, or `biblio` field —
 * double-quoted, so its spaces and commas stay part of it; and the AND operator — a `+`, or on a
 * key where words mean AND, a space between them — sent as the AND it spells. Values that are
 * text rather than filter syntax keep their `+` literal: free-text search phrases, DOIs, dates,
 * URLs, exactly matched names, `biblio` fields, award numbers, and any value the caller wrapped
 * in quotes. A value that puts an AND operator beside a `|` (OR) fails, since OpenAlex splits on
 * `|` first and drops every alternative that ANDs more than one value. A value sent double-quoted
 * holds no `"` of its own, which would end the quoted phrase early and let the text after it
 * parse as further filter clauses.
 * @module services/openalex/filter-values
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

import isoCodes from './iso-codes.json' with { type: 'json' };

/**
 * Lookups from the bundled ISO 3166-1 / ISO 639-2 table (`scripts/generate-iso-codes.ts`).
 * Maps rather than the JSON objects, so a segment such as `constructor` or `__proto__` reads as
 * no entry instead of an inherited member.
 */
const COUNTRY_BY_ALPHA3 = new Map(Object.entries(isoCodes.countries.alpha3));
const COUNTRY_BY_NUMERIC = new Map(Object.entries(isoCodes.countries.numeric));
const COUNTRY_BY_NAME = new Map(Object.entries(isoCodes.countries.names));
const LANGUAGE_BY_ALPHA3 = new Map(Object.entries(isoCodes.languages.alpha3));
const LANGUAGE_BY_NAME = new Map(Object.entries(isoCodes.languages.names));

const TWO_LETTERS = /^[A-Za-z]{2}$/;
const THREE_LETTERS = /^[A-Za-z]{3}$/;

/** The most of a caller's text an error message quotes; the error's `data` keeps it whole. */
const ECHO_MAX_CHARS = 200;

/**
 * Caller text as an error message quotes it: JSON-encoded, so a line break stays escaped, and
 * capped, so caller-sized text cannot bloat the message.
 */
export function quoteCallerText(text: string): string {
  return JSON.stringify(text.length > ECHO_MAX_CHARS ? `${text.slice(0, ECHO_MAX_CHARS)}…` : text);
}

/** Parse native clauses without splitting quoted commas or colons inside a value. */
export function parseNativeFilters(input: string): Record<string, string> {
  const filters: Record<string, string> = Object.create(null);
  let quoted = false;
  let start = 0;
  let colon = -1;
  for (let index = 0; index <= input.length; index++) {
    const char = input[index];
    if (char === '"') quoted = !quoted;
    if (char === ':' && colon === -1 && !quoted) colon = index;
    if (index !== input.length && (char !== ',' || quoted)) continue;
    if (quoted) {
      throw validationError(
        'Native filter string has unmatched double quotes. Pair the quotes, or pass filters as a record object with one key per field.',
        {
          reason: 'invalid_filter_string',
          recovery: {
            hint: 'Pass filters as a record object with one key per field, and pair any double quotes in search phrases.',
          },
        },
      );
    }
    const key = input.slice(start, colon === -1 ? start : colon).trim();
    if (colon < start || key.length === 0) {
      throw validationError(
        'Each native filter clause needs a nonempty key followed by a colon. Pass filters as a record object with one key per field.',
        {
          reason: 'invalid_filter_string',
          recovery: {
            hint: 'Pass filters as a record object with one key per field, and pair any double quotes in search phrases.',
          },
        },
      );
    }
    if (Object.hasOwn(filters, key)) {
      throw validationError(
        'Native filter string repeats a key. A filters record object holds one key per field; combine alternatives with "|", or run separate calls.',
        {
          reason: 'duplicate_filter_string_key',
          filterKey: key,
          recovery: {
            hint: 'A filters record object holds one key per field; combine alternatives with "|", or run separate calls.',
          },
        },
      );
    }
    filters[key] = input.slice(colon + 1, index);
    start = index + 1;
    colon = -1;
  }
  return filters;
}

/** Reject an unpaired quote only on values that remain unquoted on the upstream wire. */
function assertPairedQuotes(key: string, value: string): void {
  let quoted = false;
  for (let index = value.indexOf('"'); index !== -1; index = value.indexOf('"', index + 1))
    quoted = !quoted;
  if (quoted) {
    throw validationError(
      `Filter ${quoteCallerText(key)} value has an unmatched double quote. Pair double quotes used for a search phrase, or remove the stray quote.`,
      { reason: 'unmatched_quote_in_filter_value', filterKey: key },
    );
  }
}

/**
 * Reject a double-quoted value, `sent` exactly as the clause sends it, when a `"` sits inside its
 * outer pair (a leading `!` aside). OpenAlex ends a quoted phrase at the next `"` with no escape
 * for one inside, so an interior quote closes the phrase early and the text after it reads as
 * further filter clauses. Checking the value as sent, after any wrapping, is what catches a
 * caller's quote pair the wrap encloses (`! "New York"` goes out as `"! "New York""`). Runs before
 * any request.
 */
function assertNoInteriorQuote(key: string, sent: string): void {
  const trimmed = sent.trim();
  const body = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
  const inner =
    body.length >= 2 && body.startsWith('"') && body.endsWith('"') ? body.slice(1, -1) : body;
  if (inner.includes('"')) {
    throw validationError(
      `Filter ${quoteCallerText(key)} value is sent to OpenAlex as a quoted phrase and cannot contain a double quote of its own. Remove the double quote from the value.`,
      { reason: 'quote_in_filter_value', filterKey: key },
    );
  }
}

/**
 * The key suffixes OpenAlex country-code fields end in, across every entity type — and nothing
 * else: `countries_distinct_count` is a number.
 */
const COUNTRY_KEY_SUFFIXES = ['country_code', 'country_codes', 'countries'];

/** A `.search` segment, at the end of the key or followed by a suffix such as `.exact`. */
const FREE_TEXT_SEARCH_KEY = /\.search(?:\.|$)/;

/**
 * Whether `key` is a free-text search filter — `title.search`, `abstract.search.exact`,
 * `title_abstract_keywords.search`, `semantic.search` — whose value is a phrase rather than
 * filter syntax. `quotedCommaValue()` sends such a value holding a comma double-quoted, so the
 * comma stays part of the phrase, and `upstreamFilterValue()` keeps its `+` literal.
 */
function isFreeTextSearchKey(key: string): boolean {
  return FREE_TEXT_SEARCH_KEY.test(key);
}

/**
 * Whether a `+` in this (hyphen-normalized) key's value is a literal character, because the value
 * is text rather than filter syntax: a free-text search filter; a DOI filter (`doi`,
 * `doi_starts_with`, `awards.doi`, `ids.doi`), whose values include SICI DOIs such as
 * `10.1002/1097-0142(19940801)74:3+<1030::…>`; a date (every `_date` key), where the `+hh:mm` of
 * a timestamp — which `from_created_date` and `to_updated_date` take, unlike `publication_date` —
 * is its UTC offset; a URL
 * (`primary_location.landing_page_url`), which can carry a `+` of its own — every `_url` key but a
 * `has_` boolean such as `has_pdf_url`; a name matched exactly (`display_name`,
 * `awards.funder_display_name`), such as the keyword `C++` or the funder `Erasmus+`; a `biblio`
 * field, such as the combined issue `1+2`; and an award number as its funder deposited it
 * (`awards.funder_award_id`).
 */
function keepsPlusLiteral(field: string): boolean {
  if (isFreeTextSearchKey(field) || field.startsWith('biblio.')) return true;
  const leaf = field.slice(field.lastIndexOf('.') + 1);
  return (
    leaf === 'doi' ||
    leaf === 'doi_starts_with' ||
    leaf === 'display_name' ||
    leaf === 'funder_display_name' ||
    leaf === 'funder_award_id' ||
    leaf.endsWith('_date') ||
    (leaf.endsWith('_url') && !leaf.startsWith('has_'))
  );
}

/**
 * The leaves of the (hyphen-normalized) keys whose values OpenAlex matches as whole text and
 * stores with spaces: names (`display_name`, `awards.funder_display_name`), cities and regions
 * (`geo.city`, `authorships.institutions.geo.region`), raw affiliation strings, award numbers as
 * their funder deposited them (`DE AC02 05CH11231`), and an author's `block_key` (`j priem`).
 * Every `biblio` field (issue `Supplement 1`) and `parsed_longest_name` part is such a key too.
 */
const PHRASE_KEY_LEAVES = new Set([
  'display_name',
  'funder_display_name',
  'funder_award_id',
  'city',
  'region',
  'raw_affiliation_strings',
  'block_key',
]);

function isPhraseKey(field: string): boolean {
  return (
    field.startsWith('biblio.') ||
    field.startsWith('parsed_longest_name.') ||
    PHRASE_KEY_LEAVES.has(field.slice(field.lastIndexOf('.') + 1))
  );
}

/** Whether `value` is already wrapped in double quotes, a leading `!` aside: `!"New York"`. */
function isQuoted(value: string): boolean {
  const body = value.startsWith('!') ? value.slice(1) : value;
  return body.length >= 2 && body.startsWith('"') && body.endsWith('"');
}

/**
 * The value as one double-quoted phrase, when a phrase key's value has a space between words and
 * the caller has not quoted it; otherwise `undefined`. OpenAlex reads an unquoted space as AND,
 * so `geo.city:New York` asks for a city named both `New` and `York` and matches nothing, while
 * `geo.city:"New York"` matches the city. The quote goes around the whole value: OpenAlex strips
 * it before reading `!` and `|`, so `"!New York"` excludes the city and `"New York|Boston"`
 * matches either — and it reads a quote around a single `|` alternative as part of that
 * alternative. It keeps edge whitespace inside the quotes (`" New York "` matches nothing), so the
 * phrase is sent trimmed. A value with a `+` that means AND is left alone: no single clause ANDs a
 * phrase with another value, quoted or not, so it goes out as it did before.
 */
function quotedPhrase(field: string, value: string): string | undefined {
  if (!isPhraseKey(field)) return;
  const phrase = value.trim();
  if (!phrase.includes(' ') || isQuoted(phrase)) return;
  if (phrase.includes('+') && !keepsPlusLiteral(field)) return;
  return `"${phrase}"`;
}

/**
 * A value holding a comma as its clause sends it, or `undefined` where the key takes no phrase
 * and the comma could only read as OpenAlex's clause separator. A free-text search value or a
 * phrase key's value goes out whole and double-quoted, as written — `|` still ORs inside the
 * quotes, a leading `!` still negates the whole value, and a `+` is the literal character, which
 * no clause could AND with a phrase anyway. A phrase key's value is trimmed first, as
 * `quotedPhrase()` trims, and one the caller quoted (a leading `!` aside) is sent as written.
 * Either way the value as sent cannot hold a `"` inside its outer pair, which would end the quoted
 * phrase early (`quote_in_filter_value`).
 */
export function quotedCommaValue(key: string, value: string): string | undefined {
  let sent: string;
  if (isFreeTextSearchKey(key)) {
    sent = value.startsWith('"') && value.endsWith('"') ? value : `"${value}"`;
  } else if (isPhraseKey(key.replaceAll('-', '_'))) {
    const phrase = value.trim();
    sent = isQuoted(phrase) ? phrase : `"${phrase}"`;
  } else {
    return;
  }
  assertNoInteriorQuote(key, sent);
  return sent;
}

/**
 * One country segment as OpenAlex stores it: an alpha-3 code, numeric code, or English name —
 * ISO's, or the one OpenAlex displays for the country (`Russia`, `Ivory Coast`) — becomes its
 * alpha-2 code, and `UK` becomes `GB` (ISO 3166-1 reserves it for the United Kingdom). Two- and
 * three-letter segments it does not map, `null`, empty segments, and the
 * `countries/DE` path forms are sent as given — stored values include non-ISO two-letter codes
 * (`XK`), MARC three-letter codes (`NYU`), and alpha-3 tags reachable only by path. Anything
 * else cannot be a country code and matches nothing, so it fails here — a segment holding a space
 * included, since a space is part of a name (`South Korea`) and never separates two codes
 * (`DE US`), and the message says so.
 */
function countrySegment(segment: string, key: string): string {
  if (segment === '' || segment === 'null' || segment.includes('/')) return segment;
  if (TWO_LETTERS.test(segment)) return segment.toUpperCase() === 'UK' ? 'GB' : segment;
  if (THREE_LETTERS.test(segment)) return COUNTRY_BY_ALPHA3.get(segment.toUpperCase()) ?? segment;
  const code = COUNTRY_BY_NUMERIC.get(segment) ?? COUNTRY_BY_NAME.get(segment.toLowerCase());
  if (code !== undefined) return code;
  const spaced = segment.includes(' ')
    ? ' A space is part of a country name ("South Korea"), never a separator: join codes with "|" for OR or "+" for AND.'
    : '';
  throw validationError(
    `Filter ${quoteCallerText(key)} value ${quoteCallerText(segment)} is not a country code. Country filters take ISO 3166-1 alpha-2 codes such as "DE"; an alpha-3 code ("DEU"), a numeric code ("276"), or an English country name ("Germany") is converted to one, and "null" matches records with no country.${spaced}`,
    { reason: 'invalid_country_code', filterKey: key, segment },
  );
}

/**
 * One `language` segment as OpenAlex stores it: an ISO 639-2 code with an ISO 639-1 equivalent
 * becomes that code (`eng` → `en`), and an English language name becomes its code (`English` →
 * `en`). Everything else is sent as given — stored values include three-letter codes with no
 * ISO 639-1 equivalent (`ceb`), regional tags (`zh-cn`), and native names (`中文`) — so no
 * language value is rejected.
 */
function languageSegment(segment: string): string {
  if (TWO_LETTERS.test(segment)) return segment;
  if (THREE_LETTERS.test(segment)) return LANGUAGE_BY_ALPHA3.get(segment.toLowerCase()) ?? segment;
  return LANGUAGE_BY_NAME.get(segment.toLowerCase()) ?? segment;
}

/**
 * Whether `value` puts a `|` beside a `+` that means AND, which no filter value can carry:
 * OpenAlex splits a value on `|` first, and an alternative that ANDs more than one value matches
 * nothing, so `DE|FR+US` answers with the German works alone. A `+` is no AND where
 * `keepsPlusLiteral()`, nor inside a phrase key's value the caller wrapped in quotes, which
 * OpenAlex reads as text split on `|`. Read from the caller's value before any conversion, so
 * `Narnia|FR+US` fails for its operators, not its unknown country.
 */
function mixesOrWithPlus(field: string, value: string): boolean {
  if (!value.includes('|') || !value.includes('+') || keepsPlusLiteral(field)) return false;
  return !(isPhraseKey(field) && isQuoted(value.trim()));
}

/**
 * Whether a `|` alternative of `value` holds a space where a space between words is the AND
 * operator: on an ID or code key, `A1 A2|A3` drops to `A1|A3` (or matches nothing for a code)
 * exactly as `A1+A2|A3` would. Read from the value as converted, where a country or `language`
 * name is already its code: `South Korea|Japan` goes out as `KR|JP`, a multi-word country segment
 * that is no name has failed as `invalid_country_code` (`DE US|FR`), and only a segment sent as
 * given keeps its space — a `language` segment that names no language (`en fr|de`) or a country
 * path form. Never on a phrase key, whose multi-word value is sent wholly double-quoted (its spaces
 * literal), nor where `keepsPlusLiteral()`.
 */
function mixesOrWithSpace(field: string, value: string): boolean {
  if (!value.includes('|') || keepsPlusLiteral(field) || isPhraseKey(field)) return false;
  return value.split('|').some((alternative) => alternative.trim().includes(' '));
}

function mixedAndOrError(key: string) {
  return validationError(
    `Filter ${quoteCallerText(key)} value mixes "|" (OR) with an AND operator — a "+" or a space — which one OpenAlex filter value cannot combine: OpenAlex splits the value on "|" first, and an alternative that ANDs more than one value matches nothing, so that alternative would be dropped without notice.`,
    { reason: 'mixed_and_or_in_filter_value', filterKey: key },
  );
}

/**
 * A filter value as its clause sends it. A value putting `|` beside an AND operator fails as
 * `mixed_and_or_in_filter_value`: a `+` read from the caller's value (`mixesOrWithPlus()`), or a
 * space on a key where words mean AND, read from the value as converted (`mixesOrWithSpace()`).
 * On a country key or `language`, each `|`/`+` segment is trimmed and converted on its own, a
 * leading `!` and the operators kept, so a multi-word name is one value (`South Korea|Japan` →
 * `KR|JP`); upstream accepts a hyphenated key spelling, so `country-code` reads as
 * `country_code`. A phrase key's multi-word value goes out as `quotedPhrase()` writes it. A value
 * the caller wrapped in quotes goes out as written, its `+` a literal character. Otherwise, unless
 * `keepsPlusLiteral()`, each `+` becomes a space: OpenAlex reads AND only from a decoded space — a
 * raw `+` in the query string, which is what `URLSearchParams` sends for a space — and reads a
 * `%2B` as a literal plus. Any value sent double-quoted is checked for a `"` of its own
 * (`assertNoInteriorQuote()`).
 */
export function upstreamFilterValue(key: string, value: string): string {
  const field = key.replaceAll('-', '_');
  if (mixesOrWithPlus(field, value)) throw mixedAndOrError(key);
  const convert = COUNTRY_KEY_SUFFIXES.some((suffix) => field.endsWith(suffix))
    ? (segment: string) => countrySegment(segment, key)
    : field === 'language'
      ? languageSegment
      : undefined;
  const converted =
    convert === undefined
      ? value
      : value
          .split(/([|+])/)
          .map((part, index) => {
            if (index % 2 === 1) return part;
            const trimmed = part.trim();
            return trimmed.startsWith('!')
              ? `!${convert(trimmed.slice(1).trim())}`
              : convert(trimmed);
          })
          .join('');
  if (mixesOrWithSpace(field, converted)) throw mixedAndOrError(key);
  const phrase = quotedPhrase(field, converted);
  if (phrase !== undefined) {
    assertNoInteriorQuote(key, phrase);
    return phrase;
  }
  /**
   * A value the caller wrapped in quotes goes out as written, its `+` a literal character, and
   * carries no `"` beyond that pair. Free-text search values are the exception: OpenAlex reads a
   * `"` there as its own exact-phrase syntax, so a search value keeps its quotes and is left as-is.
   */
  if (!isFreeTextSearchKey(field) && isQuoted(converted.trim())) {
    assertNoInteriorQuote(key, converted);
    return converted;
  }
  assertPairedQuotes(key, converted);
  if (keepsPlusLiteral(field)) return converted;
  return converted.replaceAll('+', ' ');
}
