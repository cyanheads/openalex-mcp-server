/**
 * @fileoverview Prompt template for guided systematic literature review using OpenAlex tools.
 * @module mcp-server/prompts/definitions/literature-review.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const literatureReviewPrompt = prompt('openalex_literature_review', {
  description:
    'Guides a systematic literature search: formulate query, search, filter, analyze citation network, synthesize findings.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/prompts/definitions/literature-review.prompt.ts',
  args: z.object({
    topic: z
      .string()
      .describe(
        'Research topic or question to review (e.g., "CRISPR off-target effects in human cell lines").',
      ),
    scope: z
      .enum(['narrow', 'broad'])
      .optional()
      .describe(
        '"narrow": focused on specific question. "broad": survey of the field. Defaults to "narrow" if omitted.',
      ),
  }),
  generate: (args) => {
    const scope = args.scope ?? 'narrow';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Conduct a systematic literature review on: "${args.topic}"

Scope: ${scope}

Follow this workflow using the OpenAlex tools:

1. **Resolve entities** — Use openalex_resolve_name to identify key authors, institutions, or topics related to "${args.topic}". Collect their OpenAlex IDs.

2. **Search literature** — Use openalex_search_entities to find relevant works.${
            scope === 'narrow'
              ? `
   - Use exact search mode with specific phrases
   - Filter tightly by resolved topic IDs
   - Focus on a single topic cluster`
              : `
   - Try keyword search for the topic
   - Use semantic search for conceptually related work across subfields
   - Search with multiple related topic IDs to capture adjacent areas`
          }
   Use select to keep payloads manageable.

3. **Identify key papers** — Sort by cited_by_count to find landmark works. Use openalex_search_entities with id to get full details on the most important ones.

4. **Trace citations** — For each key paper, use openalex_get_citation_graph with direction "cites" to find subsequent work that cites it, and direction "cited_by" to find foundational work it references.

5. **Analyze the landscape** — Use openalex_analyze_trends to understand:
   - Publication volume over time (group_by: publication_year)
   - Top contributing institutions (group_by: authorships.institutions.id)
   - Open access availability (group_by: oa_status)

6. **Synthesize** — Summarize findings: key themes, seminal papers, active research fronts, gaps in the literature, and methodological trends.`,
        },
      },
    ];
  },
});
