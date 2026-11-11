/**
 * @fileoverview The `filters` input every filter-taking tool shares: a record of string values
 * under dotted keys, the form OpenAlex reads. Booleans and numbers at any depth, nested objects,
 * and keys wrapped in one pair of quotes are normalized to that record before validation, each
 * disclosed in the response `notice` — unless OPENALEX_FILTER_RECORD_REPAIR=false. Search alone
 * also takes a native `key:value` filter string. The advertised JSON Schema stays the canonical
 * record either way.
 * @module mcp-server/tools/filters-input
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { codeSpan } from '@/mcp-server/tools/record-page.js';
import { parseNativeFilters, quoteCallerText } from '@/services/openalex/filter-values.js';

const canonicalFilters = z.record(z.string(), z.string());
const { $schema: _schema, ...filterProjection } = z.toJSONSchema(canonicalFilters, { io: 'input' });

/** The ways a filters record entry is normalized, in the order the notice names them. */
const FILTER_REPAIR_KINDS = ['boolean', 'number', 'nested_object', 'quoted_key'] as const;
type FilterRepairKind = (typeof FILTER_REPAIR_KINDS)[number];

/** One normalization, named by the canonical key it produced. */
interface FilterRepair {
  key: string;
  kind: FilterRepairKind;
}

/** A rejection at the caller's own path inside `filters`, as `ctx.addIssue` takes it. */
type FilterIssue = Parameters<z.core.$RefinementCtx['addIssue']>[0];

/**
 * A nested key OpenAlex can read as part of a dotted field path: segments of letters, digits,
 * `_`, and `-`.
 */
const FIELD_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * The longest dotted key nesting may build, and the longest key that may hold nested keys.
 * OpenAlex's longest filter key is 56 characters
 * (`primary_location.source.summary_stats.2yr_mean_citedness`). The bound keeps the flattened
 * keys linear in the caller's record: without it, a long key holding many children, or a deep
 * chain with a leaf at every level, repeats its prefix once per leaf.
 */
const MAX_NESTED_KEY_CHARS = 256;

/** The key inside one matching `'…'` or `"…"` pair, or undefined when `key` is not so wrapped. */
function unquotedKey(key: string): string | undefined {
  const quote = key[0];
  if (key.length < 3 || (quote !== "'" && quote !== '"') || key.at(-1) !== quote) return;
  return key.slice(1, -1);
}

/** One key of the record being walked: the caller's spelling, its dotted segment, its parent. */
interface KeyNode {
  /** Length of the dotted key from the top-level segment through this one. */
  keyChars: number;
  parent: KeyNode | undefined;
  /** Whether this key or one above it was unwrapped from quotes. */
  quoted: boolean;
  rawKey: string;
  segment: string;
}

/** The caller's path to `node` inside `filters`, as Zod reports it. */
function callerPath(node: KeyNode): string[] {
  const path: string[] = [];
  for (let at: KeyNode | undefined = node; at; at = at.parent) path.push(at.rawKey);
  return path.reverse();
}

/** The canonical dotted key `node` names. */
function canonicalKey(node: KeyNode): string {
  const segments: string[] = [];
  for (let at: KeyNode | undefined = node; at; at = at.parent) segments.push(at.segment);
  return segments.reverse().join('.');
}

/**
 * How a collision names one of its two caller paths when both read as the same dotted string:
 * a flat key, or nested objects with their keys listed, since two nestings can split one key at
 * different dots. A nested path is at most `MAX_NESTED_KEY_CHARS` long, so the list stays short.
 */
function keyShape(path: string[]): string {
  return path.length === 1 ? 'a flat key' : `nested objects ${JSON.stringify(path)}`;
}

/**
 * The one key a filters record cannot carry: a JSON object holds `"__proto__"` as an own key, but
 * the record Zod builds from it drops the key, which would widen the query. No OpenAlex field has
 * this name.
 */
const PROTO_KEY = '__proto__';
const PROTO_KEY_MESSAGE = `Filter key "${PROTO_KEY}" names no OpenAlex field, and a filters record cannot carry it: it would be dropped, widening the query. Remove it.`;

