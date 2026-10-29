/**
 * @fileoverview Record pages for the tools that return OpenAlex entity records
 * (`openalex_search_entities`, `openalex_get_citation_graph`). A page holds every record of the
 * upstream page, and an `id` lookup every selected array whole. `windows` discloses OpenAlex's
 * author caps — 100 authorships on a list record, 5,000 stored on a singleton — and every
 * count-based `slice` window, each with the call that continues it. A response whose
 * `structuredContent` or `content[]` text would exceed 8,000,000 bytes is refused, never
 * shortened, so both surfaces and the JSON-RPC envelope stay under the 16 MiB an HTTP client
 * such as Claude Code reads from one response.
 * @module mcp-server/tools/record-page
 */

import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdown } from '@/mcp-server/tools/escape-markdown.js';
import {
  type ArrayWindowView,
  renderEntityRecord,
} from '@/mcp-server/tools/render-entity-record.js';
import type { EntityRecord, EntityType } from '@/services/openalex/types.js';

/** Per-surface ceiling: serialized `structuredContent`, and summed `content[]` text. */
export const RESPONSE_CEILING_BYTES = 8_000_000;
const CEILING_LABEL = `${RESPONSE_CEILING_BYTES.toLocaleString('en-US')}-byte`;

/**
 * The most authorships OpenAlex returns on a list record. An `id` lookup can return more,
 * up to the separate storage ceiling.
 */
const LIST_AUTHORSHIPS_CAP = 100;
const STORED_AUTHORSHIPS_CAP = 5000;
const STORAGE_CAP_NOTICE =
  'OpenAlex stores at most 5,000 authorships per work in singleton records and snapshots; this author array may omit part of the byline. `total` counts stored entries, not the complete byline. Further OpenAlex fetches or snapshots cannot recover authors beyond this storage ceiling.';

/** Record arrays the cap applies to: `authorships`, and the `author_list` derived from it. */
const CAPPED_AUTHOR_FIELDS = ['authorships', 'author_list'] as const;

/**
 * Bytes reserved on each surface for the `budget` enrichment field (the OpenAlex usage budget,
 * not a size limit). The service writes it from OpenAlex's rate-limit headers through
 * `ctx.enrich`, so its value is not in the handler's hands when the response is measured. The
 * allowance covers its widest realistic form — every number at full double precision, with a
 * prepaid balance — measured at 176 bytes as a JSON member and 108 as a trailer line with its
 * separator.
 */
export const BUDGET_FIELD_ALLOWANCE_BYTES = 256;

const CONTINUATION_TOOL = 'openalex_search_entities';
const OPENALEX_ID_PREFIX = 'https://openalex.org/';
const NATIVE_OPENALEX_ID = /^[A-Z]\d+$/;

/**
 * The call that continues a window. Its arguments are data to pass back unchanged, so the
 * schema leaves them loosely typed rather than spelling out the search tool's input a second
 * time.
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
    total: z
      .number()
      .describe('Stored array length returned to this call, not a complete byline total.'),
    possibly_capped: z
      .boolean()
      .describe(
        'True for exactly 100 authorships or author_list entries on a list record, or 5,000 on a singleton lookup: the byline may be longer than the returned array.',
      ),
    next: continuationCallSchema
      .nullable()
      .describe('`id` + `slice` call for the next elements; null at the array end.'),
  })
  .describe('An array returned in part, or possibly in part.');

/** Output field: arrays returned in part, or possibly in part, each with its continuation. */
export const windowsOutputSchema = z
  .array(arrayWindowSchema)
  .optional()
  .describe(
    "Author arrays possibly capped at 100 on a list record or 5,000 stored on a singleton, and the window of every `slice` call — present even when the slice holds the whole array. A slice window's `next` repeats its `slice.limit` from the following offset; `next` is null at the stored-array end, including a possibly capped singleton.",
  );

type ContinuationCall = z.infer<typeof continuationCallSchema>;
type ArrayWindow = z.infer<typeof arrayWindowSchema>;

