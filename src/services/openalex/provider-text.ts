/**
 * @fileoverview Normalization of provider text — the titles, abstracts, names, and affiliation
 * strings OpenAlex passes through from its sources unsanitized. Decodes HTML character
 * references against the full WHATWG table in one pass, then, in a second single pass, removes
 * HTML comments, unwraps a small allowlist of HTML/JATS/MathML elements, unwraps CDATA sections
 * and IOP's `<?CDATA …?>` instructions, drops the `<?MML …?>` instructions that restate them,
 * drops MathType MTEF equation blobs and their End lines, and turns a double-escaped line break
 * (a literal backslash + `n`) into a space. Everything else stays literal, so text such as
 * `A < B`, `Fish <Actinopterygii>`, `95% CI`, a SICI DOI, or TeX like `\nu` survives untouched.
 * Output is plain text; Markdown escaping for `content[]` happens at the render boundary, never
 * here. Identifier and URL fields of a record are not provider text and pass through
 * byte-identical, so each one resolves when passed back.
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

function isAllowlistedElement(name: string): boolean {
  return (
    INLINE_ELEMENTS.has(name) ||
    name.startsWith('mml:') ||
    BLOCK_ELEMENTS.has(name) ||
    SCRIPT_OPENERS.has(name)
  );
}

/**
 * How the text from the last `<` in `out` through one element reads as the start of a tag: `<`,
 * an optional `/`, a name — a letter, then letters, digits, `_`, `:`, `.`, or `-` — then `>`, `/>`,
 * or whitespace and anything but `<` or `>` before the `>`. The kind sits in the low bits and the
 * name's length, capped at `NAME_LENGTH_CAP`, above them. A `>` completes a tag only after
 * `TAG_NAME`, `TAG_SELF_CLOSING`, or `TAG_ATTRIBUTES`.
 */
const TAG_NONE = 0;
/** `<` */
const TAG_OPEN = 1;
/** `</` */
const TAG_CLOSING = 2;
const TAG_NAME = 3;
/** A name, then `/`. */
const TAG_SELF_CLOSING = 4;
/** A name, whitespace, then anything but `<` or `>`. */
const TAG_ATTRIBUTES = 5;
const TAG_KIND_BITS = 3;
const TAG_KIND_MASK = (1 << TAG_KIND_BITS) - 1;
const TAG_NAME_UNIT = 1 << TAG_KIND_BITS;

/** One past the longest listed name: enough of any name to look it up or to see `mml:`. */
const NAME_LENGTH_CAP =
  Math.max(
    ...[...INLINE_ELEMENTS, ...BLOCK_ELEMENTS, ...SCRIPT_OPENERS.keys()].map((name) => name.length),
  ) + 1;

const isNameChar = (ch: string) =>
  isAsciiLetter(ch) || isDigit(ch) || ch === '_' || ch === ':' || ch === '.' || ch === '-';

/** The tag shape after `ch`, given the shape before it. */
function nextTagShape(shape: number, ch: string): number {
  if (ch === '<') return TAG_OPEN;
  const kind = shape & TAG_KIND_MASK;
  if (kind === TAG_ATTRIBUTES) return ch === '>' ? TAG_NONE : shape;
  if (kind === TAG_NAME) {
    if (isNameChar(ch)) {
      return shape >> TAG_KIND_BITS < NAME_LENGTH_CAP ? shape + TAG_NAME_UNIT : shape;
    }
    if (isWhitespace(ch)) return shape - kind + TAG_ATTRIBUTES;
    return ch === '/' ? shape - kind + TAG_SELF_CLOSING : TAG_NONE;
  }
  if (kind === TAG_OPEN && ch === '/') return TAG_CLOSING;
  if ((kind === TAG_OPEN || kind === TAG_CLOSING) && isAsciiLetter(ch)) {
    return TAG_NAME_UNIT + TAG_NAME;
  }
  return TAG_NONE;
}

/**
 * What the tag `out` ends with becomes — its `<` at `top`, its `>` the last element, `shape` the
 * tag shape before that `>` — or `undefined` when the `<…>` span is no allowlisted tag and stays
 * literal. Matching a whole tag name — never a prefix — is what keeps `i1<i2<` and
 * `<Actinopterygii>`.
 */
