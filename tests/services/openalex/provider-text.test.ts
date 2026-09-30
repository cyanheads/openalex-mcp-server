/**
 * @fileoverview Property tests for the provider-text markup scanner: on tag-dense random input
 * its single linear pass must equal what repeating a regex replacement until nothing changes
 * produces, and with comments or CDATA/instruction/line-break delimiters mixed in it must leave
 * nothing to strip and be idempotent. Delimiter fixtures follow the property tests.
 * @module services/openalex/provider-text.test
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeProviderText,
  normalizeProviderValue,
} from '@/services/openalex/provider-text.js';

const TAG = /<(\/?)([A-Za-z][\w:.-]*)(?:\s[^<>]*)?\/?>/g;

/** What one complete tag becomes under the rules the scanner implements. */
function rewriteTag(tag: string, closing: string, rawName: string): string {
  const name = rawName.toLowerCase();
  if (['i', 'b', 'em', 'span', 'jats:italic'].includes(name) || name.startsWith('mml:')) return '';
  if (name === 'p' || name === 'br') return '\n\n';
  if (name === 'sub' || name === 'sup') {
    if (tag.endsWith('/>')) return '';
    return closing ? '}' : name === 'sub' ? '_{' : '^{';
  }
  return tag;
}

/**
 * Regex oracle for the tag rules (the inputs it checks carry no comments): rewrite every tag,
 * left to right, until a pass changes nothing — quadratic on deep nesting, which is fine at test
 * sizes.
 */
function reference(text: string): string {
  let t = text;
  let prev: string;
  do {
    prev = t;
    let hadBlock = false;
    let rewritten = '';
    let copied = 0;
    for (const match of t.matchAll(TAG)) {
      const [tag, closing = '', rawName = ''] = match;
      const replacement = rewriteTag(tag, closing, rawName);
      if (replacement === '\n\n') hadBlock = true;
      rewritten += t.slice(copied, match.index) + replacement;
      copied = match.index + tag.length;
    }
    t = rewritten + t.slice(copied);
    if (hadBlock) {
      t = t
        .split('\n\n')
        .map((p) => p.trim())
        .filter(Boolean)
        .join('\n\n');
    }
  } while (t !== prev);
  return t;
}

const TAG_ATOMS = [
  '<',
  '>',
  '!',
  'i',
  'b',
  'x',
  ' ',
  '/',
  '"',
  'a',
  'span',
  '<i>',
  '</i>',
  '<p>',
  '<br/>',
  '<sub>',
  '</sub>',
  '<sup>',
  '<a',
  '<mml:mi>',
  '<Fish>',
];
const COMMENT_ATOMS = [...TAG_ATOMS, '<!--', '-->', '-'];
/** The gh #89 delimiters, plus fragments that re-form an opener across a removed tag. */
const DELIMITER_ATOMS = [
  ...COMMENT_ATOMS,
  '<![CDATA[',
  '<![CDA',
  'TA[',
  ']]',
  ']]>',
  ']',
  '<?CDATA ',
  '<?MML ',
  '<?CDATA',
  '<?',
  '?>',
  '<!--inline-formula>',
  String.raw`\n`,
  '\\',
  'n',
];

/** Deterministic random strings built from `atoms`. */
function* randomInputs(atoms: string[], count: number) {
  let seed = 20260923;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 0; n < count; n++) {
    let input = '';
    const length = 1 + Math.floor(random() * 16);
    for (let k = 0; k < length; k++) input += atoms[Math.floor(random() * atoms.length)];
    yield input;
  }
}

const ALLOWLISTED_TAG =
  /<\/?(?:i|b|em|span|p|br|sub|sup|jats:italic|mml:[\w.-]+)(?:\s[^<>]*)?\/?>/i;

/** A `\n` the scanner would turn into a space: its backslash unescaped, no ASCII letter after. */
const LITERAL_NEWLINE = /(?<!\\)\\n(?![A-Za-z])/;

/** The longest `<?MML … ?>` span the scanner removes. */
const MML_SPAN_CAP = 128;

