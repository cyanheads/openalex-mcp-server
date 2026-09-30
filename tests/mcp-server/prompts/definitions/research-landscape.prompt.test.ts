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
});
