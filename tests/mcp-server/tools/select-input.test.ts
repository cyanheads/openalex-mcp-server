/**
 * @fileoverview Tests for the shared `select` input seam: the schema both record tools carry
 * (field arrays, the lone-name wrap, the JSON and integer repairs, comma-joined strings behind
 * OPENALEX_SELECT_STRING_INPUT), its advertised JSON Schema, the conversion log and counter, and
 * the notices that disclose splits and widenings. (gh #135)
 * @module tests/mcp-server/tools/select-input
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarkdown, renderedText } from '../../helpers/markdown.js';

const mockConfig = vi.hoisted(() => ({
  apiKey: '',
  baseUrl: 'https://api.openalex.org',
  mailto: '',
  filterStringInput: true,
  clampPerPage: true,
  selectStringInput: true,
}));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => ({ ...mockConfig }) }));

const selectMetrics = vi.hoisted(() => ({ add: vi.fn() }));
const otherMetrics = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) =>
    name === 'openalex.select_string.conversions' ? selectMetrics : otherMetrics,
}));

const { describeSelect, recordSelectStringConversion, selectInput } = await import(
  '@/mcp-server/tools/select-input.js'
);
const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);
const { getCitationGraphTool } = await import(
  '@/mcp-server/tools/definitions/citation-graph.tool.js'
);

/** The handler's view of `select`, echoed back so a case reads what the framework handed it. */
const parsedOutput = z.object({
  names: z.array(z.string()).nullable().describe('Names the handler received.'),
  converted: z.boolean().describe('Whether a comma-joined string was converted.'),
});

/** A tool carrying the seam, as both record tools do. Both probes share a name, so messages match. */
const seamProbe = tool('select_probe', {
  description: 'Echoes the select it was handed.',
  input: z.object({ select: selectInput.optional().describe('Field names.') }),
  output: parsedOutput,
  handler: (input) => ({
    names: input.select?.value ?? null,
    converted: input.select?.converted ?? false,
  }),
});

/** A tool carrying the 0.11.0 schema, `select: z.array(z.string()).optional()`. */
const previousProbe = tool('select_probe', {
  description: 'Echoes the select it was handed, on the previous schema.',
  input: z.object({ select: z.array(z.string()).optional().describe('Field names.') }),
  output: parsedOutput,
  handler: (input) => ({ names: input.select ?? null, converted: false }),
});

type ErrorEnvelope = { code: number; message: string; data: Record<string, unknown> };
const errorOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.structuredContent as { error: ErrorEnvelope }).error;

/** Call a probe with arguments as a client sends them: untyped, so off-schema values reach the parse. */
const call = (probe: typeof seamProbe | typeof previousProbe, args: Record<string, unknown>) =>
  runToolContract(probe as typeof seamProbe, args as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.selectStringInput = true;
});

