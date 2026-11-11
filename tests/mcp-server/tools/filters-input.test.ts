/**
 * @fileoverview Tests for the shared `filters` input: the record normalization table at its own
 * seam, its disclosure, and the four filter-taking tools reading it through the framework's
 * argument parsing and the real service, with the switch on and off. (gh #136)
 * @module tests/mcp-server/tools/filters-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  apiKey: '',
  baseUrl: 'https://api.openalex.org',
  mailto: '',
  filterStringInput: true,
  clampPerPage: true,
  filterRecordRepair: true,
  selectStringInput: true,
}));
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ ...mockConfig }),
}));

const repairMetrics = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: (
      name: string,
      ...rest: Parameters<typeof actual.createCounter> extends [string, ...infer Tail]
        ? Tail
        : never
    ) =>
      name === 'openalex.filters_record.conversions'
        ? repairMetrics
        : actual.createCounter(name, ...rest),
  };
});

const { discloseFilterRepairs, filtersInput, normalizeFilterRecord } = await import(
  '@/mcp-server/tools/filters-input.js'
);
const { initOpenAlexService } = await import('@/services/openalex/openalex-service.js');
const { searchEntitiesTool } = await import(
  '@/mcp-server/tools/definitions/search-entities.tool.js'
);
const { analyzeTrendsTool } = await import('@/mcp-server/tools/definitions/analyze-trends.tool.js');
const { resolveNameTool } = await import('@/mcp-server/tools/definitions/resolve-name.tool.js');
const { getCitationGraphTool } = await import(
  '@/mcp-server/tools/definitions/citation-graph.tool.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.filterRecordRepair = true;
  mockConfig.filterStringInput = true;
});

const recordSchema = filtersInput({ nativeString: false });
const searchSchema = filtersInput({ nativeString: true });

/** The issues a rejected `filters` value carries, as path and message. */
function issuesOf(result: z.ZodSafeParseResult<unknown>) {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map(({ path, message }) => ({ path, message }));
}

