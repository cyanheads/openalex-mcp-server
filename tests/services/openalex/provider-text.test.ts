/**
 * @fileoverview Property tests for the provider-text markup scanner: on tag-dense random input
 * its single linear pass must equal what repeating a regex replacement until nothing changes
 * produces, and with comments, CDATA/instruction/line-break delimiters, or MathType lines mixed
 * in it must leave nothing to strip and be idempotent. Delimiter and MathType fixtures follow the
 * property tests.
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
 * sizes — then, when the result holds a block tag's break, trim each paragraph and keep one break
 * between them, once, as the scanner does. The inputs carry no line breaks, so every `\n\n` left
 * came from a block tag. Trimming only at the end matters both ways: a break a later pass removes
 * leaves no trimming behind, and a break a later pass brings to an edge or beside another is
 * still trimmed.
 */
function reference(text: string): string {
  let t = text;
  let prev: string;
  do {
    prev = t;
    t = t.replace(TAG, (tag, closing: string, rawName: string) =>
      rewriteTag(tag, closing, rawName),
    );
  } while (t !== prev);
  if (!t.includes('\n\n')) return t;
  return t
    .split('\n\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');
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
  // gh #92: MathType MTEF lines, terminators, and fragments that re-form a header.
  '% MathType!MTEF!2!1!+- ',
  '%MathType!MTEF!2!1!+-',
  '% MathType!Translator!2!1!AMS LaTeX.tdl!TeX -- AMS-LaTeX! ',
  '% MathType!End!2!1! ',
  '% feaagCart1ev2 ',
  '%aB9+-',
  '% ',
  '%',
  '!44A1!',
  '!3BD8',
  '% !4DCA!',
  '% Math',
  'Type!MTEF!2!1!+-',
  '\n',
  // gh #110: an instruction target that a no-break space ends, before a block tag.
  ' ',
  '<?CDATA ',
  '<?MML ',
  '<?MML',
];

/**
 * Deterministic random strings built from `atoms`. The multiply is `Math.imul`: a plain `*` of
 * a 31-bit seed overflows 2^53, rounds, and falls into a short cycle that repeats a few hundred
 * strings.
 */
