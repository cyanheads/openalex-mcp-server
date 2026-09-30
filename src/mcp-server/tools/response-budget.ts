/**
 * @fileoverview Response-size budget for the tools that return OpenAlex entity records
 * (`openalex_search_entities`, `openalex_get_citation_graph`). Holds each surface — serialized
 * `structuredContent` and the summed `content[]` text, enrichment trailer included — to
 * 64,000 bytes: a list page loses whole records from its end, a record too large on its own has
 * its biggest arrays windowed, and every cut is disclosed with the call that continues it. The
 * same pass flags list records carrying exactly 100 authorships, OpenAlex's list-response cap.
 * @module mcp-server/tools/response-budget
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  type ArrayWindowView,
  renderEntityRecord,
} from '@/mcp-server/tools/render-entity-record.js';
import type { EntityRecord, EntityType } from '@/services/openalex/types.js';

/** Per-surface ceiling: serialized `structuredContent`, and summed `content[]` text. */
export const RESPONSE_BUDGET_BYTES = 64_000;

/**
 * The most authorships OpenAlex returns on a record in a list response; the record's `id`
 * lookup returns them all. Exactly this many on a list record may or may not be the whole list.
 */
const LIST_AUTHORSHIPS_CAP = 100;

/**
 * Bytes reserved on each surface for the `budget` enrichment field. The service writes it from
 * OpenAlex's rate-limit headers through `ctx.enrich`, so its value is not in the handler's hands
 * when the page is measured. The allowance covers its widest realistic form — every number at
 * full double precision, with a prepaid balance — measured at 176 bytes as a JSON member and 108
 * as a trailer line with its separator.
 */
export const BUDGET_FIELD_ALLOWANCE_BYTES = 256;

const BUDGET_LABEL = `${RESPONSE_BUDGET_BYTES.toLocaleString('en-US')}-byte`;
const CONTINUATION_TOOL = 'openalex_search_entities';
const OPENALEX_ID_PREFIX = 'https://openalex.org/';
const NATIVE_OPENALEX_ID = /^[A-Z]\d+$/;

/**
 * The call that continues a cut, shared by `omitted.next` and every `windows[].next`. Its
 * arguments are data to pass back unchanged, so the schema leaves them loosely typed rather than
 * spelling out the search tool's input a second time.
 */
const continuationCallSchema = z.object({
  tool: z.literal(CONTINUATION_TOOL).describe('Tool to call.'),
  arguments: z.object({}).loose().describe('Arguments to pass as-is.'),
});

const arrayWindowSchema = z
  .object({
    id: z.string().describe('Bare ID of the record.'),
    field: z.string().describe('Array field.'),
    offset: z.number().describe('Index of the first element shown.'),
    shown: z.number().describe('Elements shown.'),
    total: z.number().describe('Array length as returned to this call.'),
    possibly_capped: z
      .boolean()
      .describe(
        "True for exactly 100 authorships on a list record (OpenAlex's cap): the list may be longer.",
      ),
    next: continuationCallSchema
      .nullable()
      .describe('`id` + `slice` call for the next elements; null at the array end.'),
  })
  .describe('An array returned in part.');

/** Output field: whole records the budget cut from a list page, and the call returning them. */
export const omittedOutputSchema = z
  .object({
    ids: z
      .array(z.string())
      .describe('Bare IDs of the records left out, in page order (a keyword keeps its URL).'),
    next: continuationCallSchema.describe(
      "One call returning those records as a set, in OpenAlex's order, not page order. Budgeted too, so it may carry its own `omitted`.",
    ),
  })
  .optional()
  .describe(
    'Present when the response budget cut whole records from the page end; pagination continues after the full upstream page.',
  );

/** Output field: arrays returned in part, or possibly in part, each with its continuation. */
export const windowsOutputSchema = z
  .array(arrayWindowSchema)
  .optional()
  .describe(
    'Arrays returned in part — windowed to fit the budget, paged by `slice`, or 100 possibly capped authorships — each with its continuation. A `slice` call always carries its window, even for a whole array; otherwise absent when every array is whole.',
  );

/** Output field: the least this call can return does not fit the budget on its own. */
export const overBudgetOutputSchema = z
  .boolean()
  .optional()
  .describe(
    "True when even the least this call can return — the first record's non-array fields (its arrays windowed to empty), or one `slice` element — exceeds the budget.",
  );