describe('select input seam (gh #135)', () => {
  /**
   * Every `select` the 0.11.0 schema accepted reaches the handler as the same names under the
   * seam, with the switch on and off: the lone-string wrap (untrimmed, as sent), the JSON-string
   * repair, the integer-element repair, and a `null` deleted. The previous-schema run is the
   * characterization; the seam run must match it exactly.
   */
  it.each([
    ['omitted', {}, null],
    ['[]', { select: [] }, []],
    ['[""]', { select: [''] }, ['']],
    ['["doi"]', { select: ['doi'] }, ['doi']],
    ['a lone name', { select: 'doi' }, ['doi']],
    ['a lone name with spaces, as sent', { select: ' doi ' }, [' doi ']],
    ['a lone dotted name', { select: 'primary_location.source' }, ['primary_location.source']],
    ['a JSON-stringified array', { select: '["doi","title"]' }, ['doi', 'title']],
    ['a padded JSON-stringified array', { select: '  ["doi"]' }, ['doi']],
    ['an integer element', { select: [123, 'doi'] }, ['123', 'doi']],
    ['null', { select: null }, null],
    ['a comma-joined element', { select: ['doi,title'] }, ['doi,title']],
  ] as const)('reads %s as the previous schema did', async (_label, args, names) => {
    for (const enabled of [true, false]) {
      mockConfig.selectStringInput = enabled;
      const previous = await call(previousProbe, args);
      const current = await call(seamProbe, args);
      expect(previous.isError).toBeFalsy();
      expect(current.isError).toBeFalsy();
      expect(previous.structuredContent).toEqual({ names, converted: false });
      expect(current.structuredContent).toEqual({ names, converted: false });
    }
  });

  /** Every rejection the 0.11.0 schema made that the switch does not loosen still fails. */
  it.each([
    ['a blank string', ''],
    ['a whitespace string', '   '],
    ['a comma-joined string', 'doi,title'],
    ['a name with a line break', 'doi\ntitle'],
    ['an unparseable JSON array string', '["doi"'],
    ['a fractional number', 1.5],
    ['a boolean', true],
    ['an object', { doi: true }],
    ['a forged normalization wrapper', { value: ['doi'], converted: true }],
  ] as const)(
    'rejects %s as the previous schema did, with the switch off',
    async (_label, select) => {
      mockConfig.selectStringInput = false;
      const previous = await call(previousProbe, { select });
      const current = await call(seamProbe, { select });
      expect(previous.isError).toBe(true);
      expect(current.isError).toBe(true);
      expect(errorOf(current).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(errorOf(current).message).toBe(errorOf(previous).message);
      expect(JSON.stringify(errorOf(current))).not.toContain('value');
    },
  );

  it.each([
    ['id,title,publication_year'],
    [' doi , title '],
    ['doi,,title'],
    ['doi,title,'],
    [',doi'],
    ['doi,\ntitle'],
    ['doi, title, primary_location.source'],
  ])(
    'keeps the comma-joined string %j whole, marked converted, with the switch on',
    async (select) => {
      const result = await call(seamProbe, { select });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ names: [select], converted: true });
    },
  );

  it.each([[','], [' , '], [',,,'], [''], [' '], ['\n']])(
    'rejects %j, which names no field, with the switch on',
    async (select) => {
      const result = await call(seamProbe, { select });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain('must name at least one field');
      expect(JSON.stringify(result.content)).toContain('omit select for the curated default');
    },
  );

  /**
   * The framework turns a safe integer into its string before re-parsing, and the seam wraps that
   * string as it wraps any lone name, so `5` reaches the service as the field name `"5"` — which
   * OpenAlex refuses, as it refuses `"5"` sent as a string — rather than failing as a type
   * mismatch. No select field is numeric, so the call fails either way.
   */
  it('reads a safe-integer select as the lone name the framework repairs it to', async () => {
    const previous = await call(previousProbe, { select: 5 });
    expect(previous.isError).toBe(true);
    for (const enabled of [true, false]) {
      mockConfig.selectStringInput = enabled;
      const current = await call(seamProbe, { select: 5 });
      expect(current.structuredContent).toEqual({ names: ['5'], converted: false });
    }
  });

  it('rejects a comma-free name holding a line break with the switch on, as before', async () => {
    const previous = await call(previousProbe, { select: 'doi\ntitle' });
    const current = await call(seamProbe, { select: 'doi\ntitle' });
    expect(current.isError).toBe(true);
    expect(errorOf(current).message).toBe(errorOf(previous).message);
  });

  it('reports a bad element at its own path, not inside the wrapper', async () => {
    const result = await call(seamProbe, { select: ['doi', { nested: true }] });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('select.1');
    expect(text).not.toContain('select.value');
  });

  /**
   * The seam is a loosening: the advertised `select` schema keeps the 0.11.0 structure exactly,
   * on both record tools and in both JSON Schema modes; only description text may differ.
   */
  it.each([
    ['openalex_search_entities', searchEntitiesTool.input],
    ['openalex_get_citation_graph', getCitationGraphTool.input],
  ] as const)('advertises the 0.11.0 select schema on %s', (_name, input) => {
    for (const io of ['input', 'output'] as const) {
      const schema = z.toJSONSchema(input, { io });
      const { $schema: _schema, ...previous } = z.toJSONSchema(z.array(z.string()), { io });
      const { description, ...actual } = (schema.properties?.select ?? {}) as Record<
        string,
        unknown
      >;
      expect(typeof description).toBe('string');
      expect(actual).toStrictEqual(previous);
      expect(schema.required ?? []).not.toContain('select');
    }
  });
});

