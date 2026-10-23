/**
 * @fileoverview Page-size validation and disclosed clamping for OpenAlex list tools.
 * @module mcp-server/tools/page-size
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const clamps = createCounter('openalex.per_page.clamps', 'Oversized page sizes clamped', '{clamp}');
type PagedTool =
  | 'openalex_search_entities'
  | 'openalex_get_citation_graph'
  | 'openalex_analyze_trends';

/** Resolves lazily so environment parsing remains at application setup, including schema discovery. */
export function pageSizeSchema(maximum: 100 | 200) {
  return z.lazy(() => {
    const schema = z.number().int().min(1);
    return getServerConfig().clampPerPage ? schema : schema.max(maximum);
  });
}

/** Apply only when the caller's page size is used; IDs and samples take precedence in search. */
export function clampPageSize(
  requested: number,
  maximum: 100 | 200,
  tool: PagedTool,
  ctx: Context,
) {
  if (requested <= maximum || !getServerConfig().clampPerPage) {
    return { applied: requested, notice: undefined };
  }
  ctx.log.info('Clamped per_page', { tool, requested, applied: maximum });
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'openalex.per_page.maximum': maximum });
  return {
    applied: maximum,
    notice: `per_page ${requested} exceeds the maximum of ${maximum}; using per_page ${maximum}.`,
  };
}