type ContinuationCall = z.infer<typeof continuationCallSchema>;
type ArrayWindow = z.infer<typeof arrayWindowSchema>;
type Omitted = NonNullable<z.infer<typeof omittedOutputSchema>>;

/** The disclosure fields a budgeted page carries, each present only when it has something to say. */
export interface BudgetDisclosure {
  omitted?: Omitted | undefined;
  over_budget?: boolean | undefined;
  windows?: ArrayWindow[] | undefined;
}

/** A record page as both tools return it: upstream meta, records, and budget disclosure. */
export interface RecordPage extends BudgetDisclosure {
  meta: { count: number; next_cursor: string | null; per_page: number };
  results: readonly EntityRecord[];
}

export interface BudgetedPage {
  disclosure: BudgetDisclosure;
  /** Sentences for the tool's `notice`; undefined when nothing was cut, windowed, or flagged. */
  notice: string | undefined;
  results: EntityRecord[];
}

export interface SurfaceBytes {
  structured: number;
  text: number;
}

/**
 * Bytes of both surfaces for the page with no records in it, given the disclosure and the
 * budget sentences it would carry. The tool supplies it, since only the tool knows its own
 * header, notices, and enrichment.
 */
export type FrameMeasure = (
  disclosure: BudgetDisclosure,
  budgetNotice: string | undefined,
) => SurfaceBytes;

/** Enrichment the handler writes, which the framework renders into the `content[]` trailer. */
export interface PageEnrichment {
  echo: string;
  notice: string | undefined;
  totalCount: number;
  /** The tool's `enrichmentTrailer.totalCount.label`. */
  totalLabel: string;
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** `https://openalex.org/W123` → `W123`. Any other form (a keyword URL) passes through whole. */
export function bareId(id: string): string {
  const tail = id.startsWith(OPENALEX_ID_PREFIX) ? id.slice(OPENALEX_ID_PREFIX.length) : id;
  return NATIVE_OPENALEX_ID.test(tail) ? tail : id;
}

/** Join notice sentences, dropping empty ones; undefined when none remain. */
export function joinNotices(parts: readonly (string | undefined)[]): string | undefined {
  return parts.filter(Boolean).join(' ') || undefined;
}

// ---------------------------------------------------------------------------
// Rendering — shared by both tools' format() and by the budget's own measurement
// ---------------------------------------------------------------------------

const renderCall = (call: ContinuationCall): string =>
  `\`${call.tool}\` \`${JSON.stringify(call.arguments)}\``;

function renderWindow(window: ArrayWindow): string {
  const capped = window.possibly_capped
    ? ` — possibly capped: OpenAlex returns at most ${LIST_AUTHORSHIPS_CAP} authorships on a list record`
    : '';
  const next = window.next ? `next: ${renderCall(window.next)}` : 'end of array';
  return `**Window:** ${window.id} \`${window.field}\` — offset ${window.offset}, ${window.shown} shown of ${window.total}${capped} — ${next}`;
}

/** Markdown lines disclosing what the budget cut; empty when the page carries no disclosure. */
function renderBudgetDisclosure(disclosure: BudgetDisclosure): string[] {
  const lines: string[] = [];
  if (disclosure.over_budget) {
    lines.push(
      '',
      `**Over budget:** the least this call can return — the first record's non-array fields, or one \`slice\` element — exceeds the ${BUDGET_LABEL} response budget on its own.`,
    );
  }
  if (disclosure.windows?.length) lines.push('', ...disclosure.windows.map(renderWindow));
  if (disclosure.omitted) {
    const { ids, next } = disclosure.omitted;
    lines.push(
      '',
      `**Omitted by the ${BUDGET_LABEL} response budget (${ids.length}):** ${ids.join(', ')}`,
      `**Omitted records call:** ${renderCall(next)}`,
    );
  }
  return lines;
}

/**
 * Each windowed array's place in its full array, per record ID, so a window numbers its items
 * at their real index and its line says how much of the array it shows.
 */
function windowViewsByRecord(
  windows: readonly ArrayWindow[] | undefined,
): Map<string, Map<string, ArrayWindowView>> {
  const views = new Map<string, Map<string, ArrayWindowView>>();
  for (const window of windows ?? []) {
    const fields = views.get(window.id) ?? new Map<string, ArrayWindowView>();
    fields.set(window.field, { offset: window.offset, total: window.total });
    views.set(window.id, fields);
  }
  return views;
}

/**
 * `format()` for a record page: a count header, each record, then the budget disclosure.
 * `noun` names what `meta.count` counts ("result(s)", "edge(s)").
 */
export function formatRecordPage(page: RecordPage, noun: string): { type: 'text'; text: string }[] {
  const countLabel = `${page.meta.count} ${noun} — ${page.meta.per_page} per page`;
  const lines = [
    page.meta.next_cursor
      ? `**${countLabel}** — next cursor: \`${page.meta.next_cursor}\``
      : `**${countLabel}**`,
  ];
  const views = windowViewsByRecord(page.windows);
  for (const record of page.results) {
    lines.push(...renderEntityRecord(record, views.get(bareId(record.id))));
  }
  lines.push(...renderBudgetDisclosure(page));
  return [{ type: 'text', text: lines.join('\n') }];
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Byte-exact copy of the framework's trailer join (`joinTrailerFields` in mcp-ts-core's tool
 * handler factory, which the package does not export — cyanheads/mcp-ts-core#538). A line opening
 * a block quote or list item is followed by a blank line instead of a single newline. The
 * response-budget test compares the modelled trailer with the one `runToolContract` renders.
 */
const OPENS_LAZY_CONTAINER = /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?: |$))/;