describe('filtersInput normalization (gh #136)', () => {
  it.each([
    [{ is_oa: true }, { is_oa: 'true' }, [['boolean', 'is_oa']]],
    [{ is_oa: false }, { is_oa: 'false' }, [['boolean', 'is_oa']]],
    [{ fwci: 1.5 }, { fwci: '1.5' }, [['number', 'fwci']]],
    [{ fwci: 0.000001 }, { fwci: '0.000001' }, [['number', 'fwci']]],
    [
      { summary_stats: { h_index: 50 } },
      { 'summary_stats.h_index': '50' },
      [
        ['number', 'summary_stats.h_index'],
        ['nested_object', 'summary_stats.h_index'],
      ],
    ],
    [
      { authorships: { author: { id: 'A5033043101' } } },
      { 'authorships.author.id': 'A5033043101' },
      [['nested_object', 'authorships.author.id']],
    ],
    [
      { "'authorships.author.id'": 'A5033043101' },
      { 'authorships.author.id': 'A5033043101' },
      [['quoted_key', 'authorships.author.id']],
    ],
    [
      { '"authorships.author.id"': 'A5033043101' },
      { 'authorships.author.id': 'A5033043101' },
      [['quoted_key', 'authorships.author.id']],
    ],
    [
      { "'primary_location.source'": { id: 'S1' } },
      { 'primary_location.source.id': 'S1' },
      [
        ['nested_object', 'primary_location.source.id'],
        ['quoted_key', 'primary_location.source.id'],
      ],
    ],
    [
      { primary_location: { "'source.id'": 'S1' } },
      { 'primary_location.source.id': 'S1' },
      [
        ['nested_object', 'primary_location.source.id'],
        ['quoted_key', 'primary_location.source.id'],
      ],
    ],
    [
      { primary_location: { 'source.id': 'S1' } },
      { 'primary_location.source.id': 'S1' },
      [['nested_object', 'primary_location.source.id']],
    ],
    [{ "''": 'x' }, { "''": 'x' }, []],
    [{ "'is_oa": true }, { "'is_oa": 'true' }, [['boolean', "'is_oa"]]],
    [{ '\'is_oa"': 'true' }, { '\'is_oa"': 'true' }, []],
    [{ "''is_oa''": 'true' }, { "'is_oa'": 'true' }, [['quoted_key', "'is_oa'"]]],
    [
      { type: 'article', 'title.search': 'graph' },
      { type: 'article', 'title.search': 'graph' },
      [],
    ],
  ] as const)('reads %j as %j', (raw, value, repairs) => {
    const parsed = recordSchema.parse(raw);
    expect(parsed).toStrictEqual({
      value,
      fromNativeString: false,
      repairs: repairs.map(([kind, key]) => ({ key, kind })),
    });
    expect(Object.keys(parsed.value)).toEqual(Object.keys(value));
  });

  it('flattens past the first level in document order, depth first, beside flat keys', () => {
    const parsed = recordSchema.parse({
      type: 'article',
      primary_location: {
        source: {
          id: 'S1',
          is_oa: true,
          host_organization: { lineage: 'P1', "'country_code'": 'DE' },
        },
        version: 'publishedVersion',
      },
      'open_access.is_oa': 'true',
    });
    expect(Object.entries(parsed.value)).toEqual([
      ['type', 'article'],
      ['primary_location.source.id', 'S1'],
      ['primary_location.source.is_oa', 'true'],
      ['primary_location.source.host_organization.lineage', 'P1'],
      ['primary_location.source.host_organization.country_code', 'DE'],
      ['primary_location.version', 'publishedVersion'],
      ['open_access.is_oa', 'true'],
    ]);
    expect(parsed.repairs).toEqual([
      { kind: 'nested_object', key: 'primary_location.source.id' },
      { kind: 'boolean', key: 'primary_location.source.is_oa' },
      { kind: 'nested_object', key: 'primary_location.source.is_oa' },
      { kind: 'nested_object', key: 'primary_location.source.host_organization.lineage' },
      { kind: 'nested_object', key: 'primary_location.source.host_organization.country_code' },
      { kind: 'quoted_key', key: 'primary_location.source.host_organization.country_code' },
      { kind: 'nested_object', key: 'primary_location.version' },
    ]);
  });

  it.each([
    [{ summary_stats: { h_index: -5 } }, ['summary_stats', 'h_index'], 'is negative'],
    [{ summary_stats: { h_index: -0 } }, ['summary_stats', 'h_index'], 'is negative'],
    [{ fwci: -1.5 }, ['fwci'], 'is negative'],
    [{ fwci: 1e-7 }, ['fwci'], 'exponent (1e-7)'],
    [{ amount_usd: 1e21 }, ['amount_usd'], 'exponent (1e+21)'],
    [{ amount_usd: 2 ** 53 }, ['amount_usd'], 'past 9007199254740991'],
    [{ a: { b: 2 ** 53 } }, ['a', 'b'], 'past 9007199254740991'],
    [{ is_oa: null }, ['is_oa'], 'is null'],
    [{ a: { b: null } }, ['a', 'b'], 'is null'],
    [{ ids: ['W1', 'W2'] }, ['ids'], 'is an array'],
    [
      { 'title_and_abstract.search.exact': ['a', 'b'] },
      ['title_and_abstract.search.exact'],
      'is an array',
    ],
    [{ authorships: {} }, ['authorships'], 'empty object'],
    [{ a: { b: {} } }, ['a', 'b'], 'empty object'],
    [{ publication_year: { '>=': 2020 } }, ['publication_year', '>='], 'not part of a field path'],
    [{ a: { 'b c': 'x' } }, ['a', 'b c'], 'not part of a field path'],
    [{ a: { 'b..c': 'x' } }, ['a', 'b..c'], 'not part of a field path'],
    [{ a: { "'b c'": 'x' } }, ['a', "'b c'"], 'not part of a field path'],
    [{ a: { b: { '': 'x' } } }, ['a', 'b', ''], 'not part of a field path'],
    [{ ['a'.repeat(257)]: { b: 'x' } }, ['a'.repeat(257)], 'longer than 256 characters'],
    [{ a: { ['b'.repeat(255)]: 'x' } }, ['a', 'b'.repeat(255)], 'longer than 256 characters'],
  ] as const)('refuses %j at its caller path', (raw, path, why) => {
    const issues = issuesOf(recordSchema.safeParse(raw));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(path);
    expect(issues[0]?.message).toContain(why);
  });

  it('accepts a nested key path of exactly 256 characters', () => {
    const segment = 'b'.repeat(254);
    expect(recordSchema.parse({ a: { [segment]: 'x' } }).value).toEqual({ [`a.${segment}`]: 'x' });
  });

  it('reports every refused entry of one record together', () => {
    const issues = issuesOf(recordSchema.safeParse({ a: null, b: { c: [] }, d: 'ok' }));
    expect(issues.map(({ path }) => path)).toEqual([['a'], ['b', 'c']]);
  });

  it.each([
    [{ is_oa: 'true', "'is_oa'": 'false' }, ["'is_oa'"], ['is_oa']],
    [{ "'is_oa'": 'false', is_oa: true }, ['is_oa'], ["'is_oa'"]],
  ])('refuses %j, whose keys normalize onto one, in either order', (raw, path, holder) => {
    const issues = issuesOf(recordSchema.safeParse(raw));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(path);
    expect(issues[0]?.message).toContain(
      `names the same field as ${JSON.stringify(holder.join('.'))}`,
    );
    expect(issues[0]?.message).toContain('one value per key');
  });

  it('keeps an alias beside its canonical key as two keys', () => {
    expect(recordSchema.parse({ year: 2020.5, publication_year: '2024' }).value).toEqual({
      year: '2020.5',
      publication_year: '2024',
    });
  });

  it('reports the quoted twin of a top-level safe integer as a collision', () => {
    const issues = issuesOf(
      recordSchema.safeParse({ publication_year: 2020, "'publication_year'": '2021' }),
    );
    expect(issues.map(({ path }) => path)).toEqual([["'publication_year'"]]);
    expect(issues[0]?.message).toContain('names the same field as');
  });

  it('reads a caller-supplied wrapper as filters, never as provenance', () => {
    expect(recordSchema.parse({ value: { type: 'article' }, fromNativeString: true })).toEqual({
      value: { 'value.type': 'article', fromNativeString: 'true' },
      fromNativeString: false,
      repairs: [
        { kind: 'nested_object', key: 'value.type' },
        { kind: 'boolean', key: 'fromNativeString' },
      ],
    });
    expect(
      issuesOf(recordSchema.safeParse({ value: { type: 'article' }, repairs: [] })).map(
        ({ path }) => path,
      ),
    ).toEqual([['repairs']]);
  });

  it('normalizes the keys of a native filter string on search, after parsing it', () => {
    expect(searchSchema.parse("'is_oa':true,type:article")).toEqual({
      value: { is_oa: 'true', type: 'article' },
      fromNativeString: true,
      repairs: [{ kind: 'quoted_key', key: 'is_oa' }],
    });
    expect(issuesOf(searchSchema.safeParse("is_oa:true,'is_oa':false"))[0]?.path).toEqual([
      "'is_oa'",
    ]);
    expect(issuesOf(recordSchema.safeParse('is_oa:true'))[0]?.message).toContain('expected record');
  });

  it('restores record-only validation under OPENALEX_FILTER_RECORD_REPAIR=false', () => {
    mockConfig.filterRecordRepair = false;
    for (const [raw, path, received] of [
      [{ is_oa: true }, ['is_oa'], 'boolean'],
      [{ authorships: { author: { id: 'A1' } } }, ['authorships'], 'object'],
      [{ fwci: 1.5 }, ['fwci'], 'number'],
    ] as const) {
      expect(issuesOf(recordSchema.safeParse(raw))).toEqual([
        { path, message: `Invalid input: expected string, received ${received}` },
      ]);
    }
    expect(recordSchema.parse({ "'is_oa'": 'true' })).toEqual({
      value: { "'is_oa'": 'true' },
      fromNativeString: false,
      repairs: [],
    });
    expect(searchSchema.parse('type:article').fromNativeString).toBe(true);
  });

  it('advertises the canonical record in both JSON Schema modes', () => {
    for (const schema of [recordSchema, searchSchema]) {
      for (const io of ['input', 'output'] as const) {
        expect(z.toJSONSchema(schema, { io })).toStrictEqual({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { type: 'string' },
        });
      }
    }
  });

  it('returns normalizeFilterRecord issues without throwing on a non-JSON value', () => {
    const { issues } = normalizeFilterRecord({ a: undefined });
    expect(issues).toMatchObject([{ path: ['a'], code: 'invalid_type' }]);
  });
});

