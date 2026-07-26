/**
 * @fileoverview Tests for openalex_resolve_name tool.
 * @module mcp-server/tools/definitions/resolve-name.tool.test
 */

import { invalidParams, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteResult } from '@/services/openalex/types.js';

const mockAutocomplete = vi.fn<() => Promise<AutocompleteResult>>();
const mockResolveIdentifier = vi.fn<() => Promise<AutocompleteResult>>();

/**
 * Only the service accessor is faked. `inferIdentifier` stays real so these cases exercise
 * the actual name-vs-identifier routing rather than a restatement of it.
 */
vi.mock('@/services/openalex/openalex-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/openalex/openalex-service.js')>();
  return {
    ...actual,
    getOpenAlexService: () => ({
      autocomplete: mockAutocomplete,
      resolveIdentifier: mockResolveIdentifier,
    }),
  };
});

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

    it('carries the budget reading the service writes through to structuredContent', () => {
      // The service populates `budget` from the OpenAlex rate-limit headers via ctx.enrich.
      // structuredContent is built as output.extend(enrichment), which silently strips any
      // field the tool did not declare.
      const budget = { costUsd: 0.0001, remainingUsd: 0.0687, resetsInSeconds: 5553 };
      const structured = resolveNameTool.output
        .extend(resolveNameTool.enrichment)
        .parse({ ...sampleResults, budget });

      expect(structured.budget).toEqual(budget);
      expect(resolveNameTool.enrichmentTrailer?.budget?.render?.(budget)).toContain(
        '$0.0687 left today',
      );
    });
  });

  describe('identifier front door (gh #50)', () => {
    const schutz = {
      id: 'https://openalex.org/A5022021627',
      external_id: 'https://orcid.org/0000-0001-9487-6983',
      display_name: 'B. F. Schutz',
      entity_type: 'author',
      cited_by_count: 114591,
      works_count: 680,
      hint: 'Leibniz University Hannover',
    } as const;

    /** Shapes that resolve today only by accident, or not at all, through autocomplete. */
    const identifiers: [label: string, query: string, entityType: string][] = [
      ['bare ORCID', '0000-0001-9487-6983', 'authors'],
      ['ORCID URL', 'https://orcid.org/0000-0001-9487-6983', 'authors'],
      ['bare DOI', '10.1038/nature12373', 'works'],
      ['DOI URL', 'https://doi.org/10.1038/nature12373', 'works'],
      ['ROR URL', 'https://ror.org/013meh722', 'institutions'],
      ['bare ROR', '013meh722', 'institutions'],
      ['bare PMID', '23903748', 'works'],
      ['PMCID', 'PMC1234567', 'works'],
      ['ISSN', '1234-5678', 'sources'],
      ['OpenAlex work ID', 'W2159974629', 'works'],
      ['OpenAlex funder ID', 'F4320332161', 'funders'],
      ['OpenAlex ID URL', 'https://openalex.org/I241749', 'institutions'],
    ];

    it.each(identifiers)(
      'routes a %s to the deterministic lookup, not autocomplete',
      async (_label, query, entityType) => {
        mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
        const ctx = createMockContext();
        const input = resolveNameTool.input.parse({ query });

        await resolveNameTool.handler(input, ctx);

        expect(mockAutocomplete).not.toHaveBeenCalled();
        expect(mockResolveIdentifier).toHaveBeenCalledWith(
          expect.objectContaining({ entityType }),
          ctx,
        );
      },
    );

    it('sends real names to autocomplete', async () => {
      mockAutocomplete.mockResolvedValue(sampleResults);
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'Albert Einstein' });

      await resolveNameTool.handler(input, ctx);

      expect(mockResolveIdentifier).not.toHaveBeenCalled();
      expect(mockAutocomplete).toHaveBeenCalled();
    });

    it('sends a name containing a colon to autocomplete, not the identifier path', async () => {
      // The scheme prefix is read off the first colon — a titled name must not look like one.
      mockAutocomplete.mockResolvedValue(sampleResults);
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'Nature: a weekly journal' });

      await resolveNameTool.handler(input, ctx);
      expect(mockResolveIdentifier).not.toHaveBeenCalled();
    });

    it('resolves an identifier without entity_type', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: '0000-0001-9487-6983' });

      const result = await resolveNameTool.handler(input, ctx);
      expect(result.results[0]).toHaveProperty('id', 'https://openalex.org/A5022021627');
    });

    it('notices a conflicting entity_type rather than silently overriding it', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({
        entity_type: 'works',
        query: '0000-0001-9487-6983',
      });

      await resolveNameTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('entity_type="works"');
      expect(notice).toContain('ORCID');
      expect(notice).toContain('author');
    });

    it('notices filters, which the identifier path cannot apply', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({
        query: '10.1038/nature12373',
        filters: { publication_year: '2020' },
      });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toContain('filters');
    });

    it('stays silent when the identifier query carries nothing extra', async () => {
      mockResolveIdentifier.mockResolvedValue({ results: [schutz] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'W2159974629' });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('returns an empty result with an identifier-specific notice on a miss', async () => {
      // Not "try a shorter name" — an identifier is not a name, and shortening it is
      // never the fix.
      mockResolveIdentifier.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: '10.1038/thisdoesnotexist999999' });

      const result = await resolveNameTool.handler(input, ctx);

      expect(result.results).toHaveLength(0);
      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('DOI');
      expect(notice).not.toMatch(/shorter name/i);
    });

    it('keeps the name-miss notice unchanged', async () => {
      mockAutocomplete.mockResolvedValue({ results: [] });
      const ctx = createMockContext();
      const input = resolveNameTool.input.parse({ query: 'xyzzy_nonexistent_entity_abc' });

      await resolveNameTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toMatch(/shorter name/i);
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

    it('labels an untitled record rather than printing null (gh #50)', () => {
      const output = text({ results: [{ ...harvard, display_name: null }] });
      expect(output).toContain('(untitled)');
      expect(output).not.toContain('null');
    });
  });
});
