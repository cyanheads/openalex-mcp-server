/**
 * @fileoverview The `select` input of the tools that return OpenAlex records
 * (`openalex_search_entities`, `openalex_get_citation_graph`): an array of field names, or — while
 * OPENALEX_SELECT_STRING_INPUT allows it — OpenAlex's own comma-joined `select=` string; plus the
 * log line, counter, and notices that disclose what the projection made of the names.
 * @module mcp-server/tools/select-input
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { codeSpan } from '@/mcp-server/tools/record-page.js';
import { reportSelect, splitSelectEntry } from '@/services/openalex/openalex-service.js';
import type { EntityType } from '@/services/openalex/types.js';

type SelectTool = 'openalex_search_entities' | 'openalex_get_citation_graph';

const canonicalSelect = z.array(z.string());
const { $schema: _schema, ...selectProjection } = z.toJSONSchema(canonicalSelect, { io: 'input' });

/**
 * What keeps the framework's lone-string repair from wrapping a string as a one-element list: a
 * comma or a line break (any Unicode mandatory break), either of which may join several names.
 */
const LIST_SEPARATOR = /[,\n\v\f\r\x85\p{Zl}\p{Zp}]/u;

/**
 * `select` as the handler reads it: the names, and whether they came from a comma-joined string.
 * The preprocess stands in front of the framework's lone-string repair, so it wraps a lone field
 * name itself, exactly as that repair would: a string that is not blank and holds no comma or
 * line break becomes a one-element list, as sent. A string opening `[` is left to the framework's
 * JSON repair, and an array is validated as one; each reports issues at the caller's own paths,
 * so the integer and `null` repairs still reach `select`. A comma-joined string is accepted only
 * while the switch allows it, kept whole as the one entry the service splits, and refused when it
 * names no field; with the switch off it fails as an array type mismatch, as it did before.
 */
export const selectInput = z
  .preprocess(
    (raw, ctx) => {
      if (typeof raw === 'string' && !raw.trimStart().startsWith('[')) {
        if (raw.trim() !== '' && !LIST_SEPARATOR.test(raw))
          return { value: [raw], converted: false };
        if (getServerConfig().selectStringInput) {
          const joined = raw.includes(',');
          if (joined && splitSelectEntry(raw).length > 0) return { value: [raw], converted: true };
          if (joined || raw.trim() === '') {
            ctx.addIssue({
              code: 'custom',
              message:
                'A select string must name at least one field, such as "doi,title" or "doi"; omit select for the curated default.',
            });
            return z.NEVER;
          }
        }
      }
      const parsed = canonicalSelect.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
        return z.NEVER;
      }
      return { value: parsed.data, converted: false };
    },
    z.object({ value: canonicalSelect, converted: z.boolean() }),
  )
  .meta({
    ...selectProjection,
    properties: undefined,
    required: undefined,
    additionalProperties: undefined,
  });

const selectStringConversions = createCounter(
  'openalex.select_string.conversions',
  'Comma-joined select strings converted to field lists',
  '{conversion}',
);

/** Log and count one comma-joined `select` string converted to a list. */
export function recordSelectStringConversion(tool: SelectTool, ctx: Context): void {
  ctx.log.info('Converted select string', { tool });
  selectStringConversions.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
}

/** What a call's `select` adds to the response: notice sentences, and the parents it widened to. */
export interface SelectDisclosure {
  notices: string[];
  /** Top-level fields returned whole for nested names, which a `response_too_large` hint names. */
  widenedFields: string[];
}

/**
 * The notices disclosing what the projection made of `select` — each comma-joined entry and the
 * names it split into, and each nested name answered with the top-level field holding it — and
 * the fields those widenings returned. Renames stay silent: the caller gets the field it named.
 * Names render as code spans, which hold any caller text literally.
 */
export function describeSelect(
  entityType: EntityType,
  select: readonly string[] | undefined,
): SelectDisclosure {
  const { splits, widenings } = reportSelect(entityType, select);
  const notices: string[] = [];
  if (splits.length > 0) {
    const pairs = splits.map(
      ({ entry, names }) =>
        `${codeSpan(entry)} → ${names.length > 0 ? names.map(codeSpan).join(', ') : 'no field'}`,
    );
    notices.push(`Split comma-joined \`select\` entries into field names: ${pairs.join('; ')}.`);
  }
  const byField = new Map<string, string[]>();
  for (const { field, name } of widenings) {
    const names = byField.get(field);
    if (names) names.push(name);
    else byField.set(field, [name]);
  }
  if (byField.size > 0) {
    const pairs = Array.from(
      byField,
      ([field, names]) => `${names.map(codeSpan).join(', ')} → ${codeSpan(field)}`,
    );
    const authorTip = byField.has('authorships')
      ? ' For the authors alone, select `author_list`: each author as `{id, display_name, orcid}`.'
      : '';
    notices.push(
      `\`select\` projects top-level fields only, so each nested name returned the field holding it: ${pairs.join('; ')}.${authorTip}`,
    );
  }
  return { notices, widenedFields: [...byField.keys()] };
}