describe('discloseFilterRepairs (gh #136)', () => {
  it('logs, counts each kind once without caller values, and names every key it produced', () => {
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'info');
    const parsed = recordSchema.parse({
      is_oa: true,
      has_doi: false,
      fwci: 1.5,
      authorships: { author: { id: 'A1' } },
      "'type'": 'article',
    });
    expect(discloseFilterRepairs(parsed, 'openalex_analyze_trends', ctx)).toBe(
      'Read `filters` as string values under dotted keys: booleans sent as "true"/"false" at `"is_oa"`, `"has_doi"`; numbers sent as their decimal text at `"fwci"`; nested objects flattened to `"authorships.author.id"`; quoted keys unwrapped to `"type"`.',
    );
    expect(log).toHaveBeenCalledExactlyOnceWith('Normalized filters record', {
      tool: 'openalex_analyze_trends',
      kinds: ['boolean', 'number', 'nested_object', 'quoted_key'],
      entries: 5,
    });
    expect(repairMetrics.add.mock.calls).toEqual(
      ['boolean', 'number', 'nested_object', 'quoted_key'].map((kind) => [
        1,
        { 'mcp.tool.name': 'openalex_analyze_trends', 'openalex.filters_record.kind': kind },
      ]),
    );
  });

  it.each([
    ['no filters', undefined],
    ['a canonical record', recordSchema.parse({ type: 'article' })],
  ])('discloses nothing for %s', (_label, parsed) => {
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'info');
    expect(discloseFilterRepairs(parsed, 'openalex_search_entities', ctx)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(repairMetrics.add).not.toHaveBeenCalled();
  });

  it('JSON-encodes a key, so a line break in it stays on the notice line', () => {
    const parsed = recordSchema.parse({ 'a\n> b': true });
    expect(discloseFilterRepairs(parsed, 'openalex_search_entities', createMockContext())).toBe(
      'Read `filters` as string values under dotted keys: booleans sent as "true"/"false" at `"a\\n> b"`.',
    );
  });
});