function* randomInputs(atoms: string[], count: number) {
  let seed = 20260923;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
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
 * How long a span reads once paragraphs are trimmed: a whitespace run holding a blank line
 * becomes that one paragraph break, and each code point counts once.
 */
const trimmedLength = (span: string) =>
  [...span.replace(/\s+/g, (run) => (run.includes('\n\n') ? '\n\n' : run))].length;

/**
 * How long each `<?MML` instruction in `text` that another pass could close reads once
 * paragraphs are trimmed: its target, a separator (whitespace or `?`), then a `?>` with no other
 * `<?` before it.
 */
function closableMmlSpans(text: string): number[] {
  const spans: number[] = [];
  for (let at = text.indexOf('<?MML'); at >= 0; at = text.indexOf('<?MML', at + 1)) {
    if (!/[\s?]/.test(text[at + 5] ?? '')) continue;
    const close = text.indexOf('?>', at + 5);
    if (close < 0) continue;
    const next = text.indexOf('<?', at + 2);
    if (next < 0 || next > close) spans.push(trimmedLength(text.slice(at, close + 2)));
  }
  return spans;
}

/** Whether `text` holds an `<?MML` instruction another pass would remove: one within the cap. */
const hasRemovableMml = (text: string) =>
  closableMmlSpans(text).some((span) => span <= MML_SPAN_CAP);

/**
 * `<?MML` spans near the cap — one left literal by a removed `<?CDATA` among them — the blanks,
 * blank lines, block tags, and script openers that make a span read longer or shorter than it is
 * written (gh #111), and the tag openers and comments whose removal takes a `?>` that measured a
 * span away (gh #112).
 */
const MML_SPAN_ATOMS = [
  '<i',
  '<!--',
  '-->',
  `<?MML ${'x'.repeat(112)}`,
  `<?MML a <?CDATA b?>${'x'.repeat(108)}`,
  '<?MML ',
  '?>',
  ' ?>',
  '<?',
  'x',
  ' '.repeat(6),
  ' ',
  '\n',
  ' \n\n ',
  '<br/>',
  '<p>',
  '<sub>2</sub>',
  ' ',
  'a ',
];

/** MathType lines, terminators, and fragments that re-form a header across a removal (gh #92). */
const MTEF_ATOMS = [
  '% MathType!MTEF!2!1!+- ',
  '%MathType!MTEF!2!1!+-',
  '% MathType!Translator!2!1!LaTeX.tdl!TeX -- LaTeX 2.09 and later! ',
  '% MathType!End!2!1!',
  '% aB9+-',
  '%cd',
  '% ',
  '%',
  ' ',
  '\n',
  String.raw`\n`,
  '!44A1!',
  '!3BD8',
  '% !4DCA!',
  '!',
  'x',
  '% Math',
  'Type!MTEF!2!1!+-',
  '<i>',
  '</i>',
  '<p>',
  '<',
  '>',
  // gh #110
  ' ',
  '<?CDATA ',
  '<br/>',
];

const MTEF_HEADER = String.raw`%\s*MathType!MTEF![^\s%]*`;

/**
 * A blob another pass would remove: a header, further header and non-empty data lines, then a
 * data line ending in `!` and four uppercase hex digits.
 */
const MTEF_BLOB = new RegExp(
  String.raw`${MTEF_HEADER}(?:\s*(?:${MTEF_HEADER}|%\s*[A-Za-z0-9+-]+))*\s*%\s*[A-Za-z0-9+-]*![0-9A-F]{4}`,
);
const MTEF_END_LINE = /%\s*MathType!End!\d+!\d+!/;

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

  it('leaves no CDATA, instruction, formula opener, literal \\n, or MathType blob and is idempotent on 20,000 random delimiter inputs (gh #89, gh #92)', {
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
      expect(output, label).not.toMatch(MTEF_BLOB);
      expect(output, label).not.toMatch(MTEF_END_LINE);
      expect(normalizeProviderText(output), label).toBe(output);
    }
  });

  it('leaves no MathType blob or End line and is idempotent on 20,000 random MathType inputs (gh #92)', {
    timeout: 30_000,
  }, () => {
    let blobInputs = 0;
    for (const input of randomInputs(MTEF_ATOMS, 20_000)) {
      const output = normalizeProviderText(input);
      const label = JSON.stringify(input);
      expect(output, label).not.toMatch(MTEF_BLOB);
      expect(output, label).not.toMatch(MTEF_END_LINE);
      expect(normalizeProviderText(output), label).toBe(output);
      if (MTEF_BLOB.test(input)) blobInputs++;
    }
    // Whole blobs form often enough for the checks above to bite (1,037 with this seed).
    expect(blobInputs).toBeGreaterThan(750);
  });

  it('leaves no removable <?MML span and is idempotent on 20,000 random inputs near the span cap (gh #111, gh #112)', {
    timeout: 30_000,
  }, () => {
    let removableInputs = 0;
    let keptPastCap = 0;
    for (const input of randomInputs(MML_SPAN_ATOMS, 20_000)) {
      const output = normalizeProviderText(input);
      const label = JSON.stringify(input);
      expect(hasRemovableMml(output), label).toBe(false);
      expect(normalizeProviderText(output), label).toBe(output);
      if (hasRemovableMml(input)) removableInputs++;
      if (closableMmlSpans(output).some((span) => span > MML_SPAN_CAP)) keptPastCap++;
    }
    // Both sides of the cap come up often enough to be checked: inputs holding a span within it
    // (3,314 with this seed), and outputs that keep a closable span past it (325).
    expect(removableInputs).toBeGreaterThan(2_500);
    expect(keptPastCap).toBeGreaterThan(250);
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
 * MathType MTEF equation blobs: a `% MathType!MTEF!` header, `%`-prefixed data lines, and a
 * `!XXXX!` checksum, usually just before TeX that restates the equation. Fixtures marked with a
 * work ID are copied from that record's upstream title or abstract as of 2026-10-17.
 */
describe('normalizeProviderText MathType MTEF blobs (gh #92)', () => {
  const HEADER = '% MathType!MTEF!2!1!+-';
  const TRANSLATOR = '% MathType!Translator!2!1!AMS LaTeX.tdl!TeX -- AMS-LaTeX!';

  it.each([
    [
      'a spaced blob before CDATA-wrapped TeX (W1484087699)',
      'the unit ball % MathType!MTEF!2!1!+- % feaagCart1ev2aqatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn % hiov2DGi1BTfMBaeXatLxBI9gBaerbd9wDYLwzYbItLDharqqtubsr % 4rNCHbGeaGqiVu0Je9sqqrpepC0xbbL8F4rqqrFfpeea0xe9Lq-Jc9 % vqaqpepm0xbba9pwe9Q8fs0-yqaqpepae9pg0FirpepeKkFr0xfr-x % fr-xb9adbaqaaeGaciGaaiaabeqaamaabaabaaGcbaWaaqWaaeaaca % WG6bWaaSbaaSqaaiaaigdaaeqaaaGccaGLhWUaayjcSdWaaWbaaSqa % beaacaaIYaaaaOGaey4kaSYaaqWaaeaacaWG6bWaaSbaaSqaaiaaik % daaeqaaaGccaGLhWUaayjcSdWaaWbaaSqabeaacaaIYaaaaOGaeyip % aWJaaGymaaaa!44A1!]] <![CDATA[$${\\left| {{z_1}} \\right|^2} + {\\left| {{z_2}} \\right|^2} < 1$$ (see Yau [31]',
      'the unit ball $${\\left| {{z_1}} \\right|^2} + {\\left| {{z_2}} \\right|^2} < 1$$ (see Yau [31]',
    ],
    [
      'two blobs, each after a Translator line (W141500653)',
      String.raw`Uniqueness of % MathType!Translator!2!1!AMS LaTeX.tdl!TeX -- AMS-LaTeX! % MathType!MTEF!2!1!+- % feaaeaart1ev0aaatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbbjxAHX % garmWu51MyVXgatuuDJXwAK1uy0HwmaeHbfv3ySLgzG0uy0Hgip5wz % aebbnrfifHhDYfgasaacH8qrps0lbbf9q8WrFfeuY-Hhbbf9v8qqaq % Fr0xc9pk0xbba9q8WqFfea0-yr0RYxir-Jbba9q8aq0-yq-He9q8qq % Q8frFve9Fve9Ff0dmeaabaqaciGacaGaaeqabaWaaeWaeaaakeaatu % uDJXwAK1uy0HMmaeXbfv3ySLgzG0uy0HgiuD3BaGqbbiab-jqidnaa % CaaaleqabaGaey4fIOcaaaaa!433C! $ \mathbb{C}^{ * } $ - and % MathType!Translator!2!1!AMS LaTeX.tdl!TeX -- AMS-LaTeX! % MathType!MTEF!2!1!+- % feaaeaart1ev0aaatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbbjxAHX % garmWu51MyVXgatuuDJXwAK1uy0HwmaeHbfv3ySLgzG0uy0Hgip5wz % aebbnrfifHhDYfgasaacH8qrps0lbbf9q8WrFfeuY-Hhbbf9v8qqaq % Fr0xc9pk0xbba9q8WqFfea0-yr0RYxir-Jbba9q8aq0-yq-He9q8qq % Q8frFve9Fve9Ff0dmeaabaqaciGacaGaaeqabaWaaeWaeaaakeaatu % uDJXwAK1uy0HMmaeXbfv3ySLgzG0uy0HgiuD3BaGqbbiab-jqidnaa % BaaaleaacaqGRaaabeaaaaa!42FA! $ \mathbb{C}_{{\text{ + }}} $ -actions on Gizatullin Surfaces`,
      String.raw`Uniqueness of $ \mathbb{C}^{ * } $ - and $ \mathbb{C}_{{\text{ + }}} $ -actions on Gizatullin Surfaces`,
    ],
    [
      'a glued blob and the End line after it (W2174515875)',
      'The% MathType!Translator!2!1!AMS LaTeX.tdl!TeX -- AMS-LaTeX!% MathType!MTEF!2!1!+-% feaafiart1ev1aaatCvAUfKttLearuqr1ngBPrgarmqr1ngBPrgitL% xBI9gBamXvP5wqSXMqHnxAJn0BKvguHDwzZbqegm0B1jxALjhiov2D% aeHbuLwBLnhiov2DGi1BTfMBaebbfv3ySLgzGueE0jxyaibaieYlf9% irVeeu0dXdh9vqqj-hEeeu0xXdbba9frFj0-OqFfea0dXdd9vqaq-J% frVkFHe9pgea0dXdar-Jb9hs0dXdbPYxe9vr0-vr0-vqpWqaaeaabi% GaciaacaqabeaadaabauaaaOqaaiabec8aWjabec8aWjabgkziUkab% bUealnaanaaabaGaee4saSeaaaaa!46A8!% MathType!End!2!1! amplitude in the …',
      'The amplitude in the …',
    ],
    [
      'a blob inside a word, inserting nothing (W272469031)',
      String.raw`in the Y% MathType!MTEF!2!1!+-% feaafiart1ev1aaatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn% hiov2DGi1BTfMBaeXatLxBI9gBaerbd9wDYLwzYbItLDharqqtubsr% 4rNCHbGeaGqiVu0Je9sqqrpepC0xbbL8F4rqqrFfpeea0xe9Lq-Jc9% vqaqpepm0xbba9pwe9Q8fs0-yqaqpepae9pg0FirpepeKkFr0xfr-x% fr-xb9adbaqaaeGaciGaaiaabeqaamaabaabaaqcaaCaaiqaj+eaga% afaaaa!37A1!\[\user1{\overset{\lower0.5em\hbox{$\smash{\scriptscriptstyle\smile}$}}{O} }\]ngs`,
      String.raw`in the Y\[\user1{\overset{\lower0.5em\hbox{$\smash{\scriptscriptstyle\smile}$}}{O} }\]ngs`,
    ],
    [
      'a blob whose terminator has no closing ! (W1582174976)',
      String.raw`Let % MathType!MTEF!2!1!+- % feaagCart1ev2aaatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn % hiov2DGi1BTfMBaeXatLxBI9gBaerbd9wDYLwzYbItLDharqqtubsr % 4rNCHbGeaGqiVu0Je9sqqrpepC0xbbL8F4rqqrFfpeea0xe9Lq-Jc9 % vqaqpepm0xbba9pwe9Q8fs0-yqaqpepae9pg0FirpepeKkFr0xfr-x % fr-xb9adbaqaaeGaciGaaiaabeqaamaabaabaaGcbaGaeuyQdCLaey %OGIWSaeSyhHe6aaWbaaSqabeaacaaIZaaaaaaa!3BD8 $$Omega \subset {\mathbb{R}^3}$$ be an open`,
      String.raw`Let $$Omega \subset {\mathbb{R}^3}$$ be an open`,
    ],
    [
      'a blob whose terminator stands on its own line (W4211178014)',
      String.raw`index of fit: % MathType!MTEF!2!1!+- % feaaguart1ev2aaatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn % hiov2DGi1BTfMBaeXatLxBI9gBaerbd9wDYLwzYbItLDharqqtubsr % 4rNCHbGeaGqiVu0Je9sqqrpepC0xbbL8F4rqqrFfpeea0xe9Lq-Jc9 % vqaqpepm0xbba9pwe9Q8fs0-yqaqpepae9pg0FirpepeKkFr0xfr-x % fr-xb9adbaqaaeGaciGaaiaabeqaamaabaabaaGcbaGaamOuaiabg2 % da9maalaaabaGaeyyeIuUaam4DamaabmaabaGaamysamaaBaaaleaa % caWGJbGaamyyaiaadYgacaWGJbaabeaakiabgkHiTiaadMeadaWgaa % WcbaGaam4BaiaadkgacaWGZbaabeaaaOGaayjkaiaawMcaamaaCaaa % leqabaGaaGOmaaaaaOqaaiabggHiLlaadEhacaWGjbWaaSbaaSqaai % aad+gacaWGIbGaam4CaaqabaGcdaahaaWcbeqaaiaaikdaaaaaaaaa % !4DCA! $$R = \frac`,
      String.raw`index of fit: $$R = \frac`,
    ],
    [
      'a blob and its closing ! but not a stray second ! (W161645765)',
      'Bernoulli (Binomial)-Verteilung B (n;p;x):= % MathType!MTEF!2!1!+- % feaagCart1ev2aaatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn % hiov2DGi1BTfMBaeXatLxBI9gBaerbd9wDYLwzYbItLDharqqtubsr % 4rNCHbGeaGqiVu0Je9sqqrpepC0xbbL8F4rqqrFfpeea0xe9Lq-Jc9 % vqaqpepm0xbba9pwe9Q8fs0-yqaqpepae9pg0FirpepeKkFr0xfr-x % fr-xb9adbaqaaeGaciGaaiaabeqaamaabaabaaGcbaGaaiikamaaDa % aaleaacaWG4baabaGaamOBaaaakiaacMcacaWGWbWaaWbaaSqabeaa % caWG4baaaOGaamyCamaaCaaaleqabaGaamOBaiabgkHiTiaadIhaaa % GccaGG7aGaamiCaiabgUcaRiaadghacqGH9aqpcaaIXaaaaa!44F4!! $$ (_x^n){p^x}{q^{n - x}};p + q = 1 $$',
      'Bernoulli (Binomial)-Verteilung B (n;p;x):= ! $$ (_x^n){p^x}{q^{n - x}};p + q = 1 $$',
    ],
    [
      'a blob that repeats its header line (W4235298395)',
      String.raw`equation are % MathType!MTEF!2!1!+- % MathType!MTEF!2!1!+- % feaaguart1ev2aaatCvAUfeBSjuyZL2yd9gzLbvyNv2CaerbuLwBLn % hiov2DGi1BTfMBaeXatLxBI9gBaerbd9wDYLwzYbItLDharqqtubsr % 4rNCHbGeaGqiVu0Je9sqqrpepC0xbbL8F4rqqrFfpeea0xe9Lq-Jc9 % vqaqpepm0xbba9pwe9Q8fs0-yqaqpepae9pg0FirpepeKkFr0xfr-x % fr-xb9adbaqaaeGaciGaaiaabeqaamaabaabaaGcbaGaaiikaiaadM % gacaGGPaWaaSaaaeaacaWGKbGaamyEaaqaaiaadsgacaWG4baaaiab % g2da9iaaikdacaWG4baaaa!3ED5! $$\matrix $$(i)\frac{{dy}}{{dx}} = 2x$$ ,`,
      String.raw`equation are $$\matrix $$(i)\frac{{dy}}{{dx}} = 2x$$ ,`,
    ],
    [
      'End lines with no blob before them (W2174515875)',
      String.raw`region of the\(\pi \pi \to {\text{K}}\overline {\text{K}} \)% MathType!End!2!1! scattering. For`,
      String.raw`region of the\(\pi \pi \to {\text{K}}\overline {\text{K}} \) scattering. For`,
    ],
  ])('removes %s', (_label, input, expected) => {
    const output = normalizeProviderText(input);
    expect(output).toBe(expected);
    expect(output).not.toContain('MathType!');
    expect(normalizeProviderText(output)).toBe(output);
  });

  it.each([
    ['a blob at the start of the text', `${HEADER} % aB9+-!ABCD! x`, 'x'],
    ['a blob at the end of the text', `x ${HEADER} % aB9+-!ABCD!`, 'x'],
    ['a blob between blanks, merging them to one', `a ${HEADER} % b!ABCD! c`, 'a c'],
    ['a blob with a blank on one side only', `a ${HEADER} % b!ABCD!c`, 'a c'],
    ['a blob of glued lines', 'x%MathType!MTEF!2!1!+-%aB9+-%cd!ABCD!y', 'xy'],
    ['a blob whose lines line breaks split', `a ${HEADER}\n% bc\r\n%de\n% !ABCD! f`, 'a f'],
    ['a blob whose lines literal \\n split', String.raw`a ${HEADER}\n% bc\n% !ABCD! f`, 'a f'],
    [
      'a blob with a Translator line just before it',
      `x ${TRANSLATOR} ${HEADER} % a!ABCD! y`,
      'x y',
    ],
    [
      'a blob but not the bare % line before it',
      `tensor % ${HEADER} % a!ABCD! field`,
      'tensor % field',
    ],
    ['back-to-back blobs', `a ${HEADER} % b!ABCD!${HEADER} % c!0F9E! d`, 'a d'],
    ['an End line with longer numbers', 'a % MathType!End!12!305! b', 'a b'],
    [
      'an End line inside a run, which then closes',
      `a ${HEADER} % MathType!End!2!1! % b!ABCD! c`,
      'a c',
    ],
    [
      'a header re-formed across a removed blob',
      `x % Math${HEADER} % a!ABCD!Type!MTEF!2!1!+- % b!ABCD! y`,
      'x y',
    ],
    [
      'a header re-formed across a removed tag',
      `x % Math<i></i>Type!MTEF!2!1!+- % a!ABCD! y`,
      'x y',
    ],
    ['a blob whose removal completes a tag', `x <i${HEADER} % a!ABCD!>y`, 'x y'],
    ['a blob holding a > whose removal completes a tag', '<i%MathType!MTEF!>%!3BD8>', ''],
    ['a blob holding a > whose removal completes an mml: tag', '<mml:%MathType!MTEF!>%!ABCD>', ''],
    ['the same blob between words', 'a <i%MathType!MTEF!>%!3BD8>b', 'a b'],
    [
      'blobs holding a > whose removals complete nested tags',
      '<b<i%MathType!MTEF!>%!3BD8>%MathType!MTEF!>%!ABCD>',
      '',
    ],
    [
      'a blob whose removal re-forms a tag no allowlist holds',
      '<Fish%MathType!MTEF!>%!ABCD>',
      '<Fish>',
    ],
  ])('removes %s', (_label, input, expected) => {
    const output = normalizeProviderText(input);
    expect(output).toBe(expected);
    expect(normalizeProviderText(output)).toBe(output);
  });

  it.each([
    ['a percent sign', '95% CI'],
    ['a spaced percent sign', 'a 10 % change'],
    ['MTEF as an acronym', 'Medium-Term Expenditure Framework (MTEF)'],
    ['a run that meets prose', `${HEADER} % aaaa then prose`],
    ['a run that meets the end of the text', `a ${HEADER} % feaag % hiov`],
    ['a run that meets another character', `a ${HEADER} % fe.ag % b!ABCD! c`],
    ['a run broken by an empty data line', `a ${HEADER} % % b!ABCD! c`],
    ['a near-terminator', `a ${HEADER} % b!ABC d`],
    ['a lowercase terminator', `a ${HEADER} % b!abcd! c`],
    ['a header with no data before its terminator', `a ${HEADER}!ABCD! c`],
    ['a Translator line with no header after it', `x ${TRANSLATOR} y`],
    ['a Translator line followed by text, then a run', `${TRANSLATOR} and ${HEADER} % a`],
    ['an End line missing a number', 'a % MathType!End!2! b % MathType!End!!1! c'],
    ['MathType named in prose', 'equations typed with MathType! Then % of them'],
    ['a tag opener a kept > in an unclosed run settles', `<i${HEADER}> % x>`],
  ])('keeps %s literal', (_label, input) => {
    expect(normalizeProviderText(input)).toBe(input);
  });

  it('keeps a Translator line that text separates from the header', () => {
    expect(normalizeProviderText(`${TRANSLATOR} and ${HEADER} % a!ABCD! y`)).toBe(
      `${TRANSLATOR} and y`,
    );
  });

  it('removes blobs from every string leaf, titles included', () => {
    expect(
      normalizeProviderValue({
        title: `A ${HEADER} % a!ABCD! $x$ title`,
        abstract: `x % MathType!End!2!1! y`,
      }),
    ).toEqual({ title: 'A $x$ title', abstract: 'x y' });
  });
});

/**
 * Trimming paragraphs strips any whitespace beside a block tag's break, and a second pass reads
 * the break itself as line breaks. So every such character has to end an instruction target in
 * the first pass too, or the second pass finds a target the first left alone.
 */
describe('normalizeProviderText instruction targets ended by any whitespace (gh #110)', () => {
  it.each([
    ['a no-break space before a block tag', 'a <?CDATA <br/>b?>c', 'a\n\nbc'],
    ['a space before a block tag', 'a <?CDATA <br/>b?>c', 'a\n\nbc'],
    ['an ideographic space before a block tag', 'a <?CDATA　<br/>b?>c', 'a\n\nbc'],
    ['a no-break space, a space, then a block tag', 'a <?CDATA  <p>b?>c', 'a\n\nbc'],
    ['a no-break space before TeX', 'a <?CDATA $x$?> b', 'a $x$ b'],
    ['an MML target and a no-break space', 'a <?MML <br/>( 1 ) ?> b', 'a b'],
    ['an MML target and a space', 'a <?MML <br/>( 1 ) ?> b', 'a b'],
  ])('settles %s in one pass', (_label, input, expected) => {
    const output = normalizeProviderText(input);
    expect(output).toBe(expected);
    expect(normalizeProviderText(output)).toBe(output);
  });

  it('drops a stray ?> that a literal MML target ended by a block tag would pair with', () => {
    const output = normalizeProviderText('<?MML<br/> a <?CDATA b?> c ?>');
    expect(output).toBe('<?MML\n\na b c');
    expect(normalizeProviderText(output)).toBe(output);
  });
});

/**
 * Trimming paragraphs shortens an `<?MML` span — blanks beside a block tag's break go, and a run
 * of breaks or a blank line becomes one break — while a break or script opener reads as two
 * characters. The span cap measures the span as the output reads it, so a second pass makes the
 * same keep-or-remove call the first one made.
 */
describe('normalizeProviderText <?MML span cap measured as the output reads (gh #111)', () => {
  const x = (count: number) => 'x'.repeat(count);
  const blanks = ' '.repeat(10);

  it.each([
    ['blanks around a block tag', `a <?MML ${x(100)}${blanks}<br/>${blanks}?> b`, 'a b'],
    ['the same span alone', `<?MML ${x(100)}${blanks}<br/>${blanks}?>`, ''],
    ['a run of block tags', `a <?MML ${x(110)}${'<br/>'.repeat(15)}?> b`, 'a b'],
    [
      'a blank line, a block tag after it',
      `a <?MML ${x(110)}  \n\n${blanks}?> b<br/>c`,
      'a b\n\nc',
    ],
    ['a blank line, no block tag', `a <?MML ${x(110)}  \n\n${blanks}?> b`, 'a b'],
  ])('removes a span trimming brings within the cap: %s', (_label, input, expected) => {
    const output = normalizeProviderText(input);
    expect(output).toBe(expected);
    expect(normalizeProviderText(output)).toBe(output);
  });

  it.each([
    ['on its own text', `<?MML ${x(130)}?>`, `<?MML ${x(130)}?>`],
    [
      'with blanks around a block tag',
      `a <?MML ${x(130)}${blanks}<br/>${blanks}?> b`,
      `a <?MML ${x(130)}\n\n?> b`,
    ],
  ])('keeps a span past the cap %s literal', (_label, input, expected) => {
    const output = normalizeProviderText(input);
    expect(output).toBe(expected);
    expect(normalizeProviderText(output)).toBe(output);
  });

  /**
   * Spans that read exactly `span` characters in the output, each holding one construct, and the
   * output a span one character past the cap keeps.
   */
  it.each([
    [
      'a block tag',
      (span: number) => `<?MML ${x(span - 10)}<br/>?>`,
      `a <?MML ${x(MML_SPAN_CAP - 9)}\n\n?> b`,
    ],
    [
      'blanks around a block tag',
      (span: number) => `<?MML ${x(span - 10)}${blanks}<p>${blanks}?>`,
      `a <?MML ${x(MML_SPAN_CAP - 9)}\n\n?> b`,
    ],
    [
      'a script',
      (span: number) => `<?MML ${x(span - 12)}<sub>2</sub>?>`,
      `a <?MML ${x(MML_SPAN_CAP - 11)}_{2}?> b`,
    ],
  ])(
    'measures a span holding %s by the characters the output holds',
    (_label, spanning, keptOutput) => {
      expect(normalizeProviderText(`a ${spanning(MML_SPAN_CAP)} b`)).toBe('a b');
      const kept = normalizeProviderText(`a ${spanning(MML_SPAN_CAP + 1)} b`);
      expect(kept).toBe(keptOutput);
      expect(normalizeProviderText(kept)).toBe(kept);
    },
  );

  it('drops a stray ?> that trimming brings within the cap of a literal <?MML', () => {
    const output = normalizeProviderText(
      `<?MML a <?CDATA b?>${x(110)}${blanks}<br/>${blanks} ?> c`,
    );
    expect(output).toBe(`<?MML a b${x(110)}\n\nc`);
    expect(normalizeProviderText(output)).toBe(output);
  });

  it('keeps a stray ?> past the cap of a literal <?MML on its own text', () => {
    const output = normalizeProviderText(`<?MML a <?CDATA b?>${x(130)} ?> c`);
    expect(output).toBe(`<?MML a b${x(130)} ?> c`);
    expect(normalizeProviderText(output)).toBe(output);
  });
});

/**
 * A removal joins the text on either side of it, and the pass judges what that forms the way a
 * second pass over its output would: a `<` whose tag a `>` inside the removed text had ruled
 * out can open a tag again, and an `<?MML` span measured past the cap at a `?>` inside it is
 * measured again at the next one.
 */
describe('normalizeProviderText constructs a removal joins (gh #112)', () => {
  const x = (count: number) => 'x'.repeat(count);

  it.each([
    ['a tag opener whose > went with an MML instruction', '<b<?MML >?>>', ''],
    ['the same between words', 'a <b<?MML >?>>c', 'a c'],
    ['nested tag openers, each reopened in turn', '<b<i<?MML >?>><?MML >?>>', ''],
    ['an opener no allowlist holds, reopened and kept', '<Fish<?MML >?>>', '<Fish>'],
    ['an MML span past the cap until a tag inside it goes', `<?MML % <b ${x(125)}?>?>`, ''],
    ['an MML span past the cap until a comment inside it goes', `<?MML <!-- ${x(130)}?>-->?>`, ''],
    ['the same between words', `a <?MML <!-- ${x(130)}?>--> b ?> c`, 'a c'],
  ])('settles %s in one pass', (_label, input, expected) => {
    const output = normalizeProviderText(input);
    expect(output).toBe(expected);
    expect(normalizeProviderText(output)).toBe(output);
  });

  it('keeps a span the cap still rules out once a comment inside it goes', () => {
    const input = `<?MML ${x(130)}<!-- ?> --> ?> b`;
    const output = normalizeProviderText(input);
    expect(output).toBe(`<?MML ${x(130)} ?> b`);
    expect(normalizeProviderText(output)).toBe(output);
  });

  it('keeps an MML span literal once another <? opens before its ?>, even one a removal takes', () => {
    const output = normalizeProviderText('a <?MML ( 1 ) <!-- <? --> ?> b');
    expect(output).toBe('a <?MML ( 1 )  b');
    expect(normalizeProviderText(output)).toBe(output);
  });

  /**
   * A literal `\n` right after the blank that ends an `<?MML` target merges with it, and the
   * instruction must still be open once: the cap and an earlier `<?` keep the span literal.
   */
  const escapedBreak = String.raw`\n`;

  it.each([
    ['a span past the cap', `a <?MML ${escapedBreak}! ${x(130)}?> b`, `a <?MML ! ${x(130)}?> b`],
    [
      'a span past the cap whose target a tab ends',
      `a <?MML\t${escapedBreak}! ${x(130)}?> b`,
      `a <?MML\t! ${x(130)}?> b`,
    ],
    [
      'a span past the cap with a CDATA instruction before it',
      `a <?MML ${escapedBreak}! <?CDATA b <?MML ${x(130)}?> ?> c`,
      `a <?MML ! b <?MML ${x(130)} ?> c`,
    ],
    [
      'a span another <? opens inside',
      `a <?MML ${escapedBreak}! ${x(10)} <?x ${x(10)}?> b`,
      `a <?MML ! ${x(10)} <?x ${x(10)}?> b`,
    ],
    [
      'a span a CDATA instruction opens inside',
      `a <?MML ${escapedBreak}! <?CDATA c?> ${x(10)} ?> b`,
      `a <?MML ! c ${x(10)} b`,
    ],
  ])('keeps literal %s, its target followed by a literal \\n', (_label, input, expected) => {
    const output = normalizeProviderText(input);
    expect(output).toBe(expected);
    expect(normalizeProviderText(output)).toBe(output);
  });

  it('still removes a span within the cap whose target a literal \\n follows', () => {
    const output = normalizeProviderText(`a <?MML ${escapedBreak}! ${x(10)} ?> b`);
    expect(output).toBe('a b');
    expect(normalizeProviderText(output)).toBe(output);
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
