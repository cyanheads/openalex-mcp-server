/**
 * @fileoverview Normalization of provider text — the titles, abstracts, names, and affiliation
 * strings OpenAlex passes through from its sources unsanitized. Decodes HTML character
 * references against the full WHATWG table in one pass, then, in a second single pass, removes
 * HTML comments, unwraps a small allowlist of HTML/JATS/MathML elements, unwraps CDATA sections
 * and IOP's `<?CDATA …?>` instructions, drops the `<?MML …?>` instructions that restate them, and
 * turns a double-escaped line break (a literal backslash + `n`) into a space. Everything else
 * stays literal, so text such as `A < B`, `Fish <Actinopterygii>`, a SICI DOI, or TeX like `\nu`
 * survives untouched. Output is plain text; Markdown escaping for `content[]` happens at the
 * render boundary, never here. Identifier and URL fields of a record are not provider text and
 * pass through byte-identical, so each one resolves when passed back.
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

function isAllowlistedElement(name: string): boolean {
  return (
    INLINE_ELEMENTS.has(name) ||
    name.startsWith('mml:') ||
    BLOCK_ELEMENTS.has(name) ||
    SCRIPT_OPENERS.has(name)
  );
}

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

/**
 * `<!--inline-formula>`: an A&A/JATS formula opener written as a comment opener that never
 * closes. An allowlisted name straight after `<!--` makes it a tag to remove, not a comment —
 * left open, it would delete everything up to the next `-->`, which math text supplies as an
 * arrow (`--->`). A space after `<!--`, as every real comment in the corpus has, keeps it a
 * comment. The length cap bounds the check to the one `>` that can end such a name.
 */
const FORMULA_OPENER = /^<!--([A-Za-z][\w:.-]*)>$/;
const MAX_FORMULA_OPENER_LENGTH = 64;

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';
/** The closer without its `>`, which some sources end a section with. */
const CDATA_BARE_CLOSE = ']]';

/**
 * Processing instructions IOP wraps inline math in: `<?CDATA x?>` carries the TeX and is
 * unwrapped; the `<?MML y?>` that always follows restates it flattened (`10^4` reads `10 4`) and
 * is removed whole. Only these two targets — a generic `<?name` rule would eat `<?php` text.
 */
const INSTRUCTION_CDATA = '<?CDATA';
const INSTRUCTION_MML = '<?MML';
const INSTRUCTION_CLOSE = '?>';

/**
 * The longest `<?MML … ?>` removed, `<?MML` through `?>`. Every one in a 3,543-record sample
 * spans at most 64 characters; one that runs longer lost its `?>` and stays literal rather than
 * deleting prose up to some later `?>`.
 */
const MAX_MML_SPAN = 128;

/** An open processing instruction: where its content starts (`cdata`) or its `<` sits (`mml`). */
interface Instruction {
  kind: 'cdata' | 'mml';
  start: number;
}

/** A double-escaped line break: the two characters `\` and `n`, not a newline. */
const LITERAL_NEWLINE = '\\n';

function endsWith(out: string[], suffix: string): boolean {
  if (out.length < suffix.length) return false;
  for (let i = 0; i < suffix.length; i++) {
    if (out[out.length - suffix.length + i] !== suffix[i]) return false;
  }
  return true;
}

const isBlank = (ch: string | undefined) => ch === ' ' || ch === '\t';

const isAsciiLetter = (ch: string | undefined) =>
  ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));

/** Characters that end a processing-instruction target. */
const endsInstructionTarget = (ch: string) =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '?';

/** Whether `out` ends with a formula opener whose `<` sits at `start`. */
function isFormulaOpener(out: string[], start: number): boolean {
  if (out.length - start > MAX_FORMULA_OPENER_LENGTH) return false;
  if (out[start + 1] !== '!' || !isAsciiLetter(out[start + COMMENT_OPEN.length])) return false;
  const name = FORMULA_OPENER.exec(out.slice(start).join(''))?.[1];
  return name !== undefined && isAllowlistedElement(name.toLowerCase());
}

