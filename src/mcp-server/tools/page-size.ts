/**
 * @fileoverview Count inputs for the OpenAlex list tools — `per_page`, `sample`, and
 * `slice.limit` — validated at the schema and clamped to their caps with a disclosed notice, or
 * held to them strictly when OPENALEX_CLAMP_PER_PAGE=false.
 * @module mcp-server/tools/page-size
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const clamps = createCounter(
  'openalex.count_input.clamps',
  'Oversized count inputs clamped',
  '{clamp}',
);
type CountTool =
  | 'openalex_search_entities'
  | 'openalex_get_citation_graph'
  | 'openalex_analyze_trends';
/** A count input as the caller names it, in the notice, the log, and the metric. */
type CountInput = 'per_page' | 'sample' | 'slice.limit';

/**
 * A whole-number count input with a cap. Clamping advertises no `maximum`, since a larger value
 * is accepted and clamped, so the integer check is a refinement typed `integer` for the JSON
 * Schema rather than `.int()`, which Zod 4 emits with `maximum: 9007199254740991`. Strict mode
 * advertises and enforces the cap. Resolves lazily so environment parsing remains at
 * application setup, including schema discovery.
 */
export function countSchema(minimum: number, maximum: number) {
  return z.lazy(() => {
    const bounded = z.number().min(minimum);
    return (getServerConfig().clampPerPage ? bounded : bounded.max(maximum))
      .refine(Number.isInteger, 'Expected an integer')
      .meta({ type: 'integer' });
  });
}

export function pageSizeSchema(maximum: number) {
  return countSchema(1, maximum);
}

interface ClampRequest {
  input: CountInput;
  maximum: number;
  /** How the notice names the cap; "maximum" unless a mode sets its own. */
  maximumLabel?: string;
  requested: number;
  tool: CountTool;
}

/**
 * Clamp a count input to its cap, logging and counting the clamp and returning the notice that
 * discloses it. A no-op within the cap, and under OPENALEX_CLAMP_PER_PAGE=false, where the
 * schema or the handler rejects an over-cap value instead.
 */
export function clampCount(request: ClampRequest, ctx: Context) {
  const { input, maximum, requested, tool } = request;
  if (requested <= maximum || !getServerConfig().clampPerPage) {
    return { applied: requested, notice: undefined };
  }
  ctx.log.info(`Clamped ${input}`, { tool, requested, applied: maximum });
  clamps.add(1, {
    [ATTR_MCP_TOOL_NAME]: tool,
    'openalex.count_input.name': input,
    'openalex.count_input.maximum': maximum,
  });
  return {
    applied: maximum,
    notice: `${input} ${requested} exceeds the ${request.maximumLabel ?? 'maximum'} of ${maximum}; using ${input} ${maximum}.`,
  };
}

/** `clampCount` for a `per_page` named by its tool's one cap. */
export function clampPageSize(requested: number, maximum: number, tool: CountTool, ctx: Context) {
  return clampCount({ input: 'per_page', requested, maximum, tool }, ctx);
}
