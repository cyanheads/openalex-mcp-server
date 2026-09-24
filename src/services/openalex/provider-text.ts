/**
 * @fileoverview Normalization of provider text — the titles, abstracts, names, and affiliation
 * strings OpenAlex passes through from its sources unsanitized. Decodes HTML character
 * references against the full WHATWG table in one pass, then removes HTML comments and unwraps
 * a small allowlist of HTML/JATS/MathML elements. Everything else stays literal, so text such as
 * `A < B`, `Fish <Actinopterygii>`, or a SICI DOI survives untouched. Output is plain text;
 * Markdown escaping for `content[]` happens at the render boundary, never here.
 * @module services/openalex/provider-text
 */

import entityTable from './html-entities.json' with { type: 'json' };

/**
 * Named character references, keyed without the `&` and `;`. The data is the WHATWG table
 * (https://html.spec.whatwg.org/entities.json), which the HTML standard freezes — it is never
 * extended — so a vendored copy cannot drift. A `Map` rather than an object literal, because an
 * object answers `constructor` and every other `Object.prototype` member as if it were a name.
 */
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map(Object.entries(entityTable.named));

/** The 106 legacy names the standard also accepts without a trailing `;` (`&amp`, `&copy`, …). */
const LEGACY_REFERENCES: ReadonlySet<string> = new Set(entityTable.legacy);

/**
 * Common references OpenAlex also carries with their case changed, because a source upper- or
 * title-cased the whole title entities and all (`BLEEDING IN&NBSP;CHILDREN`, `Nations:&Nbsp;`).
 * A spelling the table does not hold decodes as the lowercase name; one it does hold keeps its
 * own meaning, so `&Lt;` stays ≪.
 */
const CASE_FOLDED_REFERENCES: ReadonlySet<string> = new Set([
  'amp',
  'apos',
  'gt',
  'lt',
  'nbsp',
  'quot',
]);

function namedReference(name: string): string | undefined {
  const exact = NAMED_REFERENCES.get(name);
  if (exact !== undefined) return exact;
  const folded = name.toLowerCase();
  return CASE_FOLDED_REFERENCES.has(folded) ? NAMED_REFERENCES.get(folded) : undefined;
}

const MAX_UNICODE_CODE_POINT = 0x10ffff;

/**
 * One character reference: decimal, hex, or a maximal alphanumeric name, each with an optional
 * `;`. The name run is maximal, so the character after an unterminated name is never an
 * alphanumeric — the only lookahead the legacy rule still needs is `=`.
 */
const CHARACTER_REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g;

/** Whether `&name;` is a named character reference, for callers that must not let one decode. */
export function isNamedCharacterReference(name: string): boolean {
  return NAMED_REFERENCES.has(name);
}

function codePointToString(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= MAX_UNICODE_CODE_POINT
    ? String.fromCodePoint(code)
    : fallback;
}

/**
 * Decode HTML character references in a single pass, so `&amp;lt;` becomes `&lt;` and never `<`.
 *
 * - Numeric references (`&#38;`, `&#x27E9;`) decode with or without the `;` — OpenAlex sends
 *   `&#38 Hepatology` — and a code point past U+10FFFF stays literal rather than corrupting text.
 * - Named references are case-sensitive (`&Alpha;` is Α, `&alpha;` is α) and need the `;`,
 *   except for the legacy names, which follow the standard's attribute-value rule: decoded
 *   without the `;` unless an `=` follows, so a URL's `&copy=2` query parameter stays intact.
 *   A recased common reference with its `;` (`&NBSP;`, `&Quot;`) decodes as the lowercase name.
 * - Anything else — `&constructor;`, `AT&T`, `&madeupentity;` — stays literal.
 */
function decodeCharacterReferences(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    CHARACTER_REFERENCE,
    (
      match,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined,
      semicolon: string,
      offset: number,
    ) => {
      if (decimal !== undefined) return codePointToString(Number.parseInt(decimal, 10), match);
      if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16), match);
      const reference = name as string;
      if (semicolon) return namedReference(reference) ?? match;
      const next = text[offset + match.length];
      return LEGACY_REFERENCES.has(reference) && next !== '='
        ? (NAMED_REFERENCES.get(reference) ?? match)
        : match;
    },
  );
}

/** Inline elements whose tags are dropped and whose text is kept. */
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'b',
  'em',
  'i',
  'inline-formula',
  'jats:bold',
  'jats:italic',
  'sc',
  'scp',
  'span',
  'strong',
  'tex-math',
  // MathML presentation markup, bare; `mml:`-prefixed names are matched by prefix.
  'math',
  'menclose',
  'mfenced',
  'mfrac',
  'mi',
  'mmultiscripts',
  'mn',
  'mo',
  'mover',
  'mpadded',
  'mphantom',
  'mroot',
  'mrow',
  'mspace',
  'msqrt',
  'mstyle',
  'msub',
  'msubsup',
  'msup',
  'mtable',
  'mtd',
  'mtext',
  'mtr',
  'munder',
  'munderover',
  'semantics',
]);