/** A record page as both tools return it: upstream meta, records, and any windows. */
export interface RecordPage {
  meta: { count: number; next_cursor: string | null; per_page: number };
  results: EntityRecord[];
  windows?: ArrayWindow[] | undefined;
}

/** Enrichment the handler writes, which the framework renders into the `content[]` trailer. */
export interface PageEnrichment {
  echo: string;
  notice: string | undefined;
  totalCount: number;
  /** The tool's `enrichmentTrailer.totalCount.label`. */
  totalLabel: string;
}

interface SurfaceBytes {
  structured: number;
  text: number;
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const count = (n: number): string => n.toLocaleString('en-US');

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
// Rendering — shared by both tools' format() and by the ceiling's measurement
// ---------------------------------------------------------------------------

/** A continuation call as code spans, which hold any backtick its arguments carry. */
const renderCall = (call: ContinuationCall): string =>
  `${codeSpan(call.tool)} ${codeSpan(JSON.stringify(call.arguments))}`;

function renderWindow(window: ArrayWindow): string {
  const capped = window.possibly_capped
    ? window.total >= STORED_AUTHORSHIPS_CAP
      ? ' — possibly capped: OpenAlex stores at most 5,000 authorships per work; total counts stored entries, not the complete byline'
      : ` — possibly capped: OpenAlex returns at most ${LIST_AUTHORSHIPS_CAP} authorships on a list record`
    : '';
  const next = window.next ? `next: ${renderCall(window.next)}` : 'end of array';
  return `**Window:** ${escapeMarkdown(window.id)} ${codeSpan(window.field)} — offset ${window.offset}, ${window.shown} shown of ${window.total}${capped} — ${next}`;
}

/**
 * Each windowed array's place in its full array, per record ID, so a slice numbers its items
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
 * `format()` for a record page: a count header, each record, then each window.
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
  if (page.windows?.length) lines.push('', ...page.windows.map(renderWindow));
  return [{ type: 'text', text: lines.join('\n') }];
}

// ---------------------------------------------------------------------------
// Measurement — both surfaces as the framework emits them
// ---------------------------------------------------------------------------

/**
 * Byte-exact copy of the framework's trailer join (`joinTrailerFields` in mcp-ts-core's tool
 * handler factory, which the package does not export — cyanheads/mcp-ts-core#538). A line opening
 * a block quote or list item is followed by a blank line instead of a single newline. The
 * record-page test compares the modelled trailer with the one `runToolContract` renders.
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
 * Byte-exact copy of the framework's inline code span (`codeSpan` in mcp-ts-core's formatting
 * utils, which the package does not export), the form a one-line trailer string takes: the
 * fence runs one backtick past the value's longest backtick run, and a space pads each side when
 * a backtick touches an end or the value both begins and ends with a space. The echo is always
 * one line — caller text in it is JSON-encoded — so the fenced-block form never applies here.
 * Authored code spans around one-line values use it too, so a backtick in the value cannot close
 * the span early.
 */
export function codeSpan(value: string): string {
  let longestRun = 0;
  for (const [run] of value.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(longestRun + 1);
  const pad =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value))
      ? ' '
      : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * The enrichment trailer's bytes, minus the service-written `budget` line. Fields render as the
 * framework renders them for these tools: `echo` as a code span under its `Query` label,
 * `totalCount` under `totalLabel`, and `notice` as a block quote with every line quoted, joined
 * after a leading blank line.
 */
export function trailerTextBytes(enrichment: PageEnrichment): number {
  const fields = [
    `**Query:** ${codeSpan(enrichment.echo)}`,
    `**${enrichment.totalLabel}:** ${enrichment.totalCount}`,
    ...(enrichment.notice === undefined
      ? []
      : [
          enrichment.notice
            .split(/\r\n|\r|\n/)
            .map((line) => (line === '' ? '>' : `> ${line}`))
            .join('\n'),
        ]),
  ];
  return utf8Bytes(`\n\n${joinTrailerFields(fields)}`);
}

/**
 * Both surfaces' bytes for a page as the client receives it: `structuredContent` with the
 * enrichment the handler writes, `content[]` with the trailer the framework renders, and on
 * each the allowance for the service's `budget` field.
 */
function measurePage(page: RecordPage, noun: string, enrichment: PageEnrichment): SurfaceBytes {
  const { echo, notice, totalCount } = enrichment;
  const structured = utf8Bytes(
    JSON.stringify({ ...page, echo, totalCount, ...(notice !== undefined && { notice }) }),
  );
  const text = formatRecordPage(page, noun).reduce((sum, block) => sum + utf8Bytes(block.text), 0);
  return {
    structured: structured + BUDGET_FIELD_ALLOWANCE_BYTES,
    text: text + trailerTextBytes(enrichment) + BUDGET_FIELD_ALLOWANCE_BYTES,
  };
}

const withinCeiling = (bytes: SurfaceBytes): boolean =>
  bytes.structured <= RESPONSE_CEILING_BYTES && bytes.text <= RESPONSE_CEILING_BYTES;

/**
 * Largest n in [0, limit] with `fits(n)`, given `fits(0)` holds and `fits` stays false once
 * it turns false. Gallops up from 0 before bisecting, so each probe measures about as many
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
// Windows
// ---------------------------------------------------------------------------

interface WindowView {
  /** The `slice.limit` the continuation repeats; absent on a cap window. */
  limit?: number;
  offset: number;
  possiblyCapped: boolean;
  /** A list cap: more stored entries may follow on the singleton, so `next` stays open. */
  recoverable?: boolean;
  shown: number;
  total: number;
}

