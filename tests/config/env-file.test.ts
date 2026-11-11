/**
 * @fileoverview The `.env` loader `src/index.ts` imports first, and the startup order that lets a
 * setting held only in `.env` reach the cached server config.
 * @module tests/config/env-file
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openalex-env-file-'));
  process.chdir(dir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  vi.doUnmock('@cyanheads/mcp-ts-core');
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Unset each variable for one test; `vi.unstubAllEnvs()` restores it over whatever `.env` wrote. */
function unsetEnv(...names: string[]) {
  for (const name of names) vi.stubEnv(name, undefined);
}

describe('the .env loader', () => {
  it('loads ./.env without overriding a variable already set', async () => {
    writeFileSync('.env', 'OPENALEX_PROBE_FROM_FILE=file\nOPENALEX_PROBE_PRESET=file\n');
    unsetEnv('OPENALEX_PROBE_FROM_FILE');
    vi.stubEnv('OPENALEX_PROBE_PRESET', 'process');

    await import('@/config/env-file.js');

    expect(process.env.OPENALEX_PROBE_FROM_FILE).toBe('file');
    expect(process.env.OPENALEX_PROBE_PRESET).toBe('process');
  });

  it('treats a missing .env as the normal case', async () => {
    await expect(import('@/config/env-file.js')).resolves.toBeDefined();
  });

  it('surfaces a .env it cannot read', async () => {
    mkdirSync('.env');
    await expect(import('@/config/env-file.js')).rejects.toThrow();
  });
});

describe('src/index.ts startup order', () => {
  /**
   * `tool()` emits each definition's input JSON Schema when its module is imported, and the count
   * inputs read the cached server config during that emission — before the framework's own `.env`
   * load inside `createApp()`. The real entry module runs here with its real imports; only
   * `createApp` is stubbed, so no transport starts.
   */
  it('loads .env before a definition module caches the server config', async () => {
    writeFileSync('.env', 'OPENALEX_API_KEY=test-key-probe\nOPENALEX_CLAMP_PER_PAGE=false\n');
    unsetEnv('OPENALEX_API_KEY', 'OPENALEX_CLAMP_PER_PAGE');
    const createApp = vi.fn(async () => undefined);
    vi.doMock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
      createApp,
    }));

    await import('@/index.js');

    expect(createApp).toHaveBeenCalledOnce();
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toMatchObject({ apiKey: 'test-key-probe', clampPerPage: false });
    const { searchEntitiesTool } = await import(
      '@/mcp-server/tools/definitions/search-entities.tool.js'
    );
    expect(
      z.toJSONSchema(searchEntitiesTool.input, { io: 'input' }).properties?.per_page,
    ).toMatchObject({ maximum: 100 });
  });
});
