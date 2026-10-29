/**
 * @fileoverview Tests for the openalex_literature_review prompt — pins the sort spelling and
 * the field-projection guidance the generated workflow hands a caller.
 * @module mcp-server/prompts/definitions/literature-review.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { literatureReviewPrompt } from '@/mcp-server/prompts/definitions/literature-review.prompt.js';

/** The generated workflow as one string, for whichever scope the caller asked for. */
async function generatedText(scope?: 'narrow' | 'broad'): Promise<string> {
  const args = literatureReviewPrompt.args!.parse({
    topic: 'groundwater recharge',
    ...(scope ? { scope } : {}),
  });
  const messages = await literatureReviewPrompt.generate(args);
  return messages
    .map((message) => (message.content.type === 'text' ? message.content.text : ''))
    .join('\n');
}

/** The numbered step whose heading contains `heading`, up to the next numbered step. */
function step(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `step "${heading}" is missing from the prompt`).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const next = rest.search(/\n\d+\. \*\*/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('literatureReviewPrompt', () => {
  const scopes = [undefined, 'narrow', 'broad'] as const;

  /**
   * `sort: "cited_by_count"` orders citations ascending upstream, so the landmark step used to
   * hand callers the exact spelling that returns zero-citation works.
   */
  it.each(scopes)('names only the descending citation sort (scope: %s)', async (scope) => {
    const text = await generatedText(scope);
    const mentions = [...text.matchAll(/(.?)cited_by_count/g)];

    expect(mentions.length).toBeGreaterThan(0);
    for (const [, preceding] of mentions) {
      expect(preceding, 'an ascending cited_by_count sort is named').toBe('-');
    }
  });

  it('spells the landmark step sort as a sort argument, not prose', async () => {
    expect(step(await generatedText(), '**Identify key papers**')).toContain('-cited_by_count');
  });

  /**
   * Citation sorting replaces relevance ranking, so a landmark search without the topical
   * filters returns the most-cited works in the catalog rather than in the topic.
   */
  it('keeps the topical filters on the landmark step', async () => {
    expect(step(await generatedText(), '**Identify key papers**')).toMatch(/filter/i);
  });

  /**
   * An `id` lookup returns the curated default projection, so "get full details" only produces
   * the extra fields when the step names them.
   */
  it('tells the detail lookup to name the fields it needs', async () => {
    const detail = step(await generatedText(), '**Identify key papers**');
    expect(detail).toContain('select');
  });

  /**
   * The detail lookup selects `author_list`, which an `id` lookup returns whole — thousands of
   * entries on a large collaboration. The step names the count-based `slice` call that pages it
   * on the same compact field, and the `windows` entry that continues it. (gh #102, #131)
   */
  it('names a count-based slice for paging a long author_list', async () => {
    const detail = step(await generatedText(), '**Identify key papers**');
    expect(detail).toContain('["abstract", "author_list", "primary_location"]');
    expect(detail).toContain('slice: {"field": "author_list", "offset": 0, "limit": 100}');
    expect(detail).toContain('windows');
    expect(detail).not.toMatch(/comes back as a window|64,000|budget/);
  });

  it('keeps authorships as the choice for affiliations (gh #102)', async () => {
    const detail = step(await generatedText(), '**Identify key papers**');
    expect(detail).toMatch(/select authorships instead when you need affiliations/);
  });

  /**
   * OpenAlex counts `authorships.institutions.id` over every authorship of a work; only
   * `authorships.countries`, which this workflow never groups by, stops at the first 100. The
   * landscape step must not tell a caller its institution counts are capped. (gh #91)
   */
  it('claims no first-100 cap on the institutions group_by', async () => {
    const text = await generatedText();
    expect(step(text, '**Analyze the landscape**')).toContain('authorships.institutions.id');
    expect(text).not.toMatch(/first 100|undercount/);
    expect(text).not.toContain('authors_count:>100');
  });
});
