/**
 * @fileoverview Environment normalization at the OpenAlex configuration boundary.
 * @module tests/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('OpenAlex environment configuration', () => {
  /**
   * A clamped count input advertises no `maximum` — `.int()` would advertise
   * Number.MAX_SAFE_INTEGER — and accepts an over-cap value for the handler to clamp; strict
   * mode advertises and enforces each cap. (gh #131)
   */
  it.each(['true', 'false'])(
    'advertises and enforces all page maxima with clamping %s',
    async (enabled) => {
      vi.stubEnv('OPENALEX_CLAMP_PER_PAGE', enabled);
      const { searchEntitiesTool } = await import(
        '@/mcp-server/tools/definitions/search-entities.tool.js'
      );
      const { getCitationGraphTool } = await import(
        '@/mcp-server/tools/definitions/citation-graph.tool.js'
      );
      const { analyzeTrendsTool } = await import(
        '@/mcp-server/tools/definitions/analyze-trends.tool.js'
      );
      for (const [definition, base, maximum] of [
        [searchEntitiesTool, { entity_type: 'works' }, 100],
        [getCitationGraphTool, { seed_id: 'W1', direction: 'cites' }, 100],
        [analyzeTrendsTool, { entity_type: 'works', group_by: 'publication_year' }, 200],
      ] as const) {
        const schema = z.toJSONSchema(definition.input, { io: 'input' });
        /**
         * Search defaults its page size in the handler — `min(sample, 100)` under `sample`, else
         * 25 — so its schema carries no `default` (gh #124).
         */
        expect(schema.properties?.per_page).toEqual({
          type: 'integer',
          minimum: 1,
          ...(enabled === 'false' && { maximum }),
          ...(definition !== searchEntitiesTool && {
            default: definition === analyzeTrendsTool ? 200 : 25,
          }),
          description: expect.any(String),
        });
        expect(definition.input.safeParse({ ...base, per_page: maximum }).success).toBe(true);
        expect(definition.input.safeParse({ ...base, per_page: maximum + 1 }).success).toBe(
          enabled === 'true',
        );
        for (const per_page of [0, -1, 1.5])
          expect(definition.input.safeParse({ ...base, per_page }).success).toBe(false);
      }

      const slice = (limit: number) => ({
        entity_type: 'works',
        id: 'W1',
        slice: { field: 'authorships', limit },
      });
      const sliceSchema = z.toJSONSchema(searchEntitiesTool.input, { io: 'input' }).properties
        ?.slice as { properties: Record<string, unknown> };
      expect(sliceSchema.properties.limit).toEqual({
        type: 'integer',
        minimum: 1,
        ...(enabled === 'false' && { maximum: 5000 }),
        default: 50,
        description: expect.any(String),
      });
      expect(searchEntitiesTool.input.safeParse(slice(5000)).success).toBe(true);
      expect(searchEntitiesTool.input.safeParse(slice(5001)).success).toBe(enabled === 'true');
      for (const limit of [0, -1, 1.5])
        expect(searchEntitiesTool.input.safeParse(slice(limit)).success).toBe(false);

      // `sample` clamps to OpenAlex's 10,000-record draw ceiling the same way (gh #124).
      const sample = (value: number) => ({ entity_type: 'works', sample: value });
      expect(z.toJSONSchema(searchEntitiesTool.input, { io: 'input' }).properties?.sample).toEqual({
        type: 'integer',
        minimum: 1,
        ...(enabled === 'false' && { maximum: 10_000 }),
        description: expect.any(String),
      });
      expect(searchEntitiesTool.input.safeParse(sample(10_000)).success).toBe(true);
      expect(searchEntitiesTool.input.safeParse(sample(10_001)).success).toBe(enabled === 'true');
      for (const value of [0, -1, 1.5])
        expect(searchEntitiesTool.input.safeParse(sample(value)).success).toBe(false);
    },
  );

  it('enables page-size clamping by default', async () => {
    vi.stubEnv('OPENALEX_CLAMP_PER_PAGE', '');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().clampPerPage).toBe(true);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    ['off', false],
    ['', true],
    [`\${OPENALEX_CLAMP_PER_PAGE}`, true],
  ])('parses the page-size switch %j as %j', async (value, expected) => {
    vi.stubEnv('OPENALEX_CLAMP_PER_PAGE', value);
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().clampPerPage).toBe(expected);
  });

  it('rejects an invalid page-size switch', async () => {
    vi.stubEnv('OPENALEX_CLAMP_PER_PAGE', 'flase');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow('OPENALEX_CLAMP_PER_PAGE');
  });

  it.each(['', `\${OPENALEX_API_KEY}`])(
    'treats unset host values (%s) as absent',
    async (value) => {
      vi.stubEnv('OPENALEX_API_KEY', value);
      vi.stubEnv('OPENALEX_MAILTO', value);
      vi.stubEnv('OPENALEX_BASE_URL', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(getServerConfig()).toEqual({
        apiKey: '',
        mailto: '',
        baseUrl: 'https://api.openalex.org',
        filterStringInput: true,
        clampPerPage: true,
      });
    },
  );

  it('preserves supplied values, including embedded placeholder text', async () => {
    vi.stubEnv('OPENALEX_API_KEY', `key-\${suffix}`);
    vi.stubEnv('OPENALEX_MAILTO', 'researcher@example.org');
    vi.stubEnv('OPENALEX_BASE_URL', 'https://example.org/api');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      apiKey: `key-\${suffix}`,
      mailto: 'researcher@example.org',
      baseUrl: 'https://example.org/api',
      filterStringInput: true,
      clampPerPage: true,
    });
  });

  it('names the environment variable when a supplied URL is invalid', async () => {
    vi.stubEnv('OPENALEX_BASE_URL', 'not-a-url');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow('OPENALEX_BASE_URL');
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    ['off', false],
    ['', true],
    [`\${OPENALEX_FILTER_STRING_INPUT}`, true],
  ])('parses the native filter switch %j as %j', async (value, expected) => {
    vi.stubEnv('OPENALEX_FILTER_STRING_INPUT', value);
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().filterStringInput).toBe(expected);
  });

  it('rejects an invalid native filter switch at the config boundary', async () => {
    vi.stubEnv('OPENALEX_FILTER_STRING_INPUT', 'flase');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow('OPENALEX_FILTER_STRING_INPUT');
  });
});
