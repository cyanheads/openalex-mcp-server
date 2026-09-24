/**
 * @fileoverview Markdown escaping for provider text at the `content[]` boundary. Every `format()`
 * that interpolates OpenAlex text routes it through `escapeMarkdown`, so the surfaces cannot
 * drift. Escapes use backslashes, never HTML entities, and cover only what a CommonMark + GFM
 * renderer would read as structure; a URL that GFM links cleanly renders byte-identical, as the
 * autolink it is. `structuredContent` never passes through here — it carries the plain text.
 * @module mcp-server/tools/escape-markdown
 */

import { isNamedCharacterReference } from '@/services/openalex/provider-text.js';

/**
 * Where the text lands. `inline` is mid-line (after a label, inside bold, in a list item);
 * `line-start` begins a line, where block syntax (`#`, `- `, `1. `, `>`, `[label]:`) applies;
 * `heading` follows `### `, where a trailing `#` run would close the heading.
 */
export type MarkdownPosition = 'inline' | 'line-start' | 'heading';

/** Line breaks and tabs would start new blocks or indent code; every position is one line. */
const LINE_BREAKS = /[\r\n\t]+/g;

const ASCII_ALPHA = /[A-Za-z]/;
const ASCII_ALPHANUMERIC = /[A-Za-z\d]/;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
/** `<` opens raw HTML or a URI autolink only before these. */
const TAG_START = /[A-Za-z/!?]/;
/**
 * The shape of a CommonMark email autolink, whose local part may also open with a digit or a
 * symbol (`<1@a.co>`); checked only there, so `P<0.05` keeps its `<` unescaped. Looser than the
 * spec's domain rule, which only costs a spare backslash.
 */
const EMAIL_AUTOLINK = /<[\w.!#$%&'*+/=?^`{|}~-]+@[a-zA-Z\d][a-zA-Z\d.-]*>/y;
/** An ordered-list marker: up to nine digits, `.` or `)`, then a space or the end. */
const ORDERED_LIST_MARKER = /^\d{1,9}[.)](?: |$)/;
/** Character references CommonMark decodes; the longest WHATWG name is 31 characters. */
const NUMERIC_REFERENCE = /&#(?:\d{1,7}|[xX][0-9a-fA-F]{1,6});/y;
const NAMED_REFERENCE = /&([A-Za-z][A-Za-z0-9]{0,31});/y;

/*
 * GFM autolink literals, recognized the way micromark-extension-gfm-autolink-literal does. A
 * backslash inside a link would become part of its text and href, so the linked span passes
 * through untouched — which is only safe if the span is exactly what the renderer links.
 */
const HTTP_PREFIX = /^https?:\/\//i;
const WWW_PREFIX = /^www\./i;
/** Characters GFM trims from the end of an autolink literal. */
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([
  '!',
  '"',
  "'",
  ')',
  '*',
  ',',
  '.',
  ':',
  ';',
  '?',
  '_',
  '~',
]);
/** Path characters at which GFM checks whether everything left is trailing punctuation. */
const PATH_TRAIL_CANDIDATES: ReadonlySet<string> = new Set([
  ...TRAILING_PUNCTUATION,
  '&',
  '<',
  ']',
]);
/** Characters a `www.` literal may follow; a protocol literal may follow anything but a letter. */
const WWW_PREVIOUS: ReadonlySet<string> = new Set(['(', '*', '_', '[', ']', '~', ' ']);
/**
 * Trailing punctuation a link leaves unescaped — escaped, the backslash would join the link. It
 * is inert when it holds no `&name;` a renderer would decode and no `*`, and any `_` or `~` forms
 * one run straight after a letter or digit: such a run can close emphasis but never open it, and
 * no other `_` or `~` in the output is left unescaped to open one. A `*` run could close the
 * `**` a caller wraps a name in.
 */
const INERT_TRAIL = /^(?:_+|~+)?[^*_~&]*$/;
const WHITESPACE = /\s/;

