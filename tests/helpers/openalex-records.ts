/**
 * @fileoverview Synthetic OpenAlex records sized like the real ones, for the response-budget
 * tests. An authorship here serializes to roughly 600 bytes, near the ~737 bytes a real CERN
 * collaboration authorship carries, so a few hundred of them reproduce an oversized record
 * without shipping a multi-megabyte fixture.
 * @module tests/helpers/openalex-records
 */

import type { EntityRecord } from '@/services/openalex/types.js';

/** One authorship shaped like OpenAlex's, deterministic in `i`. */
export function authorship(i: number): Record<string, unknown> {
  const institution = `https://openalex.org/I${100_000 + (i % 400)}`;
  return {
    author_position: i === 0 ? 'first' : 'middle',
    author: {
      id: `https://openalex.org/A${5_000_000_000 + i}`,
      display_name: `Collaboration Member ${i}`,
      orcid:
        i % 3 === 0
          ? `https://orcid.org/0000-0002-${String(1000 + (i % 9000)).padStart(4, '0')}-0000`
          : null,
    },
    institutions: [
      {
        id: institution,
        display_name: 'European Organization for Nuclear Research',
        ror: 'https://ror.org/01ggx4157',
        country_code: 'CH',
        type: 'facility',
        lineage: [institution],
      },
    ],
    countries: ['CH'],
    is_corresponding: false,
    raw_author_name: `C. Member${i}`,
    raw_affiliation_strings: ['CERN, Geneva, Switzerland'],
  };
}

/** A compact authorship (~120 bytes), for pages that should fit while carrying 100 of them. */
export function slimAuthorship(i: number): Record<string, unknown> {
  return { author: { id: `https://openalex.org/A${9_000_000 + i}`, display_name: `Author ${i}` } };
}

export function authorships(count: number, make = authorship): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

/**
 * A work shaped like the curated default works projection (~2 KB serialized), so 25 of them
 * reproduce a default page of about 50 KB.
 */
export function defaultWork(n: number): EntityRecord {
  return {
    id: `https://openalex.org/W${4_000_000_000 + n}`,
    doi: `https://doi.org/10.1000/example.${n}`,
    display_name: `Measurement of a process in proton-proton collisions, report ${n}`,
    publication_year: 2015 + (n % 10),
    type: 'article',
    cited_by_count: 1000 - n,
    open_access: {
      is_oa: true,
      oa_status: 'green',
      oa_url: `https://arxiv.org/abs/1501.0${1000 + n}`,
      any_repository_has_fulltext: true,
    },
    primary_topic: {
      id: 'https://openalex.org/T10048',
      display_name: 'Particle physics theoretical and experimental studies',
      score: 0.9998,
      subfield: {
        id: 'https://openalex.org/subfields/3106',
        display_name: 'Nuclear and High Energy Physics',
      },
      field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' },
      domain: { id: 'https://openalex.org/domains/3', display_name: 'Physical Sciences' },
    },
    primary_location: {
      is_oa: true,
      landing_page_url: `https://doi.org/10.1000/example.${n}`,
      pdf_url: null,
      source: {
        id: 'https://openalex.org/S4210202163',
        display_name: 'Physical Review Letters',
        issn_l: '0031-9007',
        issn: ['0031-9007', '1079-7114'],
        is_oa: false,
        is_in_doaj: false,
        is_core: true,
        host_organization: 'https://openalex.org/P4310320261',
        host_organization_name: 'American Physical Society',
        host_organization_lineage: ['https://openalex.org/P4310320261'],
        host_organization_lineage_names: ['American Physical Society'],
        type: 'journal',
      },
      license: null,
      license_id: null,
      version: 'publishedVersion',
      is_accepted: true,
      is_published: true,
    },
    best_oa_location: {
      is_oa: true,
      landing_page_url: `https://arxiv.org/abs/1501.0${1000 + n}`,
      pdf_url: `https://arxiv.org/pdf/1501.0${1000 + n}`,
      source: {
        id: 'https://openalex.org/S4306400194',
        display_name: 'arXiv (Cornell University)',
        issn_l: null,
        issn: null,
        is_oa: true,
        is_in_doaj: false,
        is_core: false,
        host_organization: 'https://openalex.org/I205783295',
        host_organization_name: 'Cornell University',
        host_organization_lineage: ['https://openalex.org/I205783295'],
        host_organization_lineage_names: ['Cornell University'],
        type: 'repository',
      },
      license: 'other-oa',
      license_id: 'https://openalex.org/licenses/other-oa',
      version: 'submittedVersion',
      is_accepted: false,
      is_published: false,
    },
  };
}

/** A works record carrying only `authorships` (plus the always-returned pair). */
export function workWithAuthorships(n: number, count: number, make = authorship): EntityRecord {
  return {
    id: `https://openalex.org/W${3_000_000_000 + n}`,
    display_name: `Collaboration paper ${n}`,
    authorships: authorships(count, make),
  };
}

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Summed UTF-8 bytes of every text block in a `CallToolResult`'s `content[]`. */
export function contentTextBytes(content: readonly { type: string; text?: string }[]): number {
  return content.reduce(
    (sum, block) => sum + (block.type === 'text' ? utf8Bytes(block.text ?? '') : 0),
    0,
  );
}
