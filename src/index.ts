#!/usr/bin/env node
/**
 * @fileoverview openalex-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { literatureReviewPrompt } from '@/mcp-server/prompts/definitions/literature-review.prompt.js';
import { researchLandscapePrompt } from '@/mcp-server/prompts/definitions/research-landscape.prompt.js';
import { analyzeTrendsTool } from '@/mcp-server/tools/definitions/analyze-trends.tool.js';
import { getCitationGraphTool } from '@/mcp-server/tools/definitions/citation-graph.tool.js';
import { describeFieldsTool } from '@/mcp-server/tools/definitions/describe-fields.tool.js';
import { resolveNameTool } from '@/mcp-server/tools/definitions/resolve-name.tool.js';
import { searchEntitiesTool } from '@/mcp-server/tools/definitions/search-entities.tool.js';
import { initOpenAlexService } from '@/services/openalex/openalex-service.js';

await createApp({
  tools: [
    resolveNameTool,
    searchEntitiesTool,
    analyzeTrendsTool,
    getCitationGraphTool,
    describeFieldsTool,
  ],
  prompts: [literatureReviewPrompt, researchLandscapePrompt],
  instructions:
    'Use the openalex_* tools to query the OpenAlex scholarly catalog (works, authors, sources, institutions, topics, keywords, publishers, funders): resolve names to IDs, search/filter/sort or fetch by ID, and group_by for trends. Names are ambiguous and IDs are not — call openalex_resolve_name before filtering by entity.',
  landing: {
    tagline: 'Search the OpenAlex catalog — 270M+ works, 90M+ authors, 100K+ sources.',
    requireAuth: false,
    repoRoot: 'https://github.com/cyanheads/openalex-mcp-server',
    envExample: {
      OPENALEX_API_KEY: 'your-openalex-api-key',
    },
    links: [
      { label: 'OpenAlex', href: 'https://openalex.org' },
      { label: 'API Docs', href: 'https://docs.openalex.org' },
    ],
  },
  setup() {
    initOpenAlexService();
  },
});