/**
 * What one value of the record reads as: leaf text (with the conversion that made it, if any),
 * an object of nested keys, the canonical record's own rejection, or a rejection of its own.
 */
type ValueReading =
  | { kind: 'text'; text: string; repair: 'boolean' | 'number' | undefined }
  | { kind: 'nested'; object: object }
  | { kind: 'canonical' }
  | { kind: 'rejected'; why: string };

function readValue(value: unknown, nested: boolean): ValueReading {
  if (typeof value === 'string') return { kind: 'text', text: value, repair: undefined };
  if (typeof value === 'boolean') return { kind: 'text', text: String(value), repair: 'boolean' };
  if (typeof value === 'number') {
    /**
     * A top-level safe integer goes out as its decimal text, undisclosed, as the framework's own
     * argument repair sends it. Read here, it also covers a JSON-stringified record: the framework
     * unwraps the string and re-parses once, so its integers never reach that repair.
     */
    if (!nested && Number.isSafeInteger(value)) {
      return { kind: 'text', text: String(value), repair: undefined };
    }
    const text = String(value);
    if (value < 0 || Object.is(value, -0)) {
      return {
        kind: 'rejected',
        why: 'is negative, which OpenAlex reads as a range: "-5" means at most 5. Send a comparison or range as a string, such as "<=5" or "0..5".',
      };
    }
    if (text.includes('e')) {
      return {
        kind: 'rejected',
        why: `is written with an exponent (${text}), which OpenAlex refuses. Send the number as decimal text, such as "0.0000001".`,
      };
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return {
        kind: 'rejected',
        why: 'is an integer past 9007199254740991, which JSON may already have rounded. Send it as a string.',
      };
    }
    return { kind: 'text', text, repair: 'number' };
  }
  if (value === null) {
    return {
      kind: 'rejected',
      why: 'is null, which reads either as unset or as OpenAlex\'s "null" (no value). Omit the key to leave it unset, or send the string "null".',
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: 'rejected',
      why: 'is an array, which could mean OR or AND. Join alternatives with "|" for OR, or with "+" for AND, in one string.',
    };
  }
  if (typeof value === 'object') {
    return Object.keys(value).length === 0
      ? { kind: 'rejected', why: 'is an empty object, which names no filter field.' }
      : { kind: 'nested', object: value };
  }
  return { kind: 'canonical' };
}

/**
 * Normalize a filters record to string values under dotted keys, walking nested objects with an
 * explicit stack so caller-sized nesting cannot exhaust the call stack. A boolean at any depth
 * becomes `"true"`/`"false"`; a non-negative number whose `String(n)` has no exponent becomes that
 * text; a nested object whose leaves all convert contributes dotted keys at every depth
 * (`authorships.author.id`); and a key wrapped in one matching pair of quotes becomes the key
 * inside it, at any depth. A top-level safe integer, negative included, becomes its decimal text
 * and is not disclosed, exactly as the framework's own argument repair would send it.
 *
 * Everything else is an issue at the caller's path, so the call fails before any request: a
 * negative number (`-` is OpenAlex's range separator, so `-5` reads as at most 5), one written
 * with an exponent (`1e-7` is refused upstream), an integer past `Number.MAX_SAFE_INTEGER`
 * (JSON may already have rounded it), `null`, an array (an `ids` list reads as OR, a search list
 * as AND), an empty object, a nested key that is no field path (`{">=": 2020}`) or builds a key
 * past `MAX_NESTED_KEY_CHARS`, two keys that normalize onto one — a record holds one value per
 * key — and the key `"__proto__"`, which the validated record would drop. An alias beside its
 * canonical key stays two keys, ANDed by the service. Entries keep the caller's order, depth
 * first.
 *
 * Exported for the timing suite, which runs it on caller-sized records.
 */