/**
 * For each index, where the trailing punctuation starting there ends — at whitespace, `<`, the
 * end, or after a `]` that such a character or a `(`/`[` follows — or -1 when a character that
 * is not trailing punctuation comes first. Built right to left so the scan stays linear.
 */
function trailEnds(s: string): Int32Array {
  const ends = new Int32Array(s.length + 1);
  const alphaEnds = new Int32Array(s.length + 1);
  ends[s.length] = s.length;
  alphaEnds[s.length] = s.length;
  for (let j = s.length - 1; j >= 0; j--) {
    const c = s[j] as string;
    alphaEnds[j] = ASCII_ALPHA.test(c) ? (alphaEnds[j + 1] as number) : j;
    if (c === '<' || WHITESPACE.test(c)) {
      ends[j] = j;
    } else if (TRAILING_PUNCTUATION.has(c)) {
      ends[j] = ends[j + 1] as number;
    } else if (c === ']') {
      const next = s[j + 1];
      ends[j] =
        next === undefined || next === '(' || next === '[' || WHITESPACE.test(next)
          ? j + 1
          : (ends[j + 1] as number);
    } else if (c === '&') {
      // A trailing `&name;` belongs to the trail too.
      const nameEnd = alphaEnds[j + 1] as number;
      ends[j] = nameEnd > j + 1 && s[nameEnd] === ';' ? (ends[nameEnd + 1] as number) : -1;
    } else {
      ends[j] = -1;
    }
  }
  return ends;
}

/**
 * End of a valid domain starting at `start`, or -1. Renderers disagree on how non-ASCII
 * characters classify here, so a domain holding one is treated as one no renderer links.
 */
function domainEnd(s: string, start: number, trail: Int32Array): number {
  let seen = false;
  let underscoreInLast = false;
  let underscoreInLastButOne = false;
  let j = start;
  for (; j < s.length; j++) {
    const c = s[j] as string;
    if (c.charCodeAt(0) > 127) return -1;
    if (c === '.' || c === '_') {
      if (trail[j] !== -1) break;
      if (c === '_') {
        underscoreInLast = true;
      } else {
        underscoreInLastButOne = underscoreInLast;
        underscoreInLast = false;
      }
    } else if (WHITESPACE.test(c) || (c !== '-' && ASCII_PUNCTUATION.test(c))) {
      break;
    } else {
      seen = true;
    }
  }
  return seen && !underscoreInLast && !underscoreInLastButOne ? j : -1;
}

/** End of the path starting at `start`: whitespace, or trailing punctuation to the end. */
function pathEnd(s: string, start: number, trail: Int32Array): number {
  let opened = 0;
  let closed = 0;
  for (let j = start; j < s.length; j++) {
    const c = s[j] as string;
    if (c === '(') {
      opened++;
    } else if (c === ')' && closed < opened) {
      closed++;
    } else if (PATH_TRAIL_CANDIDATES.has(c)) {
      if (trail[j] !== -1) return j;
      if (c === ')') closed++;
    } else if (WHITESPACE.test(c)) {
      return j;
    }
  }
  return s.length;
}

/**
 * Where a GFM autolink literal could begin at `i`: the index of the `:` or `.` whose escape
 * keeps it from linking, or -1 when no literal can start here.
 */
function autolinkPrefixIndex(s: string, i: number): number {
  const previous = s[i - 1];
  const rest = s.slice(i, i + 8);
  if (HTTP_PREFIX.test(rest) && (previous === undefined || !ASCII_ALPHA.test(previous))) {
    return rest.indexOf(':') + i;
  }
  if (
    WWW_PREFIX.test(rest) &&
    s.length > i + 4 &&
    (previous === undefined || WWW_PREVIOUS.has(previous))
  ) {
    return i + 3;
  }
  return -1;
}

/**
 * A GFM email literal: it starts where an atext run does and must end on a letter. GFM matches
 * one before a `www.` literal at the same `w`, and its domain can run on into `http`
 * (`a@b.co-https://…`), so a prefix inside one never starts a link of its own.
 */
const EMAIL_LITERAL = /(?<![\w+./-])[\w+.-]+@[\w-]*(?:\.[A-Za-z\d][\w-]*)+/g;

