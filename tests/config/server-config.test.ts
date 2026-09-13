/**
 * @fileoverview Environment normalization at the OpenAlex configuration boundary.
 * @module tests/config/server-config
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('OpenAlex environment configuration', () => {
  it.each(['', `\${OPENALEX_API_KEY}`])(
    'treats unset host values (%s) as absent',
    async (value) => {
      vi.stubEnv('OPENALEX_API_KEY', value);
      vi.stubEnv('OPENALEX_MAILTO', value);
      vi.stubEnv('OPENALEX_BASE_URL', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(getServerConfig()).toEqual({
        apiKey: '',
        mailto: '',
        baseUrl: 'https://api.openalex.org',
      });
    },
  );

  it('preserves supplied values, including embedded placeholder text', async () => {
    vi.stubEnv('OPENALEX_API_KEY', `key-\${suffix}`);
    vi.stubEnv('OPENALEX_MAILTO', 'researcher@example.org');
    vi.stubEnv('OPENALEX_BASE_URL', 'https://example.org/api');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      apiKey: `key-\${suffix}`,
      mailto: 'researcher@example.org',
      baseUrl: 'https://example.org/api',
    });
  });

  it('names the environment variable when a supplied URL is invalid', async () => {
    vi.stubEnv('OPENALEX_BASE_URL', 'not-a-url');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow('OPENALEX_BASE_URL');
  });
});