/** The filter-taking tools, each with the arguments that make a minimal call. */
const TOOLS = [
  ['openalex_search_entities', searchEntitiesTool, { entity_type: 'works' }],
  ['openalex_analyze_trends', analyzeTrendsTool, { entity_type: 'works', group_by: 'is_oa' }],
  ['openalex_resolve_name', resolveNameTool, { entity_type: 'works', query: 'graph neural' }],
  ['openalex_get_citation_graph', getCitationGraphTool, { seed_id: 'W1', direction: 'cites' }],
] as const;

type AnyTool = (typeof TOOLS)[number][1];

/**
 * Run `tool` with `filters` through the framework and the real service, against an OpenAlex that
 * answers every list, group_by, autocomplete, and seed request with an empty page.
 */
async function call(tool: AnyTool, base: object, filters: unknown) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.openalex.org') {
      return Promise.reject(new Error(`unmocked fetch: ${url.href}`));
    }
    const body =
      url.pathname === '/works/W1'
        ? { id: 'https://openalex.org/W1', display_name: 'Seed' }
        : { meta: { count: 0, per_page: 25, groups_count: 0 }, results: [], group_by: [] };
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
  vi.stubGlobal('fetch', fetchMock);
  initOpenAlexService();
  const result = await runToolContract(
    tool as typeof searchEntitiesTool,
    {
      ...(base as { entity_type: 'works' }),
      filters,
    } as Parameters<typeof runToolContract<typeof searchEntitiesTool>>[1],
  );
  const filterSent = fetchMock.mock.calls
    .map(([input]) => new URL(String(input)).searchParams.get('filter'))
    .filter((filter) => filter !== null);
  const text = (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  const structured = result.structuredContent as {
    notice?: string;
    echo?: string;
    error?: { message: string; data: { reason?: string; recovery?: { hint?: string } } };
  };
  return { fetchMock, filterSent, result, structured, text };
}

