/**
 * @fileoverview Tests for escapeMarkdown — every rendering position is checked by parsing the
 * escaped text with a real CommonMark + GFM parser and comparing what a reader sees against the
 * provider string.
 * @module mcp-server/tools/escape-markdown.test
 */

import { describe, expect, it } from 'vitest';
import { escapeMarkdown } from '@/mcp-server/tools/escape-markdown.js';
import { nodeTypes, nonAutolinks, renderedText } from '../../helpers/markdown.js';

/** Provider strings measured live or constructed to hit each escape rule. */
const HOSTILE = [
  'Fish <Actinopterygii>',
  'Pinus <genus>',
  '[Ir(tpy)(ppy)H](+) and [Cd(H3L)2](ClO4)',
  '![img](x.png)',
  '(*plastic) AND (pollut*',
  '**Figure 1 … **',
  'T * and a*b, c*d',
  '`code` and ``double``',
  '5~10 nm and 20~30 nm, ~~strike~~',
  '_x_ and __init__ and x _y z_ w',
  'snake_case_name Ω_Ω',
  'TeX \\{x\\} \\bf \\\\ and a trailing \\',
  '\\_already\\_escaped',
  '&lt; &amp; &#38; &#x27E9; &frac12; &AMP;',
  '&constructor; AT&T R&D',
  'A < B, P<0.001, 1.7<z<3, i1<i2<',
  '<!-- c --> <?xml?> </p> <http://auto.test> <a@b.co> <br/>',
  'x^2 $x$ | a | b |',
  'Learning C# #',
  'www.example.com/_a_ and _b_',
  'see https://x.org/a](b) now',
  '[t https://x.org/a_b_](b) and https://x.org/[t](u)',
  'cited [1, 2] and [3]',
  // URL-shaped text GFM does not link, or links over a shorter span than the text suggests.
  'http://*x* and www.*y* and http://-a.co/~z~',
  'ahttp://a.co/*x* and xwww.a.co/_y_',
  'see [ref http://a.co/*x* here',
  'https://a.co/x.*. and https://b.co/y*',
  'https://a.co/x<b>bold</b> and https://a.co/&amp; and https://a.co/x/_y_',
  'www.x@y.co*z* and a@b.co-https://c.co/`x` and `y`',
  '<1@b.co> and <+x@y.org> and P<0.05',
];

/** Strings that only matter at the start of a line. */
const LINE_START = [
  '# heading',
  '###### h6',
  '#hashtag',
  '- item',
  '+ item',
  '* item',
  '> quote',
  '1. one',
  '2) two',
  '10. ten',
  '[ref]: http://x.test',
  '[label]',
  '---',
  '***',
  '___',
  '===',
  '```fence',
  '~~~fence',
  '    indented code',
  '<div>block</div>',
  '| a | b |',
];

const collapse = (s: string) => s.replace(/[\r\n\t]+/g, ' ');

describe('escapeMarkdown', () => {
  describe.each([...HOSTILE, ...LINE_START])('%j', (raw) => {
    const expected = collapse(raw);
    const allowed = new Set(['paragraph', 'text', 'strong', 'heading', 'link']);

    it('reads back literally inline after a bold label', () => {
      const md = `**L:** ${escapeMarkdown(raw)}`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(`L: ${expected}`.trimEnd());
    });

    it('reads back literally at the start of a line', () => {
      const md = `heading:\n\nprev: 1\n${escapeMarkdown(raw, 'line-start')}: 5\n${escapeMarkdown(raw, 'line-start')}: 6`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      const line = `${expected.trimStart()}`;
      expect(renderedText(md)).toBe(`heading:\nprev: 1\n${line}: 5\n${line}: 6`);
    });

    it('reads back literally as the first line after a blank line', () => {
      const md = `heading:\n\n${escapeMarkdown(raw, 'line-start')}: 5`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(`heading:\n${expected.trimStart()}: 5`);
    });

    it('reads back literally as ATX heading text', () => {
      const md = `### ${escapeMarkdown(raw, 'heading')}`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(expected.trim());
    });

    // Callers trim inside the wrapper: `**` beside a space neither opens nor closes bold.
    it('reads back literally inside a bold wrapper', () => {
      const md = `**${escapeMarkdown(raw.trim())}** (source)`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(`${collapse(raw.trim())} (source)`);
    });
  });

  it('returns an empty string unchanged in every position', () => {
    expect(escapeMarkdown('')).toBe('');
    expect(escapeMarkdown('', 'line-start')).toBe('');
    expect(escapeMarkdown('', 'heading')).toBe('');
  });

  it('collapses CR, LF, and tab into spaces', () => {
    expect(escapeMarkdown('a\r\nb\nc\td')).toBe('a b c d');
  });

  it('leaves citation brackets alone when no `](` follows them', () => {
    expect(escapeMarkdown('as shown in [1, 2] and [3]')).toBe('as shown in [1, 2] and [3]');
    expect(escapeMarkdown('[Ir(tpy)(ppy)H](+) [1]')).toBe('\\[Ir(tpy)(ppy)H](+) [1]');
  });

  it('escapes with backslashes, never HTML entities', () => {
    const escaped = escapeMarkdown('<i>x</i> *y* & z');
    expect(escaped).toBe('\\<i>x\\</i> \\*y\\* & z');
    expect(escaped).not.toMatch(/&(?:lt|gt|amp);/);
  });

  it.each([
    'https://openalex.org/W2741809807',
    'https://doi.org/10.1002/(sici)1097-4636(199604)30:4<521::aid-jbm11>3.0.co;2-u',
    'https://doi.org/10.1007/978-3-540-78646-8_3',
    'https://example.org/article_view?id=12&lang=de&doc_library=a_b_',
    'https://example.org/~user/_private_/file*name',
    'https://orcid.org/0000-0002-1825-009X',
    'https://ror.org/02jbv0t02',
    'https://openalex.org/keywords/fish-actinopterygii',
    'W2741809807',
    '0028-0836',
    'unknown',
    '-111.0',
    '2024',
  ])('renders the single URL or ID token %s byte-identical in every position', (token) => {
    expect(escapeMarkdown(token)).toBe(token);
    expect(escapeMarkdown(token, 'line-start')).toBe(token);
    expect(escapeMarkdown(token, 'heading')).toBe(token);
  });

  it('escapes the prefix of a URL whose trailing punctuation needs a backslash', () => {
    // A backslash after the link would join its text, so the URL renders unlinked instead.
    expect(escapeMarkdown('https://a.org/x/_')).toBe('https\\://a.org/x/\\_');
    expect(renderedText(`**L:** ${escapeMarkdown('https://a.org/x/_')}`)).toBe(
      'L: https://a.org/x/_',
    );
  });

  it('keeps a `[` one value leaves open from reaching the values after it', () => {
    const values = ['see [ref', 'https://a.co/`x`', 'https://b.co/`y`'];
    const md = values.map((v, n) => `**L${n}:** ${escapeMarkdown(v)}`).join('\n');
    expect(
      nodeTypes(md).filter((t) => !['paragraph', 'text', 'strong', 'link'].includes(t)),
    ).toEqual([]);
    expect(renderedText(md)).toBe(values.map((v, n) => `L${n}: ${v}`).join('\n'));
  });
});

