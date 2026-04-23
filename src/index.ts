#!/usr/bin/env node
/**
 * @fileoverview openalex-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { literatureReviewPrompt } from '@/mcp-server/prompts/definitions/literature-review.prompt.js';
import { researchLandscapePrompt } from '@/mcp-server/prompts/definitions/research-landscape.prompt.js';
import { analyzeTrendsTool } from '@/mcp-server/tools/definitions/analyze-trends.tool.js';
import { resolveNameTool } from '@/mcp-server/tools/definitions/resolve-name.tool.js';
import { searchEntitiesTool } from '@/mcp-server/tools/definitions/search-entities.tool.js';
import { initOpenAlexService } from '@/services/openalex/openalex-service.js';

await createApp({
  tools: [resolveNameTool, searchEntitiesTool, analyzeTrendsTool],
  prompts: [literatureReviewPrompt, researchLandscapePrompt],
  landing: {
    tagline: 'Search the OpenAlex catalog — 270M+ works, 90M+ authors, 100K+ sources.',
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
