/**
 * @fileoverview Loads `./.env` into `process.env` before any definition module runs, so a setting
 * held only in `.env` reaches the server config. The framework loads the same file lazily, on its
 * first config read inside `createApp()`, but `tool()` emits each definition's input JSON Schema
 * when the module is imported, and the count inputs read `getServerConfig()` — which caches —
 * during that emission. Under `node` that snapshot predates the framework's load (Bun loads `.env`
 * itself at startup). Same semantics as the framework's loader: a variable already set is never
 * overridden, and a missing file is the normal case. `src/index.ts` imports this module first.
 * @module config/env-file
 */

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
