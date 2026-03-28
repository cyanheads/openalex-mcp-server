/**
 * @fileoverview Tests for openalex_resolve_name tool.
 * @module mcp-server/tools/definitions/resolve-name.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteResult } from '@/services/openalex/types.js';

const mockAutocomplete = vi.fn<() => Promise<AutocompleteResult>>();

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexService: () => ({ autocomplete: mockAutocomplete }),
}));

const { resolveNameTool } = await import('@/mcp-server/tools/definitions/resolve-name.tool.js');

describe('resolveNameTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const harvard = {
    id: 'https://openalex.org/I136199984',
    external_id: 'https://ror.org/02jbv0t02',
    display_name: 'Harvard University',
    entity_type: 'institution',
    cited_by_count: 25000000,
    works_count: 800000,
    hint: 'Cambridge, Massachusetts, USA',
  } as const;

  const sampleResults: AutocompleteResult = {
    results: [
      harvard,
      {
        id: 'https://openalex.org/I136199985',
        external_id: null,
        display_name: 'Harvard Medical School',
        entity_type: 'institution',
        cited_by_count: 5000000,
        works_count: 200000,
        hint: 'Boston, Massachusetts, USA',
      },
    ],
  };

  it('calls autocomplete with correct params and returns results', async () => {
    mockAutocomplete.mockResolvedValue(sampleResults);
    const ctx = createMockContext();
    const input = resolveNameTool.input.parse({
      entity_type: 'institutions',
      query: 'Harvard',
    });

    const result = await resolveNameTool.handler(input, ctx);

    expect(mockAutocomplete).toHaveBeenCalledWith(
      { entityType: 'institutions', query: 'Harvard', filters: undefined },
      ctx,
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toHaveProperty('display_name', 'Harvard University');
  });

  it('passes filters through to service', async () => {
    mockAutocomplete.mockResolvedValue({ results: [] });
    const ctx = createMockContext();
    const input = resolveNameTool.input.parse({
      query: 'MIT',
      filters: { country_code: 'us' },
    });

    await resolveNameTool.handler(input, ctx);

    expect(mockAutocomplete).toHaveBeenCalledWith(
      { entityType: undefined, query: 'MIT', filters: { country_code: 'us' } },
      ctx,
    );
  });

  it('omits entity_type for cross-entity search', async () => {
    mockAutocomplete.mockResolvedValue({ results: [] });
    const ctx = createMockContext();
    const input = resolveNameTool.input.parse({ query: 'machine learning' });

    await resolveNameTool.handler(input, ctx);

    expect(mockAutocomplete).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: undefined }),
      ctx,
    );
  });

  describe('format', () => {
    const text = (result: AutocompleteResult) => {
      const blocks = resolveNameTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    it('formats results with hints', () => {
      const output = text(sampleResults);
      expect(output).toContain('Harvard University');
      expect(output).toContain('Cambridge, Massachusetts, USA');
    });

    it('formats results without hints', () => {
      const output = text({ results: [{ ...harvard, hint: null }] });
      expect(output).not.toContain('[');
    });

    it('returns "No matches" for empty results', () => {
      expect(text({ results: [] })).toBe('No matches found.');
    });
  });
});
