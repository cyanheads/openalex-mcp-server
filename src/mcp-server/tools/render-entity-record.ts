/**
 * @fileoverview Markdown rendering for OpenAlex entity records — shared between
 * tool `format()` callbacks that surface entity payloads to MCP clients. Flattens
 * arbitrary upstream record shapes (works/authors/sources/etc.) to dot-pathed
 * "label: value" lines that mirror `structuredContent` field-for-field.
 * @module mcp-server/tools/render-entity-record
 */

import type { EntityRecord } from '@/services/openalex/types.js';

const ACRONYMS = new Set([
  'apc',
  'doi',
  'fwci',
  'id',
  'issn',
  'oa',
  'orcid',
  'pmcid',
  'pmid',
  'ror',
  'url',
]);

type Scalar = string | number | boolean;

function toFieldLabel(field: string): string {
  return field
    .split(/[_\-.]/g)
    .filter(Boolean)
    .map((part) =>
      ACRONYMS.has(part.toLowerCase())
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(' ');
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isScalarOrNull(value: unknown): value is Scalar | null {
  return value === null || isScalar(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Flatten a value to "path: value" strings, one per scalar leaf. Nested objects use dot
 * notation (`subfield.display_name`); arrays of scalars collapse to a single comma-joined
 * pair (`countries: us, gb`); arrays of objects produce one entry per element with bracket
 * indexing (`institutions[0].id`). All terminal values reach the output — `format()` and
 * `structuredContent` stay in parity.
 */
function flattenLeaves(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return prefix ? [`${prefix}: —`] : [];
  if (isScalar(value)) return [prefix ? `${prefix}: ${String(value)}` : String(value)];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix || 'value'}: (empty)`];
    if (value.every(isScalarOrNull)) {
      const joined = value.map((item) => (item === null ? '—' : String(item))).join(', ');
      return [prefix ? `${prefix}: ${joined}` : joined];
    }
    return value.flatMap((item, i) => flattenLeaves(item, `${prefix}[${i}]`));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return prefix ? [`${prefix}: (empty)`] : [];
    return entries.flatMap(([k, v]) => flattenLeaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix ? `${prefix}: ${String(value)}` : String(value)];
}

function compactPairs(value: Record<string, unknown>): string {
  return flattenLeaves(value).join(', ');
}

function renderField(field: string, value: unknown): string {
  const label = toFieldLabel(field);
  if (value == null) return `**${label}:** —`;
  if (isScalar(value)) return `**${label}:** ${String(value)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `**${label}:** (empty)`;
    if (value.every(isScalarOrNull)) {
      return `**${label}:** ${value.map((item) => (item === null ? '—' : String(item))).join(', ')}`;
    }
    const items = value.map((item, i) =>
      isPlainObject(item)
        ? `- [${i}] ${compactPairs(item)}`
        : `- [${i}] ${flattenLeaves(item).join(', ') || '—'}`,
    );
    return `**${label}:**\n${items.join('\n')}`;
  }
  if (isPlainObject(value)) return `**${label}:** ${compactPairs(value)}`;
  return `**${label}:** ${String(value)}`;
}

/**
 * Render an OpenAlex entity record as markdown lines: a `### display_name` header,
 * the ID, then each remaining field as a labeled line. Caller joins the lines into
 * the final text block.
 */
export function renderEntityRecord(record: EntityRecord): string[] {
  const { id, display_name, ...rest } = record;
  const lines = ['', `### ${display_name || id}`, `**ID:** ${id}`];
  for (const [field, value] of Object.entries(rest)) {
    lines.push(renderField(field, value));
  }
  return lines;
}