/** `[start, end)` spans GFM would link as email literals. */
function emailLiteralSpans(s: string): [number, number][] {
  if (!s.includes('@')) return [];
  const spans: [number, number][] = [];
  for (const email of s.matchAll(EMAIL_LITERAL)) {
    if (ASCII_ALPHA.test(email[0].at(-1) as string)) {
      spans.push([email.index, email.index + email[0].length]);
    }
  }
  return spans;
}

/** End of the autolink literal whose prefix is at `i`, or -1 when the renderer would not link. */
function autolinkEnd(s: string, i: number, prefix: number, trail: Int32Array): number {
  // A `www.` literal's domain starts at the `w`; a protocol's after `//`, on neither a control
  // character nor punctuation — not even the `-` a domain may hold later.
  let domainStart = i;
  if (s[prefix] === ':') {
    domainStart = prefix + 3;
    const first = s[domainStart] ?? '';
    const code = first.charCodeAt(0);
    if (code < 32 || code === 127 || ASCII_PUNCTUATION.test(first)) return -1;
  }
  const domain = domainEnd(s, domainStart, trail);
  return domain === -1 ? -1 : pathEnd(s, domain, trail);
}

/**
 * Indices of the `[` characters to escape: those ahead of a `](` pair, where a link needs the
 * `[` to open its label, the one a line starts with, and any the text never closes. Left open, a
 * `[` stays an unbalanced label across everything interpolated after it on the line, and GFM
 * links no URL inside an unbalanced label.
 */
function escapedBrackets(s: string, blockMarker: number): Set<number> {
  const lastLinkClose = s.lastIndexOf('](');
  const escaped = new Set<number>();
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') {
      if (i < lastLinkClose || i === blockMarker) escaped.add(i);
      else open.push(i);
    } else if (s[i] === ']') {
      open.pop();
    }
  }
  for (const i of open) escaped.add(i);
  return escaped;
}

/** Whether the `<` at `index` opens raw HTML or an autolink. */
function opensTagOrAutolink(text: string, index: number): boolean {
  if (TAG_START.test(text[index + 1] ?? '')) return true;
  EMAIL_AUTOLINK.lastIndex = index;
  return EMAIL_AUTOLINK.test(text);
}

/** Whether the `&` at `index` starts a reference a Markdown renderer would decode. */
function startsCharacterReference(text: string, index: number): boolean {
  NUMERIC_REFERENCE.lastIndex = index;
  if (NUMERIC_REFERENCE.test(text)) return true;
  NAMED_REFERENCE.lastIndex = index;
  const named = NAMED_REFERENCE.exec(text);
  return named !== null && isNamedCharacterReference(named[1] as string);
}

/**
 * Index of the `#` that would open an ATX closing sequence — a trailing run of `#` preceded by a
 * space or standing alone — or -1 when the text has none.
 */
function closingHashIndex(text: string): number {
  const end = text.trimEnd().length;
  let start = end;
  while (start > 0 && text[start - 1] === '#') start--;
  if (start === end) return -1;
  return start === 0 || text[start - 1] === ' ' ? start : -1;
}

/** Index of the character to escape so the text cannot open a block at the start of a line. */
function blockMarkerIndex(text: string): number {
  const first = text[0];
  if (first === '#' || first === '>' || first === '[') return 0;
  if ((first === '-' || first === '+') && (text.length === 1 || text[1] === ' ')) return 0;
  const ordered = ORDERED_LIST_MARKER.exec(text);
  return ordered ? ordered[0].trimEnd().length - 1 : -1;
}

/**
 * Escape provider text for Markdown so a renderer shows exactly the characters it holds.
 *
 * Escaped everywhere: `*`, backticks, `~` (GFM strikethrough), `<` before a letter, `/`, `!`, or
 * `?`, `_` unless it sits between two letters or digits, `&` when it starts a character reference
 * a renderer would decode, a backslash before punctuation or at the end, a `<` that opens an
 * email autolink, and any `[` ahead of a `](` pair (a link needs it to open its label) or never
 * closed. Closed citation brackets with no `](` after them stay as they are. At a line start,
 * also the block markers; in a heading, a trailing `#` run. Line breaks and tabs collapse to a
 * space.
 *
 * A span GFM links as an autolink literal passes through untouched. When it cannot — trailing
 * punctuation that needs an escape would join the link, an open `[` or an email literal holds
 * it, or GFM would not link it at all — the `:` or `.` of its prefix is escaped instead, which
 * reads the same but links nothing in any renderer, and the span is escaped like any other text.
 */