/** The citation graph adds its direction clause to the caller's filters. */
const sentFor = (name: string, filter: string) =>
  name === 'openalex_get_citation_graph' ? `${filter},cites:W1` : filter;

describe('every filter-taking tool reads the normalized record (gh #136)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const USE_CASES = [
    [{ is_oa: true }, 'is_oa:true', 'booleans sent as "true"/"false" at `"is_oa"`'],
    [
      { authorships: { author: { id: 'A5033043101' } } },
      'authorships.author.id:A5033043101',
      'nested objects flattened to `"authorships.author.id"`',
    ],
    [
      { "'authorships.author.id'": 'A5033043101' },
      'authorships.author.id:A5033043101',
      'quoted keys unwrapped to `"authorships.author.id"`',
    ],
    [{ fwci: 1.5 }, 'fwci:1.5', 'numbers sent as their decimal text at `"fwci"`'],
    [
      { primary_location: { source: { id: 'S1' } } },
      'primary_location.source.id:S1',
      'nested objects flattened to `"primary_location.source.id"`',
    ],
    [
      { "'primary_location.source'": { id: 'S1' } },
      'primary_location.source.id:S1',
      'nested objects flattened to `"primary_location.source.id"`',
    ],
  ] as const;

  it.each(
    TOOLS.flatMap(([name, tool, base]) =>
      USE_CASES.map(
        ([filters, sent, notice]) => [name, filters, tool, base, sent, notice] as const,
      ),
    ),
  )(
    '%s sends %j as its string record, disclosed on both surfaces',
    async (name, filters, tool, base, sent, notice) => {
      const { filterSent, result, structured, text } = await call(tool, base, filters);
      expect(result.isError).toBeFalsy();
      expect(filterSent.at(-1)).toBe(sentFor(name, sent));
      expect(structured.notice).toContain(notice);
      expect(text).toContain(notice);
      if (structured.echo !== undefined) {
        const [key, value] = sent.split(':') as [string, string];
        expect(structured.echo).toContain(`filters=${JSON.stringify({ [key]: value })}`);
      }
    },
  );

  it.each(TOOLS)(
    '%s sends a top-level safe integer beside a boolean, disclosing only the boolean',
    async (name, tool, base) => {
      const { filterSent, result, structured } = await call(tool, base, {
        is_oa: true,
        publication_year: 2020,
      });
      expect(result.isError).toBeFalsy();
      expect(filterSent.at(-1)).toBe(sentFor(name, 'is_oa:true,publication_year:2020'));
      expect(structured.notice).toMatch(
        /^Read `filters` as string values under dotted keys: booleans sent as "true"\/"false" at `"is_oa"`\. /,
      );
      expect(repairMetrics.add).toHaveBeenCalledExactlyOnceWith(1, {
        'mcp.tool.name': name,
        'openalex.filters_record.kind': 'boolean',
      });
    },
  );

  /** Every call that succeeded before the normalization returns the same response with it. */
  it.each(
    TOOLS.flatMap(([name, tool, base]) =>
      (
        [
          [{ type: 'article' }, 'type:article'],
          ['{"publication_year":"2020"}', 'publication_year:2020'],
          [{ publication_year: 2020 }, 'publication_year:2020'],
          [{ publication_year: -5 }, 'publication_year:-5'],
          [
            { year: '2020', publication_year: '2024' },
            // Autocomplete sends its filters without alias translation.
            name === 'openalex_resolve_name'
              ? 'year:2020,publication_year:2024'
              : 'publication_year:2020,publication_year:2024',
          ],
        ] as const
      ).map(([filters, sent]) => [name, filters, tool, base, sent] as const),
    ),
  )(
    '%s answers %j exactly as before, with no disclosure',
    async (name, filters, tool, base, sent) => {
      const repaired = await call(tool, base, filters);
      mockConfig.filterRecordRepair = false;
      const canonical = await call(tool, base, filters);
      expect(repaired.result.isError).toBeFalsy();
      expect(repaired.filterSent.at(-1)).toBe(sentFor(name, sent));
      expect(repaired.filterSent).toEqual(canonical.filterSent);
      expect(repaired.result.structuredContent).toStrictEqual(canonical.result.structuredContent);
      expect(repaired.result.content).toStrictEqual(canonical.result.content);
      expect(repaired.text).not.toContain('Read `filters`');
      expect(repairMetrics.add).not.toHaveBeenCalled();
    },
  );

  it.each(
    TOOLS.flatMap(([name, tool, base]) =>
      (
        [
          [{ summary_stats: { h_index: -5 } }, 'filters.summary_stats.h_index', 'is negative'],
          [{ fwci: 1e-7 }, 'filters.fwci', 'exponent (1e-7)'],
          [{ ids: ['W1', 'W2'] }, 'filters.ids', 'is an array'],
          [{ publication_year: { '>=': 2020 } }, 'filters.publication_year.>=', 'field path'],
          [{ is_oa: 'true', "'is_oa'": 'false' }, "filters.'is_oa'", 'one value per key'],
          [{ "'is_oa'": 'false', is_oa: 'true' }, 'filters.is_oa', 'one value per key'],
        ] as const
      ).map(([filters, path, why]) => [name, filters, tool, base, path, why] as const),
    ),
  )(
    '%s refuses %j at the caller path before any request',
    async (_name, filters, tool, base, path, why) => {
      const { fetchMock, result, structured, text } = await call(tool, base, filters);
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(structured.error?.data.reason).toBe('invalid_arguments');
      expect(structured.error?.message).toContain(`: ${path}: `);
      expect(structured.error?.message).toContain(why);
      expect(structured.error?.data.recovery?.hint).toContain(why);
      expect(text).toContain(why);
    },
  );

  /** The envelopes 0.11.0 returned for the three use-case shapes, on every tool. */
  it.each(TOOLS)(
    '%s fails each use-case shape exactly as before under OPENALEX_FILTER_RECORD_REPAIR=false',
    async (name, tool, base) => {
      mockConfig.filterRecordRepair = false;
      for (const [filters, path, received] of [
        [{ is_oa: true }, 'filters.is_oa', 'boolean'],
        [{ authorships: { author: { id: 'A5033043101' } } }, 'filters.authorships', 'object'],
      ] as const) {
        const { fetchMock, structured } = await call(tool, base, filters);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(structured.error?.message).toBe(
          `Input validation error: Invalid arguments for tool ${name}: ${path}: Invalid input: expected string, received ${received}`,
        );
        expect(structured.error?.data.recovery?.hint).toBe(
          `Send ${path} as a string, not ${received === 'object' ? 'an object' : 'a boolean'}.`,
        );
      }
      const quoted = await call(tool, base, { "'authorships.author.id'": 'A5033043101' });
      expect(quoted.filterSent.at(-1)).toBe(sentFor(name, "'authorships.author.id':A5033043101"));
      expect(quoted.text).not.toContain('Read `filters`');
    },
  );

  it.each(TOOLS)(
    '%s keeps each concurrent call to its own disclosure',
    async (_name, tool, base) => {
      const fetchMock = vi.fn((input: unknown) => {
        const url = new URL(String(input));
        const body =
          url.pathname === '/works/W1'
            ? { id: 'https://openalex.org/W1', display_name: 'Seed' }
            : { meta: { count: 0, per_page: 25, groups_count: 0 }, results: [], group_by: [] };
        return Promise.resolve(new Response(JSON.stringify(body)));
      });
      vi.stubGlobal('fetch', fetchMock);
      initOpenAlexService();
      const args = (filters: object) =>
        ({ ...(base as { entity_type: 'works' }), filters }) as Parameters<
          typeof runToolContract<typeof searchEntitiesTool>
        >[1];
      const results = await Promise.all([
        runToolContract(tool as typeof searchEntitiesTool, args({ is_oa: true })),
        runToolContract(tool as typeof searchEntitiesTool, args({ is_oa: 'true' })),
        runToolContract(tool as typeof searchEntitiesTool, args({ has_doi: false })),
        runToolContract(tool as typeof searchEntitiesTool, args({ type: 'article' })),
      ]);
      const notices = results.map(
        (result) => (result.structuredContent as { notice?: string }).notice ?? '',
      );
      expect(notices.map((notice) => notice.includes('`"is_oa"`'))).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(notices.map((notice) => notice.includes('`"has_doi"`'))).toEqual([
        false,
        false,
        true,
        false,
      ]);
    },
  );
});

