/**
 * @fileoverview URL sanitization for error messages. Strips operator-injected query params
 * (the `api_key` account credential and the `mailto` polite-pool identifier, plus any future
 * internal additions) so they never reach MCP clients via thrown error text. `api_key` is a
 * real secret under OpenAlex usage-based pricing — the allowlist below is what keeps it out
 * of surfaced errors.
 * @module services/openalex/url-redaction
 */

/**
 * Query params the caller actually controls. Anything else on the URL (the `api_key`
 * account credential, the `mailto` polite-pool email, future auth tokens or identifiers) is
 * dropped before the URL is surfaced in an error message. Allowlist over denylist — the
 * `api_key` credential won't silently leak because nobody remembered to add it to a blocklist.
 * NEVER add `api_key` or `mailto` here.
 */
const CALLER_PARAMS = new Set([
  'q',
  'search',
  'search.exact',
  'search.semantic',
  'filter',
  'sort',
  'select',
  'per_page',
  'page',
  'cursor',
  'sample',
  'seed',
  'group_by',
]);

/** Drop every query param except the caller-controlled allowlist. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (!CALLER_PARAMS.has(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

/**
 * Scan a string for embedded URLs and redact each one. Used at the error-formatting site
 * because the framework's fetch helper formats messages as `Fetch failed for <URL>. Status: …`
 * — the URL chunk has to be sanitized in place.
 */
export function redactUrlsInMessage(message: string): string {
  return message.replace(/https?:\/\/\S+/g, (match) => {
    // Greedy match may slurp sentence punctuation (the trailing `.` in "URL. Status: …").
    // Peel it off, sanitize the body, restore the trailing chars outside the URL.
    const split = /^(.+?)([.,;)\]!]*)$/.exec(match);
    if (!split) return match;
    const [, body, trailing] = split;
    return redactUrl(body ?? match) + (trailing ?? '');
  });
}