export function escapeMarkdown(text: string, position: MarkdownPosition = 'inline'): string {
  let s = text.replace(LINE_BREAKS, ' ');
  if (position === 'line-start') s = s.trimStart();

  const blockMarker = position === 'line-start' ? blockMarkerIndex(s) : -1;
  const closingHash = position === 'heading' ? closingHashIndex(s) : -1;
  const brackets = escapedBrackets(s, blockMarker);
  let trail: Int32Array | undefined;
  let emails: [number, number][] | undefined;
  let nextEmail = 0;
  let openBrackets = 0;

  /**
   * Whether the autolink literal ending at `end`, with its trailing punctuation up to `trailEnd`,
   * renders as exactly those characters: no open `[` before it, inert trailing punctuation, and
   * no escape needed on the character past it, whose backslash would join the link.
   */
  const linksCleanly = (end: number, trailEnd: number): boolean => {
    if (openBrackets > 0) return false;
    const trailing = s.slice(end, trailEnd);
    if (!INERT_TRAIL.test(trailing)) return false;
    if (/^[_~]/.test(trailing) && !ASCII_ALPHANUMERIC.test(s[end - 1] as string)) return false;
    const after = s[trailEnd];
    if (after === '<') return !opensTagOrAutolink(s, trailEnd);
    return after !== '[' || !brackets.has(trailEnd);
  };

  // Unescaped runs are copied as slices; `copied` marks where the pending run begins.
  const parts: string[] = [];
  let copied = 0;
  let prefixToEscape = -1;
  // Autolink prefixes before this index sit inside a span that could not link as a whole.
  let unlinkedUntil = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const next = s[i + 1];

    if (ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W') {
      const prefix = autolinkPrefixIndex(s, i);
      if (prefix !== -1) {
        trail ??= trailEnds(s);
        emails ??= emailLiteralSpans(s);
        while ((emails[nextEmail]?.[1] ?? Number.POSITIVE_INFINITY) <= i) nextEmail++;
        const inEmail = (emails[nextEmail]?.[0] ?? Number.POSITIVE_INFINITY) <= i;
        const end = i < unlinkedUntil || inEmail ? -1 : autolinkEnd(s, i, prefix, trail);
        // The link and its inert trailing punctuation pass through as they are.
        if (end !== -1 && linksCleanly(end, trail[end] as number)) {
          i = (trail[end] as number) - 1;
          continue;
        }
        prefixToEscape = prefix;
        unlinkedUntil = Math.max(unlinkedUntil, end);
      }
    }

    let needsEscape: boolean;
    switch (ch) {
      case '*':
      case '`':
      case '~':
        needsEscape = true;
        break;
      case '_':
        needsEscape = !(WORD_CHARACTER.test(s[i - 1] ?? '') && WORD_CHARACTER.test(next ?? ''));
        break;
      case '\\':
        needsEscape = next === undefined || ASCII_PUNCTUATION.test(next);
        break;
      case '<':
        needsEscape = opensTagOrAutolink(s, i);
        break;
      case '[':
        needsEscape = brackets.has(i);
        if (!needsEscape) openBrackets++;
        break;
      case ']':
        needsEscape = false;
        if (openBrackets > 0) openBrackets--;
        break;
      case '&':
        needsEscape = startsCharacterReference(s, i);
        break;
      default:
        needsEscape = i === blockMarker || i === closingHash || i === prefixToEscape;
    }
    if (needsEscape) {
      parts.push(s.slice(copied, i), '\\');
      copied = i;
    }
  }
  parts.push(s.slice(copied));
  return parts.join('');
}