/** Block elements, each replaced by a paragraph break. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'br',
  'jats:p',
  'jats:sec',
  'jats:title',
  'li',
  'p',
]);

const PARAGRAPH_BREAK = '\n\n';

/**
 * Sub/superscripts open as TeX-style `_{`/`^{` and close with `}`. Unicode has no
 * sub/superscript for most letters, unwrapping would read `10<sup>-3</sup>` as `10-3`, and
 * OpenAlex's TeX-bearing abstracts already use this notation.
 */
const SCRIPT_OPENERS: ReadonlyMap<string, string> = new Map([
  ['sub', '_{'],
  ['jats:sub', '_{'],
  ['sup', '^{'],
  ['jats:sup', '^{'],
]);

/** A complete tag, checked against one `<…>` candidate that holds no other `<` or `>`. */
const TAG = /^<(\/?)([A-Za-z][\w:.-]*)(?:\s[^<>]*)?\/?>$/;

/**
 * What an allowlisted tag becomes, or `undefined` for any other `<…>` span, which stays literal.
 * Matching a whole tag name — never a prefix — is what keeps `i1<i2<` and `<Actinopterygii>`.
 */
function replaceTag(candidate: string): string | undefined {
  const tag = TAG.exec(candidate);
  if (!tag) return;
  const closing = tag[1] === '/';
  const name = (tag[2] as string).toLowerCase();
  if (INLINE_ELEMENTS.has(name) || name.startsWith('mml:')) return '';
  if (BLOCK_ELEMENTS.has(name)) return PARAGRAPH_BREAK;
  const opener = SCRIPT_OPENERS.get(name);
  if (opener === undefined) return;
  if (candidate.endsWith('/>')) return '';
  return closing ? '}' : opener;
}

const COMMENT_OPEN = '<!--';
/** `<!---->` — the shortest span that closes a comment it opened. */
const MIN_COMMENT_LENGTH = 7;

function endsWith(out: string[], suffix: string): boolean {
  if (out.length < suffix.length) return false;
  for (let i = 0; i < suffix.length; i++) {
    if (out[out.length - suffix.length + i] !== suffix[i]) return false;
  }
  return true;
}

/**
 * Remove HTML comments and rewrite allowlisted tags in one left-to-right pass, reaching the
 * result that repeating a regex replacement until nothing changes would reach — no allowlisted
 * tag can re-form in the output — in linear time. A replace-until-stable loop costs one full
 * pass per nesting level, which is quadratic on nested input such as `<<<i>i>i>`.
 *
 * Characters are copied to `out`. Removing a tag or comment can join the text on either side
 * into a new one (`<<i>i>`, `<!-<!---->- x -->`), so every removal truncates `out` and scanning
 * simply continues: `opens` holds the positions of each `<` that could still begin a tag, and
 * `commentStart` the earliest unclosed `<!--`. A tag ends at the first `>` after its `<`, so a
 * `>` settles the innermost open `<`: kept as text, it also blocks every `<` below it, except
 * those before an unclosed comment, which come back into play if that comment closes. Each
 * character is examined a bounded number of times.
 */
function stripMarkup(text: string): string {
  if (!text.includes('<')) return text;
  const out: string[] = [];
  const opens: number[] = [];
  let commentStart = -1;

  for (const ch of text) {
    out.push(ch);
    if (ch === '<') {
      opens.push(out.length - 1);
      continue;
    }
    if (ch === '-') {
      if (commentStart < 0 && endsWith(out, COMMENT_OPEN)) commentStart = out.length - 4;
      continue;
    }
    if (ch !== '>') continue;

    if (
      commentStart >= 0 &&
      out.length - commentStart >= MIN_COMMENT_LENGTH &&
      endsWith(out, '-->')
    ) {
      out.length = commentStart;
      commentStart = -1;
      while (opens.length > 0 && (opens.at(-1) as number) >= out.length) opens.pop();
      continue;
    }

    // Inside an unclosed comment, only a `<` opened after it can form a tag.
    const top = opens.at(-1);
    if (top === undefined || top <= commentStart) continue;
    opens.pop();
    const replacement = replaceTag(out.slice(top).join(''));
    if (replacement === undefined) {
      while (opens.length > 0 && (opens.at(-1) as number) > commentStart) opens.pop();
      continue;
    }
    out.length = top;
    if (replacement) out.push(replacement);
  }

  // A break element can only come from a block tag (input is copied one character at a time),
  // and one inside a comment was truncated with it.
  const stripped = out.join('');
  if (!out.includes(PARAGRAPH_BREAK)) return stripped;
  // Block tags leave runs of breaks and stray edge whitespace; keep one break between paragraphs.
  return stripped
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join(PARAGRAPH_BREAK);
}

/**
 * Normalize one provider string to plain text: decode character references once, then handle
 * markup. Decoding first is what lets an encoded tag (`&lt;i&gt;x&lt;/i&gt;`) unwrap; decoding
 * never runs again afterward, so double-encoded text keeps its remaining level.
 */
export function normalizeProviderText(text: string): string {
  return stripMarkup(decodeCharacterReferences(text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize every string leaf of a JSON value; keys, numbers, booleans, and nulls pass through. */
export function normalizeProviderValue<T>(value: T): T {
  if (typeof value === 'string') return normalizeProviderText(value) as T;
  if (Array.isArray(value)) return value.map(normalizeProviderValue) as T;
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) next[k] = normalizeProviderValue(v);
    return next as T;
  }
  return value;
}
