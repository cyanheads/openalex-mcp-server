/**
 * @fileoverview Test helper that reads rendered Markdown the way a client does — through a real
 * CommonMark + GFM parser (micromark via mdast) — so escaping is proven by the parse, not by the
 * string's shape.
 * @module tests/helpers/markdown
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

type MdNode = ReturnType<typeof fromMarkdown>['children'][number] | ReturnType<typeof fromMarkdown>;

/** Parse Markdown with CommonMark + GFM (autolink literals, strikethrough, tables, …). */
export function parseMarkdown(markdown: string) {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** Every node type the parse produced, root excluded. */
export function nodeTypes(markdown: string): string[] {
  const types: string[] = [];
  const walk = (node: MdNode) => {
    if (node.type !== 'root') types.push(node.type);
    if ('children' in node) for (const child of node.children) walk(child as MdNode);
  };
  walk(parseMarkdown(markdown));
  return types;
}

/**
 * Every link that is not an autolink showing its own URL, as `text -> url`. GFM links a bare
 * URL, `www.` host, or email in place; any other link means provider text built one.
 */
export function nonAutolinks(markdown: string): string[] {
  const found: string[] = [];
  const text = (node: MdNode): string =>
    'value' in node && typeof node.value === 'string'
      ? node.value
      : 'children' in node
        ? node.children.map((c) => text(c as MdNode)).join('')
        : '';
  const walk = (node: MdNode) => {
    if (node.type === 'link') {
      const shown = text(node);
      if (![shown, `http://${shown}`, `mailto:${shown}`].includes(node.url)) {
        found.push(`${shown} -> ${node.url}`);
      }
    }
    if ('children' in node) for (const child of node.children) walk(child as MdNode);
  };
  walk(parseMarkdown(markdown));
  return found;
}

/**
 * The text a reader sees: text-node values concatenated per block, blocks joined by newlines.
 * Raw HTML contributes nothing — a renderer hides it — so a string swallowed as a tag, an
 * entity decoded by the renderer, or characters consumed as emphasis, link, or strikethrough
 * syntax all show up as a mismatch against the source text.
 */
export function renderedText(markdown: string): string {
  const blocks: string[] = [];
  const inline = (node: MdNode): string => {
    if (node.type === 'text') return node.value;
    if (node.type === 'inlineCode') return node.value;
    if (node.type === 'break') return '\n';
    if ('children' in node) return node.children.map((c) => inline(c as MdNode)).join('');
    return '';
  };
  const block = (node: MdNode) => {
    if (node.type === 'paragraph' || node.type === 'heading') {
      blocks.push(inline(node));
      return;
    }
    if (node.type === 'code') {
      blocks.push(node.value);
      return;
    }
    if ('children' in node) for (const child of node.children) block(child as MdNode);
  };
  block(parseMarkdown(markdown));
  return blocks.join('\n');
}
