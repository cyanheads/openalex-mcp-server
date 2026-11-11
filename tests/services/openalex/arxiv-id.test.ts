/**
 * @fileoverview Tests for the arXiv identifier grammar and the notice an arXiv lookup carries.
 * @module services/openalex/arxiv-id.test
 */

import { describe, expect, it } from 'vitest';
import {
  ARXIV_SOURCE_ID,
  arxivDoi,
  arxivLandingPageUrls,
  arxivResolutionNotice,
  parseArxivId,
} from '@/services/openalex/arxiv-id.js';

describe('parseArxivId (gh #137)', () => {
  it.each([
    // new-style
    ['1706.03762', { id: '1706.03762' }],
    ['1412.6980', { id: '1412.6980' }],
    ['  1706.03762\n', { id: '1706.03762' }],
    // old-style: archive lower-cased, a two-letter subject class dropped
    ['hep-th/9901001', { id: 'hep-th/9901001' }],
    ['HEP-TH/9901001', { id: 'hep-th/9901001' }],
    ['math/0309136', { id: 'math/0309136' }],
    ['math.GT/0309136', { id: 'math/0309136' }],
    ['cond-mat.mes-hall/0101001', undefined],
    // version
    ['1706.03762v5', { id: '1706.03762', version: 'v5' }],
    ['1706.03762V12', { id: '1706.03762', version: 'v12' }],
    ['hep-th/9901001v2', { id: 'hep-th/9901001', version: 'v2' }],
    // prefix
    ['arXiv:1706.03762', { id: '1706.03762' }],
    ['ARXIV:1706.03762', { id: '1706.03762' }],
    ['arxiv:hep-th/9901001', { id: 'hep-th/9901001' }],
    // URL
    ['https://arxiv.org/abs/1706.03762', { id: '1706.03762' }],
    ['http://arxiv.org/abs/1706.03762', { id: '1706.03762' }],
    ['https://www.arxiv.org/abs/1706.03762', { id: '1706.03762' }],
    ['https://export.arxiv.org/abs/1706.03762', { id: '1706.03762' }],
    ['arxiv.org/abs/1706.03762', { id: '1706.03762' }],
    ['HTTPS://ARXIV.ORG/ABS/1706.03762', { id: '1706.03762' }],
    ['https://arxiv.org/pdf/1706.03762', { id: '1706.03762' }],
    ['https://arxiv.org/pdf/1706.03762.pdf', { id: '1706.03762' }],
    ['https://arxiv.org/pdf/1706.03762v5', { id: '1706.03762', version: 'v5' }],
    ['https://arxiv.org/pdf/1706.03762v5.pdf', { id: '1706.03762', version: 'v5' }],
    ['https://arxiv.org/abs/1706.03762v5/', { id: '1706.03762', version: 'v5' }],
    ['https://arxiv.org/abs/1706.03762?context=cs', { id: '1706.03762' }],
    ['https://arxiv.org/abs/1706.03762#S3', { id: '1706.03762' }],
    ['https://arxiv.org/pdf/1706.03762.pdf?download=1#page=2', { id: '1706.03762' }],
    ['https://arxiv.org/abs/hep-th/9901001', { id: 'hep-th/9901001' }],
    // DOI
    ['10.48550/arXiv.1706.03762', { id: '1706.03762' }],
    ['10.48550/arxiv.1706.03762', { id: '1706.03762' }],
    ['10.48550/ARXIV.1706.03762', { id: '1706.03762' }],
    ['10.48550/arXiv.1706.03762v5', { id: '1706.03762', version: 'v5' }],
    ['10.48550/arXiv.math.GT/0309136', { id: 'math/0309136' }],
    ['https://doi.org/10.48550/arXiv.1706.03762', { id: '1706.03762' }],
    ['doi:10.48550/arXiv.1706.03762', { id: '1706.03762' }],
    ['DOI:10.48550/arXiv.hep-th/9901001', { id: 'hep-th/9901001' }],
  ])('reads %j', (value, expected) => {
    expect(parseArxivId(value)).toEqual(expected);
  });

  /** Every identifier form another scheme owns, and the arXiv look-alikes, stays unread. */
  it.each([
    '10.1038/nature12373',
    '12345678',
    '1234-5678',
    '0000-0002-1825-0097',
    '013meh722',
    'PMC1234567',
    'W2741809807',
    'https://openalex.org/works/W2741809807',
    'groundwater',
    // shapes near the grammar
    '1706.037621',
    '17060.3762',
    '1706.376',
    '1706.03762v',
    '1706.03762 v5',
    '1706. 03762',
    'hep-th/990100',
    'hep-th-x/9901001',
    'math.GTX/0309136',
    'arXiv:arXiv:1706.03762',
    'arXiv: 1706.03762',
    '10.48551/arXiv.1706.03762',
    '10.48550/arXiv.',
    '10.48550/arXiv.arXiv:1706.03762',
    'http://doi.org/10.48550/arXiv.1706.03762',
    // look-alike hosts and paths
    'https://arxiv.org.evil.test/abs/1706.03762',
    'https://arxiv.org@evil.test/abs/1706.03762',
    'https://evil.test/arxiv.org/abs/1706.03762',
    'https://notarxiv.org/abs/1706.03762',
    'ftp://arxiv.org/abs/1706.03762',
    'https://arxiv.org/list/1706.03762',
    'https://arxiv.org/abs/1706.03762/extra',
    'https://arxiv.org/abs/',
  ])('leaves %j unread', (value) => {
    expect(parseArxivId(value)).toBeUndefined();
  });
});

describe('arXiv lookup values (gh #137)', () => {
  it('builds the DOI and both landing-page spellings OpenAlex stores', () => {
    expect(arxivDoi('hep-th/9901001')).toBe('10.48550/arXiv.hep-th/9901001');
    expect(arxivLandingPageUrls('2608.25542')).toEqual([
      'http://arxiv.org/abs/2608.25542',
      'https://arxiv.org/abs/2608.25542',
    ]);
    expect(ARXIV_SOURCE_ID).toBe('https://openalex.org/S4306400194');
  });
});

describe('arxivResolutionNotice (gh #137)', () => {
  it('has nothing to say about a versionless ID its DOI found', () => {
    expect(arxivResolutionNotice({ arxivId: '1706.03762', via: 'doi' })).toBeUndefined();
  });

  it('names the dropped version', () => {
    expect(arxivResolutionNotice({ arxivId: '1706.03762', droppedVersion: 'v5', via: 'doi' })).toBe(
      'Version v5 was dropped from arXiv ID 1706.03762v5: OpenAlex keeps one work per arXiv paper, not one per version, so it was looked up as 1706.03762.',
    );
  });

  it('names the billed landing-page lookup', () => {
    expect(arxivResolutionNotice({ arxivId: '2608.25542', via: 'landing_page' })).toBe(
      'No work in OpenAlex carries the DOI 10.48550/arXiv.2608.25542, so arXiv ID 2608.25542 was found by its landing page, https://arxiv.org/abs/2608.25542 — a list request OpenAlex bills ($0.0001), counted in `budget`.',
    );
  });

  it('names both, version first', () => {
    const notice = arxivResolutionNotice({
      arxivId: 'hep-th/9901001',
      droppedVersion: 'v1',
      via: 'landing_page',
    });
    expect(notice).toMatch(/^Version v1 was dropped from arXiv ID hep-th\/9901001v1: .* No work/);
    expect(notice).toContain('https://arxiv.org/abs/hep-th/9901001');
  });
});
