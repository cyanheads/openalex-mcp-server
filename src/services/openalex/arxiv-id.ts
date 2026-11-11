/**
 * @fileoverview arXiv identifiers: the forms a caller writes one in, read down to the versionless
 * ID OpenAlex can find a work by, and the notice a lookup by one carries. (gh #137)
 * @module services/openalex/arxiv-id
 */

import type { ArxivResolution } from './types.js';

/** An arXiv ID as `parseArxivId()` reads it. */
export interface ArxivId {
  /** The versionless ID: `1706.03762`, or old-style `hep-th/9901001` with its archive lower-cased. */
  id: string;
  /** The version suffix the caller wrote (`v5`), lower-cased; absent when none was written. */
  version?: string;
}

/**
 * The DOI prefix arXiv registers for every article with DataCite: `10.48550/arXiv.<id>`, with no
 * version and no subject class. OpenAlex resolves it on `/works/doi:` whatever its case.
 */
const ARXIV_DOI_PREFIX = '10.48550/arXiv.';

/** OpenAlex's source record for arXiv, which every location arXiv itself serves names. */
export const ARXIV_SOURCE_ID = 'https://openalex.org/S4306400194';

/**
 * The ID itself: new-style `YYMM.NNNN(N)`, or old-style `archive[.SC]/YYMMNNN` — archive letters
 * with at most one hyphen, then an optional two-letter subject class arXiv no longer writes
 * (`math.GT/0309136` is `math/0309136`) — then an optional version. Anchored on both ends with no
 * nested quantifiers, so a non-match fails in one pass.
 */
const ARXIV_ID_PATTERN =
  /^(?:(\d{4}\.\d{4,5})|([a-z]+(?:-[a-z]+)?)(?:\.[a-z]{2})?\/(\d{7}))(v\d+)?$/i;

/** The `arXiv:` prefix, in any case. */
const ARXIV_PREFIX = /^arxiv:/i;

/**
 * An arXiv abstract or PDF page: `https://`, `http://`, or no scheme; host `arxiv.org`,
 * `www.arxiv.org`, or `export.arxiv.org`, anchored on the right by the `/abs/` or `/pdf/` path,
 * so a look-alike that only starts with the host (`arxiv.org.example`) is never read.
 */
const ARXIV_URL = /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//i;

/** The arXiv DOI in any case, bare, `doi:`-prefixed, or as a `https://doi.org/` URL. */
const ARXIV_DOI = /^(?:https:\/\/doi\.org\/|doi:)?10\.48550\/arxiv\./i;

/** A page path's query string or fragment, which names nothing about the paper. */
const QUERY_OR_FRAGMENT = /[?#]/;

/**
 * Read `value` as an arXiv ID — bare (`1706.03762`, `hep-th/9901001`), `arXiv:`-prefixed, an
 * arxiv.org abstract or PDF URL (`/abs/<id>`, `/pdf/<id>`, optional `.pdf`, a trailing `/`, query
 * string, or fragment ignored), or the arXiv DOI (`10.48550/arXiv.<id>`, bare or as a
 * `https://doi.org/` URL), each with an optional version — or return undefined for any other value.
 *
 * No other identifier the server accepts takes either ID shape: DOIs open with `10.`, PMIDs and
 * bare RORs carry no dot or slash, ISSNs and ORCIDs are hyphenated digit groups, PMCIDs open with
 * `PMC`, and OpenAlex IDs are a letter and digits. Runs on caller-sized text in linear time.
 */
export function parseArxivId(value: string): ArxivId | undefined {
  const trimmed = value.trim();
  const doi = ARXIV_DOI.exec(trimmed);
  if (doi) return readId(trimmed.slice(doi[0].length));
  const prefix = ARXIV_PREFIX.exec(trimmed);
  if (prefix) return readId(trimmed.slice(prefix[0].length));
  const url = ARXIV_URL.exec(trimmed);
  if (!url) return readId(trimmed);

  const path = trimmed.slice(url[0].length);
  const end = path.search(QUERY_OR_FRAGMENT);
  const page = end === -1 ? path : path.slice(0, end);
  const unslashed = page.endsWith('/') ? page.slice(0, -1) : page;
  return readId(/\.pdf$/i.test(unslashed) ? unslashed.slice(0, -'.pdf'.length) : unslashed);
}

function readId(value: string): ArxivId | undefined {
  const match = ARXIV_ID_PATTERN.exec(value);
  if (!match) return;
  const [, newStyle, archive, number, version] = match;
  const id = newStyle ?? `${archive?.toLowerCase()}/${number}`;
  return version === undefined ? { id } : { id, version: version.toLowerCase() };
}

/** The DOI arXiv registers for `id`: `10.48550/arXiv.<id>`. */
export function arxivDoi(id: string): string {
  return `${ARXIV_DOI_PREFIX}${id}`;
}

/**
 * The two spellings of `id`'s abstract page OpenAlex stores as a location's `landing_page_url`.
 * Its filter on that field matches case- and version-sensitively, so only the versionless ID
 * `parseArxivId()` returns finds the page.
 */
export function arxivLandingPageUrls(id: string): readonly [http: string, https: string] {
  return [`http://arxiv.org/abs/${id}`, `https://arxiv.org/abs/${id}`];
}

/**
 * The notice a lookup that `resolution` describes carries — the dropped version, and the billed
 * landing-page lookup — or undefined when there is nothing to disclose. Its only variable text is
 * the ID `parseArxivId()` read, which holds no Markdown syntax.
 */
export function arxivResolutionNotice(resolution: ArxivResolution): string | undefined {
  const { arxivId, droppedVersion, via } = resolution;
  const parts: string[] = [];
  if (droppedVersion !== undefined) {
    parts.push(
      `Version ${droppedVersion} was dropped from arXiv ID ${arxivId}${droppedVersion}: OpenAlex keeps one work per arXiv paper, not one per version, so it was looked up as ${arxivId}.`,
    );
  }
  if (via === 'landing_page') {
    const [, page] = arxivLandingPageUrls(arxivId);
    parts.push(
      `No work in OpenAlex carries the DOI ${arxivDoi(arxivId)}, so arXiv ID ${arxivId} was found by its landing page, ${page} — a list request OpenAlex bills ($0.0001), counted in \`budget\`.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