/**
 * Handle markup in one left-to-right pass, reaching the result that repeating a regex
 * replacement until nothing changes would reach — no allowlisted tag, comment, or delimiter can
 * re-form in the output — in linear time. A replace-until-stable loop costs one full pass per
 * nesting level, which is quadratic on nested input such as `<<<i>i>i>`.
 *
 * Characters are copied to `out`. Removing a tag, comment, or delimiter can join the text on
 * either side into a new one (`<<i>i>`, `<!-<!---->- x -->`, `<![CDA<i></i>TA[`), so every
 * removal truncates `out` and scanning simply continues, and every delimiter is recognized by
 * how `out` ends rather than by the input: `opens` holds the positions of each `<` that could
 * still begin a tag, and `commentStart` the earliest unclosed `<!--`. A tag ends at the first `>`
 * after its `<`, so a `>` settles the innermost open `<`: kept as text, it also blocks every `<`
 * below it, except those before an unclosed comment, which come back into play if that comment
 * closes. Each character is examined a bounded number of times.
 *
 * CDATA: the `<![CDATA[` opener is dropped where it forms and `cdataStart` marks where the
 * section's text begins. `]]>` closes it. Sources also drop the `>`, so a bare `]]` followed by
 * anything but `>` or `]` — the end of the text included — closes it as well, unless the text
 * still holds a `]]>` before its next opener: then the `]]` belongs to the section, as in TeX's
 * `k[[x]]`. A bare `]]` at most one space before an opener closed a section whose opener was
 * lost, and goes with it. With no open section, `]]` and `]]>` are text.
 *
 * `<?MML`: a pending instruction closes at the next `?>` unless another `<?` forms first or the
 * span passes `MAX_MML_SPAN`; either way it stays literal, since its `?>` was lost. A `?>` that
 * closes nothing is dropped when another pass would pair it with such a literal `<?MML` — no
 * `<?` between them, within the cap — so the output stays a fixed point.
 *
 * Literal `\n`: sources that double-escaped their line breaks leave a backslash and an `n`. One
 * whose backslash is not itself escaped and which no ASCII letter follows becomes a single
 * space, merged with the spaces around it and dropped at either end of the text. Most wrap
 * mid-sentence, so it is never a paragraph break. A letter after it reads as TeX (`\nu`,
 * `\neq`, `\nabla`, a custom `\np`), and no local rule tells those from a glued `\nand`, so
 * those stay. A backslash just before a removed opener forms one with the `n` after it; the
 * section or instruction that opener began stays open.
 */
