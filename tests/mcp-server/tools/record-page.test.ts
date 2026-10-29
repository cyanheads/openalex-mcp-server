/**
 * @fileoverview Tests for the record-page helpers shared by `openalex_search_entities` and
 * `openalex_get_citation_graph`: whole pages and whole arrays, the author-cap windows, the
 * count-based `slice` window, the 8,000,000-byte response ceiling measured against the response
 * `runToolContract` emits, the enrichment-trailer model, the `budget` field allowance, input
 * immutability, and `bareId`.
 * @module mcp-server/tools/record-page.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUDGET_FIELD_ALLOWANCE_BYTES,
  bareId,
  buildRecordPage,
  buildSlicePage,
  type PageOutcome,
  RESPONSE_CEILING_BYTES,
  trailerTextBytes,
  windowsOutputSchema,
} from '@/mcp-server/tools/record-page.js';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';
import type { UpstreamBudget } from '@/services/openalex/budget.js';
import type { EntityRecord, SearchParams, SearchResult } from '@/services/openalex/types.js';
import { parseMarkdown, renderedText } from '../../helpers/markdown.js';
import {
  authorships,
  contentTextBytes,
  slimAuthorship,
  utf8Bytes,
  workWithAuthorList,
  workWithAuthorships,
} from '../../helpers/openalex-records.js';

const mockSearch = vi.fn<() => Promise<SearchResult>>();

vi.mock('@/services/openalex/openalex-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/openalex/openalex-service.js')>();
  return { ...actual, getOpenAlexService: () => ({ search: mockSearch }) };
});

const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);
const { getCitationGraphTool } = await import(
  '@/mcp-server/tools/definitions/citation-graph.tool.js'
);

/** What a page is built from besides its records, as the search tool passes it. */
const context = {
  entityType: 'works' as const,
  meta: { count: 1, per_page: 25, next_cursor: null },
  noun: 'result(s)',
  echo: 'entity_type=works',
  totalCount: 1,
  totalLabel: 'Total',
  notices: [],
};

