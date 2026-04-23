/**
 * @fileoverview Prompt template for quantitative research landscape analysis using OpenAlex tools.
 * @module mcp-server/prompts/definitions/research-landscape.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const researchLandscapePrompt = prompt('openalex_research_landscape', {
  description:
    'Analyzes the research landscape for a topic: volume trends, top authors/institutions, open access rates, funding sources.',
  sourceUrl:
    'https://github.com/cyanheads/openalex-mcp-server/blob/main/src/mcp-server/prompts/definitions/research-landscape.prompt.ts',
  args: z.object({
    topic: z.string().describe('Research area to analyze.'),
  }),
  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Analyze the research landscape for: "${args.topic}"

Use the OpenAlex tools to build a quantitative profile:

1. **Resolve** — Use openalex_resolve_name to find the OpenAlex topic ID for "${args.topic}".

2. **Volume & trends** — Use openalex_analyze_trends to group works by publication_year, filtered to the resolved topic. Is the field growing, stable, or declining?

3. **Top contributors** — Analyze by:
   - authorships.institutions.id (which institutions lead?)
   - authorships.institutions.country_code (geographic distribution)
   - primary_location.source.id (which journals publish most?)

4. **Open access** — Group by oa_status. What fraction is freely available?

5. **Funding** — Group by awards.funder_id to identify major funders. The group keys are OpenAlex IDs — resolve the top funder IDs with openalex_resolve_name to get human-readable names.

6. **Impact** — Search for the most-cited works (sort by -cited_by_count). Get details on the top 5.

7. **Emerging fronts** — Filter to the last 2 years, sort by -cited_by_count to find rising papers. Compare topics to the broader field.

Present findings as a structured report with data tables and key takeaways.`,
      },
    },
  ],
});
