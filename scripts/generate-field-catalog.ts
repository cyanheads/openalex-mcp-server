/**
 * @fileoverview Build-time catalog generator for OpenAlex valid field names.
 *
 * Fetches one bogus `filter` and one bogus `select` request per entity type,
 * parses the full valid-field list from each 400 response body, and writes
 * `src/services/openalex/field-catalog.json`.
 *
 * Uses a direct `fetch` — NOT the framework's `fetchWithTimeout` — so the
 * response body is never truncated (the framework caps captured bodies at
 * 500 bytes; OpenAlex's works filter list alone is ~4800 bytes).
 *
 * Run manually when the OpenAlex field list changes:
 *   bun run generate:field-catalog
 *
 * @module scripts/generate-field-catalog
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://api.openalex.org';
const ENTITY_TYPES = [
  'works',
  'authors',
  'sources',
  'institutions',
  'topics',
  'keywords',
  'publishers',
  'funders',
  'awards',
] as const;

type EntityType = (typeof ENTITY_TYPES)[number];
type Catalog = Record<EntityType, { filter: string[]; select: string[] }>;

/**
 * Names OpenAlex lists among an entity type's valid filter fields but answers with an HTTP 400
 * as a filter, so cataloguing them would advertise keys no call can use: works
 * `semantic.search` ("is not a filter. For semantic search use the search.semantic parameter")
 * and `topics_count`, sources `is_in_jstage_since_year` ("can't be used as a filter").
 */
const UNUSABLE_FILTER_FIELDS: Partial<Record<EntityType, ReadonlySet<string>>> = {
  works: new Set(['semantic.search', 'topics_count']),
  sources: new Set(['is_in_jstage_since_year']),
};

/** Extract the comma-separated valid-field list from an OpenAlex 400 error body. */
function parseValidFields(body: string): string[] {
  let parsed: { message?: string } = {};
  try {
    parsed = JSON.parse(body) as { message?: string };
  } catch {
    // Body may be non-JSON in unexpected failure modes — proceed with empty.
    return [];
  }

  const msg = parsed.message ?? '';
  const idx = msg.indexOf('Valid fields');
  if (idx < 0) return [];

  const afterLabel = msg.slice(idx);
  const colonIdx = afterLabel.indexOf(':');
  if (colonIdx < 0) return [];

  return afterLabel
    .slice(colonIdx + 1)
    .trim()
    .replace(/\.$/, '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

async function fetchFields(
  entityType: EntityType,
  context: 'filter' | 'select',
): Promise<string[]> {
  const url =
    context === 'filter'
      ? `${BASE_URL}/${entityType}?filter=_generate_catalog_bogus_field:x`
      : `${BASE_URL}/${entityType}?select=_generate_catalog_bogus_field`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (response.status !== 400) {
    console.warn(`  [warn] ${entityType}/${context}: expected 400, got ${response.status}`);
    return [];
  }

  const body = await response.text();
  const unusable = context === 'filter' ? UNUSABLE_FILTER_FIELDS[entityType] : undefined;
  const fields = parseValidFields(body).filter((field) => !unusable?.has(field));
  console.log(`  ${entityType}/${context}: ${fields.length} fields`);
  return fields;
}

async function main(): Promise<void> {
  console.log('Generating field catalog from OpenAlex live API...\n');

  const catalog: Partial<Catalog> = {};

  for (const entityType of ENTITY_TYPES) {
    console.log(`${entityType}:`);
    const [filter, select] = await Promise.all([
      fetchFields(entityType, 'filter'),
      fetchFields(entityType, 'select'),
    ]);
    catalog[entityType] = { filter, select };
  }

  const outPath = join(
    fileURLToPath(import.meta.url),
    '../../src/services/openalex/field-catalog.json',
  );
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  writeFileSync(outPath, json, 'utf8');

  console.log(`\nWrote ${outPath}`);
}

await main();
