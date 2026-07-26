/**
 * @fileoverview Tests for openalex_resolve_name tool.
 * @module mcp-server/tools/definitions/resolve-name.tool.test
 */

import { invalidParams, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

  describe('error contract', () => {
    /**
     * `filters` reaches the autocomplete endpoint, so every 400 shape the search tools
     * see is reachable here too — each needs a declared entry or its recovery hint is
     * dropped on the floor. The 400 family is thrown through the `invalidParams` factory,
     * so an entry declaring `ValidationError` advertises a code the caller never receives.
     */
    it('declares InvalidParams for every reason the 400 family delivers (gh #53)', () => {
      const upstream400Reasons = [
        'comma_in_filter_value',
        'upstream_invalid_params',
        'upstream_invalid_id_value',
        'upstream_invalid_params_other',
      ];
      for (const reason of upstream400Reasons) {
        const entry = resolveNameTool.errors?.find((e) => e.reason === reason);
        expect(entry, `${reason} missing from the contract`).toBeDefined();
        expect(entry?.code, `${reason} declares the wrong code`).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
      }
    });

    it('declares the budget entry non-retryable and the throttle entry retryable (gh #54)', () => {
      const budget = resolveNameTool.errors?.find((e) => e.reason === 'upstream_budget_exhausted');
      const throttle = resolveNameTool.errors?.find((e) => e.reason === 'rate_limited');
      expect(budget?.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(budget?.retryable).toBe(false);
      expect(throttle?.retryable).toBe(true);
    });

    it('carries the invalid-ID-value recovery through to the caller (gh #49)', async () => {
      const ctx = createMockContext({ errors: resolveNameTool.errors });
      mockAutocomplete.mockRejectedValue(
        invalidParams("'Einstein' is not a valid OpenAlex ID.", {
          reason: 'upstream_invalid_id_value',
          ...ctx.recoveryFor('upstream_invalid_id_value'),
        }),
      );
      const input = resolveNameTool.input.parse({
        query: 'climate',
        filters: { 'authorships.author.id': 'Einstein' },
      });

      await expect(resolveNameTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'upstream_invalid_id_value',
          recovery: { hint: expect.stringMatching(/resolve that name/i) },
        },
      });
    });
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

  describe('enrichment', () => {
    it('sets no notice when results are present', async () => {
      mockAutocomplete.mockResolvedValue(sampleResults);
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'Harvard' });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('sets notice when no matches found (cross-entity)', async () => {
      mockAutocomplete.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'xyzzy_nonexistent_entity_abc' });

      await resolveNameTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toMatch(/No matches/i);
      expect(notice).toContain('xyzzy_nonexistent_entity_abc');
    });

    it('includes entity_type scope in notice when specified', async () => {
      mockAutocomplete.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({
        entity_type: 'works',
        query: 'missing_title_xyz',
      });

      await resolveNameTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('works');
    });
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