/**
 * Whether `text` holds an `<?MML` instruction another pass would remove: its target, a
 * separator, then a `?>` within the span cap with no other `<?` before it.
 */
function hasRemovableMml(text: string): boolean {
  for (let at = text.indexOf('<?MML'); at >= 0; at = text.indexOf('<?MML', at + 1)) {
    if (!/[ \t\n\r?]/.test(text[at + 5] ?? '')) continue;
    const close = text.indexOf('?>', at + 5);
    if (close < 0) continue;
    const next = text.indexOf('<?', at + 2);
    if ((next < 0 || next > close) && close + 2 - at <= MML_SPAN_CAP) return true;
  }
  return false;
}

describe('normalizeProviderText markup scanner', () => {
  it('matches the regex fixed point on 20,000 random tag inputs', { timeout: 30_000 }, () => {
    for (const input of randomInputs(TAG_ATOMS, 20_000)) {
      expect(normalizeProviderText(input), JSON.stringify(input)).toBe(reference(input));
    }
  });

  /**
   * With comments in the mix the scanner resolves constructs strictly left to right: a tag
   * removed inside an open comment can form the `-->` that closes it, where a regex pass would
   * first match the comment against a `-->` further on. The output still holds no comment and
   * no allowlisted tag, and a second run changes nothing.
   */
  it('leaves no comment or allowlisted tag and is idempotent on 20,000 random inputs', {
    timeout: 30_000,
  }, () => {
    for (const input of randomInputs(COMMENT_ATOMS, 20_000)) {
      const output = normalizeProviderText(input);
      expect(output, JSON.stringify(input)).not.toMatch(ALLOWLISTED_TAG);
      expect(output, JSON.stringify(input)).not.toMatch(/<!--[\s\S]*?-->/);
      expect(normalizeProviderText(output), JSON.stringify(input)).toBe(output);
    }
  });

  it('leaves no CDATA, instruction, formula opener, or literal \\n and is idempotent on 20,000 random delimiter inputs (gh #89)', {
    timeout: 30_000,
  }, () => {
    for (const input of randomInputs(DELIMITER_ATOMS, 20_000)) {
      const output = normalizeProviderText(input);
      const label = JSON.stringify(input);
      expect(output, label).not.toContain('<![CDATA[');
      expect(output, label).not.toMatch(/<\?CDATA[\s?]/);
      expect(hasRemovableMml(output), label).toBe(false);
      expect(output, label).not.toContain('<!--inline-formula>');
      expect(output, label).not.toMatch(LITERAL_NEWLINE);
      expect(normalizeProviderText(output), label).toBe(output);
    }
  });

  it('closes a comment at a `-->` that a tag removal inside it forms', () => {
    expect(normalizeProviderText('a <!--<!--<i>>-->b')).toBe('a -->b');
  });

  it('ignores a block tag that sits inside a removed comment', () => {
    expect(normalizeProviderText('</sub></i><sub><!-- <p>-->a ')).toBe('}_{a ');
  });

  it('keeps a decoded script tag as literal text', () => {
    expect(normalizeProviderText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(
      '<script>alert(1)</script>',
    );
  });
});

/**
 * XML/JATS delimiters and double-escaped line breaks that sources leave in titles and abstracts.
 * Fixtures marked with a work ID are copied from that record's upstream text as of 2026-09-30.
 */
describe('normalizeProviderText delimiters and literal \\n (gh #89)', () => {
  it.each([
    [
      'a whole-title wrapper (W2143241432)',
      '<![CDATA[Immune cellular response to HPV: current concepts]]>',
      'Immune cellular response to HPV: current concepts',
    ],
    [
      'an unterminated section',
      '<![CDATA[From a review of the first edition',
      'From a review of the first edition',
    ],
    [
      'a section closed by ]] and a character other than >',
      String.raw`a real \(<![CDATA[$z$]]\) is random`,
      String.raw`a real \($z$\) is random`,
    ],
    ['a section closed by ]] at the end of the text', 'x <![CDATA[y]]', 'x y'],
    ['a section whose body is bracketed', '<![CDATA[[x]]]>', '[x]'],
    ['a section whose body ends in ]', '<![CDATA[x [via intern.de]]]>', 'x [via intern.de]'],
  ])('unwraps CDATA: %s', (_label, input, expected) => {
    expect(normalizeProviderText(input)).toBe(expected);
  });

  it.each([
    [
      'one space before the opener (W2337004314)',
      String.raw`it satisfies AX=bX≥O ]] <![CDATA[$$AX = bX \geqslant O$$ where A is an m x n matrix`,
      String.raw`it satisfies AX=bX≥O $$AX = bX \geqslant O$$ where A is an m x n matrix`,
    ],
    [
      'repeated through one abstract (W2337004314)',
      String.raw`feasible if E= μ T X ]] <![CDATA[$$E = {\mu ^T}X$$ V= X T CX ]] <![CDATA[$$V = {X^T}CX$$ for some`,
      String.raw`feasible if E= μ T X $$E = {\mu ^T}X$$ V= X T CX $$V = {X^T}CX$$ for some`,
    ],
    ['no space before the opener', 'O]]<![CDATA[x', 'Ox'],
  ])('removes a bare ]] that closes a lost section before an opener: %s', (_l, input, expected) => {
    expect(normalizeProviderText(input)).toBe(expected);
  });

  it.each([
    [']] with no opener', 'gradient of − $0.04]] > to − 0.05 dex'],
    [']]> with no opener', 'a ]]> b'],
  ])('keeps %s', (_label, input) => {
    expect(normalizeProviderText(input)).toBe(input);
  });

  it('keeps a ]] two spaces before an opener while still unwrapping the section', () => {
    expect(normalizeProviderText('O ]]  <![CDATA[x')).toBe('O ]]  x');
  });

  it.each([
    ['TeX double brackets', '<![CDATA[$k[[x]]$]]>', '$k[[x]]$'],
    ['a nested index', 'x <![CDATA[a[b[1]] + c]]> y', 'x a[b[1]] + c y'],
    ['a ]] before a space', '<![CDATA[a]] b]]>', 'a]] b'],
    ['a ]] as the last text', '<![CDATA[a]]]]>', 'a]]'],
    ['the second of two sections', '<![CDATA[a]] b <![CDATA[c]] d ]]> e', 'a b c]] d  e'],
  ])('keeps a ]] inside a section that a later ]]> closes: %s', (_label, input, expected) => {
    expect(normalizeProviderText(input)).toBe(expected);
  });

  it('closes a section at a bare ]] when another opener comes before any ]]>', () => {
    expect(normalizeProviderText('<![CDATA[a]] b <![CDATA[c]]>')).toBe('a b c');
  });

  it.each([
    [
      'an IOP pair (W3105622196)',
      String.raw`sodium blueshifted by <?CDATA $(8\pm 2)$?> <?MML ( 8 ± 2 ) ?> km s −1 , this likely implies`,
      String.raw`sodium blueshifted by $(8\pm 2)$ km s −1 , this likely implies`,
    ],
    ['a CDATA instruction on its own', 'a <?CDATA x?> b', 'a x b'],
    ['an unterminated CDATA instruction', 'velocity of <?CDATA $v$ km', 'velocity of $v$ km'],
    ['an MML instruction holding a comment', 'p <?MML ( 3 <!-- note --> 4 ) ?> q', 'p q'],
    ['an MML instruction at the start', '<?MML ( 1 ) ?> km', 'km'],
    ['an MML instruction at the end', 'value $x$ <?MML ( x ) ?>', 'value $x$'],
    ['a CDATA target ended by a literal \\n', String.raw`a <?CDATA\n $x$?> b`, 'a $x$ b'],
    ['an MML target ended by a literal \\n', String.raw`a <?MML\n( 1 ) ?> b`, 'a b'],
    ['a CDATA target ended by a block tag', 'a <?CDATA<br/>$x$?> b', 'a $x$ b'],
    ['a CDATA target ended by the space a lost ]] leaves', '<?CDATA]] <![CDATA[x?>', 'x'],
  ])('handles processing instructions: %s', (_label, input, expected) => {
    expect(normalizeProviderText(input)).toBe(expected);
  });

  it.each([
    ['an unterminated MML instruction', 'a <?MML ( 8 ± 2 ) km'],
    ['an XML declaration', '<?xml version="1.0"?> text'],
    ['a PHP block', 'run <?php echo 1; ?> here'],
    ['a longer target name', '<?CDATAX y?>'],
  ])('keeps %s literal', (_label, input) => {
    expect(normalizeProviderText(input)).toBe(input);
  });

  /**
   * An MML instruction whose `?>` was lost must not delete the text up to some later `?>`. A
   * `<?` opening first leaves it literal; a stray `?>` that would close it on another pass goes,
   * so the output stays a fixed point.
   */
  it.each([
    [
      'CDATA and MML pairs follow',
      'a <?MML ( 1 ) b c <?CDATA $x$?> <?MML ( x ) ?> d ?> e',
      'a <?MML ( 1 ) b c $x$ d e',
    ],
    ['another MML instruction follows', 'a <?MML ( 1 ) <?MML ( 2 ) ?> b', 'a <?MML ( 1 ) b'],
    ['a literal instruction follows', 'a <?MML ( 1 ) <?php x ?> b', 'a <?MML ( 1 ) <?php x ?> b'],
  ])(
    'keeps an MML instruction literal when another <? opens before its ?>: %s',
    (_l, input, expected) => {
      const output = normalizeProviderText(input);
      expect(output).toBe(expected);
      expect(normalizeProviderText(output)).toBe(output);
    },
  );

  /** `<?MML ` + filler + ` ?>`, `span` characters in all. */
  const mmlSpanning = (span: number) => `<?MML ${'x'.repeat(span - 9)} ?>`;

  it('removes an MML instruction spanning exactly the 128-character cap', () => {
    expect(normalizeProviderText(`a ${mmlSpanning(MML_SPAN_CAP)} b`)).toBe('a b');
  });

  it('keeps an MML instruction one character past the cap literal', () => {
    const input = `a ${mmlSpanning(MML_SPAN_CAP + 1)} b`;
    expect(normalizeProviderText(input)).toBe(input);
  });

  it('removes an inline-formula opener that never closes (W3104529773)', () => {
    expect(
      normalizeProviderText(
        String.raw`the integrated line intensities I12CO<!--inline-formula> <![CDATA[\\hbox{$I_{^{12}\\rm CO}$}]]> I12CO /I13CO> 4.\n`,
      ),
    ).toBe(
      String.raw`the integrated line intensities I12CO \\hbox{$I_{^{12}\\rm CO}$} I12CO /I13CO> 4.`,
    );
  });

  it('keeps the text between a formula opener and a later --> arrow', () => {
    expect(normalizeProviderText('A<!--inline-formula> <![CDATA[x]]> B ---> C')).toBe(
      'A x B ---> C',
    );
  });

  it('removes a formula opener inside an unclosed comment', () => {
    expect(normalizeProviderText('a <!-- b<!--inline-formula> c')).toBe('a <!-- b c');
  });

  it('keeps the text between a formula opener and a later comment', () => {
    expect(normalizeProviderText('a <!--inline-formula> b <!-- c --> d')).toBe('a  b  d');
  });

  it.each([
    ['a spaced comment', 'a<!-- comment -->b', 'ab'],
    ['an unclosed comment', 'a <!-- b', 'a <!-- b'],
    ['a non-allowlisted name', 'a <!--foo> b', 'a <!--foo> b'],
  ])('treats %s as before', (_label, input, expected) => {
    expect(normalizeProviderText(input)).toBe(expected);
  });

  it.each([
    [
      'a leading section label (W3104529773)',
      String.raw`\n Context. Born-again stars provide a unique possibility to study the evolution of the circumstellar envelope of evolved stars in human timescales.`,
      'Context. Born-again stars provide a unique possibility to study the evolution of the circumstellar envelope of evolved stars in human timescales.',
    ],
    [
      'a section label mid-text (W3104529773)',
      String.raw`However, up until now, all attempts to detect molecular emission from the cool material around born-again stars have failed.\n Aims. We searched for emission from rotational transitions of molecules in the hydrogen-deficient circumstellar envelopes of born-again stars to explore the chemical composition, kinematics, and physical parameters of the relatively cool gas.`,
      'However, up until now, all attempts to detect molecular emission from the cool material around born-again stars have failed. Aims. We searched for emission from rotational transitions of molecules in the hydrogen-deficient circumstellar envelopes of born-again stars to explore the chemical composition, kinematics, and physical parameters of the relatively cool gas.',
    ],
    [
      'a title (W3100494400)',
      String.raw`VISIR / VLT mid-infrared imaging of Seyfert\n nuclei: \n nuclear dust emission and the Seyfert-2 dichotomy`,
      'VISIR / VLT mid-infrared imaging of Seyfert nuclei: nuclear dust emission and the Seyfert-2 dichotomy',
    ],
    [
      'mid-sentence wraps (W3100494400)',
      String.raw`Half of the Seyfert-2 galaxies\n escaped detection of broad lines in their\n polarised spectra`,
      'Half of the Seyfert-2 galaxies escaped detection of broad lines in their polarised spectra',
    ],
    [
      'a run of them (W3100494400)',
      String.raw`as traced by [OIII]. \n \n Methods.During the scientific verification phase`,
      'as traced by [OIII]. Methods.During the scientific verification phase',
    ],
    ['one before a digit', String.raw`suggest\n1) that`, 'suggest 1) that'],
    ['one before punctuation', String.raw`end\n. Next`, 'end . Next'],
    ['one before a backslash', String.raw`x\n\nu`, String.raw`x \nu`],
    ['one inside markup', String.raw`<i>a</i>\n<b>b</b>`, 'a b'],
  ])('turns a literal \\n into a space: %s', (_label, input, expected) => {
    expect(normalizeProviderText(input)).toBe(expected);
  });

  it('never turns a literal \\n into a paragraph break', () => {
    expect(normalizeProviderText(String.raw`one\n two\n\n three`)).not.toContain('\n');
  });

  it.each([
    ['a CDATA section', String.raw`\<![CDATA[n x]]>`, 'x'],
    ['a CDATA section mid-text', String.raw`a \<![CDATA[n x]]> b`, 'a x b'],
    ['a CDATA instruction', String.raw`a \<?CDATA n$x$?> b`, 'a $x$ b'],
  ])(
    'turns a \\n joined across a removed opener into a space and keeps %s open',
    (_l, input, expected) => {
      expect(normalizeProviderText(input)).toBe(expected);
    },
  );

  it.each([
    String.raw`$\nu$`,
    String.raw`spin-down of $ \langle\dot\nu\rangle \sim -2$ Hz`,
    String.raw`there exist $x\neq y$ in X`,
    String.raw`$\nabla f$`,
    String.raw`a \newline b`,
    String.raw`\noindent text`,
    String.raw`$a \nonumber$`,
    String.raw`\(f\) is locally QH \(\nRightarrow f\) is QH`,
    String.raw`contains both $\np^{\bpp}$ and`,
    String.raw`$f_{\\nu}\\propto \\nu^{-1.4}$`,
    String.raw`distances, \nand did not`,
    'Mitochondrial Theory of Aging (CDATA)',
    'XML config files with XSL inside CDATA',
  ])('keeps %s unchanged', (input) => {
    expect(normalizeProviderText(input)).toBe(input);
  });

  it('keeps TeX glued to a letter in text that also carries markup', () => {
    expect(normalizeProviderText(String.raw`<i>x</i> $\nu$ \nand`)).toBe(String.raw`x $\nu$ \nand`);
  });

  it('applies the same rules to every string leaf, titles and names included', () => {
    expect(
      normalizeProviderValue({
        title: '<![CDATA[Immune cellular response to HPV: current concepts]]>',
        display_name: String.raw`Seyfert\n nuclei`,
        authorships: [{ raw_author_name: 'A. <?CDATA Smith?>' }],
      }),
    ).toEqual({
      title: 'Immune cellular response to HPV: current concepts',
      display_name: 'Seyfert nuclei',
      authorships: [{ raw_author_name: 'A. Smith' }],
    });
  });
});

/**
 * Identifiers are what a caller passes back to look a record up or filter on it, so they leave
 * byte-identical to upstream while the display text around them is normalized.
 */
describe('normalizeProviderValue identifiers (gh #94)', () => {
  const RAW = 'x&amp;<i>y</i>\\n';

  it('passes identifier and URL fields through byte-identical at any depth', () => {
    const upstream = {
      id: `https://openalex.org/W1${RAW}`,
      doi: `https://doi.org/10.1/a${RAW}`,
      ids: { openalex: RAW, doi: RAW, mag: RAW, pmid: RAW, pmcid: RAW, wikidata: RAW },
      primary_location: {
        landing_page_url: RAW,
        pdf_url: RAW,
        license_id: RAW,
        source: {
          id: RAW,
          issn_l: RAW,
          issn: [RAW, RAW],
          host_organization: RAW,
          host_organization_lineage: [RAW],
        },
      },
      authorships: [
        {
          author: { id: RAW, orcid: RAW },
          institutions: [{ id: RAW, ror: RAW, lineage: [RAW] }],
          raw_orcid: RAW,
        },
      ],
      corresponding_author_ids: [RAW],
      referenced_works: [RAW],
      related_works: [RAW],
      content_urls: { pdf: RAW, grobid_xml: RAW },
      cited_by_api_url: RAW,
      concepts: [{ id: RAW, wikidata: RAW }],
      societies: [{ url: RAW }],
      awards: [{ id: RAW, funder_id: RAW, funder_award_id: RAW, doi: RAW }],
      parent_publisher: RAW,
      external_id: RAW,
    };
    expect(normalizeProviderValue(upstream)).toEqual(upstream);
  });

  it.each([
    'title',
    'display_name',
    'abstract',
    'raw_author_name',
    'raw_affiliation_strings',
    'raw_source_name',
    'host_organization_name',
    'funder_display_name',
    'display_name_alternatives',
    'alternate_titles',
    'abbreviated_title',
    'description',
    'hint',
  ])('still normalizes the display field %s', (key) => {
    expect(normalizeProviderValue({ [key]: RAW, list: [{ [key]: [RAW] }] })).toEqual({
      [key]: 'x&y',
      list: [{ [key]: ['x&y'] }],
    });
  });

  it('walks an object held under an identifier key by its own keys', () => {
    expect(
      normalizeProviderValue({
        lineage: [{ id: RAW, display_name: RAW }],
        parent_publisher: { id: RAW, display_name: RAW },
      }),
    ).toEqual({
      lineage: [{ id: RAW, display_name: 'x&y' }],
      parent_publisher: { id: RAW, display_name: 'x&y' },
    });
  });

  it('keeps sparse identifier values as they are', () => {
    const sparse = { id: '', doi: null, ids: {}, issn: [], mag: 123, content_urls: null };
    expect(normalizeProviderValue(sparse)).toEqual(sparse);
  });
});

describe('normalizeProviderValue own keys (gh #93)', () => {
  /**
   * `JSON.parse` keeps a `__proto__` key as an own data property. Copying it with `next[k] = …`
   * onto a fresh object literal hit the inherited `__proto__` setter instead: an object value
   * became the copy's prototype and a string value was discarded, so the key vanished.
   */
  it('keeps an own __proto__ key as an own property, nested levels included', () => {
    const upstream = JSON.parse(
      '{"__proto__":{"display_name":"<i>x</i>"},"authorships":[{"__proto__":"<b>y</b>","raw_author_name":"A"}]}',
    ) as { authorships: object[] };

    const out = normalizeProviderValue(upstream);

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'authorships']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({
      display_name: 'x',
    });

    const author = out.authorships[0] as object;
    expect(Object.getPrototypeOf(author)).toBe(Object.prototype);
    expect(Object.keys(author)).toEqual(['__proto__', 'raw_author_name']);
    expect(Object.getOwnPropertyDescriptor(author, '__proto__')?.value).toBe('y');
  });
});
