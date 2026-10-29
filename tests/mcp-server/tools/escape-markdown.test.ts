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

/** What a reader sees for a provider string: CommonMark reads CR and CRLF as LF. */
const lf = (s: string) => s.replace(/\r\n?/g, '\n');

describe('escapeMarkdown', () => {
  describe.each([...HOSTILE, ...LINE_START])('%j', (raw) => {
    const expected = lf(raw);
    const allowed = new Set(['paragraph', 'text', 'strong', 'heading', 'link']);

    it('reads back literally inline after a bold label', () => {
      const md = `**L:** ${escapeMarkdown(raw)}`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(`L: ${expected}`);
    });

    it('reads back literally at the start of a line', () => {
      const md = `heading:\n\nprev: 1\n${escapeMarkdown(raw, 'line-start')}: 5\n${escapeMarkdown(raw, 'line-start')}: 6`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(`heading:\nprev: 1\n${expected}: 5\n${expected}: 6`);
    });

    it('reads back literally as the first line after a blank line', () => {
      const md = `heading:\n\n${escapeMarkdown(raw, 'line-start')}: 5`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(`heading:\n${expected}: 5`);
    });

    it('reads back literally as ATX heading text', () => {
      const md = `### ${escapeMarkdown(raw, 'heading')}`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(expected);
    });

    it('reads back literally inside a bold wrapper', () => {
      const md = `**${escapeMarkdown(raw)}** (source)`;
      expect(nodeTypes(md).filter((t) => !allowed.has(t))).toEqual([]);
      expect(renderedText(md)).toBe(`${expected} (source)`);
    });
  });

  it('returns an empty string unchanged in every position', () => {
    expect(escapeMarkdown('')).toBe('');
    expect(escapeMarkdown('', 'line-start')).toBe('');
    expect(escapeMarkdown('', 'heading')).toBe('');
  });

  it('keeps line breaks as hard breaks and tabs as tabs (gh #128)', () => {
    expect(escapeMarkdown('a\r\nb\nc\td')).toBe('a\\\nb\\\nc\td');
    expect(escapeMarkdown('a\rb')).toBe('a\\\nb');
  });

  it('writes a final line break, edge whitespace, and blank lines as references (gh #128)', () => {
    expect(escapeMarkdown('a\n')).toBe('a&#10;');
    expect(escapeMarkdown(' a\t')).toBe('&#32;a&#9;');
    expect(escapeMarkdown('a\n\n  \nb')).toBe('a\\\n\\\n&#32;&#32;\\\nb');
    expect(escapeMarkdown('  ', 'line-start')).toBe('&#32;&#32;');
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
 * Provider text with line breaks, in every slot a multi-line value can land in. The real values
 * are measured OpenAlex strings after `provider-text.ts` normalization (gh #128).
 */
describe('escapeMarkdown on multi-line provider text (gh #128)', () => {
  const MULTI_LINE = [
    // W2611533896 abstract
    'Implementar ayudas tecnicas en personas con discapacidad fisica de\r\nla Parroquia San Juan de Iluman del Canton Otavalo en la provincia\r\nde Imbabura en el periodo 2015-2016.',
    // W2236131296 abstract, first two lines: a space before the break, then `=` and parentheses
    'مفهوم شبة المضاعف m (Quasi-multiplier )على الجبر A انه ترابط معرف من AxA الي نفسها بحيث \r\nm(ax,yb)=am(x,y)b لكل من a,x,y,b تنتمي إلي A',
    // W4206853251 raw_affiliation_strings: a blank line
    "LCME - Laboratoire de Chimie Moléculaire et Environnement (Université Savoie Mont Blanc - LCME 73376 Le Bourget du Lac cedex\r\n\r\nA fusionné avec l'Edytem - France)",
    // W4206853251: `[…]`, a space before a break, and a line opening with ` - `
    "LSCE - Laboratoire des Sciences du Climat et de l'Environnement [Gif-sur-Yvette] (Bât. 12,\r\navenue de la Terrasse, \r\nF-91198 GIF-SUR-YVETTE CEDEX\r\n - France)",
    // W4232217492: a continuation line indented by twelve spaces
    'Aus der Rontgenabteilung (Leitung: Prof. Dr. H. Reindell) der Medizinischen Universitäts-Klinik\n            Freiburg i. Br. (Direktor: Prof. Dr. Dr. h. c. L. Heilmeyer)',
    // W2908174118
    'Key Laboratory of Ocean Energy Utilization and Energy Conservation of Ministry of Education,\nSchool of Energy and Power Engineering, Dalian University of Technology, Dalian 116024, China',
    // A5149007440 display_name_alternatives
    'Wichmann, Arthur,\n    b. 1851.',
    // W3174182629 and W2058299847: a leading and a trailing space
    ' Department of Physiology Tzu Chi university Hualien Taiwan',
    'Department of Biology, Ecology and Earth Sciences (Di.B.E.S.T.), University of Calabria , Rende , Italy ',
    // W2904215230 abstract tail: tabs
    'Keywords\t: Early Breastfeeding Initiation, Body Temperature of Neonates\r\nReferences\t: 44 (2007 – 2017)',
    // Constructed: what a continuation line could open, and the edges of a break.
    'line one\n- not a list\n+ nor this\n* nor this\n# not a heading\n> not a quote\n1. not a list\n2) nor this',
    'a\n-\tnot a list\n1.\tnor this\n\tindented by a tab',
    'setext\n---\nand\n==\nand\n- - -',
    'a | b\n---|---\nand\n|---|\nand\n:-',
    'fences\n```\nx\n~~~\n<div>not html</div>',
    '[label]: http://x.test\n[^1]: footnote',
    'ends with a break\n',
    '\n\nonly breaks before\n\n',
    'a\n   \nwhitespace-only line',
    'Learning C# #\nC:\\dir\\\nnext',
    'see https://doi.org/10.1/x\nand www.example.com/a_b_\nnext',
    // GFM links a `www.` after a tab, and none after the `;` of a leading reference.
    'tab\twww.a.co/`x`\n\twww.b.co/`y`',
    'line one\nsee https://doi.org/10.1/x here and a@b.co too',
  ];

  /** Each slot renders the Markdown a tool builds around the value `place` escapes for it. */
  const SLOTS: [string, (place: (position: 'inline' | 'line-start') => string) => string][] = [
    ['a **Field:** line', (e) => `**Abstract:** ${e('inline')}\n**Next:** x`],
    ['a list item', (e) => `**Authorships:**\n- [0] raw: ${e('inline')}\n- [1] k: y`],
    ['a bold name', (e) => `**${e('inline')}** (work)\nid | hint`],
    ['a line-start label', (e) => `heading:\n\n${e('line-start')}: 5\nother: 6`],
  ];

  /** Block-level structure: everything but inline text, breaks, and links. */
  const structure = (md: string) =>
    nodeTypes(md).filter((t) => !['text', 'break', 'link'].includes(t));

  describe.each(SLOTS)('in %s', (_slot, render) => {
    it.each(MULTI_LINE)('%j reads back intact', (raw) => {
      const md = render((position) => escapeMarkdown(raw, position));
      const skeleton = render(() => 'VALUE');
      expect(structure(md)).toEqual(structure(skeleton));
      expect(nonAutolinks(md)).toEqual([]);
      expect(renderedText(md)).toBe(renderedText(skeleton).replace('VALUE', () => lf(raw)));
    });
  });

  // A hard break's backslash, or the reference a trailing space becomes, would join the link.
  it('keeps a URL mid-line byte-identical, and keeps a break or space out of a URL ending a line', () => {
    const md = `**L:** ${escapeMarkdown('see https://doi.org/10.1/x here\nhttps://a.co/y\nhttps://b.co/z \nwww.\nend')}`;
    expect(md).toContain('see https://doi.org/10.1/x here');
    expect(nonAutolinks(md)).toEqual([]);
    expect(renderedText(md)).toBe(
      'L: see https://doi.org/10.1/x here\nhttps://a.co/y\nhttps://b.co/z \nwww.\nend',
    );
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

  it('renders 3,000 random value triples as their literal text', () => {
    for (const [a, b, c] of randomValues(3_000)) {
      // A heading holds one line: a multi-line name takes a labeled line, as entity records do.
      const title = /[\r\n]/.test(a)
        ? `### W1\n**Display Name:** ${escapeMarkdown(a)}`
        : `### ${escapeMarkdown(a, 'heading')}`;
      const markdown = [
        title,
        `**L:** ${escapeMarkdown(a)}, ${escapeMarkdown(b)}`,
        `**${escapeMarkdown(b)}** (source)`,
        `${escapeMarkdown(c, 'line-start')} (${escapeMarkdown(a)}): 5`,
        `unknown (no value; key ${escapeMarkdown(b)}, label ${escapeMarkdown(c)}): 7`,
      ].join('\n');
      const [la, lb, lc] = [a, b, c].map(lf) as [string, string, string];
      const expected = [
        /[\r\n]/.test(a) ? `W1\nDisplay Name: ${la}` : la,
        `L: ${la}, ${lb}`,
        `${lb} (source)`,
        `${lc} (${la}): 5`,
        `unknown (no value; key ${lb}, label ${lc}): 7`,
      ].join('\n');
      const label = JSON.stringify([a, b, c]);
      expect(
        nodeTypes(markdown).filter((t) => !ALLOWED.has(t)),
        label,
      ).toEqual([]);
      expect(nonAutolinks(markdown), label).toEqual([]);
      // `****` is no bold wrapper: skip the text check when the wrapped name is empty.
      if (b !== '') expect(renderedText(markdown), label).toBe(expected);
    }
  }, 60_000);
});
