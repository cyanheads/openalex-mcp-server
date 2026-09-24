/**
 * @fileoverview Property tests for the provider-text markup scanner: on tag-dense random input
 * its single linear pass must equal what repeating a regex replacement until nothing changes
 * produces, and with comments mixed in it must leave nothing to strip and be idempotent.
 * @module services/openalex/provider-text.test
 */

import { describe, expect, it } from 'vitest';
import { normalizeProviderText } from '@/services/openalex/provider-text.js';

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

describe('normalizeProviderText markup scanner', () => {
  it('matches the regex fixed point on 20,000 random tag inputs', () => {
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
  it('leaves no comment or allowlisted tag and is idempotent on 20,000 random inputs', () => {
    for (const input of randomInputs(COMMENT_ATOMS, 20_000)) {
      const output = normalizeProviderText(input);
      expect(output, JSON.stringify(input)).not.toMatch(ALLOWLISTED_TAG);
      expect(output, JSON.stringify(input)).not.toMatch(/<!--[\s\S]*?-->/);
      expect(normalizeProviderText(output), JSON.stringify(input)).toBe(output);
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