function joinTrailerFields(fields: readonly string[]): string {
  let text = '';
  for (const field of fields) {
    if (text.length > 0) {
      text += OPENS_LAZY_CONTAINER.test(text.slice(text.lastIndexOf('\n') + 1)) ? '\n\n' : '\n';
    }
    text += field;
  }
  return text;
}

/**
 * The enrichment trailer's bytes, minus the service-written `budget` line. Fields render as the
 * framework renders them for these tools: `echo` under its `Query` label, `totalCount` under
 * `totalLabel`, and `notice` as a block quote, joined after a leading blank line.
 */
export function trailerTextBytes(enrichment: PageEnrichment): number {
  const fields = [
    `**Query:** ${enrichment.echo}`,
    `**${enrichment.totalLabel}:** ${enrichment.totalCount}`,
    ...(enrichment.notice === undefined ? [] : [`> ${enrichment.notice}`]),
  ];
  return utf8Bytes(`\n\n${joinTrailerFields(fields)}`);
}

/**
 * Both surfaces' bytes for a page frame — the page with no records — plus the enrichment the
 * handler writes and the allowance for the service's `budget` field.
 */
export function measurePageFrame(
  frame: RecordPage,
  noun: string,
  enrichment: PageEnrichment,
): SurfaceBytes {
  const { echo, notice, totalCount } = enrichment;
  const structured = utf8Bytes(
    JSON.stringify({ ...frame, echo, totalCount, ...(notice !== undefined && { notice }) }),
  );
  const text = formatRecordPage(frame, noun).reduce((sum, block) => sum + utf8Bytes(block.text), 0);
  return {
    structured: structured + BUDGET_FIELD_ALLOWANCE_BYTES,
    text: text + trailerTextBytes(enrichment) + BUDGET_FIELD_ALLOWANCE_BYTES,
  };
}

/**
 * What one record adds to the busier surface: its JSON array member or its rendered lines,
 * each plus the one separator byte (comma, newline) joining it to its neighbour. Rendered with
 * the renderer `format()` uses, with the window views `format()` will pass.
 */
function recordCharge(record: EntityRecord, views?: ReadonlyMap<string, ArrayWindowView>): number {
  const json = utf8Bytes(JSON.stringify(record));
  const text = utf8Bytes(renderEntityRecord(record, views).join('\n'));
  return Math.max(json, text) + 1;
}

const frameBytes = (bytes: SurfaceBytes): number => Math.max(bytes.structured, bytes.text);

/**
 * Largest n in [0, limit] with `fits(n)`, given `fits(0)` holds and `fits` stays false once
 * it turns false. Gallops up from 0 before bisecting, so each probe renders about as many
 * elements as the answer holds rather than half the array.
 */
function largestFitting(limit: number, fits: (n: number) => boolean): number {
  let low = 0;
  let high = 1;
  while (high <= limit && fits(high)) {
    low = high;
    high *= 2;
  }
  high = Math.min(high, limit + 1);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return low;
}

// ---------------------------------------------------------------------------
// Disclosure construction
// ---------------------------------------------------------------------------

