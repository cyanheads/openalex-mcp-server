/**
 * @fileoverview Server-specific configuration for OpenAlex API access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .default('')
    .describe(
      'OpenAlex API key or mailto email — optional (without: anonymous rate limits; with: polite pool)',
    ),
  baseUrl: z.string().url().default('https://api.openalex.org').describe('OpenAlex API base URL'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    apiKey: process.env.OPENALEX_API_KEY,
    baseUrl: process.env.OPENALEX_BASE_URL,
  });
  return _config;
}
