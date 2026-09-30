/**
 * @fileoverview Tests for the response-budget helper: the byte boundary, the enrichment-trailer
 * model against the trailer the framework renders, the `budget` field allowance, input
 * immutability, and `bareId`.
 * @module mcp-server/tools/response-budget.test
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderBudgetTrailer } from '@/mcp-server/tools/render-budget.js';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';
import {
  BUDGET_FIELD_ALLOWANCE_BYTES,
  bareId,
  type FrameMeasure,
  fitRecordsToBudget,
  fitSliceToBudget,
  omittedOutputSchema,
  RESPONSE_BUDGET_BYTES,
  trailerTextBytes,
  windowsOutputSchema,
} from '@/mcp-server/tools/response-budget.js';
import type { UpstreamBudget } from '@/services/openalex/budget.js';
import type { EntityRecord, SearchParams, SearchResult } from '@/services/openalex/types.js';
import { authorships, utf8Bytes, workWithAuthorships } from '../../helpers/openalex-records.js';

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

/** What one record costs the busier surface, per the spec: max(JSON, rendered) plus a separator. */
const charge = (record: EntityRecord) =>
  Math.max(utf8Bytes(JSON.stringify(record)), utf8Bytes(renderEntityRecord(record).join('\n'))) + 1;

const constantFrame =
  (structured: number, text: number): FrameMeasure =>
  () => ({ structured, text });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('response budget helper (gh #72, #73)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
  });

  describe('byte boundary', () => {
    const records = Array.from({ length: 5 }, (_, n) => workWithAuthorships(n, 4));
    const recordBytes = records.reduce((sum, record) => sum + charge(record), 0);

    it('keeps every record when frame plus record charges total exactly the budget', () => {
      const frame = RESPONSE_BUDGET_BYTES - recordBytes;
      const page = fitRecordsToBudget({
        records,
        entityType: 'works',
        path: 'list',
        select: ['authorships'],
        measureFrame: constantFrame(frame, frame - 500),
      });

      expect(page.results).toEqual(records);
      expect(page.disclosure).toEqual({});
      expect(page.notice).toBeUndefined();
    });

    it('cuts the last record when the total runs one byte over', () => {
      const frame = RESPONSE_BUDGET_BYTES - recordBytes + 1;
      const page = fitRecordsToBudget({
        records,
        entityType: 'works',
        path: 'list',
        select: ['authorships'],
        // The text surface is the busier one here: the frame charge is the larger of the two.
        measureFrame: constantFrame(frame - 500, frame),
      });

      expect(page.results).toEqual(records.slice(0, 4));
      expect(page.disclosure.omitted?.ids).toEqual([bareId(records[4]!.id)]);
      expect(page.notice).toMatch(/held 4 of 5 records/);
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

    type Result = Awaited<ReturnType<typeof runToolContract>>;
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

    it('matches when the echo ends in a line that opens a list item', async () => {
      serve([]);
      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'works',
        query: 'alpha\n- beta',
      });
      // The list-item line forces a blank line before the next field; the model must follow.
      expect(expectModelled(result, 'Total')).toContain('- beta"\n\n**Total:**');
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
    const measureFrame = constantFrame(1_000, 1_000);

    it('are not mutated or returned as the same array when a list page is cut', () => {
      const records = deepFreeze(Array.from({ length: 25 }, (_, n) => workWithAuthorships(n, 8)));
      const page = fitRecordsToBudget({
        records,
        entityType: 'works',
        path: 'list',
        select: undefined,
        measureFrame,
      });

      expect(page.disclosure.omitted).toBeDefined();
      expect(page.results).not.toBe(records);
      expect(page.results).toEqual(records.slice(0, page.results.length));
    });

    it('are not mutated when the first record is windowed', () => {
      const records = deepFreeze([workWithAuthorships(1, 2932), workWithAuthorships(2, 3)]);
      const page = fitRecordsToBudget({
        records,
        entityType: 'works',
        path: 'list',
        select: ['authorships'],
        measureFrame,
      });

      const [windowed] = page.results;
      expect(page.disclosure.windows?.[0]?.field).toBe('authorships');
      expect(windowed).not.toBe(records[0]);
      expect(windowed?.authorships).not.toBe(records[0]!.authorships);
      expect(records[0]!.authorships).toHaveLength(2932);
    });

    it('are not mutated when non-array fields alone overflow', () => {
      const record = deepFreeze({
        id: 'https://openalex.org/W77',
        display_name: 'Oversized',
        abstract: 'lorem ipsum '.repeat(6000),
        authorships: authorships(3),
      });
      const page = fitRecordsToBudget({
        records: [record],
        entityType: 'works',
        path: 'lookup',
        select: ['*'],
        measureFrame,
      });

      expect(page.disclosure.over_budget).toBe(true);
      expect(page.results[0]).not.toBe(record);
      expect(page.results[0]?.authorships).toEqual([]);
      expect(record.authorships).toHaveLength(3);
    });

    it('are not mutated by a slice window', () => {
      const record = deepFreeze(workWithAuthorships(1, 2932));
      const page = fitSliceToBudget({
        record,
        field: 'authorships',
        offset: 100,
        entityType: 'works',
        measureFrame,
      });

      const [windowed] = page.results;
      const items = windowed?.authorships as unknown[] | undefined;
      expect(windowed).not.toBe(record);
      expect(items).not.toBe(record.authorships);
      expect(items?.[0]).toBe((record.authorships as unknown[])[100]);
      expect(record.authorships).toHaveLength(2932);
    });
  });

  /**
   * When a record needs more than one array windowed, the windowed arrays fill round-robin, one
   * element at a time, so none is starved while elements of it would fit.
   */
  describe('windowed array fill', () => {
    const measureFrame = constantFrame(1_000, 1_000);
    /** Bytes the fill may spend on the record: the budget less the constant frame. */
    const available = RESPONSE_BUDGET_BYTES - 1_000;

    /** A record's charge as the fill measures it, with the window views `format()` passes. */
    function windowedCharge(record: EntityRecord, source: EntityRecord, fields: string[]): number {
      const views = new Map(
        fields.map((field) => [field, { offset: 0, total: (source[field] as unknown[]).length }]),
      );
      return (
        Math.max(
          utf8Bytes(JSON.stringify(record)),
          utf8Bytes(renderEntityRecord(record, views).join('\n')),
        ) + 1
      );
    }

    /** The fill fits, and one more element on any windowed array would not: no round is left. */
    function expectMaximalFill(
      page: ReturnType<typeof fitRecordsToBudget>,
      source: EntityRecord,
    ): void {
      const windows = page.disclosure.windows ?? [];
      const fields = windows.map((window) => window.field);
      const kept = page.results[0]!;
      expect(windowedCharge(kept, source, fields)).toBeLessThanOrEqual(available);
      for (const { field, shown } of windows) {
        const grown = { ...kept, [field]: (source[field] as unknown[]).slice(0, shown + 1) };
        expect(
          windowedCharge(grown, source, fields),
          `${field} had room for element ${shown}`,
        ).toBeGreaterThan(available);
      }
    }

    it('shows elements of every windowed array, evenly when their elements match in size', () => {
      // Neither array fits beside the other emptied, so both are windowed.
      const record: EntityRecord = {
        id: 'https://openalex.org/W88',
        display_name: 'Two long arrays',
        authorships: authorships(300),
        locations: authorships(200),
      };
      const page = fitRecordsToBudget({
        records: [record],
        entityType: 'works',
        path: 'lookup',
        select: ['*'],
        measureFrame,
      });

      const shown = Object.fromEntries(
        (page.disclosure.windows ?? []).map((w) => [w.field, w.shown]),
      );
      expect(Object.keys(shown).sort()).toEqual(['authorships', 'locations']);
      expect(shown.authorships).toBeGreaterThan(0);
      expect(shown.locations).toBeGreaterThan(0);
      expect(Math.abs((shown.authorships ?? 0) - (shown.locations ?? 0))).toBeLessThanOrEqual(1);
      expect(page.results[0]?.authorships).toEqual(
        (record.authorships as unknown[]).slice(0, shown.authorships),
      );
      expect(page.results[0]?.locations).toEqual(
        (record.locations as unknown[]).slice(0, shown.locations),
      );
      expect(page.disclosure.over_budget).toBeUndefined();
      expectMaximalFill(page, record);
    });

    it('fills a small-element array past a large-element one once the large one stops fitting', () => {
      const record: EntityRecord = {
        id: 'https://openalex.org/W89',
        display_name: 'Unequal arrays',
        authorships: authorships(300),
        referenced_works: Array.from(
          { length: 4_000 },
          (_, i) => `https://openalex.org/W${2_000_000_000 + i}`,
        ),
      };
      const page = fitRecordsToBudget({
        records: [record],
        entityType: 'works',
        path: 'lookup',
        select: ['*'],
        measureFrame,
      });

      const shown = Object.fromEntries(
        (page.disclosure.windows ?? []).map((w) => [w.field, w.shown]),
      );
      expect(shown.authorships).toBeGreaterThan(0);
      // Round-robin keeps adding the 35-byte references after a 600-byte authorship stops fitting.
      expect(shown.referenced_works).toBeGreaterThan(shown.authorships ?? 0);
      expectMaximalFill(page, record);
    });
  });

  /**
   * `slice` always returns at least one element so a walk advances; when that one element alone
   * outgrows the budget, the response runs over it and says so.
   */
  describe('slice window over budget', () => {
    const measureFrame = constantFrame(1_000, 1_000);
    const huge = { note: 'x'.repeat(70_000) };

    it('flags a slice whose single element alone exceeds the budget', () => {
      const record: EntityRecord = {
        id: 'https://openalex.org/W5',
        display_name: 'Huge elements',
        authorships: [huge, huge],
      };
      const page = fitSliceToBudget({
        record,
        field: 'authorships',
        offset: 0,
        entityType: 'works',
        measureFrame,
      });

      expect(page.results[0]?.authorships).toEqual([huge]);
      expect(page.disclosure.over_budget).toBe(true);
      expect(page.disclosure.windows?.[0]).toMatchObject({ offset: 0, shown: 1, total: 2 });
      expect(page.disclosure.windows?.[0]?.next?.arguments).toMatchObject({
        slice: { field: 'authorships', offset: 1 },
      });
      expect(page.notice).toMatch(/alone exceeds the 64,000-byte response budget/);
      expect(page.notice).toContain("the `windows` entry's `next` call continues after it");
    });

    it('promises no continuation when the over-budget element is the last one', () => {
      const page = fitSliceToBudget({
        record: {
          id: 'https://openalex.org/W5',
          display_name: 'Huge elements',
          authorships: [huge, huge],
        },
        field: 'authorships',
        offset: 1,
        entityType: 'works',
        measureFrame,
      });

      expect(page.disclosure.over_budget).toBe(true);
      expect(page.disclosure.windows?.[0]).toMatchObject({
        offset: 1,
        shown: 1,
        total: 2,
        next: null,
      });
      expect(page.notice).toContain('it is the last element');
      expect(page.notice).not.toContain('`next` call');
    });

    it('leaves a slice whose elements fit unflagged', () => {
      const page = fitSliceToBudget({
        record: workWithAuthorships(1, 2932),
        field: 'authorships',
        offset: 0,
        entityType: 'works',
        measureFrame,
      });

      expect(page.disclosure.over_budget).toBeUndefined();
      expect(page.notice).toBeUndefined();
    });

    /**
     * A `slice` call reports its window even when it returns the whole array, so the `windows`
     * description cannot say the field is absent whenever every array is whole.
     */
    it('carries a final window for a slice that returns its whole array, as `windows` describes', () => {
      const references = Array.from(
        { length: 167 },
        (_, i) => `https://openalex.org/W${2_000_000_000 + i}`,
      );
      const page = fitSliceToBudget({
        record: {
          id: 'https://openalex.org/W7',
          display_name: 'Whole',
          referenced_works: references,
        },
        field: 'referenced_works',
        offset: 0,
        entityType: 'works',
        measureFrame,
      });

      expect(page.results[0]?.referenced_works).toEqual(references);
      expect(page.disclosure.windows).toEqual([
        expect.objectContaining({ offset: 0, shown: 167, total: 167, next: null }),
      ]);
      expect(windowsOutputSchema.description).toMatch(/`slice` call[^.]*always/);
    });
  });

  /**
   * OpenAlex has no `openalex` filter on keywords — it answers 400 "openalex is not a valid
   * field" — while their `id` filter takes the keyword URL a search returns, `|`-joined.
   */
  describe('omitted-records continuation filter', () => {
    const keyword = (n: number): EntityRecord => ({
      id: `https://openalex.org/keywords/keyword-${n}`,
      display_name: `Keyword ${n}`,
      description: 'x'.repeat(8_000),
    });

    it('selects omitted keywords through the `id` filter', () => {
      const records = Array.from({ length: 10 }, (_, n) => keyword(n));
      const page = fitRecordsToBudget({
        records,
        entityType: 'keywords',
        path: 'list',
        select: undefined,
        measureFrame: constantFrame(1_000, 1_000),
      });

      const ids = records.slice(page.results.length).map((r) => r.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(page.disclosure.omitted).toEqual({
        ids,
        next: {
          tool: 'openalex_search_entities',
          arguments: {
            entity_type: 'keywords',
            filters: { id: ids.join('|') },
            per_page: ids.length,
          },
        },
      });
    });

    it('names the `id` filter on both surfaces of a cut keywords page', async () => {
      const records = Array.from({ length: 10 }, (_, n) => keyword(n));
      mockSearch.mockResolvedValue({
        meta: { count: 10, per_page: 10, next_cursor: null },
        results: records,
      });

      const result = await runToolContract(searchEntitiesTool, {
        entity_type: 'keywords',
        query: 'keyword',
        per_page: 10,
      });

      const structured = result.structuredContent as {
        omitted?: { ids: string[]; next: { arguments: { filters?: Record<string, string> } } };
      };
      const filters = structured.omitted?.next.arguments.filters;
      expect(filters).toEqual({ id: structured.omitted?.ids.join('|') });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain(`"filters":{"id":"${filters?.id}"}`);
    });

    it('discloses that the continuation returns the records in OpenAlex order, not page order', () => {
      const described = JSON.stringify(z.toJSONSchema(omittedOutputSchema.unwrap()));
      expect(described).toMatch(/OpenAlex's order, not page order/);
    });

    it('keeps the `openalex` filter for every other entity type', () => {
      const records = Array.from({ length: 10 }, (_, n) => ({
        ...keyword(n),
        id: `https://openalex.org/A${n + 1}`,
      }));
      const page = fitRecordsToBudget({
        records,
        entityType: 'authors',
        path: 'list',
        select: undefined,
        measureFrame: constantFrame(1_000, 1_000),
      });

      expect(page.disclosure.omitted?.next.arguments.filters).toEqual({
        openalex: page.disclosure.omitted?.ids.join('|'),
      });
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
});