function arrayWindow(
  entityType: EntityType,
  record: EntityRecord,
  field: string,
  view: { offset: number; shown: number; total: number; possiblyCapped: boolean },
): ArrayWindow {
  const id = bareId(record.id);
  const end = Math.min(view.offset, view.total) + view.shown;
  return {
    id,
    field,
    offset: view.offset,
    shown: view.shown,
    total: view.total,
    possibly_capped: view.possiblyCapped,
    next:
      end < view.total || view.possiblyCapped
        ? {
            tool: CONTINUATION_TOOL,
            arguments: { entity_type: entityType, id, slice: { field, offset: end } },
          }
        : null,
  };
}

function isCappedListRecord(record: EntityRecord, capCheck: boolean): boolean {
  return (
    capCheck &&
    Array.isArray(record.authorships) &&
    record.authorships.length === LIST_AUTHORSHIPS_CAP
  );
}

function capWindow(entityType: EntityType, record: EntityRecord): ArrayWindow {
  return arrayWindow(entityType, record, 'authorships', {
    offset: 0,
    shown: LIST_AUTHORSHIPS_CAP,
    total: LIST_AUTHORSHIPS_CAP,
    possiblyCapped: true,
  });
}

interface PageParts {
  cappedCount: number;
  kept: readonly EntityRecord[];
  omitted: readonly EntityRecord[];
  overBudget: boolean;
  windowedCount: number;
  windows: readonly ArrayWindow[];
}

function budgetNotice(parts: PageParts): string | undefined {
  const { cappedCount, kept, omitted, overBudget, windowedCount } = parts;
  return joinNotices([
    omitted.length > 0
      ? `The ${BUDGET_LABEL} response budget held ${kept.length} of ${kept.length + omitted.length} records; \`omitted\` names the other ${omitted.length} and the openalex_search_entities call that returns them.`
      : undefined,
    windowedCount > 0
      ? `${windowedCount} array field(s) were windowed to fit the budget; each \`windows\` entry gives the \`id\` + \`slice\` call that continues it.`
      : undefined,
    overBudget
      ? "The first record's non-array fields alone exceed the budget, so this response runs over it."
      : undefined,
    cappedCount > 0
      ? `${cappedCount} record(s) carry exactly ${LIST_AUTHORSHIPS_CAP} authorships, the most OpenAlex returns on a list record, so the author list may be longer; the \`windows\` entry gives the \`id\` + \`slice\` call for the rest.`
      : undefined,
  ]);
}