/**
 * The framework unwraps a JSON-stringified `filters` record, then re-parses once, so an integer
 * inside it never reaches the framework's integer repair: the normalization reads the top-level
 * safe integer itself, sending the decimal text that repair sends, with no disclosure.
 */
describe('a JSON-stringified filters record holding a whole number (gh #136)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(TOOLS)(
    '%s sends \'{"publication_year":2020}\' as its string record, undisclosed',
    async (name, tool, base) => {
      const { filterSent, result, structured, text } = await call(
        tool,
        base,
        '{"publication_year":2020}',
      );
      expect(result.isError).toBeFalsy();
      expect(filterSent.at(-1)).toBe(sentFor(name, 'publication_year:2020'));
      expect(structured.notice ?? '').not.toContain('Read `filters`');
      expect(text).not.toContain('Read `filters`');
      expect(repairMetrics.add).not.toHaveBeenCalled();
    },
  );

  it.each(TOOLS)(
    '%s sends a stringified negative integer as the bare record does, and discloses a boolean beside it',
    async (name, tool, base) => {
      const { filterSent, result, structured } = await call(
        tool,
        base,
        '{"publication_year":-5,"is_oa":true}',
      );
      expect(result.isError).toBeFalsy();
      expect(filterSent.at(-1)).toBe(sentFor(name, 'publication_year:-5,is_oa:true'));
      expect(structured.notice).toContain('booleans sent as "true"/"false" at `"is_oa"`');
      expect(structured.notice).not.toContain('`"publication_year"`');
    },
  );

  it.each(TOOLS)(
    '%s still refuses it under OPENALEX_FILTER_RECORD_REPAIR=false, before any request',
    async (_name, tool, base) => {
      mockConfig.filterRecordRepair = false;
      const { fetchMock, result } = await call(tool, base, '{"publication_year":2020}');
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('reads the top-level safe integer at the seam as its decimal text, with no repair', () => {
    for (const year of [2020, -5, 0]) {
      expect(recordSchema.parse({ publication_year: year })).toStrictEqual({
        value: { publication_year: String(year) },
        fromNativeString: false,
        repairs: [],
      });
    }
  });
});

