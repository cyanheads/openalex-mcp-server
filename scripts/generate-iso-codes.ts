/**
 * @fileoverview Build-time generator for the bundled ISO 3166-1 / ISO 639-2 code table.
 *
 * Fetches the ISO 3166-1 (countries) and ISO 639-2 (languages) data files of a pinned Debian
 * `iso-codes` release and writes `src/services/openalex/iso-codes.json`: the lookups the filter
 * path uses to convert country values to ISO 3166-1 alpha-2 and `language` values to ISO 639-1.
 * Bundled rather than read from `Intl`: `Intl` has no alpha-3 region data, and its language
 * canonicalization differs between Bun and Node.
 *
 * - `countries.alpha3`: uppercase alpha-3 code → alpha-2 code
 * - `countries.numeric`: three-digit numeric code → alpha-2 code
 * - `countries.names`: lowercased English short name, common name where one is listed, and the
 *   name OpenAlex displays for a country where it differs from both (`OPENALEX_COUNTRY_NAMES`) →
 *   alpha-2
 * - `languages.alpha3`: lowercased ISO 639-2 code (terminology and bibliographic) → ISO 639-1 code,
 *   for the languages that have one
 * - `languages.names`: lowercased English name (each `;`-separated alternative) → ISO 639-1 code,
 *   or the ISO 639-2 code where no ISO 639-1 code exists
 *
 * A name shared by two entries maps to neither. Run manually when a new `iso-codes` release
 * changes either standard, after bumping `ISO_CODES_TAG`:
 *   bun run generate:iso-codes
 *
 * @module scripts/generate-iso-codes
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ISO_CODES_TAG = 'v4.20.1';
const DATA_URL = `https://salsa.debian.org/iso-codes-team/iso-codes/-/raw/${ISO_CODES_TAG}/data`;

/**
 * The country names OpenAlex displays (`key_display_name` on a country `group_by`) that ISO
 * 3166-1 does not carry, with the code OpenAlex stores for each — so a name copied from an
 * OpenAlex facet converts like an ISO one. Taken from the group_by of every country key on all
 * eight entity types (2026-10-17); Kosovo's `XK` is OpenAlex's, not ISO's.
 */
const OPENALEX_COUNTRY_NAMES: [name: string, code: string][] = [
  ['Bosnia & Herzegovina', 'BA'],
  ['British Virgin Islands', 'VG'],
  ['Brunei', 'BN'],
  ['Caribbean Netherlands', 'BQ'],
  ['DR Congo', 'CD'],
  ['Dominican Rep.', 'DO'],
  ['Falkland Islands', 'FK'],
  ['Ivory Coast', 'CI'],
  ['Kosovo', 'XK'],
  ['Micronesia', 'FM'],
  ['Northern Mariana Is.', 'MP'],
  ['Palestine', 'PS'],
  ['Russia', 'RU'],
  ['Saint Martin', 'MF'],
  ['Sint Maarten', 'SX'],
  ['South Georgia & South Sandwich Is.', 'GS'],
  ['St. Kitts & Nevis', 'KN'],
  ['St. Vincent & Grenadines', 'VC'],
  ['São Tomé & Príncipe', 'ST'],
  ['Trinidad & Tobago', 'TT'],
  ['Turkey', 'TR'],
  ['Turks & Caicos Islands', 'TC'],
  ['US Virgin Islands', 'VI'],
  ['Vatican City', 'VA'],
];

interface CountryEntry {
  alpha_2: string;
  alpha_3: string;
  common_name?: string;
  name: string;
  numeric: string;
}

interface LanguageEntry {
  alpha_2?: string;
  alpha_3: string;
  bibliographic?: string;
  name: string;
}

async function fetchJson<T>(file: string, rootKey: string): Promise<T[]> {
  const response = await fetch(`${DATA_URL}/${file}`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const entries = ((await response.json()) as Record<string, T[]>)[rootKey];
  if (!entries?.length) throw new Error(`${file}: no "${rootKey}" entries`);
  return entries;
}

/** Map each name to its code, dropping a name two entries share. Keys come out sorted. */
function uniqueNames(pairs: [name: string, code: string][]): Record<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const [name, code] of pairs) {
    const key = name.trim().toLowerCase();
    byName.set(key, (byName.get(key) ?? new Set()).add(code));
  }
  const ambiguous = [...byName].filter(([, codes]) => codes.size > 1).map(([name]) => name);
  if (ambiguous.length > 0) console.log(`  dropped ambiguous names: ${ambiguous.join(', ')}`);
  return sorted(
    [...byName].flatMap(([name, codes]): [string, string][] =>
      codes.size === 1 ? [[name, [...codes][0] as string]] : [],
    ),
  );
}

function sorted(pairs: [string, string][]): Record<string, string> {
  return Object.fromEntries(pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function main(): Promise<void> {
  console.log(`Generating ISO code table from Debian iso-codes ${ISO_CODES_TAG}...\n`);

  const [countries, languages] = await Promise.all([
    fetchJson<CountryEntry>('iso_3166-1.json', '3166-1'),
    fetchJson<LanguageEntry>('iso_639-2.json', '639-2'),
  ]);
  console.log(`  ISO 3166-1: ${countries.length} countries`);
  console.log(`  ISO 639-2: ${languages.length} languages`);

  const withAlpha2 = languages.filter((l) => l.alpha_2);
  const table = {
    source: `Debian iso-codes ${ISO_CODES_TAG} (https://salsa.debian.org/iso-codes-team/iso-codes): data/iso_3166-1.json, data/iso_639-2.json; plus the country names OpenAlex displays (OPENALEX_COUNTRY_NAMES in scripts/generate-iso-codes.ts)`,
    countries: {
      alpha3: sorted(countries.map((c) => [c.alpha_3.toUpperCase(), c.alpha_2])),
      numeric: sorted(countries.map((c) => [c.numeric, c.alpha_2])),
      names: uniqueNames([
        ...countries.flatMap((c): [string, string][] => [
          [c.name, c.alpha_2],
          ...(c.common_name ? [[c.common_name, c.alpha_2] as [string, string]] : []),
        ]),
        ...OPENALEX_COUNTRY_NAMES,
      ]),
    },
    languages: {
      alpha3: sorted(
        withAlpha2.flatMap((l): [string, string][] => [
          [l.alpha_3, l.alpha_2 as string],
          ...(l.bibliographic ? [[l.bibliographic, l.alpha_2 as string] as [string, string]] : []),
        ]),
      ),
      names: uniqueNames(
        languages.flatMap((l) =>
          l.name.split(';').map((name): [string, string] => [name, l.alpha_2 ?? l.alpha_3]),
        ),
      ),
    },
  };

  const outPath = join(
    fileURLToPath(import.meta.url),
    '../../src/services/openalex/iso-codes.json',
  );
  writeFileSync(outPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  console.log(`\nWrote ${outPath}`);
}

await main();
