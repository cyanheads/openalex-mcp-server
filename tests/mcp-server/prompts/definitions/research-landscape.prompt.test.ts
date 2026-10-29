/**
 * @fileoverview Tests for the openalex_research_landscape prompt — pins the contributor step's
 * group_by fields and keeps it free of a count cap those fields do not have.
 * @module mcp-server/prompts/definitions/research-landscape.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { researchLandscapePrompt } from '@/mcp-server/prompts/definitions/research-landscape.prompt.js';

/** The generated workflow as one string. */
async function generatedText(): Promise<string> {
  const args = researchLandscapePrompt.args!.parse({ topic: 'single-cell RNA sequencing' });
  const messages = await researchLandscapePrompt.generate(args);
  return messages
    .map((message) => (message.content.type === 'text' ? message.content.text : ''))
    .join('\n');
}

describe('researchLandscapePrompt', () => {
  /**
   * OpenAlex counts `authorships.institutions.id` and `authorships.institutions.country_code`
   * over every authorship of a work; only `authorships.countries`, which this workflow never
   * groups by, stops at the first 100. The contributor step must not tell a caller its
   * institution or country counts are capped. (gh #91)
   */
  it('claims no first-100 cap on the contributor group_by fields', async () => {
    const text = await generatedText();
    const start = text.indexOf('**Top contributors**');
    expect(start).toBeGreaterThan(-1);
    const contributors = text.slice(start, text.indexOf('**Open access**'));
    expect(contributors).toContain('authorships.institutions.id');
    expect(contributors).toContain('authorships.institutions.country_code');
    expect(text).not.toMatch(/first 100|undercount/);
    expect(text).not.toContain('authors_count:>100');
  });

  /**
   * `funders.id` counts every work that lists a funder and labels each group with its name;
   * `awards.funder_id` counts only works whose award records name the funder, under bare-ID labels,
   * and `awards.funder_display_name` carries the same award-only counts. (gh #100)
   */
  it('groups the funding step by funders.id, with no resolve hop or award-based fallback', async () => {
    const text = await generatedText();
    const start = text.indexOf('**Funding**');
    expect(start).toBeGreaterThan(-1);
    const funding = text.slice(start, text.indexOf('**Impact**'));
    expect(funding).toMatch(/\bGroup by funders\.id\b/);
    expect(funding).not.toMatch(/awards\.funder_id|awards\.funder_display_name/);
    expect(funding).not.toContain('openalex_resolve_name');
  });

  /**
   * Few awards carry a primary topic, so an awards search filtered by `primary_topic.id`
   * undercounts the topic's grants. The step reaches grants from the works side, grouping the
   * topic's works by `awards.id`, then opens the top `G…` IDs on the awards entity for amounts,
   * dates, and investigators. (gh #125)
   */
  it('reaches grants by grouping the topic works by awards.id, then opens them as awards (gh #125)', async () => {
    const text = await generatedText();
    const funding = text.slice(text.indexOf('**Funding**'), text.indexOf('**Impact**'));
    expect(funding).toMatch(/group the topic's works by awards\.id/);
    expect(funding).toContain('entity_type "awards", id');
    expect(funding).toContain('G…');
    expect(funding).not.toMatch(/filtered by primary_topic\.id|-amount_usd/);
    expect(funding).not.toContain('awards.* fields');
  });
});