describe('recordSelectStringConversion (gh #135)', () => {
  it.each(['openalex_search_entities', 'openalex_get_citation_graph'] as const)(
    'logs and counts one conversion for %s with bounded attributes',
    (tool) => {
      const ctx = createMockContext() as Context;
      const log = vi.spyOn(ctx.log, 'info');
      recordSelectStringConversion(tool, ctx);
      expect(log).toHaveBeenCalledExactlyOnceWith('Converted select string', { tool });
      expect(selectMetrics.add).toHaveBeenCalledExactlyOnceWith(1, { 'mcp.tool.name': tool });
      expect(otherMetrics.add).not.toHaveBeenCalled();
    },
  );
});

describe('describeSelect (gh #135)', () => {
  it('discloses nothing for omitted, empty, default-shaped, and renamed selects', () => {
    for (const select of [undefined, [], [''], ['doi', 'title'], ['year', 'authors', 'abstract']]) {
      expect(describeSelect('works', select)).toEqual({ notices: [], widenedFields: [] });
    }
    expect(describeSelect('sources', ['publisher', 'is_oa'])).toEqual({
      notices: [],
      widenedFields: [],
    });
  });

  it('names each widening grouped by the field it returned', () => {
    const { notices, widenedFields } = describeSelect('works', [
      'is_oa',
      'oa_status',
      'primary_location.source.display_name',
      'open_access',
    ]);
    expect(widenedFields).toEqual(['open_access', 'primary_location']);
    expect(notices).toEqual([
      '`select` projects top-level fields only, so each nested name returned the field holding it: `is_oa`, `oa_status` → `open_access`; `primary_location.source.display_name` → `primary_location`.',
    ]);
  });

  it('points a widened authorships at author_list', () => {
    const { notices, widenedFields } = describeSelect('works', [
      'authorships.author',
      'authorships.institutions.country_code',
    ]);
    expect(widenedFields).toEqual(['authorships']);
    expect(notices[0]).toContain(
      '`authorships.author`, `authorships.institutions.country_code` → `authorships`.',
    );
    expect(notices[0]).toContain('select `author_list`');
  });

  it('discloses a summary_stats leaf widening, which shipped silent (gh #64)', () => {
    expect(describeSelect('authors', ['h_index', 'summary_stats.i10_index'])).toEqual({
      notices: [
        '`select` projects top-level fields only, so each nested name returned the field holding it: `h_index`, `summary_stats.i10_index` → `summary_stats`.',
      ],
      widenedFields: ['summary_stats'],
    });
  });

  it('names each split, and a split that left no field', () => {
    expect(describeSelect('works', ['doi,abstract', ',', 'doi,abstract']).notices).toEqual([
      'Split comma-joined `select` entries into field names: `doi,abstract` → `doi`, `abstract`; `,` → no field.',
    ]);
  });

  it('joins a split and a widening it produced, split first', () => {
    const { notices } = describeSelect('works', [' doi , is_oa ']);
    expect(notices).toEqual([
      'Split comma-joined `select` entries into field names: `  doi , is_oa  ` → `doi`, `is_oa`.',
      '`select` projects top-level fields only, so each nested name returned the field holding it: `is_oa` → `open_access`.',
    ]);
  });

  it('widens nothing under `*`, which projects the whole record', () => {
    expect(describeSelect('works', ['*,is_oa']).widenedFields).toEqual([]);
    expect(describeSelect('works', ['*', 'authorships.author']).notices).toEqual([]);
  });

  /** Caller text sits in code spans, so a parse reads every name back exactly. */
  it('reads a hostile widened name back literally from the rendered notice', () => {
    const name = 'primary_location.`x` *y* [z](https://evil.test) <b>';
    const [notice] = describeSelect('works', [name]).notices;
    const read = renderedText(notice ?? '');
    expect(read).toContain(`${name} → primary_location`);
    const nodes = JSON.stringify(parseMarkdown(notice ?? ''));
    expect(nodes).not.toContain('"type":"link"');
    expect(nodes).not.toContain('"type":"emphasis"');
    expect(nodes).not.toContain('"type":"html"');
  });
});