function arrayWindow(
  entityType: EntityType,
  record: EntityRecord,
  field: string,
  view: WindowView,
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
      end < view.total || view.recoverable
        ? {
            tool: CONTINUATION_TOOL,
            arguments: {
              entity_type: entityType,
              id,
              slice: { field, offset: end, ...(view.limit !== undefined && { limit: view.limit }) },
            },
          }
        : null,
  };
}

/** Author arrays holding exactly the cap for this request path. */
function cappedAuthorFields(record: EntityRecord, cap: number | undefined): string[] {
  if (cap === undefined) return [];
  return CAPPED_AUTHOR_FIELDS.filter((field) => {
    const items = record[field];
    return Array.isArray(items) && items.length === cap;
  });
}

function capWindow(entityType: EntityType, record: EntityRecord, field: string): ArrayWindow {
  const total = (record[field] as unknown[]).length;
  return arrayWindow(entityType, record, field, {
    offset: 0,
    shown: total,
    total,
    possiblyCapped: true,
    recoverable: total === LIST_AUTHORSHIPS_CAP,
  });
}

function capNotice(listCapped: number, windows: readonly ArrayWindow[]): string | undefined {
  return joinNotices([
    listCapped > 0
      ? `${listCapped} record(s) carry exactly ${LIST_AUTHORSHIPS_CAP} authorships or author_list entries, the most OpenAlex returns on a list record, so the author list may be longer; each such array's \`windows\` entry gives the \`id\` + \`slice\` call for more stored authors, up to the singleton storage ceiling of 5,000.`
      : undefined,
    windows.some((window) => window.possibly_capped && window.total >= STORED_AUTHORSHIPS_CAP)
      ? STORAGE_CAP_NOTICE
      : undefined,
  ]);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** What a record page is built from, besides its records. */
interface PageContext {
  echo: string;
  entityType: EntityType;
  meta: RecordPage['meta'];
  /** The tool's own notice sentences, joined ahead of the page's. */
  notices: readonly (string | undefined)[];
  /** What `meta.count` counts in the rendered header ("result(s)", "edge(s)"). */
  noun: string;
  totalCount: number;
  /** The tool's `enrichmentTrailer.totalCount.label`. */
  totalLabel: string;
}

/** A page within the ceiling, or the typed refusal of one that is not. */
export type PageOutcome =
  | { kind: 'page'; page: RecordPage; notice: string | undefined }
  | { kind: 'too_large'; message: string; data: TooLargeData };

/** `data` for a `response_too_large` failure. */
export interface TooLargeData {
  ceilingBytes: number;
  /** The largest value of the named input whose response fits; absent when none does. */
  largestFitting?: { input: 'per_page' | 'slice.limit'; value: number };
  recovery: { hint: string };
  structuredBytes: number;
  textBytes: number;
  [key: string]: unknown;
}

function tooLarge(
  subject: string,
  bytes: SurfaceBytes,
  hint: string,
  largest?: TooLargeData['largestFitting'],
): PageOutcome {
  return {
    kind: 'too_large',
    message: `${subject} would return ${count(bytes.structured)} bytes of structuredContent and ${count(bytes.text)} bytes of content[] text, over the ${CEILING_LABEL} response ceiling.`,
    data: {
      structuredBytes: bytes.structured,
      textBytes: bytes.text,
      ceilingBytes: RESPONSE_CEILING_BYTES,
      ...(largest && { largestFitting: largest }),
      recovery: { hint },
    },
  };
}

export interface RecordPageRequest extends PageContext {
  /**
   * How the listing continues past this page, for the hint naming a smaller `per_page`: a
   * `cursor`, or the next `page` of a semantic search or a sample.
   */
  continuation: 'cursor' | 'page';
  /** The 1-based `page` of a listing that continues by `page`, whose boundaries move with per_page. */
  page?: number;
  /**
   * `list` checks the 100-author list cap; a `lookup` holds one record and checks the
   * 5,000-author storage cap.
   */
  path: 'list' | 'lookup';
  records: readonly EntityRecord[];
}

/**
 * Every record of the upstream page, with the windows that disclose OpenAlex's author caps —
 * or, when that response would run over the ceiling on either surface, its refusal naming the
 * largest page that fits. Returns new arrays, never the caller's mutated.
 */
export function buildRecordPage(request: RecordPageRequest): PageOutcome {
  const { continuation, entityType, meta, noun, path, records } = request;
  const cap =
    entityType === 'works'
      ? path === 'list'
        ? LIST_AUTHORSHIPS_CAP
        : STORED_AUTHORSHIPS_CAP
      : undefined;

  const pageFor = (kept: number): { page: RecordPage; notice: string | undefined } => {
    const results = records.slice(0, kept);
    const capped = results
      .map((record) => ({ record, fields: cappedAuthorFields(record, cap) }))
      .filter(({ fields }) => fields.length > 0);
    const windows = capped.flatMap(({ record, fields }) =>
      fields.map((field) => capWindow(entityType, record, field)),
    );
    return {
      page: { meta, results, ...(windows.length > 0 && { windows }) },
      notice: joinNotices([
        ...request.notices,
        capNotice(path === 'list' ? capped.length : 0, windows),
      ]),
    };
  };

  /**
   * Each record's bytes on each surface plus the separator joining it to its neighbour: a comma
   * in `results`, a newline in the rendered text. `format()` renders a page record with no
   * window note — a cap window shows its whole array — so the bare render is the one it emits.
   */
  const sizes = records.map((record) => ({
    structured: utf8Bytes(JSON.stringify(record)) + 1,
    text: utf8Bytes(renderEntityRecord(record).join('\n')) + 1,
  }));
  const bytesFor = (kept: number): SurfaceBytes => {
    const { page, notice } = pageFor(kept);
    const frame = measurePage({ ...page, results: [] }, noun, { ...request, notice });
    // `kept` records carry `kept - 1` commas, not `kept`.
    const bytes = { structured: frame.structured - (kept > 0 ? 1 : 0), text: frame.text };
    for (const size of sizes.slice(0, kept)) {
      bytes.structured += size.structured;
      bytes.text += size.text;
    }
    return bytes;
  };

  const bytes = bytesFor(records.length);
  if (withinCeiling(bytes)) return { kind: 'page', ...pageFor(records.length) };

  const [record] = records;
  if (path === 'lookup' && record) {
    const largest = Object.entries(record)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([field, items]) => ({ field, items, bytes: utf8Bytes(JSON.stringify(items)) }))
      .sort((a, b) => b.bytes - a.bytes)[0];
    return tooLarge(
      `The record at \`${bareId(record.id)}\``,
      bytes,
      largest
        ? `Narrow \`select\` to the fields you need, or page \`${largest.field}\` (${count(largest.items.length)} elements, its largest array) with \`slice\`.`
        : 'Narrow `select` to the fields you need.',
    );
  }

  const fits = largestFitting(records.length - 1, (kept) => withinCeiling(bytesFor(kept)));
  const subject = records.length === 1 ? 'This record' : `These ${records.length} records`;
  if (fits === 0) {
    return tooLarge(
      subject,
      bytes,
      'The first record alone exceeds the ceiling. Narrow `select` to the fields you need, or fetch the record by `id` and page its largest array with `slice`.',
    );
  }
  // Past page 1, the same `page` at a smaller per_page holds other records, so the named size
  // holds only from page 1.
  const page = request.page ?? 1;
  return tooLarge(
    subject,
    bytes,
    continuation === 'page' && page > 1
      ? `per_page ${fits} is the most of these records that fit, but page boundaries move with per_page, so \`page: ${page}\` at that size holds other records; walk the listing from page 1 at per_page ${fits}, or narrow \`select\` to the fields you need.`
      : `Rerun with per_page ${fits}, the most of these records that fit, and continue ${continuation === 'cursor' ? 'from the cursor that page returns' : 'with the next `page`'}; or narrow \`select\` to the fields you need.`,
    { input: 'per_page', value: fits },
  );
}