/**
 * Two caller paths can spell one dotted key the same way — a flat key beside nested objects, or
 * nested objects split at different dots — so the collision names their shapes, not one string
 * twice.
 */
describe('a collision between caller paths that read alike', () => {
  it.each([
    [
      { 'authorships.author.id': 'A1', authorships: { author: { id: 'A2' } } },
      ['authorships', 'author', 'id'],
      'once as a flat key and once as nested objects ["authorships","author","id"]',
    ],
    [
      { authorships: { author: { id: 'A2' } }, 'authorships.author.id': 'A1' },
      ['authorships.author.id'],
      'once as nested objects ["authorships","author","id"] and once as a flat key',
    ],
    [
      { 'authorships.author': { id: 'A1' }, authorships: { author: { id: 'A2' } } },
      ['authorships', 'author', 'id'],
      'once as nested objects ["authorships.author","id"] and once as nested objects ["authorships","author","id"]',
    ],
    [
      { authorships: { author: { id: 'A2' } }, 'authorships.author': { id: 'A1' } },
      ['authorships.author', 'id'],
      'once as nested objects ["authorships","author","id"] and once as nested objects ["authorships.author","id"]',
    ],
  ])('names the two shapes of %j', (raw, path, shapes) => {
    const issues = issuesOf(recordSchema.safeParse(raw));
    expect(issues).toEqual([
      {
        path,
        message: `Filter key "authorships.author.id" appears twice: ${shapes}. A filters record holds one value per key; combine alternatives with "|" in one value.`,
      },
    ]);
  });
});