function replaceTag(out: readonly string[], top: number, shape: number): string | undefined {
  const kind = shape & TAG_KIND_MASK;
  if (kind !== TAG_NAME && kind !== TAG_SELF_CLOSING && kind !== TAG_ATTRIBUTES) return;
  const closing = out[top + 1] === '/';
  const nameStart = top + (closing ? 2 : 1);
  const name = out
    .slice(nameStart, nameStart + (shape >> TAG_KIND_BITS))
    .join('')
    .toLowerCase();
  if (INLINE_ELEMENTS.has(name) || name.startsWith('mml:')) return '';
  if (BLOCK_ELEMENTS.has(name)) return PARAGRAPH_BREAK;
  const opener = SCRIPT_OPENERS.get(name);
  if (opener === undefined) return;
  // The element before the closing `>` ends `/>` on a self-closing tag.
  if ((out.at(-2) as string).endsWith('/')) return '';
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
 * The longest `<?MML … ?>` removed, `<?MML` through `?>`, as the output reads it
 * (`SecondPassLength`). Every one in a 3,543-record sample spans at most 64 characters; one that
 * runs longer lost its `?>` and stays literal rather than deleting prose up to some later `?>`.
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

/**
 * Whitespace as `String.prototype.trim` defines it — what trimming paragraphs strips beside a
 * block tag's break — and the break element itself, which a second pass reads as line breaks.
 * Whatever trimming can remove or a break can become must already read as whitespace here, or a
 * second pass would find a delimiter this one did not.
 */
const isWhitespace = (ch: string) =>
  ch === ' ' || (ch >= '\t' && ch <= '\r') || (ch > '~' && ch.trim() === '');

/** Characters that end a processing-instruction target: any whitespace, or a `?`. */
const endsInstructionTarget = (ch: string) => ch === '?' || isWhitespace(ch);

/** Whether `out` ends with a formula opener whose `<` sits at `start`. */
function isFormulaOpener(out: string[], start: number): boolean {
  if (out.length - start > MAX_FORMULA_OPENER_LENGTH) return false;
  if (out[start + 1] !== '!' || !isAsciiLetter(out[start + COMMENT_OPEN.length])) return false;
  const name = FORMULA_OPENER.exec(out.slice(start).join(''))?.[1];
  return name !== undefined && isAllowlistedElement(name.toLowerCase());
}

/**
 * MathType MTEF equation blobs, which TeX beside them restates: `% MathType!MTEF!2!1!+-`, then
 * `%`-prefixed lines of `[A-Za-z0-9+-]` data, then a checksum of `!` and four uppercase hex
 * digits (`!44A1!`). A `% MathType!Translator!…!` line can come just before the header, and a
 * stray `% MathType!End!2!1!` line anywhere.
 */
const MATHTYPE_KEYWORD = 'MathType!';
/** What follows the keyword on a header, a Translator line, and an End line. */
const MATHTYPE_TAILS = ['MTEF!', 'Translator!', 'End!'] as const;
/**
 * The longest Translator body, `2!1!AMS LaTeX.tdl!TeX -- AMS-LaTeX!` and the like: four
 * `!`-ended fields. A longer one is prose that happens to hold four `!`s, not a blob's start.
 */
const MAX_TRANSLATOR_BODY = 64;
const TRANSLATOR_FIELDS = 4;
const CHECKSUM_DIGITS = 4;

/** What the line the last `%` opened has matched. */
const LINE_NONE = 0;
/** `MathType!`, `count` characters of it; blanks may come before the first. */
const LINE_KEYWORD = 1;
/** The tail after the keyword, `count` characters in — `MATHTYPE_TAILS[phase - LINE_HEADER]`. */
const LINE_HEADER = 2;
const LINE_TRANSLATOR = 3;
const LINE_END = 4;
/** A Translator body, `count` characters and `bangs` `!`s in. */
const LINE_TRANSLATOR_BODY = 5;
/** A complete Translator line, then blanks up to the next `%`. */
const LINE_TRANSLATED = 6;
/** An End line's two `!`-ended numbers; `count` is 1 once the current one has a digit. */
const LINE_END_FIRST = 7;
const LINE_END_SECOND = 8;

/** Where the run a header opened stands. */
const RUN_NONE = 0;
/** The header's fields, up to whitespace or the next `%`. */
const RUN_HEADER = 1;
/** Whitespace after a header or data line. */
const RUN_GAP = 2;
/** A `%` and any whitespace after it, no data yet. */
const RUN_LINE = 3;
const RUN_DATA = 4;
/** The checksum's `!`, plus the hex digits seen so far. */
const RUN_CHECKSUM = 5;

const isDigit = (ch: string) => ch >= '0' && ch <= '9';

const isMtefData = (ch: string) => isAsciiLetter(ch) || isDigit(ch) || ch === '+' || ch === '-';

const isUpperHex = (ch: string) => isDigit(ch) || (ch >= 'A' && ch <= 'F');

/** Numbers saved per element: its index in `out`, the packed phases, `lineStart`, `runStart`. */
const MATHTYPE_STATE_SIZE = 4;

/**
 * Recognizes MathType blobs and End lines in `out` as `stripMarkup` builds it. Its state after
 * each element is saved, so when a removal truncates `out` the scanner resumes from exactly the
 * state that text left it in — the same state a second pass over the output would reach — and
 * no character is examined twice. Only states mid-match are saved: idle, with no line or run in
 * progress, nothing else in the state matters, and every element without a saved state left it
 * idle.
 *
 * Two threads run side by side. The line thread starts at every `%` and matches a header, a
 * Translator line, or an End line. The run thread follows the blob a header opened: further
 * header and data lines, separated by whitespace or nothing, until a checksum completes it or any
 * other character ends it. Every header continues the run it sits in, so a blob starts at its
 * first header — or at the Translator line just before it — and `runStart` holds that position.
 */
class MathTypeScanner {
  private readonly saved: number[] = [];
  private linePhase = LINE_NONE;
  private count = 0;
  private bangs = 0;
  private runPhase = RUN_NONE;
  /** The current line continues the run, or follows a Translator line; `runStart` is its start. */
  private continues = false;
  private lineStart = -1;
  private runStart = -1;
  /** Whether the last completion was a blob, whose checksum may close with one more `!`. */
  completedBlob = false;

  /**
   * Advance over the element just pushed at `index` of `out`. Returns where the blob or End line
   * it completes starts, or -1. Only a single character completes one.
   */
  push(element: string, index: number): number {
    // Only a `%` moves the scanner off idle.
    if (this.linePhase === LINE_NONE && this.runPhase === RUN_NONE && element !== '%') return -1;
    if (element.length === 1) {
      const start = this.step(element, index);
      if (start >= 0) return start;
    } else {
      for (const ch of element) this.step(ch, index);
    }
    if (this.linePhase !== LINE_NONE || this.runPhase !== RUN_NONE) {
      this.saved.push(
        index,
        this.linePhase |
          (this.count << 4) |
          (this.bangs << 11) |
          (this.runPhase << 14) |
          (this.continues ? 1 << 18 : 0),
        this.lineStart,
        this.runStart,
      );
    }
    return -1;
  }

  /** Return to the state `out` was in at `length` elements. */
  truncate(length: number): void {
    const saved = this.saved;
    while (saved.length > 0 && (saved[saved.length - MATHTYPE_STATE_SIZE] as number) >= length) {
      saved.length -= MATHTYPE_STATE_SIZE;
    }
    const at = saved.length - MATHTYPE_STATE_SIZE;
    if (at < 0 || saved[at] !== length - 1) {
      this.linePhase = LINE_NONE;
      this.runPhase = RUN_NONE;
      return;
    }
    const packed = saved[at + 1] as number;
    this.linePhase = packed & 0xf;
    this.count = (packed >> 4) & 0x7f;
    this.bangs = (packed >> 11) & 0x7;
    this.runPhase = (packed >> 14) & 0xf;
    this.continues = (packed & (1 << 18)) !== 0;
    this.lineStart = saved[at + 2] as number;
    this.runStart = saved[at + 3] as number;
  }

  private step(ch: string, index: number): number {
    const run = this.runPhase;
    let next = RUN_NONE;
    if (run === RUN_HEADER) {
      next = isWhitespace(ch) ? RUN_GAP : ch === '%' ? RUN_LINE : RUN_HEADER;
    } else if (run === RUN_GAP) {
      next = isWhitespace(ch) ? RUN_GAP : ch === '%' ? RUN_LINE : RUN_NONE;
    } else if (run === RUN_LINE || run === RUN_DATA) {
      // An empty data line ends the run; a checksum may stand on a line of its own.
      if (isMtefData(ch)) next = RUN_DATA;
      else if (ch === '!') next = RUN_CHECKSUM;
      else if (isWhitespace(ch)) next = run === RUN_LINE ? RUN_LINE : RUN_GAP;
      else if (ch === '%' && run === RUN_DATA) next = RUN_LINE;
    } else if (run >= RUN_CHECKSUM && isUpperHex(ch)) {
      next = run + 1;
      if (next === RUN_CHECKSUM + CHECKSUM_DIGITS) {
        this.completedBlob = true;
        return this.runStart;
      }
    }
    this.runPhase = next;

    if (ch === '%') {
      this.continues = next === RUN_LINE || this.linePhase === LINE_TRANSLATED;
      this.linePhase = LINE_KEYWORD;
      this.count = 0;
      this.lineStart = index;
      return -1;
    }
    switch (this.linePhase) {
      case LINE_KEYWORD:
        if (this.count < MATHTYPE_KEYWORD.length) {
          if (ch === MATHTYPE_KEYWORD[this.count]) this.count++;
          else if (this.count > 0 || !isWhitespace(ch)) this.linePhase = LINE_NONE;
          return -1;
        }
        this.linePhase =
          ch === 'M'
            ? LINE_HEADER
            : ch === 'T'
              ? LINE_TRANSLATOR
              : ch === 'E'
                ? LINE_END
                : LINE_NONE;
        this.count = 1;
        return -1;
      case LINE_HEADER:
      case LINE_TRANSLATOR:
      case LINE_END: {
        const tail = MATHTYPE_TAILS[this.linePhase - LINE_HEADER] as string;
        if (ch !== tail[this.count]) {
          this.linePhase = LINE_NONE;
          return -1;
        }
        if (++this.count < tail.length) return -1;
        if (this.linePhase === LINE_HEADER) {
          if (!this.continues) this.runStart = this.lineStart;
          this.runPhase = RUN_HEADER;
          this.linePhase = LINE_NONE;
        } else {
          this.linePhase =
            this.linePhase === LINE_TRANSLATOR ? LINE_TRANSLATOR_BODY : LINE_END_FIRST;
          this.count = 0;
          this.bangs = 0;
        }
        return -1;
      }
      case LINE_TRANSLATOR_BODY:
        // No line break inside a body; a Translator line holds no run, so `runStart` is free.
        if (ch === '\n' || ch === '\r' || ++this.count > MAX_TRANSLATOR_BODY) {
          this.linePhase = LINE_NONE;
        } else if (ch === '!' && ++this.bangs === TRANSLATOR_FIELDS) {
          this.linePhase = LINE_TRANSLATED;
          this.runStart = this.lineStart;
        }
        return -1;
      case LINE_TRANSLATED:
        if (!isWhitespace(ch)) this.linePhase = LINE_NONE;
        return -1;
      case LINE_END_FIRST:
      case LINE_END_SECOND:
        if (isDigit(ch)) {
          this.count = 1;
          return -1;
        }
        if (ch !== '!' || this.count === 0) {
          this.linePhase = LINE_NONE;
          return -1;
        }
        if (this.linePhase === LINE_END_FIRST) {
          this.linePhase = LINE_END_SECOND;
          this.count = 0;
          return -1;
        }
        this.completedBlob = false;
        return this.lineStart;
    }
    return -1;
  }
}

/** Whether text could hold a MathType blob or End line, before or after other removals. */
const mayHoldMathType = (text: string) => text.includes('%') && text.includes('!');

/** Code points in an element of `out`: one for an input character, a replacement's own count. */
const codePointLength = (element: string) =>
  element.length > 1 && (element.codePointAt(0) as number) > 0xffff ? 1 : element.length;

/**
 * How long text in `out` reads on another pass, for the `<?MML` span cap. A break element and a
 * script opener are one element each but two characters. And when the output holds a break,
 * trimming paragraphs collapses every whitespace run that holds a paragraph break — a break
 * element, or two line feeds in a row — to the break alone. So each such run counts as two
 * characters whether trimming runs or not, and every other element as its code points: a span
 * then measures the same in `out`, in the output, and on any later pass.
 *
 * Every measured span starts at a `<?`, so measuring starts at the earliest `<?` in `out`, the
 * origin: text that never forms one pays nothing. The length past the origin is saved for each
 * element with the raw length of the whitespace run it ends, so a span's length is one
 * subtraction and a truncation rewinds in constant time.
 */
class SecondPassLength {
  private readonly origin: number;
  /**
   * Two numbers per prefix of `out` that reaches the origin, the one ending there first: its
   * length past the origin, then the raw length of the whitespace run it ends — 0 for none, -1
   * once that run holds a paragraph break.
   */
  private readonly saved: number[] = [0, 0];

  /** Measure `out` from `origin`, which no whitespace run crosses. */
  constructor(out: readonly string[], origin: number) {
    this.origin = origin;
    for (let i = origin; i < out.length; i++) this.push(out[i] as string, out[i - 1]);
  }

  /** Advance over the element just pushed, `previous` being the one before it. */
  push(element: string, previous: string | undefined): void {
    const saved = this.saved;
    const through = saved[saved.length - 2] as number;
    if (!isWhitespace(element)) {
      saved.push(through + codePointLength(element), 0);
      return;
    }
    const run = saved[saved.length - 1] as number;
    if (run < 0) {
      saved.push(through, -1);
    } else if (element === PARAGRAPH_BREAK || (element === '\n' && previous === '\n')) {
      saved.push(through - run + PARAGRAPH_BREAK.length, -1);
    } else {
      saved.push(through + 1, run + 1);
    }
  }

  /** Return to the length `out` had at `length` elements, the origin still among them. */
  truncate(length: number): void {
    this.saved.length = 2 * (length - this.origin + 1);
  }

  /** How long `out` reads from `start`, at or past the origin and in no whitespace run, to its end. */
  from(start: number): number {
    const through = this.saved[this.saved.length - 2] as number;
    return through - (this.saved[2 * (start - this.origin)] as number);
  }
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
 * how `out` ends rather than by the input: `opens` holds the position of each `<` in `out`,
 * `tagShapes` how the text from the last of them reads as a tag after each element, and
 * `commentStart` the earliest unclosed `<!--`. A tag ends at the first `>` after its `<`, so only
 * the last `<` in `out` can begin one, and none can while a `>` kept as text follows it. A
 * removal that takes that `>` away puts the `<` back in play, as a second pass over the joined
 * text would (`<i%MathType!MTEF!>%!3BD8>`, `<b<?MML >?>>`). Inside an unclosed comment only a `<`
 * opened after it can begin a tag, since `<!` begins none. Each character is examined a bounded
 * number of times.
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
 * `<?` between them, within the cap — so the output stays a fixed point. Both caps measure the
 * span as the output reads it, after paragraph trimming, so another pass makes the same call. A
 * span measured past the cap at a `?>` that a later removal takes away, inside a tag or a
 * comment, is measured again at the next `?>`, which is where another pass would measure it. A
 * `<?` that forms first leaves the span literal even when a later removal takes that `<?` too.
 *
 * Literal `\n`: sources that double-escaped their line breaks leave a backslash and an `n`. One
 * whose backslash is not itself escaped and which no ASCII letter follows becomes a single
 * space, merged with the spaces around it and dropped at either end of the text. Most wrap
 * mid-sentence, so it is never a paragraph break. A letter after it reads as TeX (`\nu`,
 * `\neq`, `\nabla`, a custom `\np`), and no local rule tells those from a glued `\nand`, so
 * those stay. A backslash just before a removed opener forms one with the `n` after it; the
 * section or instruction that opener began stays open.
 *
 * MathType: `MathTypeScanner` follows `out` element by element. A blob starts at the `%` of its
 * first `MathType!MTEF!` header line, or of a Translator line just before it, and ends at its
 * checksum: the first `!` after a data line's characters with four uppercase hex digits. Only
 * header lines and `%`-prefixed `[A-Za-z0-9+-]` data lines sit between — a `%` with no data
 * before the next one ends the run — so a run that meets any other character, or the end of the
 * text, stays literal, header included. A closing `!` right after the checksum goes with it. An
 * End line goes wherever it stands. Both are removed like an `<?MML` instruction: blanks around
 * one merge into one, drop at either end of the text, and none is added between two other
 * characters.
 */
function stripMarkup(text: string): string {
  if (!text.includes('<') && !text.includes(LITERAL_NEWLINE) && !text.includes(MATHTYPE_KEYWORD)) {
    return text;
  }
  const out: string[] = [];
  const mathType = mayHoldMathType(text) ? new MathTypeScanner() : undefined;
  const opens: number[] = [];
  /** The tag shape after each element of `out`. */
  const tagShapes: number[] = [];
  /** Where each `<?` in `out` starts. */
  const instructionOpens: number[] = [];
  /** Measures `out` from the first of `instructionOpens`, while there is one. */
  let lengths: SecondPassLength | undefined;
  const instructions: Instruction[] = [];
  /** Each `<?MML` left literal for passing the cap, and where the `?>` that measured it ends. */
  const overCap: { end: number; instruction: Instruction }[] = [];
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
  /** A MathType blob was just removed; a `!` next closes its checksum and goes with it. */
  let checksumClose = false;
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

  /** Append to `out`; returns where a MathType blob or End line this completes starts, or -1. */
  const push = (element: string): number => {
    let shape = tagShapes.at(-1) ?? TAG_NONE;
    if (element.length === 1) shape = nextTagShape(shape, element);
    else for (const ch of element) shape = nextTagShape(shape, ch);
    tagShapes.push(shape);
    out.push(element);
    lengths?.push(element, out.at(-2));
    return mathType ? mathType.push(element, out.length - 1) : -1;
  };

  /** How long `out` reads from `start`, a `<?` still in it, to its end on another pass. */
  const spanLength = (start: number) => (lengths as SecondPassLength).from(start);

  const truncate = (length: number) => {
    out.length = length;
    tagShapes.length = length;
    mathType?.truncate(length);
    while (opens.length > 0 && (opens.at(-1) as number) >= length) opens.pop();
    // A `<?` goes with its `?`.
    while (instructionOpens.length > 0 && (instructionOpens.at(-1) as number) >= length - 1) {
      instructionOpens.pop();
    }
    if (instructionOpens.length === 0) lengths = undefined;
    else lengths?.truncate(length);
    if (commentStart >= length) commentStart = -1;
    if (cdataStart > length) cdataStart = -1;
    while (instructions.length > 0) {
      const { kind, start } = instructions.at(-1) as Instruction;
      if (kind === 'mml' ? start < length : start <= length) break;
      instructions.pop();
    }
    // A span measured past the cap at a `?>` this takes away is measured again at the next one.
    while (overCap.length > 0 && (overCap.at(-1)?.end as number) >= length) {
      const { instruction } = overCap.pop() as (typeof overCap)[number];
      if (instruction.start < length) instructions.push(instruction);
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
    /**
     * Blanks before a section's or instruction's text stay, so its opener keeps its position. An
     * `<?MML` keeps the blank that ends its target too, or it would open a second time here.
     */
    const instruction = instructions.at(-1);
    const floor = Math.max(
      cdataStart,
      instruction === undefined
        ? -1
        : instruction.start + (instruction.kind === 'mml' ? INSTRUCTION_MML.length + 1 : 0),
    );
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
      push(' ');
      softSpace = length;
    }
  };

  /**
   * Whether the `?>` ending `out` would close a literal `<?MML` on another pass: the nearest `<?`
   * before it begins one, within `MAX_MML_SPAN` of its end.
   */
  const pairsWithLiteralMml = (): boolean => {
    const at = instructionOpens.at(-1);
    if (at === undefined) return false;
    for (let i = 2; i < INSTRUCTION_MML.length; i++) {
      if (out[at + i] !== INSTRUCTION_MML[i]) return false;
    }
    const separator = out[at + INSTRUCTION_MML.length];
    return (
      separator !== undefined && endsInstructionTarget(separator) && spanLength(at) <= MAX_MML_SPAN
    );
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
      push(' ');
    }
    // Sections do not nest; a second opener inside one only goes.
    if (cdataStart < 0) cdataStart = out.length;
  };

  let offset = 0;
  for (const ch of text) {
    const at = offset;
    offset += ch.length;
    if (checksumClose) {
      checksumClose = false;
      if (ch === '!') continue;
    }
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

    const mathTypeStart = push(ch);
    if (mathTypeStart >= 0) {
      checksumClose = mathType?.completedBlob === true;
      truncate(mathTypeStart);
      settleRemoval();
      continue;
    }
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
      if (out.at(-2) === '<') {
        instructionOpens.push(out.length - 2);
        lengths ??= new SecondPassLength(out, out.length - 2);
        if (instructions.at(-1)?.kind === 'mml') {
          instructions.pop();
          literalMml = true;
        }
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
      if (instruction?.kind === 'mml' && spanLength(instruction.start) > MAX_MML_SPAN) {
        instructions.pop();
        overCap.push({ end: out.length - 1, instruction });
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
    const top = opens.at(-1);
    if (top === undefined) continue;
    // Like a tag, a formula opener goes even inside an unclosed comment.
    if (isFormulaOpener(out, top)) {
      truncate(top);
      continue;
    }
    const replacement = replaceTag(out, top, tagShapes[out.length - 2] as number);
    if (replacement === undefined) continue;
    truncate(top);
    if (replacement === PARAGRAPH_BREAK && openInstruction(replacement)) continue;
    if (replacement) push(replacement);
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