function assemblePage(
  parts: PageParts,
  entityType: EntityType,
  select: readonly string[] | undefined,
): BudgetedPage {
  const disclosure: BudgetDisclosure = {};
  if (parts.omitted.length > 0) {
    const ids = parts.omitted.map((record) => bareId(record.id));
    // Keywords have no `openalex` filter upstream (400); their `id` filter takes the keyword URLs.
    const idFilter = entityType === 'keywords' ? 'id' : 'openalex';
    disclosure.omitted = {
      ids,
      next: {
        tool: CONTINUATION_TOOL,
        arguments: {
          entity_type: entityType,
          filters: { [idFilter]: ids.join('|') },
          per_page: ids.length,
          ...(select !== undefined && { select: [...select] }),
        },
      },
    };
  }
  if (parts.windows.length > 0) disclosure.windows = [...parts.windows];
  if (parts.overBudget) disclosure.over_budget = true;
  return { results: [...parts.kept], disclosure, notice: budgetNotice(parts) };
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export interface FitRecordsRequest {
  entityType: EntityType;
  measureFrame: FrameMeasure;
  /**
   * `list` pages cut whole records and check the authorship cap; a `lookup` holds one record,
   * which OpenAlex returns uncapped, so it can only be windowed.
   */
  path: 'list' | 'lookup';
  records: readonly EntityRecord[];
  /** The caller's `select`, repeated in the omitted-records call. */
  select: readonly string[] | undefined;
}

/**
 * Fit a page of records to the budget. Keeps the longest prefix whose records, charged
 * `max(JSON bytes, rendered bytes)` each, fit beside the page frame; the rest become `omitted`.
 * When even the first record does not fit alone, its largest arrays are windowed instead.
 * Returns new arrays and, for a windowed record, a new record — never the caller's objects
 * mutated.
 */
export function fitRecordsToBudget(request: FitRecordsRequest): BudgetedPage {
  const { entityType, measureFrame, path, records, select } = request;
  const capCheck = path === 'list' && entityType === 'works';
  const charges = records.map((record) => recordCharge(record));
  let recordBytes = charges.reduce((sum, charge) => sum + charge, 0);

  for (let kept = records.length; kept >= 1; kept--) {
    const keptRecords = records.slice(0, kept);
    const capped = keptRecords.filter((record) => isCappedListRecord(record, capCheck));
    const page = assemblePage(
      {
        kept: keptRecords,
        omitted: records.slice(kept),
        windows: capped.map((record) => capWindow(entityType, record)),
        windowedCount: 0,
        cappedCount: capped.length,
        overBudget: false,
      },
      entityType,
      select,
    );
    if (
      frameBytes(measureFrame(page.disclosure, page.notice)) + recordBytes <=
      RESPONSE_BUDGET_BYTES
    ) {
      return page;
    }
    recordBytes -= charges[kept - 1] ?? 0;
  }

  const [first, ...rest] = records;
  if (!first) return { results: [], disclosure: {}, notice: undefined };
  return windowRecord(first, rest, isCappedListRecord(first, capCheck), request);
}

interface WindowableArray {
  bytes: number;
  field: string;
  items: readonly unknown[];
}

/**
 * Fill windowed arrays round-robin: each array in turn takes its next leading element while it
 * fits, so every array shows elements for as long as any of its elements would fit. A record's
 * charge only grows as elements are added, so an array whose next element does not fit never
 * fits again and drops out. Whole rounds are found by bisection and the round that ends a run
 * is played one array at a time, so the result is exactly the one-element-at-a-time fill at a
 * cost of a few renders per array. Returns the count shown per field.
 */
function fillRoundRobin(
  base: EntityRecord,
  arrays: readonly WindowableArray[],
  fits: (record: EntityRecord) => boolean,
): Map<string, number> {
  const counts = new Map(arrays.map((array) => [array.field, 0]));
  const shownOf = (array: WindowableArray) => counts.get(array.field) ?? 0;
  const build = (extra: (array: WindowableArray) => number): EntityRecord => {
    const record: EntityRecord = { ...base };
    for (const array of arrays) {
      record[array.field] = array.items.slice(0, shownOf(array) + extra(array));
    }
    return record;
  };

  let active = [...arrays];
  while (active.length > 0) {
    const inPlay = new Set(active);
    const raise = (rounds: number) => (array: WindowableArray) =>
      inPlay.has(array) ? Math.min(rounds, array.items.length - shownOf(array)) : 0;
    const headroom = Math.max(...active.map((array) => array.items.length - shownOf(array)));
    const rounds = largestFitting(headroom, (n) => fits(build(raise(n))));
    for (const array of active) counts.set(array.field, shownOf(array) + raise(rounds)(array));

    active = active.filter((array) => {
      if (shownOf(array) >= array.items.length) return false;
      const grown = build((other) => (other === array ? 1 : 0));
      if (!fits(grown)) return false;
      counts.set(array.field, shownOf(array) + 1);
      return true;
    });
  }
  return counts;
}

/**
 * Window the arrays of a record too large to fit whole. Tries windowing the largest array
 * alone, then the two largest, and so on, until the record with those arrays emptied fits;
 * then fills the windowed arrays round-robin. The disclosure is sized at its upper bound while
 * fitting — every count at its array length — so the final, smaller disclosure can only fit too.
 */
function windowRecord(
  record: EntityRecord,
  rest: readonly EntityRecord[],
  capped: boolean,
  request: FitRecordsRequest,
): BudgetedPage {
  const { entityType, measureFrame, select } = request;
  const arrays: WindowableArray[] = Object.entries(record)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0)
    .map(([field, items]) => ({ field, items, bytes: utf8Bytes(JSON.stringify(items)) }))
    .sort((a, b) => b.bytes - a.bytes);

  /** Window entries for `shown` counts per windowed field, plus the cap entry when it applies. */
  const windowsFor = (shown: ReadonlyMap<string, number>): ArrayWindow[] => {
    const entries: ArrayWindow[] = [];
    for (const [field, items] of Object.entries(record)) {
      if (!Array.isArray(items)) continue;
      const count = shown.get(field);
      const cappedField = capped && field === 'authorships';
      if (count !== undefined && count < items.length) {
        entries.push(
          arrayWindow(entityType, record, field, {
            offset: 0,
            shown: count,
            total: items.length,
            possiblyCapped: cappedField,
          }),
        );
      } else if (cappedField) {
        entries.push(capWindow(entityType, record));
      }
    }
    return entries;
  };

  const partsFor = (
    kept: EntityRecord,
    windows: ArrayWindow[],
    overBudget: boolean,
  ): PageParts => ({
    kept: [kept],
    omitted: rest,
    windows,
    windowedCount: windows.filter((w) => w.shown < w.total).length,
    cappedCount: capped ? 1 : 0,
    overBudget,
  });

  for (let count = 1; count <= arrays.length; count++) {
    const windowed = arrays.slice(0, count);
    // Upper bound: every windowed count at its full length, each still continuing.
    const bound = windowed.map((array) =>
      arrayWindow(entityType, record, array.field, {
        offset: 0,
        shown: array.items.length,
        total: array.items.length + 1,
        possiblyCapped: capped && array.field === 'authorships',
      }),
    );
    const boundWindows = [
      ...bound,
      ...(capped && !windowed.some((a) => a.field === 'authorships')
        ? [capWindow(entityType, record)]
        : []),
    ];
    const boundPage = assemblePage(partsFor(record, boundWindows, false), entityType, select);
    const available =
      RESPONSE_BUDGET_BYTES - frameBytes(measureFrame(boundPage.disclosure, boundPage.notice));

    // Charged with the views `format()` passes, so each window's note is paid for.
    const views = new Map(
      windowed.map((array) => [array.field, { offset: 0, total: array.items.length }]),
    );
    const fits = (candidate: EntityRecord) => recordCharge(candidate, views) <= available;
    const emptied: EntityRecord = { ...record };
    for (const array of windowed) emptied[array.field] = [];
    if (!fits(emptied)) continue;

    const shown = fillRoundRobin(record, windowed, fits);
    const kept: EntityRecord = { ...record };
    for (const array of windowed) {
      kept[array.field] = array.items.slice(0, shown.get(array.field));
    }
    return assemblePage(partsFor(kept, windowsFor(shown), false), entityType, select);
  }

  // The record's non-array fields alone exceed the budget: return them whole, arrays empty.
  const emptied: EntityRecord = { ...record };
  for (const array of arrays) emptied[array.field] = [];
  const shown = new Map(arrays.map((array) => [array.field, 0]));
  return assemblePage(partsFor(emptied, windowsFor(shown), true), entityType, select);
}