/**
 * Seeded random strings built from Markdown syntax, URL and email pieces, and entity references,
 * interpolated the way the tools' `format()` callbacks place them — several to a paragraph, so
 * state one value leaves open can reach the next. A reader must see exactly the provider text,
 * and the only links allowed are autolinks whose text is their own URL.
 */
describe('escapeMarkdown on random provider text', () => {
  const ATOMS = [
    ...'*_`~<>[]()!#-+=|:&;\\ ./@$^{}"\'?',
    'a',
    'b',
    '1',
    'é',
    '😀',
    '\u00a0',
    '\n',
    'http://',
    'https://a.co/',
    'www.',
    'www.a.co',
    'x@y.co',
    '@b.co>',
    '<1',
    '&amp;',
    '&lt;',
    '&#38;',
    '&copy',
    '[^x]',
    '```',
    '---',
  ];

  function* randomValues(count: number) {
    let seed = 20260924;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let n = 0; n < count; n++) {
      const values: string[] = [];
      for (let v = 0; v < 3; v++) {
        let value = '';
        const length = 1 + Math.floor(random() * 12);
        for (let k = 0; k < length; k++) value += ATOMS[Math.floor(random() * ATOMS.length)];
        values.push(value);
      }
      yield values as [string, string, string];
    }
  }

  const ALLOWED = new Set(['paragraph', 'heading', 'text', 'strong', 'link', 'break']);
  /** Whitespace runs collapse and line edges trim in the rendered text; the rest must match. */
  const words = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/[ \u00a0]+/g, ' ').trim())
      .join('\n');

  it('renders 3,000 random value triples as their literal text', () => {
    for (const [a, b, c] of randomValues(3_000)) {
      const markdown = [
        `### ${escapeMarkdown(a, 'heading')}`,
        `**L:** ${escapeMarkdown(a)}, ${escapeMarkdown(b)}`,
        `**${escapeMarkdown(b.trim())}** (source)`,
        `${escapeMarkdown(c, 'line-start')} (${escapeMarkdown(a)}): 5`,
        `unknown (no value; key ${escapeMarkdown(b)}, label ${escapeMarkdown(c)}): 7`,
      ].join('\n');
      const [ca, cb, cc] = [a, b, c].map(collapse) as [string, string, string];
      const expected = [
        ca,
        `L: ${ca}, ${cb}`,
        `${cb.trim()} (source)`,
        `${cc} (${ca}): 5`,
        `unknown (no value; key ${cb}, label ${cc}): 7`,
      ].join('\n');
      const label = JSON.stringify([a, b, c]);
      expect(
        nodeTypes(markdown).filter((t) => !ALLOWED.has(t)),
        label,
      ).toEqual([]);
      expect(nonAutolinks(markdown), label).toEqual([]);
      // `****` is no bold wrapper: skip the text check when the wrapped name is blank.
      if (cb.trim()) expect(words(renderedText(markdown)), label).toBe(words(expected));
    }
  });
});