function stripMarkup(text: string): string {
  if (!text.includes('<') && !text.includes(LITERAL_NEWLINE)) return text;
  const out: string[] = [];
  const opens: number[] = [];
  const instructions: Instruction[] = [];
  let commentStart = -1;
  let cdataStart = -1;
  /** A space standing where text was removed, dropped if nothing follows it. */
  let softSpace = -1;
  /** Swallow spaces and tabs up to the next other character. */
  let skipBlanks = false;
  /** An unescaped `\n` was just copied; the next character decides what it is. */
  let newlinePending = false;
  /** A pending `<?MML` was left literal, so a stray `?>` may pair with it on another pass. */
  let literalMml = false;
  /**
   * Where the next `]]>` and `<![CDATA[` start in `text`, -1 for none. The scan position only
   * advances, so each is searched again only once passed, and every search covers new ground.
   */
  let nextSectionClose = -2;
  let nextSectionOpen = -2;

  /** Whether `text` holds a `]]>` at or after `from`, before any further section opener. */
  const sectionCloseAhead = (from: number): boolean => {
    if (nextSectionClose !== -1 && nextSectionClose < from) {
      nextSectionClose = text.indexOf(CDATA_CLOSE, from);
    }
    if (nextSectionClose < 0) return false;
    if (nextSectionOpen !== -1 && nextSectionOpen < from) {
      nextSectionOpen = text.indexOf(CDATA_OPEN, from);
    }
    return nextSectionOpen < 0 || nextSectionClose < nextSectionOpen;
  };

  const truncate = (length: number) => {
    out.length = length;
    while (opens.length > 0 && (opens.at(-1) as number) >= length) opens.pop();
    if (commentStart >= length) commentStart = -1;
    if (cdataStart > length) cdataStart = -1;
    while (instructions.length > 0) {
      const { kind, start } = instructions.at(-1) as Instruction;
      if (kind === 'mml' ? start < length : start <= length) break;
      instructions.pop();
    }
    if (softSpace >= length) softSpace = -1;
  };

  /**
   * Open a processing instruction when `out` ends with its target and `separator` ends that
   * target — whitespace, a `?`, or the space or break a removal leaves. Returns whether the
   * separator is consumed: the whitespace after a CDATA target only separates it from the content.
   */
  const openInstruction = (separator: string): boolean => {
    if (endsWith(out, INSTRUCTION_CDATA)) {
      truncate(out.length - INSTRUCTION_CDATA.length);
      instructions.push({ kind: 'cdata', start: out.length });
      return separator !== '?';
    }
    if (endsWith(out, INSTRUCTION_MML)) {
      instructions.push({ kind: 'mml', start: out.length - INSTRUCTION_MML.length });
    }
    return false;
  };

  /** Replace the `\n` that ends `out` with one space, merging the blanks before it. */
  const replaceNewline = () => {
    // Blanks before a section or instruction opener stay, so the opener keeps its position.
    const instruction = instructions.at(-1);
    const floor = Math.max(cdataStart, instruction?.start ?? -1);
    let length = out.length - LITERAL_NEWLINE.length;
    while (length > floor && length > 0 && isBlank(out[length - 1])) length--;
    // The backslash sits before a removed opener whose section or instruction the `n` began.
    const reopenSection = cdataStart > length;
    const reopenInstruction = instruction?.kind === 'cdata' && instruction.start > length;
    truncate(length);
    if (reopenSection) cdataStart = length;
    if (reopenInstruction) instructions.push({ kind: 'cdata', start: length });
    skipBlanks = true;
    if (!openInstruction(' ') && length > 0 && !isBlank(out[length - 1])) {
      out.push(' ');
      softSpace = length;
    }
  };

  /**
   * Whether the `?>` ending `out` would close a literal `<?MML` on another pass: the nearest `<?`
   * before it, within `MAX_MML_SPAN` of its end, begins one.
   */
  const pairsWithLiteralMml = (): boolean => {
    const floor = Math.max(0, out.length - MAX_MML_SPAN);
    for (let at = out.length - INSTRUCTION_CLOSE.length - 1; at >= floor; at--) {
      if (out[at] !== '<' || out[at + 1] !== '?') continue;
      for (let i = 2; i < INSTRUCTION_MML.length; i++) {
        if (out[at + i] !== INSTRUCTION_MML[i]) return false;
      }
      const separator = out[at + INSTRUCTION_MML.length];
      return separator !== undefined && endsInstructionTarget(separator);
    }
    return false;
  };

  /** After removing a span: merge the blanks around it, and drop it cleanly at either end. */
  const settleRemoval = () => {
    if (out.length === 0) {
      skipBlanks = true;
    } else if (isBlank(out.at(-1))) {
      skipBlanks = true;
      softSpace = out.length - 1;
    }
  };

  const openSection = () => {
    let start = out.length - CDATA_OPEN.length;
    const gap = out[start - 1] === ' ' ? 1 : 0;
    const lostClose = out[start - 1 - gap] === ']' && out[start - 2 - gap] === ']';
    if (lostClose) start -= CDATA_BARE_CLOSE.length + gap;
    truncate(start);
    if (lostClose && gap > 0 && out.length > 0 && !isBlank(out.at(-1)) && !openInstruction(' ')) {
      out.push(' ');
    }
    // Sections do not nest; a second opener inside one only goes.
    if (cdataStart < 0) cdataStart = out.length;
  };

  let offset = 0;
  for (const ch of text) {
    const at = offset;
    offset += ch.length;
    if (newlinePending) {
      newlinePending = false;
      if (!isAsciiLetter(ch)) replaceNewline();
    }
    if (skipBlanks) {
      if (isBlank(ch)) continue;
      skipBlanks = false;
    }
    if (
      cdataStart >= 0 &&
      ch !== '>' &&
      ch !== ']' &&
      out.length - CDATA_BARE_CLOSE.length >= cdataStart &&
      endsWith(out, CDATA_BARE_CLOSE) &&
      !sectionCloseAhead(at)
    ) {
      truncate(out.length - CDATA_BARE_CLOSE.length);
      cdataStart = -1;
      // `x ]] y` leaves one space, not two.
      if (isBlank(ch) && isBlank(out.at(-1))) continue;
    }
    if (endsInstructionTarget(ch) && openInstruction(ch)) continue;

    out.push(ch);
    if (ch === 'n' && out.at(-2) === '\\' && out.at(-3) !== '\\') {
      newlinePending = true;
      continue;
    }
    if (ch === '<') {
      opens.push(out.length - 1);
      continue;
    }
    if (ch === '[') {
      if (endsWith(out, CDATA_OPEN)) openSection();
      continue;
    }
    if (ch === '-') {
      if (commentStart < 0 && endsWith(out, COMMENT_OPEN)) commentStart = out.length - 4;
      continue;
    }
    if (ch === '?') {
      if (out.at(-2) === '<' && instructions.at(-1)?.kind === 'mml') {
        instructions.pop();
        literalMml = true;
      }
      continue;
    }
    if (ch !== '>') continue;

    if (
      cdataStart >= 0 &&
      out.length - CDATA_CLOSE.length >= cdataStart &&
      endsWith(out, CDATA_CLOSE)
    ) {
      truncate(out.length - CDATA_CLOSE.length);
      cdataStart = -1;
      continue;
    }
    if (endsWith(out, INSTRUCTION_CLOSE)) {
      let instruction = instructions.at(-1);
      if (instruction?.kind === 'mml' && out.length - instruction.start > MAX_MML_SPAN) {
        instructions.pop();
        instruction = instructions.at(-1);
      }
      if (instruction) {
        instructions.pop();
        if (instruction.kind === 'cdata') {
          truncate(out.length - INSTRUCTION_CLOSE.length);
        } else {
          truncate(instruction.start);
          settleRemoval();
        }
        continue;
      }
      if (literalMml && pairsWithLiteralMml()) {
        truncate(out.length - INSTRUCTION_CLOSE.length);
        settleRemoval();
        continue;
      }
    }
    if (
      commentStart >= 0 &&
      out.length - commentStart >= MIN_COMMENT_LENGTH &&
      endsWith(out, '-->')
    ) {
      truncate(commentStart);
      continue;
    }
    // Like a tag, a formula opener goes even inside an unclosed comment.
    const top = opens.at(-1);
    if (top !== undefined && isFormulaOpener(out, top)) {
      truncate(top);
      continue;
    }

    // Inside an unclosed comment, only a `<` opened after it can form a tag.
    if (top === undefined || top <= commentStart) continue;
    opens.pop();
    const replacement = replaceTag(out.slice(top).join(''));
    if (replacement === undefined) {
      while (opens.length > 0 && (opens.at(-1) as number) > commentStart) opens.pop();
      continue;
    }
    truncate(top);
    if (replacement === PARAGRAPH_BREAK && openInstruction(replacement)) continue;
    if (replacement) out.push(replacement);
  }

  if (newlinePending) replaceNewline();
  if (
    cdataStart >= 0 &&
    out.length - CDATA_BARE_CLOSE.length >= cdataStart &&
    endsWith(out, CDATA_BARE_CLOSE)
  ) {
    truncate(out.length - CDATA_BARE_CLOSE.length);
  }
  if (softSpace >= 0 && softSpace === out.length - 1) out.length = softSpace;

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

/**
 * Keys holding identifiers and URLs — what a caller passes back to look a record up, filter on,
 * or open. Their strings stay byte-identical to upstream: OpenAlex stores some DOIs with a
 * literal `&amp;`, and only that spelling resolves. Named by the key holding the string or the
 * array of strings, at any depth: these, and any key ending in `_id`, `_ids`, `_url`, or
 * `_lineage`. No display-text field (`title`, `display_name`, `abstract`, `raw_*`,
 * `host_organization_name`, `description`, `hint`, …) matches.
 */
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  'doi',
  'host_organization',
  'id',
  'issn',
  'issn_l',
  'lineage',
  'orcid',
  'parent_publisher',
  'raw_orcid',
  'referenced_works',
  'related_works',
  'ror',
  'url',
  'wikidata',
]);
const IDENTIFIER_SUFFIX = /_(?:id|ids|url|lineage)$/;
/** Objects whose every value is an identifier or URL (`ids.doi`, `content_urls.pdf`). */
const IDENTIFIER_MAPS: ReadonlySet<string> = new Set(['content_urls', 'ids']);

function isIdentifierKey(key: string): boolean {
  return IDENTIFIER_KEYS.has(key) || IDENTIFIER_SUFFIX.test(key);
}

function normalizeLeaves(value: unknown, identifier: boolean): unknown {
  if (typeof value === 'string') return identifier ? value : normalizeProviderText(value);
  if (Array.isArray(value)) return value.map((item) => normalizeLeaves(item, identifier));
  if (!isRecord(value)) return value;
  // `fromEntries` defines each key as an own data property; assigning an own `__proto__` key
  // onto an object literal would run the inherited setter and drop it. An object under an
  // identifier key is still walked by its own keys, so a `display_name` inside it is normalized.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      IDENTIFIER_MAPS.has(key) && isRecord(item)
        ? item
        : normalizeLeaves(item, isIdentifierKey(key)),
    ]),
  );
}

/**
 * Normalize every string leaf of a JSON value except identifiers and URLs, which pass through
 * byte-identical; keys, numbers, booleans, and nulls pass through too.
 */
export function normalizeProviderValue<T>(value: T): T {
  return normalizeLeaves(value, false) as T;
}