export interface FitSliceRequest {
  entityType: EntityType;
  /** Record key of the array to page (a `select` alias already resolved); must hold an array. */
  field: string;
  measureFrame: FrameMeasure;
  /** Requested start index; past the end yields an empty, final window. */
  offset: number;
  /** The record from a one-field projection: `id`, `display_name`, and `field`. */
  record: EntityRecord;
}

/**
 * Fit one array window of an `id` lookup to the budget: the elements of `field` from `offset`,
 * as many as fit. A window holds at least one element whenever any remain, so a caller walking
 * the array always advances; when that one element alone does not fit, the response runs over
 * the budget and is flagged `over_budget`.
 */
export function fitSliceToBudget(request: FitSliceRequest): BudgetedPage {
  const { entityType, field, measureFrame, offset, record } = request;
  const items = record[field] as unknown[];
  const total = items.length;
  const start = Math.min(offset, total);
  const remaining = total - start;
  const views = new Map([[field, { offset, total }]]);
  const view = (shown: number) => ({ offset, shown, total, possiblyCapped: false });

  // Upper bound: the whole remainder shown, with a continuation call.
  const bound = arrayWindow(entityType, record, field, { ...view(remaining), total: total + 1 });
  const available =
    RESPONSE_BUDGET_BYTES - frameBytes(measureFrame({ windows: [bound] }, undefined));
  const fitted = largestFitting(
    remaining,
    (n) => recordCharge({ ...record, [field]: items.slice(start, start + n) }, views) <= available,
  );
  const overBudget = remaining > 0 && fitted === 0;
  const shown = overBudget ? 1 : fitted;

  return {
    results: [{ ...record, [field]: items.slice(start, start + shown) }],
    disclosure: {
      windows: [arrayWindow(entityType, record, field, view(shown))],
      ...(overBudget && { over_budget: true }),
    },
    notice: overBudget
      ? `The element at offset ${start} of \`${field}\` alone exceeds the ${BUDGET_LABEL} response budget, so this response runs over it; ${start + 1 < total ? "the `windows` entry's `next` call continues after it" : 'it is the last element'}.`
      : undefined,
  };
}