export function normalizeFilterRecord(raw: Record<string, unknown>) {
  const record = new Map<string, string>();
  /** The entry that claimed each canonical key, so a second one is reported against it. */
  const claimedBy = new Map<string, KeyNode>();
  const repairs: FilterRepair[] = [];
  const issues: FilterIssue[] = [];
  const stack: [KeyNode, unknown][] = [];

  const reject = (node: KeyNode, value: unknown, message: string) => {
    issues.push({ code: 'custom', path: callerPath(node), input: value, message });
  };
  /**
   * Claim `node`'s canonical key; undefined, with an issue, when another entry holds it or the
   * key is `"__proto__"`.
   */
  const claimKey = (node: KeyNode): string | undefined => {
    const key = canonicalKey(node);
    if (key === PROTO_KEY) {
      reject(node, undefined, PROTO_KEY_MESSAGE);
      return;
    }
    const holder = claimedBy.get(key);
    if (holder) {
      const path = callerPath(node);
      const holderPath = callerPath(holder);
      const spelling = path.join('.');
      const holderSpelling = holderPath.join('.');
      const which =
        spelling === holderSpelling
          ? `${quoteCallerText(key)} appears twice: once as ${keyShape(holderPath)} and once as ${keyShape(path)}`
          : `${quoteCallerText(spelling)} names the same field as ${quoteCallerText(holderSpelling)}: ${quoteCallerText(key)}`;
      reject(
        node,
        undefined,
        `Filter key ${which}. A filters record holds one value per key; combine alternatives with "|" in one value.`,
      );
      return;
    }
    claimedBy.set(key, node);
    return key;
  };
  const pushEntries = (parent: KeyNode | undefined, object: object) => {
    const entries = Object.entries(object);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [rawKey, value] = entries[index] as [string, unknown];
      const unquoted = unquotedKey(rawKey);
      const segment = unquoted ?? rawKey;
      stack.push([
        {
          parent,
          rawKey,
          segment,
          keyChars: parent ? parent.keyChars + 1 + segment.length : segment.length,
          quoted: unquoted !== undefined || parent?.quoted === true,
        },
        value,
      ]);
    }
  };

  pushEntries(undefined, raw);
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, value] = entry;
    const reading = readValue(value, node.parent !== undefined);
    if (node.parent && !FIELD_PATH.test(node.segment)) {
      reject(
        node,
        value,
        `Nested filter key ${quoteCallerText(node.rawKey)} is not part of a field path: a nested key is a field name of letters, digits, "_", or "-" (dots between them), and a comparison goes in the value, such as ">=2020".`,
      );
      continue;
    }
    if ((node.parent || reading.kind === 'nested') && node.keyChars > MAX_NESTED_KEY_CHARS) {
      reject(
        node,
        value,
        `Filter key path ${quoteCallerText(callerPath(node).join('.'))} is longer than ${MAX_NESTED_KEY_CHARS} characters, longer than any OpenAlex field path, so it cannot be flattened into one.`,
      );
      continue;
    }
    switch (reading.kind) {
      case 'nested':
        pushEntries(node, reading.object);
        break;
      case 'canonical':
        for (const issue of z.string().safeParse(value).error?.issues ?? []) {
          issues.push({ ...issue, path: callerPath(node) });
        }
        claimKey(node);
        break;
      case 'rejected':
        reject(node, value, `Filter value ${reading.why}`);
        break;
      case 'text': {
        const key = claimKey(node);
        if (key === undefined) break;
        record.set(key, reading.text);
        if (reading.repair) repairs.push({ kind: reading.repair, key });
        if (node.parent) repairs.push({ kind: 'nested_object', key });
        if (node.quoted) repairs.push({ kind: 'quoted_key', key });
        break;
      }
      default: {
        const unhandled: never = reading;
        throw new Error(`Unhandled filter value reading: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return { record: Object.fromEntries(record), repairs, issues };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `filters` schema of a filter-taking tool. It advertises the canonical record — the
 * `.meta()` reprojects `z.record(z.string(), z.string())`, so `tools/list` is unchanged — and
 * parses into a per-call wrapper: the record to send, whether it came from a native filter string,
 * and the normalizations `normalizeFilterRecord()` made. Provenance belongs to the parsed call, so
 * concurrent calls cannot exchange notices, and a caller cannot forge the wrapper: whatever it
 * sends is read as filters. With `nativeString`, a string that does not open a JSON object is
 * parsed as OpenAlex's native `key:value` syntax first (`OPENALEX_FILTER_STRING_INPUT`); a
 * JSON-stringified object is left to the framework's own repair. Issues name the caller's paths,
 * never the wrapper's.
 */
export function filtersInput(options: { nativeString: boolean }) {
  return z
    .preprocess(
      (raw, ctx) => {
        const config = getServerConfig();
        const fromNativeString =
          options.nativeString &&
          typeof raw === 'string' &&
          !raw.trimStart().startsWith('{') &&
          config.filterStringInput;
        const filters = fromNativeString ? parseNativeFilters(raw) : raw;
        if (config.filterRecordRepair && isRecord(filters)) {
          const { record, repairs, issues } = normalizeFilterRecord(filters);
          if (issues.length > 0) {
            for (const issue of issues) ctx.addIssue(issue);
            return z.NEVER;
          }
          return { value: record, fromNativeString, repairs };
        }
        if (isRecord(filters) && Object.hasOwn(filters, PROTO_KEY)) {
          ctx.addIssue({ code: 'custom', path: [PROTO_KEY], message: PROTO_KEY_MESSAGE });
          return z.NEVER;
        }
        const parsed = canonicalFilters.safeParse(filters);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
          return z.NEVER;
        }
        return { value: parsed.data, fromNativeString, repairs: [] };
      },
      z.object({
        value: canonicalFilters,
        fromNativeString: z.boolean(),
        repairs: z.array(z.object({ key: z.string(), kind: z.enum(FILTER_REPAIR_KINDS) })),
      }),
    )
    .meta({ ...filterProjection, properties: undefined, required: undefined });
}

/** The parsed `filters` a handler receives. */
export type FiltersInput = z.output<ReturnType<typeof filtersInput>>;

type FiltersTool =
  | 'openalex_search_entities'
  | 'openalex_analyze_trends'
  | 'openalex_resolve_name'
  | 'openalex_get_citation_graph';

const repairCounter = createCounter(
  'openalex.filters_record.conversions',
  'Filters record entries normalized to string values under dotted keys',
  '{conversion}',
);

const REPAIR_PHRASES: Record<FilterRepairKind, string> = {
  boolean: 'booleans sent as "true"/"false" at',
  number: 'numbers sent as their decimal text at',
  nested_object: 'nested objects flattened to',
  quoted_key: 'quoted keys unwrapped to',
};

/**
 * Disclose the normalizations behind a call's `filters`: log them, count each kind once per call
 * (no caller value in the metric attributes), and return the notice sentence naming the keys
 * each kind produced, or undefined when nothing was normalized. Keys are JSON-encoded code spans,
 * read back exactly on both surfaces.
 */
export function discloseFilterRepairs(
  filters: FiltersInput | undefined,
  tool: FiltersTool,
  ctx: Context,
): string | undefined {
  if (!filters || filters.repairs.length === 0) return;
  const keysByKind = new Map<FilterRepairKind, string[]>();
  for (const kind of FILTER_REPAIR_KINDS) {
    const keys = filters.repairs.filter((repair) => repair.kind === kind).map(({ key }) => key);
    if (keys.length > 0) keysByKind.set(kind, keys);
  }
  const kinds = [...keysByKind.keys()];
  ctx.log.info('Normalized filters record', { tool, kinds, entries: filters.repairs.length });
  for (const kind of kinds) {
    repairCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'openalex.filters_record.kind': kind });
  }
  const parts = [...keysByKind].map(
    ([kind, keys]) =>
      `${REPAIR_PHRASES[kind]} ${keys.map((key) => codeSpan(JSON.stringify(key))).join(', ')}`,
  );
  return `Read \`filters\` as string values under dotted keys: ${parts.join('; ')}.`;
}
