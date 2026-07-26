/**
 * @fileoverview Tests for renderEntityRecord and supporting helpers.
 * @module mcp-server/tools/render-entity-record.test
 */

import { describe, expect, it } from 'vitest';
import { renderEntityRecord } from '@/mcp-server/tools/render-entity-record.js';

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

  it('handles a string value that contains special markdown characters', () => {
    const lines = renderEntityRecord({
      id: 'W001',
      display_name: 'Paper',
      summary: 'Key findings: **bold** and <html>',
    });
    const text = lines.join('\n');
    expect(text).toContain('Key findings: **bold** and <html>');
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
