/**
 * @fileoverview Tests for URL redaction — ensures the polite-pool mailto and any
 * future operator-injected query params are stripped before URLs surface in errors.
 * @module services/openalex/url-redaction.test
 */

import { describe, expect, it } from 'vitest';

import { redactUrl, redactUrlsInMessage } from '@/services/openalex/url-redaction.js';

describe('redactUrl', () => {
  it('drops mailto and keeps caller-controlled params', () => {
    const redacted = redactUrl(
      'https://api.openalex.org/works?mailto=op%40example.com&search=climate',
    );
    expect(redacted).not.toContain('mailto');
    expect(redacted).not.toContain('example.com');
    expect(redacted).toContain('search=climate');
  });

  it('drops mailto regardless of param order', () => {
    const a = redactUrl('https://api.openalex.org/works?mailto=op%40example.com&select=id');
    const b = redactUrl('https://api.openalex.org/works?select=id&mailto=op%40example.com');
    expect(a).toBe(b);
    expect(a).not.toContain('mailto');
  });

  it('drops unknown params (allowlist, not denylist)', () => {
    const redacted = redactUrl(
      'https://api.openalex.org/works?api_key=secret&select=id&filter=is_oa%3Atrue',
    );
    expect(redacted).not.toContain('api_key');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('select=id');
    expect(redacted).toContain('filter=');
  });

  it('preserves all caller-controlled params', () => {
    const redacted = redactUrl(
      'https://api.openalex.org/works?mailto=x&search=foo&filter=is_oa%3Atrue&sort=cited_by_count%3Adesc&select=id&per_page=10&cursor=abc&sample=5&seed=42&group_by=type',
    );
    expect(redacted).not.toContain('mailto');
    expect(redacted).toContain('search=foo');
    expect(redacted).toContain('filter=');
    expect(redacted).toContain('sort=');
    expect(redacted).toContain('select=id');
    expect(redacted).toContain('per_page=10');
    expect(redacted).toContain('cursor=abc');
    expect(redacted).toContain('sample=5');
    expect(redacted).toContain('seed=42');
    expect(redacted).toContain('group_by=type');
  });

  it('keeps dotted search-mode keys (search.exact, search.semantic)', () => {
    expect(redactUrl('https://api.openalex.org/works?mailto=x&search.exact=foo')).toContain(
      'search.exact=foo',
    );
    expect(redactUrl('https://api.openalex.org/works?mailto=x&search.semantic=foo')).toContain(
      'search.semantic=foo',
    );
  });

  it('keeps autocomplete `q` param', () => {
    const redacted = redactUrl('https://api.openalex.org/autocomplete?mailto=x&q=harvard');
    expect(redacted).not.toContain('mailto');
    expect(redacted).toContain('q=harvard');
  });

  it('returns the input unchanged when not a parseable URL', () => {
    expect(redactUrl('not a url')).toBe('not a url');
    expect(redactUrl('')).toBe('');
  });
});

describe('redactUrlsInMessage', () => {
  it('strips mailto from the framework fetch-failure message', () => {
    const original =
      'Fetch failed for https://api.openalex.org/works/W2919115771?mailto=op%40example.com&select=id%2Cdoi. Status: 400';
    const redacted = redactUrlsInMessage(original);
    expect(redacted).not.toContain('mailto');
    expect(redacted).not.toContain('@');
    expect(redacted).not.toContain('example.com');
    expect(redacted).toContain('select=');
    expect(redacted).toContain('Status: 400');
  });

  it('preserves the trailing sentence delimiter outside the URL', () => {
    const redacted = redactUrlsInMessage(
      'Fetch failed for https://api.openalex.org/works?mailto=x. Status: 429',
    );
    expect(redacted).toMatch(/\.\s+Status: 429$/);
  });

  it('redacts URLs embedded in arbitrary text', () => {
    const redacted = redactUrlsInMessage(
      'Network error for https://api.openalex.org/works?mailto=x — connection refused',
    );
    expect(redacted).not.toContain('mailto');
    expect(redacted).toContain('connection refused');
  });

  it('passes through messages with no URL unchanged', () => {
    expect(redactUrlsInMessage('No entity found for W404.')).toBe('No entity found for W404.');
  });
});
