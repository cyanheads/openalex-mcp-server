/**
 * @fileoverview Tests for renderEntityRecord and supporting helpers.
 * @module mcp-server/tools/render-entity-record.test
 */

import { describe, expect, it } from 'vitest';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';
import { nodeTypes, renderedText } from '../../helpers/markdown.js';

describe('renderEntityRecord', () => {
  it('renders the heading from display_name', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Climate Change Paper' });
    expect(lines).toContain('### Climate Change Paper');
  });

  it('falls back to id for heading when display_name is empty', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: '' });
    expect(lines).toContain('### W001');
  });

  it('falls back to id for heading when display_name is null (gh #51)', () => {
    const lines = renderEntityRecord({ id: 'W4235673932', display_name: null, type: 'paratext' });
    expect(lines).toContain('### W4235673932');
    expect(lines).toContain('**ID:** W4235673932');
    expect(lines).toContain('**Type:** paratext');
  });

  it('always renders the ID line', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper' });
    expect(lines).toContain('**ID:** W001');
  });

  it('omits id and display_name from the field rows', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper' });
    // No field lines should re-render id or display_name
    const fieldLines = lines.filter((l) => l.startsWith('**'));
    expect(fieldLines.every((l) => !l.startsWith('**ID:** W001') || l === '**ID:** W001')).toBe(
      true,
    );
    expect(fieldLines.filter((l) => l.startsWith('**Display Name:**'))).toHaveLength(0);
  });

  it('renders scalar fields with humanized bold labels', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      publication_year: 2023,
      cited_by_count: 42,
      is_retracted: false,
    });
    expect(lines).toContain('**Publication Year:** 2023');
    expect(lines).toContain('**Cited By Count:** 42');
    expect(lines).toContain('**Is Retracted:** false');
  });

  it('renders null fields as em dash', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper', doi: null });
    expect(lines).toContain('**DOI:** —');
  });

  it('renders boolean false correctly', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper', is_oa: false });
    expect(lines).toContain('**Is OA:** false');
  });

  it('renders an array of scalars as comma-joined string', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      country_codes: ['us', 'gb', 'de'],
    });
    expect(lines).toContain('**Country Codes:** us, gb, de');
  });

  it('renders an array with nulls using em dash for null items', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      country_list: ['us', null, 'gb'],
    });
    expect(lines).toContain('**Country List:** us, —, gb');
  });

  it('renders an empty array as (empty)', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper', topics: [] });
    expect(lines).toContain('**Topics:** (empty)');
  });

  it('renders an array of objects with bracket-indexed items', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      authorships: [
        { author: { display_name: 'Alice', orcid: '0000-0001' } },
        { author: { display_name: 'Bob', orcid: null } },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('[0] author.display_name: Alice, author.orcid: 0000-0001');
    expect(text).toContain('[1] author.display_name: Bob, author.orcid: —');
  });

  it('numbers a windowed array from its start index and leaves other arrays at 0 (gh #72)', () => {
    const lines = renderEntityRecord(
      {
        id: 'W001',
        display_name: 'Paper',
        authorships: [{ author: { display_name: 'Alice' } }, { author: { display_name: 'Bob' } }],
        locations: [{ source: { display_name: 'arXiv' } }],
      },
      new Map([['authorships', { offset: 108, total: 110 }]]),
    );
    const text = lines.join('\n');
    expect(text).toContain(
      '**Authorships:** (2 of 110 shown from offset 108 — windowed; see Window)\n- [108] author.display_name: Alice\n- [109] author.display_name: Bob',
    );
    expect(text).not.toContain('- [0] author.display_name');
    expect(text).toContain('**Locations:**\n- [0] source.display_name: arXiv');
  });

  describe('windowed arrays (gh #72)', () => {
    it('marks a windowed array with no elements shown instead of rendering (empty)', () => {
      const text = renderEntityRecord(
        { id: 'W001', display_name: 'Paper', authorships: [], topics: [] },
        new Map([['authorships', { offset: 0, total: 2932 }]]),
      ).join('\n');
      expect(text).toContain('**Authorships:** (0 of 2,932 shown — windowed; see Window)');
      expect(text).not.toContain('**Authorships:** (empty)');
      // An array that really is empty keeps its marker.
      expect(text).toContain('**Topics:** (empty)');
    });

    it('marks a partly shown array of scalars on its label line', () => {
      const text = renderEntityRecord(
        { id: 'W001', display_name: 'Paper', referenced_works: ['W1', 'W2'] },
        new Map([['referenced_works', { offset: 0, total: 400 }]]),
      ).join('\n');
      expect(text).toContain(
        '**Referenced Works:** (2 of 400 shown — windowed; see Window) W1, W2',
      );
    });

    it('leaves a window that shows its whole array unmarked', () => {
      const text = renderEntityRecord(
        { id: 'W001', display_name: 'Paper', authorships: [{ author: { display_name: 'Alice' } }] },
        new Map([['authorships', { offset: 0, total: 1 }]]),
      ).join('\n');
      expect(text).toContain('**Authorships:**\n- [0] author.display_name: Alice');
      expect(text).not.toContain('windowed');
    });
  });

  it('flattens a nested plain object to dot-notation key:value pairs', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      primary_topic: {
        id: 'T1',
        display_name: 'Climate',
        subfield: { id: 'S1', display_name: 'Atm' },
      },
    });
    const text = lines.join('\n');
    expect(text).toContain(
      '**Primary Topic:** id: T1, display_name: Climate, subfield.id: S1, subfield.display_name: Atm',
    );
  });

  it('renders acronym field labels in uppercase', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      doi: '10.1038/x',
      orcid: '0000',
    });
    expect(lines).toContain('**DOI:** 10.1038/x');
    expect(lines).toContain('**ORCID:** 0000');
  });

  it('renders fwci as an uppercase acronym label', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper', fwci: 1.5 });
    expect(lines).toContain('**FWCI:** 1.5');
  });

  it('renders unknown fields with title-cased label', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper', my_custom_field: 'val' });
    expect(lines).toContain('**My Custom Field:** val');
  });

  it('renders an ids object with multiple sub-fields', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      ids: { openalex: 'https://openalex.org/W001', pmid: '12345678' },
    });
    const text = lines.join('\n');
    expect(text).toContain('openalex: https://openalex.org/W001');
    expect(text).toContain('pmid: 12345678');
  });

  it('renders an empty object field with blank value (no entries to flatten)', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper', empty_obj: {} });
    const text = lines.join('\n');
    // An empty plain object has no leaves — the label is emitted with an empty value
    expect(text).toContain('**Empty Obj:**');
  });

  it('starts with a blank line to separate from previous records', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper' });
    expect(lines[0]).toBe('');
  });

  it('handles unicode characters in display_name without corruption', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Frühjahr Analyse — 日本語' });
    expect(lines).toContain('### Frühjahr Analyse — 日本語');
  });

  it('escapes a string value carrying Markdown syntax so it renders as the literal text (gh #76)', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      summary: 'Key findings: **bold** and <html>',
    });
    const text = lines.join('\n');
    expect(text).toContain('Key findings: \\*\\*bold\\*\\* and \\<html>');
    expect(renderedText(text)).toContain('Key findings: **bold** and <html>');
  });

  // Characterization: identifier and URL leaves read the same after escaping as before it.
  it('renders URL and ID leaves byte-identical', () => {
    const record = {
      id: 'https://openalex.org/W2741809807',
      display_name: 'Paper',
      doi: 'https://doi.org/10.1002/(sici)1097-4636(199604)30:4<521::aid-jbm11>3.0.co;2-u',
      ids: {
        openalex: 'https://openalex.org/W2741809807',
        pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345678',
      },
      primary_location: {
        landing_page_url: 'https://example.org/article_view?id=12&lang=de&doc_library=a_b_',
        source: { id: 'https://openalex.org/S137773608', issn_l: '0028-0836' },
      },
      authorships: [
        {
          author: {
            id: 'https://openalex.org/A5023888391',
            orcid: 'https://orcid.org/0000-0002-1825-009X',
          },
        },
      ],
    };
    const text = renderEntityRecord(record).join('\n');
    expect(text).toContain('**ID:** https://openalex.org/W2741809807');
    expect(text).toContain(`**DOI:** ${record.doi}`);
    expect(text).toContain('openalex: https://openalex.org/W2741809807');
    expect(text).toContain('pmid: https://pubmed.ncbi.nlm.nih.gov/12345678');
    expect(text).toContain(`landing_page_url: ${record.primary_location.landing_page_url}`);
    expect(text).toContain('source.id: https://openalex.org/S137773608, source.issn_l: 0028-0836');
    expect(text).toContain('author.orcid: https://orcid.org/0000-0002-1825-009X');
  });

  describe('Markdown escaping of provider text (gh #76)', () => {
    const provider = [
      'Fish <Actinopterygii>',
      '[Ir(tpy)(ppy)H](+) and [Cd(H3L)2](ClO4)',
      '(*plastic) AND (pollut*',
      '**Figure 1 … **',
      '`code` span',
      'range 5~10 nm and 20~30 nm',
      '_emphasis_ but snake_case stays',
      'TeX \\{x\\} and \\bf and a trailing \\',
      'x &lt; y &amp; z &#38; w',
      'A < B, P<0.001, <!-- c --> <?pi?> </close>',
    ];

    it('keeps every provider string literal in the heading, labeled fields, pairs, and list items', () => {
      const text = renderEntityRecord({
        id: 'W1',
        display_name: provider.join(' | '),
        abstract: provider.join(' '),
        keywords: provider.map((display_name, i) => ({
          id: `https://openalex.org/keywords/k${i}`,
          display_name,
        })),
        primary_location: {
          raw_source_name: provider[0],
          nested: { deeper: { deepest: provider[1] } },
        },
        concepts: provider,
      }).join('\n');

      const allowed = new Set([
        'heading',
        'paragraph',
        'text',
        'strong',
        'list',
        'listItem',
        'link',
      ]);
      expect(nodeTypes(text).filter((t) => !allowed.has(t))).toEqual([]);
      const rendered = renderedText(text);
      expect(rendered.split('\n')[0]).toBe(provider.join(' | '));
      expect(rendered).toContain(`Abstract: ${provider.join(' ')}`);
      for (const [i, value] of provider.entries()) {
        expect(rendered).toContain(
          `[${i}] id: https://openalex.org/keywords/k${i}, display_name: ${value}`,
        );
      }
      expect(rendered).toContain(`nested.deeper.deepest: ${provider[1]}`);
      expect(rendered).toContain(`Concepts: ${provider.join(', ')}`);
    });

    it('keeps a trailing # in the heading as text', () => {
      const text = renderEntityRecord({ id: 'W1', display_name: 'Learning C# #' }).join('\n');
      expect(renderedText(text).split('\n')[0]).toBe('Learning C# #');
    });

    it('keeps line breaks, tabs, and edge whitespace in provider text (gh #128)', () => {
      const text = renderEntityRecord({
        id: 'W1',
        display_name: ' Paper ',
        abstract: 'para\r\n - item\n1. item\ttab\n# not a heading',
        keywords: [{ display_name: 'one\n> not a quote' }],
      }).join('\n');
      expect(nodeTypes(text).filter((t) => t === 'heading')).toHaveLength(1);
      expect(nodeTypes(text).filter((t) => t === 'list')).toHaveLength(1);
      expect(nodeTypes(text)).not.toContain('blockquote');
      const rendered = renderedText(text);
      expect(rendered.split('\n')[0]).toBe(' Paper ');
      expect(rendered).toContain('Abstract: para\n - item\n1. item\ttab\n# not a heading\n');
      expect(rendered).toContain('[0] display_name: one\n> not a quote');
    });

    it('keeps a multi-line display_name out of the heading, on a Display Name line (gh #128)', () => {
      const lines = renderEntityRecord({
        id: 'https://openalex.org/A5149007440',
        display_name: 'Wichmann, Arthur,\r\n    b. 1851.',
        works_count: 3,
      });
      expect(lines).toContain('### https://openalex.org/A5149007440');
      const text = lines.join('\n');
      expect(nodeTypes(text).filter((t) => t === 'heading')).toHaveLength(1);
      expect(renderedText(text)).toBe(
        'https://openalex.org/A5149007440\nID: https://openalex.org/A5149007440\nDisplay Name: Wichmann, Arthur,\n    b. 1851.\nWorks Count: 3',
      );
    });
  });

  /**
   * Live OpenAlex values (2026-10-28) after `provider-text.ts` normalization: content[] reads
   * back what structuredContent holds, CR and CRLF as LF (gh #128).
   */
  describe('measured multi-line provider text (gh #128)', () => {
    const W3082917150_ABSTRACT =
      'PO Puspa Jaya merupakan usaha dibidang transportasi khusunya pada transportasi BUS. Sistem pemesanan tiket PO Puspa Jaya yang sedang berjalan pada perusahaan ini sudah ada tetapi masih terdapat kekurangan-kekurangan seperti belum menerapkan sistem secara terkomputerisasi dan hanya dapat melakukan pemesanan pada loket penjualan tiket yang ada di terminal BUS, cakupan jangkauan yang tidak terlalu luas, pelanggan harus datang ke terminal BUS PO Puspa Jaya dan melakukan pemesanan pada loket yang disediakan PO Puspa Jaya. Tujuan penelitian ini adalah merancang sistem informasi pemesanan tiket PO Puspa Jaya.\r\n\r\nMetode pengembangan sistem yang digunakan dalam membagun sistem informasi tiket PO Puspa Jaya dengan metode Prototype yang diharapkan dapat membantu dalam proses membangun sistem informasi ini. Metode pengumpulan data menggunakan metode observasi (observation) dan (interview). Alat yang dipakai untuk memodelkan sistem dengan penggambaran aktor, dan Unified Modeling Language (UML). Adapun perangkat lunak yang digunakan untuk perancangan dan implementasi program aplikasi web menggunakan appserv sebagai webserver, MySQL sebagai database dan Macromedia Dreamweaver 8 sebagai editor penulisan code PHP dan HTML.\r\n\r\nHasil pengembangan perancangan aplikasi pemesanan tiket PO Puspa Jaya dapat menampilkan informasi harga, tujuan, ketersedian kursi, kontak, hingga pemesanan tiket.';
    const W2904215230_ABSTRACT =
      'The risk of hypothermia in neonates is four times higher than adult. It is possible since neonates’ body cannot perform the proper body heat production yet. The solution of hypothermia is by skin to skin contact with the mother for the first an hour after the delivery process. This research was aimed to find out the influence of early breastfeeding initiation toward body temperature change. It was quasi experimental research with pretest-posttest nonequivalent control group design. The neonates at recovery room of Kendal Islamic Hospital were the population of the research. For the sample, 26 neonates were taken as sample using purposive sampling. Paired T-test and independent samples T-test were used as the data analysis method. The average body temperature before early breast feeding initiation in intervention group was 36.2°C and after the initiation was 36.9°C. Meanwhile in control group, the average body temperature before the initiation was 36.3°C and 36.7°C after the initiation. There was influence of early breast feeding initiation toward neonatal body temperature change with p value 0.000 < α 0.05. The early breastfeeding initiation in intervention group was proven to be significant in improving body temperature of neonates. Mother’s chest temperature is able to raise 1°C from the delivery process. When the baby’s temperature drops, mother’s skin temperature raises up to 2°C to warm the baby through skin to skin contact or the conduction process. It is expected for the nurse to allow the longer early breastfeeding initiation, not only in the recovery room but also in the inpatient room for the first two hours to stabilize the body temperature of neonates.\r\n\r\nKeywords\t: Early Breastfeeding Initiation, Body Temperature of Neonates\r\nReferences\t: 44 (2007 – 2017)';
    const W2908174118_AFFILIATIONS = [
      'Key Laboratory of Ocean Energy Utilization and Energy Conservation of Ministry of Education,\nSchool of Energy and Power Engineering, Dalian University of Technology, Dalian 116024, China',
      'Key Laboratory of Ocean Energy Utilization and Energy Conservation of the Ministry of\nEducation, Dalian University of Technology, Dalian, 116024, Liaoning, P.R. China; School of Energy and Power Engineering, Dalian University of Technology, Dalian, 116024,\nLiaoning, P.R. China',
      'School of Energy and Power Engineering, Dalian University of Technology, Dalian, 116024,\nLiaoning, P.R. China',
    ];
    const lf = (s: string) => s.replace(/\r\n?/g, '\n');

    it.each([
      ['W3082917150', W3082917150_ABSTRACT],
      ['W2904215230', W2904215230_ABSTRACT],
    ])('reads the %s abstract back line for line', (id, abstract) => {
      const text = renderEntityRecord({ id, display_name: 'Paper', abstract }).join('\n');
      expect(nodeTypes(text).filter((t) => !['text', 'break'].includes(t))).toEqual([
        'heading',
        'paragraph',
        'strong',
        'strong',
      ]);
      expect(renderedText(text)).toBe(`Paper\nID: ${id}\nAbstract: ${lf(abstract)}`);
    });

    it('reads the W2908174118 raw_affiliation_strings back in their list items', () => {
      const text = renderEntityRecord({
        id: 'W2908174118',
        display_name: 'Paper',
        authorships: [
          { author_position: 'first', raw_affiliation_strings: W2908174118_AFFILIATIONS },
          { author_position: 'last', raw_affiliation_strings: [W2908174118_AFFILIATIONS[2]] },
        ],
      }).join('\n');
      expect(nodeTypes(text).filter((t) => t === 'listItem')).toHaveLength(2);
      expect(renderedText(text)).toBe(
        [
          'Paper',
          'ID: W2908174118',
          'Authorships:',
          `[0] author_position: first, raw_affiliation_strings: ${W2908174118_AFFILIATIONS.join(', ')}`,
          `[1] author_position: last, raw_affiliation_strings: ${W2908174118_AFFILIATIONS[2]}`,
        ].join('\n'),
      );
    });
  });

  it('handles deeply nested objects', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      location: { source: { host_organization: { display_name: 'Elsevier', id: 'P4310315004' } } },
    });
    const text = lines.join('\n');
    expect(text).toContain('source.host_organization.display_name: Elsevier');
    expect(text).toContain('source.host_organization.id: P4310315004');
  });

  it('renders a number 0 correctly (not as falsy blank)', () => {
    const lines = renderEntityRecord({ id: 'W001', display_name: 'Paper', cited_by_count: 0 });
    expect(lines).toContain('**Cited By Count:** 0');
  });
});