/**
 * A JSON object carries `"__proto__"` as an own key, but the record Zod builds drops it, so the
 * filter would silently widen the query. No OpenAlex field has that name: it fails at the caller
 * path instead. `constructor` and `prototype` are ordinary keys and go out as given.
 */
describe('a "__proto__" filter key', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PROTO_RECORD = '{"__proto__":"true","is_oa":"true"}';
  const PROTO_MESSAGE =
    'Filter key "__proto__" names no OpenAlex field, and a filters record cannot carry it: it would be dropped, widening the query. Remove it.';

  const parsedJson = (text: string): unknown => JSON.parse(text);

  it.each([
    ['a record', recordSchema, parsedJson(PROTO_RECORD), ['__proto__']],
    ['a quoted key', recordSchema, parsedJson('{"\'__proto__\'":"true"}'), ["'__proto__'"]],
    ['a native filter string', searchSchema, '__proto__:true,is_oa:true', ['__proto__']],
  ] as const)('refuses it in %s at the caller path', (_label, schema, raw, path) => {
    expect(issuesOf(schema.safeParse(raw))).toEqual([{ path, message: PROTO_MESSAGE }]);
  });

  it('refuses it under OPENALEX_FILTER_RECORD_REPAIR=false', () => {
    mockConfig.filterRecordRepair = false;
    expect(issuesOf(recordSchema.safeParse(JSON.parse(PROTO_RECORD)))).toEqual([
      { path: ['__proto__'], message: PROTO_MESSAGE },
    ]);
  });

  it('keeps "constructor" and "prototype" as ordinary keys', () => {
    for (const repair of [true, false]) {
      mockConfig.filterRecordRepair = repair;
      expect(
        recordSchema.parse(JSON.parse('{"constructor":"x","prototype":"y","is_oa":"true"}')).value,
      ).toStrictEqual({ constructor: 'x', prototype: 'y', is_oa: 'true' });
    }
  });

  it.each(TOOLS)('%s refuses it before any request', async (_name, tool, base) => {
    const { fetchMock, result, structured, text } = await call(
      tool,
      base,
      JSON.parse(PROTO_RECORD),
    );
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(structured.error?.data.reason).toBe('invalid_arguments');
    expect(structured.error?.message).toContain(`: filters.__proto__: ${PROTO_MESSAGE}`);
    expect(structured.error?.data.recovery?.hint).toContain(PROTO_MESSAGE);
    // content[] escapes the underscores for Markdown.
    expect(text).toContain(PROTO_MESSAGE.replaceAll('_', '\\_'));
  });
});
