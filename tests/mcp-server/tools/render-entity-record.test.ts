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

    it('collapses line breaks and tabs in provider text into spaces', () => {
      const text = renderEntityRecord({
        id: 'W1',
        display_name: 'Line one\n# injected heading',
        abstract: 'para\r\n - item\n1. item\ttab',
      }).join('\n');
      expect(nodeTypes(text).filter((t) => t === 'heading')).toHaveLength(1);
      expect(nodeTypes(text)).not.toContain('list');
      const rendered = renderedText(text);
      expect(rendered.split('\n')[0]).toBe('Line one # injected heading');
      expect(rendered).toContain('Abstract: para  - item 1. item tab');
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