export interface SlicePageRequest extends PageContext {
  /** Record key of the array to page (a `select` alias already resolved); must hold an array. */
  field: string;
  /** Elements to return, already clamped. */
  limit: number;
  /** Requested start index; past the end yields an empty, final window. */
  offset: number;
  /** The record from a one-field projection: `id`, `display_name`, and `field`. */
  record: EntityRecord;
}

/**
 * One count-based window of an `id` lookup's array: `limit` elements of `field` from `offset`,
 * fewer only at the array end, whose `next` repeats `limit` — or, when that response would run
 * over the ceiling, its refusal naming the largest `slice.limit` that fits.
 */
export function buildSlicePage(request: SlicePageRequest): PageOutcome {
  const { entityType, field, limit, meta, noun, offset, record } = request;
  const items = record[field] as unknown[];
  const total = items.length;
  const start = Math.min(offset, total);
  const possiblyCapped = cappedAuthorFields(
    record,
    entityType === 'works' ? STORED_AUTHORSHIPS_CAP : undefined,
  ).includes(field);
  const notice = joinNotices([...request.notices, possiblyCapped ? STORAGE_CAP_NOTICE : undefined]);

  const pageFor = (shown: number): RecordPage => ({
    meta,
    results: [{ ...record, [field]: items.slice(start, start + shown) }],
    windows: [
      arrayWindow(entityType, record, field, { offset, shown, total, possiblyCapped, limit }),
    ],
  });
  const bytesFor = (shown: number) => measurePage(pageFor(shown), noun, { ...request, notice });

  const shown = Math.min(limit, total - start);
  const bytes = bytesFor(shown);
  if (withinCeiling(bytes)) return { kind: 'page', page: pageFor(shown), notice };

  const fits = largestFitting(shown - 1, (n) => withinCeiling(bytesFor(n)));
  const subject = `This slice of ${shown} \`${field}\` elements`;
  if (fits === 0) {
    return tooLarge(
      subject,
      bytes,
      `The element at offset ${start} alone exceeds the ceiling; continue past it with slice.offset ${start + 1}.`,
    );
  }
  return tooLarge(
    subject,
    bytes,
    `Rerun with slice.limit ${fits}, the most of these elements that fit, and continue from the offset its window's \`next\` names.`,
    { input: 'slice.limit', value: fits },
  );
}
