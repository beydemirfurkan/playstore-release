// Composition root. Wire the dependencies once and hand every operation the same
// context — operations never construct their own client or read the environment.

import { dirname } from "node:path";

import { resolveCredentials } from "./credentials.mjs";
import { findConfigPath, loadConfig } from "./config.mjs";
import { createLog } from "./events.mjs";
import { resolveProjectPath } from "./paths.mjs";
import { createTokenProvider } from "../play/auth.mjs";
import { PlayClient, DEFAULT_BASE_URL, DEFAULT_UPLOAD_BASE_URL } from "../play/client.mjs";
import { EditManager } from "../play/edits.mjs";
import { ImageUploader, BundleUploader } from "../play/uploads.mjs";

/**
 * @typedef {Object} CreateContextOptions
 * @property {import("./credentials.mjs").PlayCredentialsInput} [credentials]
 * @property {object|string} [config]        parsed object, or a path to a JSON file
 * @property {string} [projectRoot]          base for every relative path in the config
 * @property {boolean} [dryRun]
 * @property {(e: any) => void} [onEvent]    structured event sink
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [baseUrl]
 * @property {string} [uploadBaseUrl]
 * @property {string} [tokenUrl]
 * @property {{ env?: Record<string,string|undefined>, cwd?: string, random?: () => number, now?: () => number }} [runtime]
 */

/**
 * @typedef {Object} Context
 * @property {import("./credentials.mjs").PlayCredentials} credentials
 * @property {string} packageName
 * @property {string} projectRoot
 * @property {string|null} configPath
 * @property {object|null} config
 * @property {PlayClient} client
 * @property {EditManager} edit
 * @property {ImageUploader} images
 * @property {BundleUploader} bundles
 * @property {boolean} dryRun
 * @property {boolean} [keepEdit]           leave the edit open after a run (debugging)
 * @property {import("./events.mjs").Log} log
 * @property {import("./findings.mjs").Finding[]} findings
 * @property {(rel: string, purpose?: string) => string} resolvePath
 */

/**
 * Build a context. Missing credentials or config are reported as findings on the
 * returned object rather than thrown, so a caller (the MCP server especially) can
 * start up and explain itself instead of dying at construction time.
 *
 * @param {CreateContextOptions} [options]
 * @returns {Promise<Context>}
 */
export async function createContext(options = {}) {
  const { env = process.env, cwd = process.cwd(), random = Math.random, now = Date.now } = options.runtime ?? {};

  const { credentials, findings } = resolveCredentials(options.credentials ?? {}, { env });

  const configSource =
    typeof options.config === "object" && options.config !== null
      ? options.config
      : (options.config ?? findConfigPath({ env, cwd }));
  const { config, configPath } = loadConfig(configSource);

  // Relative paths belong to the config's directory, not to wherever the process
  // was started.
  const projectRoot = options.projectRoot ?? (configPath ? dirname(configPath) : cwd);

  const log = createLog({ onEvent: options.onEvent ?? null });
  const dryRun = options.dryRun ?? false;

  // Package name: explicit/env (already folded into credentials) beats config.
  const packageName = credentials?.packageName ?? config?.packageName ?? "";

  // privateKey is non-enumerable on purpose (it must never serialise), so it
  // has to be named here — a spread would silently drop it.
  const tokenProvider = credentials
    ? createTokenProvider({
        clientEmail: credentials.clientEmail,
        privateKey: credentials.privateKey,
        fetchImpl: options.fetchImpl,
        tokenUrl: options.tokenUrl,
        now,
      })
    : async () => {
        throw new Error("Google Play credentials are not configured");
      };

  const client = new PlayClient({
    tokenProvider,
    packageName,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    uploadBaseUrl: options.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE_URL,
    dryRun,
    log,
    random,
  });

  const edit = new EditManager({ client, log });

  return {
    credentials: /** @type {any} */ (credentials),
    packageName,
    projectRoot,
    configPath,
    config,
    client,
    edit,
    images: new ImageUploader(client, edit),
    bundles: new BundleUploader(client, edit),
    dryRun,
    log,
    findings,
    resolvePath: (rel, purpose) => resolveProjectPath(projectRoot, rel, { purpose }),
  };
}

/** True when the context has everything a Google Play call needs. */
export const isUsable = (ctx) => Boolean(ctx.credentials && ctx.packageName);