function pageOf(outcome: PageOutcome) {
  if (outcome.kind !== 'page') throw new Error(`expected a page: ${outcome.message}`);
  return outcome;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A work whose `note` is `bytes` ASCII letters, which no surface escapes or expands. */
const padded = (n: number, bytes: number): EntityRecord => ({
  id: `https://openalex.org/W${n}`,
  display_name: `Padded ${n}`,
  note: 'x'.repeat(bytes),
});

type Result = Awaited<ReturnType<typeof runToolContract>>;
const surfaces = (result: Result) => ({
  structured: utf8Bytes(JSON.stringify(result.structuredContent)),
  text: contentTextBytes(result.content),
});
const errorData = (result: Result) =>
  (result.structuredContent as { error: { data: Record<string, unknown> } }).error.data;

describe('record pages (gh #131)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
  });

  /**
   * The ceiling holds both surfaces of the response `runToolContract` emits, with the
   * `budget` field's allowance on each, to 8,000,000 bytes. Every size here is read off a real
   * `CallToolResult`, so a measurement that drifts from what the framework emits fails.
   */
  describe('response ceiling', () => {
    /** Serve one record to `id` lookups and the first `per_page` of `records` to searches. */
    function serve(records: EntityRecord[]) {
      mockSearch.mockImplementation(async (...args: unknown[]) => {
        const [params] = args as [SearchParams];
        if (params.id) {
          return {
            meta: { count: 1, per_page: 1, next_cursor: null },
            results: records.filter((r) => bareId(r.id) === params.id),
          };
        }
        const perPage = params.sample ?? params.perPage ?? 25;
        return {
          meta: { count: records.length, per_page: perPage, next_cursor: 'cursor-2' },
          results: records.slice(0, perPage),
        };
      });
    }
    const lookup = () =>
      runToolContract(searchEntitiesTool, { entity_type: 'works', id: 'W1', select: ['note'] });

    it('returns a response at exactly the ceiling and refuses one a byte over', async () => {
      serve([padded(1, 1_000)]);
      const probe = surfaces(await lookup());
      const busier = Math.max(probe.structured, probe.text);
      const headroom = RESPONSE_CEILING_BYTES - BUDGET_FIELD_ALLOWANCE_BYTES - busier;

      serve([padded(1, 1_000 + headroom)]);
      const fit = await lookup();
      expect(fit.isError).toBeFalsy();
      const fitBytes = surfaces(fit);
      expect(Math.max(fitBytes.structured, fitBytes.text) + BUDGET_FIELD_ALLOWANCE_BYTES).toBe(
        RESPONSE_CEILING_BYTES,
      );

      serve([padded(1, 1_001 + headroom)]);
      const over = await lookup();
      expect(over.isError).toBe(true);
      const data = errorData(over);
      expect(data).toMatchObject({ reason: 'response_too_large', ceilingBytes: 8_000_000 });
      expect(Math.max(data.structuredBytes as number, data.textBytes as number)).toBe(
        RESPONSE_CEILING_BYTES + 1,
      );
      const text = JSON.stringify(over.content);
      expect(text).toContain('response_too_large');
      expect(text).toContain('8,000,000-byte response ceiling');
    });

    it('names the largest per_page that fits, and that page fits', async () => {
      const records = Array.from({ length: 10 }, (_, n) => padded(n + 1, 1_000_000));
      serve(records);

      const over = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'padded' },
        select: ['note'],
        per_page: 10,
      });
      expect(over.isError).toBe(true);
      expect(errorData(over)).toMatchObject({
        reason: 'response_too_large',
        largestFitting: { input: 'per_page', value: 7 },
        recovery: { hint: expect.stringContaining('Rerun with per_page 7') },
      });
      expect(JSON.stringify(over.content)).toContain('Rerun with per_page 7');

      const rerun = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        filters: { 'title.search': 'padded' },
        select: ['note'],
        per_page: 7,
      });
      expect(rerun.isError).toBeFalsy();
      expect((rerun.structuredContent as { results: unknown[] }).results).toEqual(
        records.slice(0, 7),
      );
    });

    /**
     * `per_page` sizes a sample page as it does a search page (gh #124), and a sample walks its
     * draw with `page`, as semantic search walks its candidates — neither returns a cursor.
     */
    it.each([
      ['a sample', { sample: 10 }],
      ['a semantic search', { query: 'padded', search_mode: 'semantic', per_page: 10 }],
    ] as const)(
      'names the largest per_page and continues %s with `page`',
      async (_label, extra) => {
        serve(Array.from({ length: 10 }, (_, n) => padded(n + 1, 1_000_000)));
        const over = await runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          select: ['note'],
          ...extra,
        });
        expect(errorData(over)).toMatchObject({
          largestFitting: { input: 'per_page', value: 7 },
          recovery: { hint: expect.stringContaining('Rerun with per_page 7') },
        });
        const { hint } = (errorData(over) as { recovery: { hint: string } }).recovery;
        expect(hint).toContain('`page`');
        expect(hint).not.toContain('cursor');
        expect(hint).not.toMatch(/sample \d/);
      },
    );

    it('sends a refused page past page 1 back to page 1, where its per_page holds these records', async () => {
      serve(Array.from({ length: 10 }, (_, n) => padded(n + 1, 1_000_000)));
      const over = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        select: ['note'],
        query: 'padded',
        search_mode: 'semantic',
        per_page: 10,
        page: 2,
      });
      const { hint } = (errorData(over) as { recovery: { hint: string } }).recovery;
      expect(errorData(over)).toMatchObject({ largestFitting: { input: 'per_page', value: 7 } });
      expect(hint).toContain('from page 1 at per_page 7');
      expect(hint).not.toContain('Rerun with per_page');
      expect(JSON.stringify(over.content)).toContain('from page 1 at per_page 7');
    });

    it('names a lone overflowing record in the singular', () => {
      const outcome = buildRecordPage({
        ...context,
        records: [padded(1, 8_000_000)],
        path: 'list',
        continuation: 'cursor',
      });
      expect(outcome.kind).toBe('too_large');
      if (outcome.kind !== 'too_large') return;
      expect(outcome.message).toMatch(/^This record would return /);
    });

    it('sends a list page whose first record alone overflows to `select` and `slice`', () => {
      const outcome = buildRecordPage({
        ...context,
        records: [padded(1, 8_000_000), padded(2, 10)],
        path: 'list',
        continuation: 'cursor',
      });
      expect(outcome.kind).toBe('too_large');
      if (outcome.kind !== 'too_large') return;
      expect(outcome.data.largestFitting).toBeUndefined();
      expect(outcome.data.recovery.hint).toMatch(/first record alone exceeds.*`select`.*`slice`/);
    });

    it('names the largest array of an overflowing id lookup', () => {
      const record: EntityRecord = {
        ...padded(1, 4_000_000),
        authorships: [{ note: 'x'.repeat(2_200_000) }, { note: 'x'.repeat(2_200_000) }],
        referenced_works: ['https://openalex.org/W2'],
      };
      const outcome = buildRecordPage({
        ...context,
        records: [record],
        path: 'lookup',
        continuation: 'cursor',
      });
      expect(outcome).toMatchObject({
        kind: 'too_large',
        message: expect.stringMatching(/^The record at `W1` would return [\d,]+ bytes/),
        data: {
          recovery: { hint: expect.stringContaining('page `authorships` (2 elements') },
        },
      });
    });

    it('names the largest slice.limit that fits, and that slice fits', async () => {
      const record: EntityRecord = {
        id: 'https://openalex.org/W1',
        display_name: 'Wide elements',
        authorships: Array.from({ length: 10 }, (_, i) => ({ note: `${i}${'x'.repeat(1e6)}` })),
      };
      serve([record]);
      const slice = (limit: number) =>
        runToolContract(searchEntitiesTool, {
          entity_type: 'works',
          id: 'W1',
          slice: { field: 'authorships', offset: 0, limit },
        });

      const over = await slice(10);
      expect(over.isError).toBe(true);
      expect(errorData(over)).toMatchObject({
        reason: 'response_too_large',
        largestFitting: { input: 'slice.limit', value: 7 },
        recovery: { hint: expect.stringContaining('Rerun with slice.limit 7') },
      });

      const rerun = await slice(7);
      expect(rerun.isError).toBeFalsy();
      expect(rerun.structuredContent).toMatchObject({
        windows: [
          {
            offset: 0,
            shown: 7,
            total: 10,
            next: { arguments: { slice: { field: 'authorships', offset: 7, limit: 7 } } },
          },
        ],
      });
    });

    it('steps past a slice element that alone overflows', () => {
      const outcome = buildSlicePage({
        ...context,
        record: {
          id: 'https://openalex.org/W1',
          display_name: 'Huge element',
          authorships: [{ note: 'x' }, { note: 'x'.repeat(8_000_000) }],
        },
        field: 'authorships',
        offset: 1,
        limit: 50,
      });
      expect(outcome).toMatchObject({
        kind: 'too_large',
        data: { recovery: { hint: expect.stringContaining('slice.offset 2') } },
      });
      expect(outcome.kind === 'too_large' && outcome.data.largestFitting).toBeFalsy();
    });
  });

  describe('whole pages and arrays', () => {
    it('returns every record of a page far past 64,000 bytes, with no window', () => {
      const records = Array.from({ length: 25 }, (_, n) => workWithAuthorships(n, 98));
      expect(utf8Bytes(JSON.stringify(records))).toBeGreaterThan(1_000_000);
      const { page, notice } = pageOf(
        buildRecordPage({ ...context, records, path: 'list', continuation: 'cursor' }),
      );
      expect(page.results).toEqual(records);
      expect(page).not.toHaveProperty('windows');
      expect(notice).toBeUndefined();
    });

    it('returns a 2,932-element array of an id lookup whole', () => {
      const record = workWithAuthorships(1, 2932);
      const { page, notice } = pageOf(
        buildRecordPage({ ...context, records: [record], path: 'lookup', continuation: 'cursor' }),
      );
      expect(page.results[0]?.authorships).toHaveLength(2932);
      expect(page).not.toHaveProperty('windows');
      expect(notice).toBeUndefined();
    });

    it('joins the tool notices ahead of its own', () => {
      const { notice } = pageOf(
        buildRecordPage({
          ...context,
          notices: ['First.', undefined, 'Second.'],
          records: [workWithAuthorList(1, 100)],
          path: 'list',
          continuation: 'cursor',
        }),
      );
      expect(notice).toMatch(/^First\. Second\. 1 record\(s\) carry exactly 100/);
    });
  });

  /**
   * `slice: { field, offset, limit }` returns `limit` elements from `offset`, fewer only at the
   * array end; its window's `next` repeats `limit` from the following offset.
   */
  describe('count-based slice', () => {
    const record = workWithAuthorships(1, 2932);
    const id = bareId(record.id);
    const slice = (offset: number, limit: number) =>
      pageOf(buildSlicePage({ ...context, record, field: 'authorships', offset, limit }));

    it.each([
      [0, 50, 50, 50],
      [100, 100, 100, 200],
      [2900, 100, 32, null],
      [2932, 50, 0, null],
      [5000, 50, 0, null],
    ])('offset %i, limit %i shows %i, next offset %s', (offset, limit, shown, nextOffset) => {
      const { page } = slice(offset, limit);
      const items = record.authorships as unknown[];
      expect(page.results[0]?.authorships).toEqual(items.slice(offset, offset + limit));
      expect(page.windows).toEqual([
        {
          id,
          field: 'authorships',
          offset,
          shown,
          total: 2932,
          possibly_capped: false,
          next:
            nextOffset === null
              ? null
              : {
                  tool: 'openalex_search_entities',
                  arguments: {
                    entity_type: 'works',
                    id,
                    slice: { field: 'authorships', offset: nextOffset, limit },
                  },
                },
        },
      ]);
    });

    it('walks 2,932 authorships in exactly ceil(2932 / limit) calls with no gap or overlap', () => {
      const collected: unknown[] = [];
      let next: { offset: number; limit: number } | undefined = { offset: 0, limit: 300 };
      let calls = 0;
      while (next) {
        const { page } = slice(next.offset, next.limit);
        collected.push(...((page.results[0]?.authorships ?? []) as unknown[]));
        next = page.windows?.[0]?.next?.arguments.slice as typeof next;
        calls++;
      }
      expect(calls).toBe(10);
      expect(collected).toEqual(record.authorships);
    });

    it('carries a final window for a slice that returns its whole array, as `windows` describes', () => {
      const references = Array.from(
        { length: 167 },
        (_, i) => `https://openalex.org/W${2_000_000_000 + i}`,
      );
      const { page } = pageOf(
        buildSlicePage({
          ...context,
          record: {
            id: 'https://openalex.org/W7',
            display_name: 'Whole',
            referenced_works: references,
          },
          field: 'referenced_works',
          offset: 0,
          limit: 5000,
        }),
      );
      expect(page.results[0]?.referenced_works).toEqual(references);
      expect(page.windows).toEqual([
        expect.objectContaining({ offset: 0, shown: 167, total: 167, next: null }),
      ]);
      expect(windowsOutputSchema.description).toMatch(/every `slice` call[^.]*even when/);
    });
  });

  /**
   * OpenAlex caps a list record at 100 authorships, so the `author_list` derived from them is
   * capped the same way; either array at exactly 100 on a list record gets its own possibly
   * capped window, continued by an `id` + `slice` call on that same field. A singleton stores
   * at most 5,000. (gh #73, #102)
   */
  describe('author-cap windows', () => {
    const capWindowFor = (record: EntityRecord, field: string) => ({
      id: bareId(record.id),
      field,
      offset: 0,
      shown: 100,
      total: 100,
      possibly_capped: true,
      next: {
        tool: 'openalex_search_entities',
        arguments: { entity_type: 'works', id: bareId(record.id), slice: { field, offset: 100 } },
      },
    });
    const build = (records: EntityRecord[], path: 'list' | 'lookup') =>
      pageOf(buildRecordPage({ ...context, records, path, continuation: 'cursor' }));

    it.each([
      [99, false],
      [100, true],
      [101, false],
    ])('windows a %i-entry author_list on a list record: %s', (count, capped) => {
      const record = workWithAuthorList(1, count);
      const { page, notice } = build([record], 'list');
      expect(page.results).toEqual([record]);
      expect(page.windows).toEqual(capped ? [capWindowFor(record, 'author_list')] : undefined);
      if (capped) expect(notice).toMatch(/exactly 100 authorships or author_list entries/);
      else expect(notice).toBeUndefined();
    });

    it('gives each capped array its own window when a record carries both', () => {
      const record: EntityRecord = {
        ...workWithAuthorList(1, 100, slimAuthorship),
        authorships: authorships(100, slimAuthorship),
      };
      const { page, notice } = build([record, workWithAuthorList(2, 3)], 'list');
      expect(page.results).toHaveLength(2);
      expect(page.windows).toEqual([
        capWindowFor(record, 'authorships'),
        capWindowFor(record, 'author_list'),
      ]);
      expect(notice).toMatch(/^1 record\(s\) carry exactly 100/);
    });

    it('never windows a 100-entry author_list on an id lookup', () => {
      const { page, notice } = build([workWithAuthorList(1, 100)], 'lookup');
      expect(page.windows).toBeUndefined();
      expect(notice).toBeUndefined();
    });

    it.each(['authorships', 'author_list'])(
      'keeps a below-ceiling singleton %s certain',
      (field) => {
        const { page, notice } = build(
          [{ id: 'W1', display_name: null, [field]: Array(4999).fill(null) }],
          'lookup',
        );
        expect(page.windows).toBeUndefined();
        expect(notice).toBeUndefined();
      },
    );

    it.each(['authorships', 'author_list'])(
      'discloses a whole singleton %s at the storage ceiling',
      (field) => {
        const { page, notice } = build(
          [{ id: 'W1', display_name: null, [field]: Array(5000).fill(null) }],
          'lookup',
        );
        expect(page.results[0]?.[field]).toHaveLength(5000);
        expect(page.windows).toEqual([
          {
            id: 'W1',
            field,
            offset: 0,
            shown: 5000,
            total: 5000,
            possibly_capped: true,
            next: null,
          },
        ]);
        expect(notice).toContain('5,000');
        expect(notice).toContain('stored');
      },
    );

    it('discloses both selected author fields at the storage ceiling', () => {
      const record = { ...workWithAuthorList(1, 5000), authorships: authorships(5000) };
      const { page, notice } = build([record], 'lookup');
      expect(page.windows?.map((window) => [window.field, window.shown, window.next])).toEqual([
        ['authorships', 5000, null],
        ['author_list', 5000, null],
      ]);
      expect(notice).toContain('stored entries');
    });

    it.each(['authorships', 'author_list'])('keeps capped singleton %s slices finite', (field) => {
      const record = { id: 'W1', display_name: null, [field]: Array(5000).fill(null) };
      for (const [offset, shown] of [
        [4999, 1],
        [5000, 0],
        [5001, 0],
      ]) {
        const { page, notice } = pageOf(
          buildSlicePage({ ...context, record, field, offset: offset!, limit: 50 }),
        );
        expect(page.windows).toEqual([
          { id: 'W1', field, offset, shown, total: 5000, possibly_capped: true, next: null },
        ]);
        expect(notice).toContain('5,000');
      }
    });
  });

  /**
   * The framework renders the trailer from enrichment in insertion order; the service writes
   * `budget` before the handler writes `echo`, `totalCount`, and `notice`. So the rendered
   * trailer is the modelled one plus the budget line and its one-byte separator.
   */
  describe('trailer model vs the trailer runToolContract renders', () => {
    const SPEND: UpstreamBudget = {
      costUsd: 0.30000000000000004,
      remainingUsd: 12345.678901234567,
      resetsInSeconds: 86399.99999999999,
      prepaidRemainingUsd: 98765.43210987654,
    };

    function serve(results: EntityRecord[]) {
      mockSearch.mockImplementation(async (...args: unknown[]) => {
        const [params, ctx] = args as [SearchParams, Context];
        ctx.enrich({ budget: SPEND });
        if (params.id) {
          return {
            meta: { count: 1, per_page: 1, next_cursor: null },
            results: [{ id: 'https://openalex.org/W9', display_name: '' }],
          };
        }
        return { meta: { count: results.length, per_page: 25, next_cursor: null }, results };
      });
    }

    function expectModelled(result: Result, totalLabel: string) {
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        echo: string;
        totalCount: number;
        notice?: string;
      };
      const trailer = result.content.at(-1);
      expect(trailer?.type).toBe('text');
      const rendered = trailer?.type === 'text' ? trailer.text : '';
      const modelled = trailerTextBytes({
        echo: structured.echo,
        totalCount: structured.totalCount,
        totalLabel,
        notice: structured.notice,
      });
      expect(utf8Bytes(rendered)).toBe(modelled + utf8Bytes(renderBudgetTrailer(SPEND)) + 1);
      return rendered;
    }

    const record = workWithAuthorships(1, 2);

    it('matches on a search page with no notice', async () => {
      serve([record]);
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'collaboration',
      });
      expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
      expectModelled(result, 'Total');
    });

    it('matches on a search page with a notice', async () => {
      serve([]);
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'collaboration',
      });
      expect(expectModelled(result, 'Total')).toContain('> No matches');
    });

    it('matches when the echoed query holds a line that would open a list item', async () => {
      serve([]);
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'alpha\n- beta',
      });
      // The echo JSON-encodes the query, so the break stays escaped inside the echo's one-line
      // code span.
      expect(expectModelled(result, 'Total')).toContain('query="alpha\\n- beta"`\n**Total:**');
    });

    it('matches on a citation-graph page, with and without a notice', async () => {
      serve([record]);
      expectModelled(
        await runToolContract(getCitationGraphTool, { seed_id: 'W9', direction: 'cites' }),
        'Total Edges',
      );
      serve([]);
      const empty = await runToolContract(getCitationGraphTool, {
        seed_id: 'W9',
        direction: 'cites',
      });
      expect(expectModelled(empty, 'Total Edges')).toContain('> No edges');
    });
  });

  /**
   * The allowance reserved for the service-written `budget` field must cover its widest
   * realistic form on both surfaces: every number at full double precision, a prepaid balance,
   * amounts under $1,000,000, and a reset under a day away. The trailer line is charged with a
   * two-byte separator, the most `joinTrailerFields` ever puts beside it.
   */
  describe('budget field allowance', () => {
    // 17 significant digits at 1e-6 serialize as 24 characters, the longest non-exponent form.
    const widest = 0.0000012345678901234567;
    const widestJson: UpstreamBudget = {
      costUsd: widest,
      remainingUsd: widest,
      resetsInSeconds: widest,
      prepaidRemainingUsd: widest,
    };
    const widestTrailer: UpstreamBudget = {
      costUsd: 999_999.99999999988,
      remainingUsd: 999_999.99999999988,
      resetsInSeconds: 86_399.99999999999,
      prepaidRemainingUsd: 999_999.99999999988,
    };

    it('covers the budget member of structuredContent', () => {
      const member = `,"budget":${JSON.stringify(widestJson)}`;
      expect(utf8Bytes(member)).toBe(176);
      expect(utf8Bytes(member)).toBeLessThanOrEqual(BUDGET_FIELD_ALLOWANCE_BYTES);
    });

    it('covers the budget line of the content[] trailer', () => {
      const line = renderBudgetTrailer(widestTrailer);
      expect(line).toContain('+ $1000000.0000 prepaid');
      expect(utf8Bytes(line) + 2).toBe(108);
      expect(utf8Bytes(line) + 2).toBeLessThanOrEqual(BUDGET_FIELD_ALLOWANCE_BYTES);
    });
  });

  describe('input records', () => {
    it('are not mutated or returned as the same array by a list page', () => {
      const records = deepFreeze(Array.from({ length: 5 }, (_, n) => workWithAuthorList(n, 100)));
      const { page } = pageOf(
        buildRecordPage({ ...context, records, path: 'list', continuation: 'cursor' }),
      );
      expect(page.results).not.toBe(records);
      expect(page.results).toEqual(records);
    });

    it('are not mutated by a slice window', () => {
      const record = deepFreeze(workWithAuthorships(1, 2932));
      const { page } = pageOf(
        buildSlicePage({ ...context, record, field: 'authorships', offset: 100, limit: 100 }),
      );
      const [windowed] = page.results;
      const items = windowed?.authorships as unknown[] | undefined;
      expect(windowed).not.toBe(record);
      expect(items).not.toBe(record.authorships);
      expect(items?.[0]).toBe((record.authorships as unknown[])[100]);
      expect(record.authorships).toHaveLength(2932);
    });
  });

  describe('bareId', () => {
    it.each([
      ['https://openalex.org/W2741809807', 'W2741809807'],
      ['https://openalex.org/A5023888391', 'A5023888391'],
      ['W2741809807', 'W2741809807'],
      [
        'https://openalex.org/keywords/machine-learning',
        'https://openalex.org/keywords/machine-learning',
      ],
    ])('%s → %s', (id, expected) => {
      expect(bareId(id)).toBe(expected);
    });
  });

  /**
   * A window line renders its field and continuation call as code spans. A backtick in either
   * value — here a slice field the record carries — must not close its span early, so each span's
   * fence runs one backtick past the value's longest backtick run, as the framework fences the
   * echo.
   */
  describe('window line code spans', () => {
    const inlineCodes = (markdown: string): string[] => {
      const found: string[] = [];
      const walk = (node: { type: string; value?: string; children?: unknown[] }) => {
        if (node.type === 'inlineCode') found.push(node.value ?? '');
        for (const child of node.children ?? []) walk(child as typeof node);
      };
      walk(parseMarkdown(markdown) as Parameters<typeof walk>[0]);
      return found;
    };

    it.each([
      ['a single backtick', 'x`y'],
      ['a backtick run', 'x``y`z'],
    ])('keeps a field holding %s inside its spans', async (_label, field) => {
      mockSearch.mockResolvedValueOnce({
        meta: { count: 1, per_page: 1, next_cursor: null },
        results: [
          {
            id: 'https://openalex.org/keywords/groundwater',
            display_name: 'Groundwater',
            [field]: ['a', 'b', 'c'],
          },
        ],
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'keywords',
        id: 'groundwater',
        slice: { field, offset: 0, limit: 1 },
      });

      expect(result.isError).toBeFalsy();
      const { windows } = result.structuredContent as {
        windows: { next: { tool: string; arguments: Record<string, unknown> } }[];
      };
      const next = windows[0]?.next;
      expect(next?.arguments).toEqual({
        entity_type: 'keywords',
        id: 'https://openalex.org/keywords/groundwater',
        slice: { field, offset: 1, limit: 1 },
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      const line = text.split('\n').find((l) => l.startsWith('**Window:**')) ?? '';
      expect(inlineCodes(line)).toEqual([
        field,
        'openalex_search_entities',
        JSON.stringify(next?.arguments),
      ]);
      expect(renderedText(line)).toBe(
        `Window: https://openalex.org/keywords/groundwater ${field} — offset 0, 1 shown of 3 — next: openalex_search_entities ${JSON.stringify(next?.arguments)}`,
      );
    });
  });
});
