// Config loading. Single responsibility: produce a parsed config plus the path it
// came from, or a precise reason why not. No network, no side effects.
//
// Validation lives in requirements.mjs; this module only gets the object.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export class ConfigError extends Error {}

/**
 * Searched in order when no path is given. `playstore.config.json` is what
 * `init` writes; the dotted directory is for projects that keep every store
 * artefact (config, images, data-safety CSV) together.
 */
export const CONFIG_CANDIDATES = Object.freeze(["playstore.config.json", ".playstore-release/config.json"]);

/**
 * @param {{ explicit?: string, env?: Record<string, string|undefined>, cwd?: string }} [opts]
 * @returns {string|null} absolute path, or null when there is nothing to load
 */
export function findConfigPath({ explicit, env = process.env, cwd = process.cwd() } = {}) {
  const named = explicit ?? env.PLAYSTORE_CONFIG;
  if (named) return isAbsolute(named) ? named : resolve(cwd, named);
  for (const candidate of CONFIG_CANDIDATES) {
    const p = resolve(cwd, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Accept an already-parsed object as readily as a path — a library or MCP caller
 * may hold the config in memory and should not have to write it to disk first.
 *
 * @param {string|object|null|undefined} source
 * @returns {{ config: object|null, configPath: string|null }}
 */
export function loadConfig(source) {
  if (source == null) return { config: null, configPath: null };
  if (typeof source === "object") return { config: source, configPath: null };

  let raw;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    throw new ConfigError(`Cannot read config at ${source}`);
  }
  try {
    return { config: JSON.parse(raw), configPath: resolve(source) };
  } catch (e) {
    throw new ConfigError(`Config is not valid JSON (${source}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
