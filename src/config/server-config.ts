/**
 * @fileoverview Server-specific configuration for OpenAlex API access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .default('')
    .describe(
      'OpenAlex account API key, sent upstream as api_key= — optional but required for keyed rate/budget under usage-based pricing (free from https://openalex.org/settings/api; omit for anonymous access)',
    ),
  mailto: z
    .string()
    .default('')
    .describe(
      'Optional email sent upstream as mailto= to identify yourself to OpenAlex (the "polite pool"); a courtesy identifier, separate from and not a substitute for the API key',
    ),
  baseUrl: z.string().url().default('https://api.openalex.org').describe('OpenAlex API base URL'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'OPENALEX_API_KEY',
    mailto: 'OPENALEX_MAILTO',
    baseUrl: 'OPENALEX_BASE_URL',
  });
  return _config;
}
