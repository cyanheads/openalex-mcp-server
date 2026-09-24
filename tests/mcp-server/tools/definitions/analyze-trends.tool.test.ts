/**
 * @fileoverview Tests for openalex_analyze_trends tool.
 * @module mcp-server/tools/definitions/analyze-trends.tool.test
 */

import { invalidParams, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createCoreMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeResult } from '@/services/openalex/types.js';
import { nodeTypes, renderedText } from '../../../helpers/markdown.js';

const mockAnalyze = vi.fn<() => Promise<AnalyzeResult>>();

vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexService: () => ({ analyze: mockAnalyze }),
}));

const { analyzeTrendsTool } = await import('@/mcp-server/tools/definitions/analyze-trends.tool.js');

const createMockContext = (options?: Parameters<typeof createCoreMockContext>[0]) =>
  createCoreMockContext({ ...options, errors: analyzeTrendsTool.errors });

describe('analyzeTrendsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('error contract', () => {
    /**
     * The 400 family is thrown through the `invalidParams` factory, so a contract entry
     * declaring `ValidationError` advertises a code the caller never receives.
     */
    it('declares InvalidParams for every reason the 400 family delivers (gh #53)', () => {
      const upstream400Reasons = [
        'comma_in_filter_value',
        'upstream_invalid_params',
        'upstream_invalid_id_value',
        'upstream_ungroupable_group_by',
        'upstream_invalid_params_other',
      ];
      for (const reason of upstream400Reasons) {
        const entry = analyzeTrendsTool.errors?.find((e) => e.reason === reason);
        expect(entry, `${reason} missing from the contract`).toBeDefined();
        expect(entry?.code, `${reason} declares the wrong code`).toBe(
          JsonRpcErrorCode.InvalidParams,
        );
      }
    });

    it('declares the budget entry non-retryable and the throttle entry retryable (gh #54)', () => {
      const budget = analyzeTrendsTool.errors?.find(
        (e) => e.reason === 'upstream_budget_exhausted',
      );
      const throttle = analyzeTrendsTool.errors?.find((e) => e.reason === 'rate_limited');
      expect(budget?.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(budget?.retryable).toBe(false);
      expect(throttle?.retryable).toBe(true);
    });

    it('points an invalid-ID-value 400 at openalex_resolve_name (gh #49)', async () => {
      const ctx = createMockContext({ errors: analyzeTrendsTool.errors });
      mockAnalyze.mockRejectedValue(
        invalidParams("'Albert' is not a valid OpenAlex ID.", {
          reason: 'upstream_invalid_id_value',
          ...ctx.recoveryFor('upstream_invalid_id_value'),
        }),
      );
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_year',
        filters: { 'authorships.author.id': 'Albert Einstein' },
      });

      await expect(analyzeTrendsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'upstream_invalid_id_value',
          recovery: { hint: expect.stringMatching(/openalex_resolve_name/) },
        },
      });
    });
  });

  const sampleResult: AnalyzeResult = {
    meta: { count: 50000, groups_count: 3, next_cursor: null },
    groups: [
      { key: '2024', key_display_name: '2024', count: 20000 },
      { key: '2023', key_display_name: '2023', count: 18000 },
      { key: '2022', key_display_name: '2022', count: 12000 },
    ],
  };

  it('calls analyze with correct params', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
    });

    const result = await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(
      {
        entityType: 'works',
        groupBy: 'publication_year',
        filters: undefined,
        includeUnknown: false,
        perPage: 200,
        cursor: undefined,
      },
      ctx,
    );
    expect(result.groups).toHaveLength(3);
    expect(result.meta.count).toBe(50000);
  });

  it('threads per_page through to the service', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
      per_page: 25,
    });

    await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(expect.objectContaining({ perPage: 25 }), ctx);
  });

  it('rejects per_page outside 1-200', () => {
    expect(() =>
      analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_year',
        per_page: 201,
      }),
    ).toThrow();
    expect(() =>
      analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_year',
        per_page: 0,
      }),
    ).toThrow();
  });

  it('passes filters and includeUnknown', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'oa_status',
      filters: { 'primary_topic.field.id': 'F12345' },
      include_unknown: true,
    });

    await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { 'primary_topic.field.id': 'F12345' },
        includeUnknown: true,
      }),
      ctx,
    );
  });

  it('passes cursor for pagination', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
      cursor: 'page2',
    });

    await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'page2' }), ctx);
  });

  it('threads order through to the service', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'primary_topic.field.id',
      order: 'key',
    });

    await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(expect.objectContaining({ order: 'key' }), ctx);
  });

  it('passes order: undefined when not supplied', async () => {
    mockAnalyze.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
    });

    await analyzeTrendsTool.handler(input, ctx);

    expect(mockAnalyze).toHaveBeenCalledWith(expect.objectContaining({ order: undefined }), ctx);
  });

  /**
   * A blank `group_by` was dropped by a truthiness check, so OpenAlex answered with its plain
   * list shape and the tool reported a successful aggregation of zero groups over the whole
   * catalog. Rejecting it at the schema keeps the mistake from reaching upstream. (gh #69)
   */
  it('rejects a blank group_by before any upstream call (gh #69)', () => {
    expect(() =>
      analyzeTrendsTool.input.parse({ entity_type: 'works', group_by: '', per_page: 1 }),
    ).toThrow();
  });

  it('declares upstream_missing_group_by so its recovery reaches the caller (gh #69)', () => {
    const entry = analyzeTrendsTool.errors?.find((e) => e.reason === 'upstream_missing_group_by');
    expect(entry?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(entry?.thrownBy).toBe('service');
  });

  it('defaults include_unknown to false', () => {
    const input = analyzeTrendsTool.input.parse({
      entity_type: 'works',
      group_by: 'publication_year',
    });
    expect(input.include_unknown).toBe(false);
  });

  describe('enrichment', () => {
    it('carries the budget reading the service writes through to structuredContent', () => {
      // The service populates `budget` from the OpenAlex rate-limit headers via ctx.enrich.
      // structuredContent is built as output.extend(enrichment), which silently strips any
      // field the tool did not declare.
      const budget = { costUsd: 0.0001, remainingUsd: 0.0688, resetsInSeconds: 5554 };
      const structured = analyzeTrendsTool.output
        .extend(analyzeTrendsTool.enrichment!)
        .parse({ ...sampleResult, echo: 'entity_type=works', totalCount: 50000, budget });

      expect(structured.budget).toEqual(budget);
      expect(analyzeTrendsTool.enrichmentTrailer?.budget?.render?.(budget)).toContain(
        '$0.0688 left today',
      );
    });

    it('populates echo and totalCount on success', async () => {
      mockAnalyze.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'oa_status',
        filters: { 'authorships.institutions.country_code': 'us' },
        include_unknown: true,
      });

      await analyzeTrendsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(50000);
      expect(enrichment.echo).toContain('entity_type=works');
      expect(enrichment.echo).toContain('group_by=oa_status');
      expect(enrichment.echo).toContain('filters={"authorships.institutions.country_code":"us"}');
      expect(enrichment.echo).toContain('include_unknown=true');
      expect(enrichment.notice).toBeUndefined();
    });

    it('sets notice when no groups are returned', async () => {
      mockAnalyze.mockResolvedValue({
        meta: { count: 0, groups_count: 0, next_cursor: null },
        groups: [],
      });
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'type',
        filters: { x: 'y' },
      });

      await analyzeTrendsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(0);
      expect(enrichment.notice).toMatch(/No groups/i);
    });

    it('does not set notice when groups are present but page is not full', async () => {
      mockAnalyze.mockResolvedValue(sampleResult);
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_year',
      });

      await analyzeTrendsTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('sets truncation notice when page is filled to per_page limit', async () => {
      // Create a result with exactly per_page=4 groups (page full)
      const groups = Array.from({ length: 4 }, (_, i) => ({
        key: `k${i}`,
        key_display_name: `Key ${i}`,
        count: 100 - i * 10,
      }));
      mockAnalyze.mockResolvedValue({
        meta: { count: 5000, groups_count: 4, next_cursor: null },
        groups,
      });
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'primary_topic.field.id',
        per_page: 4,
      });

      await analyzeTrendsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('top 4 groups by count');
      expect(enrichment.notice).toContain('Smallest shown has count = 70');
      expect(enrichment.notice).toContain('order: "key"');
    });

    it('does not set truncation notice when groups count is less than per_page', async () => {
      // 3 groups returned but per_page=10 — page not full
      mockAnalyze.mockResolvedValue({
        meta: { count: 500, groups_count: 3, next_cursor: null },
        groups: [
          { key: 'a', key_display_name: 'A', count: 300 },
          { key: 'b', key_display_name: 'B', count: 150 },
          { key: 'c', key_display_name: 'C', count: 50 },
        ],
      });
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'type',
        per_page: 10,
      });

      await analyzeTrendsTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('emits a key-order pagination notice (not the count-bound one) on order:"key" with a next_cursor', async () => {
      // Page filled to per_page in key-ascending mode with more pages to come (#41).
      const groups = Array.from({ length: 5 }, (_, i) => ({
        key: `${1990 + i}`,
        key_display_name: `${1990 + i}`,
        count: 10 + i,
      }));
      mockAnalyze.mockResolvedValue({
        meta: { count: 5000, groups_count: 5, next_cursor: 'nxt-key' },
        groups,
      });
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_year',
        order: 'key',
        per_page: 5,
      });

      await analyzeTrendsTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toBeDefined();
      expect(notice).toContain('key-ascending order');
      expect(notice).toContain('next_cursor');
      // The count-bound wording from #37 must not appear in key-order mode (#41).
      expect(notice).not.toMatch(/by count/);
      expect(notice).not.toMatch(/omitted group/);
    });

    it('suppresses the notice on order:"key" when the traversal is complete (no next_cursor)', async () => {
      const groups = Array.from({ length: 5 }, (_, i) => ({
        key: `${1990 + i}`,
        key_display_name: `${1990 + i}`,
        count: 10 + i,
      }));
      mockAnalyze.mockResolvedValue({
        meta: { count: 5000, groups_count: 5, next_cursor: null },
        groups,
      });
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_year',
        order: 'key',
        per_page: 5,
      });

      await analyzeTrendsTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('still emits the count-bound notice when order is explicitly "count" and the page is full', async () => {
      const groups = Array.from({ length: 4 }, (_, i) => ({
        key: `k${i}`,
        key_display_name: `Key ${i}`,
        count: 100 - i * 10,
      }));
      mockAnalyze.mockResolvedValue({
        meta: { count: 5000, groups_count: 4, next_cursor: null },
        groups,
      });
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'primary_topic.field.id',
        order: 'count',
        per_page: 4,
      });

      await analyzeTrendsTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('top 4 groups by count');
      expect(notice).toContain('order: "key"');
    });
  });

  describe('upstream 400 recovery (gh #43)', () => {
    it('carries the ungroupable-group_by reason and recovery from the service', async () => {
      const ctx = createMockContext({ errors: analyzeTrendsTool.errors });
      mockAnalyze.mockRejectedValue(
        invalidParams('Cannot group by date, number, or search fields.', {
          reason: 'upstream_ungroupable_group_by',
          ...ctx.recoveryFor('upstream_ungroupable_group_by'),
        }),
      );
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_date',
      });

      await expect(analyzeTrendsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'upstream_ungroupable_group_by',
          recovery: {
            hint: expect.stringMatching(/openalex_describe_fields\(entity_type, "group_by"\)/),
          },
        },
      });
    });

    it('carries the neutral other-400 reason and recovery from the service', async () => {
      const ctx = createMockContext({ errors: analyzeTrendsTool.errors });
      mockAnalyze.mockRejectedValue(
        invalidParams('Invalid cursor value provided.', {
          reason: 'upstream_invalid_params_other',
          ...ctx.recoveryFor('upstream_invalid_params_other'),
        }),
      );
      const input = analyzeTrendsTool.input.parse({ entity_type: 'works', group_by: 'type' });

      await expect(analyzeTrendsTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'upstream_invalid_params_other',
          recovery: { hint: expect.stringMatching(/upstream message/i) },
        },
      });
    });
  });

  /**
   * A zero-group page on a cursor continuation is a finished key-ascending traversal, not a
   * filter set that grouped nothing — the remove-filters advice there names filters that are
   * already doing their job. (gh #74)
   */
  describe('exhausted pages (gh #74)', () => {
    const renderedText = (blocks: { type: string; text?: string }[] | undefined) =>
      (blocks ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

    /** Terminal key-ascending page: population count unchanged from page 1, no groups. */
    const terminalCursorPage: AnalyzeResult = {
      meta: { count: 4782, groups_count: 0, next_cursor: null },
      groups: [],
    };

    it('replaces the broadening advice on a cursor continuation, on both surfaces', async () => {
      mockAnalyze.mockResolvedValue(terminalCursorPage);

      const result = await runToolContract(analyzeTrendsTool, {
        entity_type: 'works',
        group_by: 'publication_year',
        filters: { publication_year: '2024-2025', 'primary_topic.id': 'T10398' },
        order: 'key',
        per_page: 2,
        cursor: 'second-page',
      });

      expect(result.isError).toBeFalsy();
      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain('Pagination exhausted');
      expect(notice).not.toContain('No groups returned for');
      const rendered = renderedText(result.content);
      expect(rendered).toContain('Pagination exhausted');
      expect(rendered).not.toContain('No groups returned for');
    });

    it('leaves echo, totalCount, and groups_count untouched on the exhausted branch', async () => {
      mockAnalyze.mockResolvedValue(terminalCursorPage);
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'publication_year',
        order: 'key',
        per_page: 2,
        cursor: 'second-page',
      });

      const output = await analyzeTrendsTool.handler(input, ctx);

      expect(output.meta.count).toBe(4782);
      expect(output.meta.groups_count).toBe(0);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(4782);
      expect(enrichment.echo).toContain('group_by=publication_year');
    });

    it('keeps the broadening advice for an all-values-unknown first page', async () => {
      // count > 0 with zero groups on page 1: every matched entity is null for the grouped
      // field and include_unknown is false. Not exhaustion — the advice still fits.
      mockAnalyze.mockResolvedValue({
        meta: { count: 4782, groups_count: 0, next_cursor: null },
        groups: [],
      });
      const ctx = createMockContext();
      const input = analyzeTrendsTool.input.parse({
        entity_type: 'works',
        group_by: 'grants.funder',
      });

      await analyzeTrendsTool.handler(input, ctx);

      const { notice } = getEnrichment(ctx);
      expect(notice).toContain('No groups returned for');
      expect(notice).not.toContain('Pagination exhausted');
    });

    it('leaves the groups_count description unchanged', () => {
      expect(analyzeTrendsTool.output.shape.meta.shape.groups_count.description).toBe(
        'Number of groups on this page (max 200).',
      );
    });
  });

  /**
   * A supplied-but-blank `cursor` was dropped by a truthiness check, so the request restarted
   * the key-ascending traversal at the first page while the tool read the parameter's presence
   * as a continuation and reported a genuine zero-group first call as exhausted. (gh #80)
   */
  describe('blank cursor (gh #80)', () => {
    it('rejects a blank cursor on the error envelope before the round trip', async () => {
      // The resolved value is what makes `not.toHaveBeenCalled()` load-bearing: without it a
      // forwarded call would still fail, just for a different reason.
      mockAnalyze.mockResolvedValue(sampleResult);

      const result = await runToolContract(analyzeTrendsTool, {
        entity_type: 'works',
        group_by: 'publication_year',
        order: 'key',
        per_page: 2,
        cursor: '',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(mockAnalyze).not.toHaveBeenCalled();
    });

    it('documents that a blank cursor is rejected rather than read as the first page', () => {
      expect(analyzeTrendsTool.input.shape.cursor.description ?? '').toMatch(/empty string/i);
    });
  });

  describe('format', () => {
    const text = (result: AnalyzeResult) => {
      const blocks = analyzeTrendsTool.format?.(result) ?? [];
      expect(blocks[0]).toHaveProperty('type', 'text');
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    it('formats groups with total count', () => {
      const output = text(sampleResult);
      expect(output).toContain('50000 total entities across 3 groups on this page');
      expect(output).toContain('2024: 20000');
      expect(output).toContain('2023: 18000');
    });

    it('renders year-keyed groups in chronological order, not count order', () => {
      const output = text(sampleResult);
      const positions = ['2022', '2023', '2024'].map((year) => output.indexOf(`${year}:`));
      expect(positions[0]).toBeLessThan(positions[1]!);
      expect(positions[1]!).toBeLessThan(positions[2]!);
    });

    it('keeps count-desc order for non-time-series groupings', () => {
      const output = text({
        meta: {
          count: 100,
          groups_count: 2,
          next_cursor: null,
        },
        groups: [
          { key: 'article', key_display_name: 'article', count: 80 },
          { key: 'book', key_display_name: 'book', count: 20 },
        ],
      });
      expect(output.indexOf('article: 80')).toBeLessThan(output.indexOf('book: 20'));
    });

    it('renders every group returned on the page', () => {
      const groups = Array.from({ length: 60 }, (_, index) => ({
        key: `group-${index + 1}`,
        key_display_name: `Group ${index + 1}`,
        count: 60 - index,
      }));
      const output = text({
        meta: {
          count: 600,
          groups_count: groups.length,
          next_cursor: null,
        },
        groups,
      });

      expect(output).toContain('Group 1 (group-1): 60');
      expect(output).toContain('Group 60 (group-60): 1');
    });

    it('returns "No groups" for empty results', () => {
      const output = text({
        meta: {
          count: 0,
          groups_count: 0,
          next_cursor: null,
        },
        groups: [],
      });
      expect(output).toContain('No groups found');
      expect(output).toContain('count=0');
      expect(output).toContain('groups_count=0');
    });

    it('surfaces next_cursor when present', () => {
      const output = text({
        meta: {
          count: 500,
          groups_count: 200,
          next_cursor: 'nxt-abc',
        },
        groups: [{ key: 'k', key_display_name: 'K', count: 1 }],
      });
      expect(output).toContain('nxt-abc');
      expect(output).toContain('200 groups on this page');
    });

    it('escapes provider labels at the line start so none becomes a Markdown block (gh #76)', () => {
      const labels = [
        '# Journal &constructor; *Ann* <genus>',
        '- Listy Source',
        '+ Plus Source',
        '1. Ordered Source',
        '2) Paren Source',
        '[ref]: http://x.test',
        '> Quoted Source',
        'Fish <Actinopterygii>',
        '[Ir(tpy)(ppy)H](+) `code` 5~10 ~~x~~ _e_ a\\*b',
        '    indented',
      ];
      const groups = labels.map((label, index) => ({
        key: `https://openalex.org/S${index}`,
        key_display_name: label,
        count: 10 - index,
      }));
      const output = text({
        meta: { count: 100, groups_count: groups.length, next_cursor: null },
        groups,
      });

      // Two paragraphs of text; the only links are the GFM autolinks of the URL keys.
      expect(nodeTypes(output).filter((t) => !['text', 'link'].includes(t))).toEqual([
        'paragraph',
        'paragraph',
      ]);
      const rendered = renderedText(output);
      for (const [index, label] of labels.entries()) {
        expect(rendered).toContain(
          `${label.trimStart()} (https://openalex.org/S${index}): ${10 - index}`,
        );
      }
    });

    it('renders a URL group key byte-identical', () => {
      const output = text({
        meta: { count: 3, groups_count: 1, next_cursor: null },
        groups: [
          {
            key: 'https://openalex.org/subfields/some_field_',
            key_display_name: 'Some Field',
            count: 3,
          },
        ],
      });
      expect(output).toContain('Some Field (https://openalex.org/subfields/some_field_): 3');
    });
  });

  describe('unknown bucket (gh #75)', () => {
    const text = (result: AnalyzeResult) => {
      const blocks = analyzeTrendsTool.format?.(result) ?? [];
      return (blocks[0] as { type: 'text'; text: string }).text;
    };

    it('carries is_unknown through structuredContent and labels the bucket as unknown', async () => {
      mockAnalyze.mockResolvedValue({
        meta: { count: 54351, groups_count: 2, next_cursor: null },
        groups: [
          { key: '-111.0', key_display_name: '-111.0', count: 48777, is_unknown: true },
          { key: '0.0', key_display_name: '0.0', count: 171 },
        ],
      });
      const result = await runToolContract(analyzeTrendsTool, {
        entity_type: 'works',
        group_by: 'apc_paid.value_usd',
        include_unknown: true,
      });

      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as AnalyzeResult).groups).toEqual([
        { key: '-111.0', key_display_name: '-111.0', count: 48777, is_unknown: true },
        { key: '0.0', key_display_name: '0.0', count: 171 },
      ]);
      const content = (result.content[0] as { text: string }).text;
      expect(content).toContain('unknown (no value; key -111.0): 48777');
      expect(content).not.toMatch(/^-111\.0: 48777$/m);
      expect(content).toContain('0.0: 171');
    });

    it.each([
      ['-111', '-111', 'unknown (no value; key -111): 85'],
      ['unknown', 'unknown', 'unknown (no value; key unknown): 85'],
      [
        'https://openalex.org/subfields/unknown',
        'unknown',
        'unknown (no value; key https://openalex.org/subfields/unknown): 85',
      ],
      ['unknown', 'Not recorded', 'unknown (no value; key unknown, label Not recorded): 85'],
    ])('labels the %s bucket (display %s) as unknown', (key, display, line) => {
      const output = text({
        meta: { count: 100, groups_count: 1, next_cursor: null },
        groups: [{ key, key_display_name: display, count: 85, is_unknown: true }],
      });
      expect(output).toContain(line);
    });

    it('renders a year trend ascending with the unknown bucket last, upstream order kept', async () => {
      const groups = [
        { key: '2024', key_display_name: '2024', count: 300 },
        { key: '-111', key_display_name: '-111', count: 85, is_unknown: true as const },
        { key: '2022', key_display_name: '2022', count: 200 },
        { key: '2023', key_display_name: '2023', count: 250 },
      ];
      mockAnalyze.mockResolvedValue({
        meta: { count: 835, groups_count: 4, next_cursor: null },
        groups,
      });
      const result = await runToolContract(analyzeTrendsTool, {
        entity_type: 'works',
        group_by: 'publication_year',
        include_unknown: true,
      });

      expect((result.structuredContent as AnalyzeResult).groups.map((g) => g.key)).toEqual([
        '2024',
        '-111',
        '2022',
        '2023',
      ]);
      const content = (result.content[0] as { text: string }).text;
      const order = ['2022: 200', '2023: 250', '2024: 300', 'unknown (no value; key -111): 85'].map(
        (line) => content.indexOf(line),
      );
      expect(order.every((position) => position >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('labels the unknown bucket on a full key-order page that continues by cursor', async () => {
      mockAnalyze.mockResolvedValue({
        meta: { count: 54351, groups_count: 2, next_cursor: 'next-page' },
        groups: [
          { key: '0.0', key_display_name: '0.0', count: 62 },
          { key: 'unknown', key_display_name: 'unknown', count: 48777, is_unknown: true },
        ],
      });
      const result = await runToolContract(analyzeTrendsTool, {
        entity_type: 'works',
        group_by: 'apc_paid.value_usd',
        include_unknown: true,
        order: 'key',
        per_page: 2,
      });
      const content = result.content.map((b) => (b as { text: string }).text).join('\n');
      expect(content).toContain('0.0: 62\nunknown (no value; key unknown): 48777');
      expect((result.structuredContent as { notice?: string }).notice).toContain('next_cursor');
    });

    it('reports an exhausted continuation the same way with include_unknown set', async () => {
      mockAnalyze.mockResolvedValue({
        meta: { count: 54351, groups_count: 0, next_cursor: null },
        groups: [],
      });
      const result = await runToolContract(analyzeTrendsTool, {
        entity_type: 'works',
        group_by: 'apc_paid.value_usd',
        include_unknown: true,
        order: 'key',
        cursor: 'past-the-end',
      });
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toContain('No groups found');
      expect((result.structuredContent as { notice?: string }).notice).toContain(
        'Pagination exhausted',
      );
    });

    it('rejects a non-boolean include_unknown before the round trip', async () => {
      const result = await runToolContract(analyzeTrendsTool, {
        entity_type: 'works',
        group_by: 'apc_paid.value_usd',
        include_unknown: 'yes' as unknown as boolean,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(mockAnalyze).not.toHaveBeenCalled();
    });

    it('documents keying, the boolean case, and that the key is not a filter value', () => {
      const description = analyzeTrendsTool.input.shape.include_unknown.description ?? '';
      expect(description).toContain('is_unknown');
      expect(description).toContain('-111');
      expect(description).toContain('/unknown');
      expect(description).toMatch(/boolean/i);
      expect(description).toMatch(/not a filter value/i);
    });
  });
});
