// Turn "whatever the caller gave us" into a validated Google service account.
// Explicit input wins over the environment, so one process can serve several
// apps — which is what the MCP server and any library consumer need.

import { readFileSync } from "node:fs";
import { finding, Severity, Category, FixOwner } from "./findings.mjs";

export class CredentialsError extends Error {}

/**
 * @typedef {Object} PlayCredentialsInput
 * @property {string} [serviceAccount]   path to the service-account JSON, the JSON itself, or its base64
 * @property {string} [packageName]
 */

/**
 * @typedef {Object} PlayCredentials
 * @property {string} clientEmail
 * @property {string} privateKey   PEM text (non-enumerable)
 * @property {string} [projectId]
 * @property {string} [packageName]
 */

const PEM_MARKER = "-----BEGIN PRIVATE KEY-----";
const SA_EMAIL_RE = /\.iam\.gserviceaccount\.com$/;
export const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/**
 * Accept the service account as a path, as inline JSON, or as base64 of the
 * JSON — so it can travel in an environment variable where writing a file is
 * not an option (CI, containers, an MCP host's env block).
 *
 * @param {string} value
 * @returns {{ json: any, source: "inline"|"base64"|"path" }}
 */
function toJson(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) return { json: parse(trimmed, "inline JSON"), source: "inline" };

  let decoded = "";
  try {
    decoded = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    /* not base64 — fall through to path */
  }
  if (decoded.trim().startsWith("{")) return { json: parse(decoded, "base64 JSON"), source: "base64" };

  let raw;
  try {
    raw = readFileSync(trimmed, "utf8");
  } catch {
    throw new CredentialsError(`Cannot read the service account JSON at ${trimmed}`);
  }
  return { json: parse(raw, trimmed), source: "path" };
}

function parse(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CredentialsError(`The service account (${what}) is not valid JSON`);
  }
}

/**
 * Resolve credentials from explicit input, falling back to the environment.
 * Never throws for *missing* values — it reports them as findings so the caller
 * decides whether that is fatal. It does throw for values that are present but
 * unusable (an unreadable file, invalid JSON), because there is nothing to
 * report about.
 *
 * @param {PlayCredentialsInput} [input]
 * @param {{ env?: Record<string, string|undefined> }} [runtime]
 * @returns {{ credentials: PlayCredentials|null, findings: import("./findings.mjs").Finding[] }}
 */
export function resolveCredentials(input = {}, { env = process.env } = {}) {
  const source = input.serviceAccount ?? env.PLAY_SERVICE_ACCOUNT_JSON;
  const packageName = input.packageName ?? env.PLAY_PACKAGE_NAME;

  /** @type {import("./findings.mjs").Finding[]} */
  const findings = [];

  if (!source) {
    findings.push(
      finding({
        id: "account.credentials.serviceAccount",
        severity: Severity.BLOCKER,
        category: Category.ACCOUNT,
        title: "No PLAY_SERVICE_ACCOUNT_JSON",
        detail: "PLAY_SERVICE_ACCOUNT_JSON is not set and no service account was passed in.",
        fixOwner: FixOwner.EXTERNAL,
        fix: "Point PLAY_SERVICE_ACCOUNT_JSON at the service-account key file downloaded from Google Cloud, or put its JSON (or base64) inline.",
        docs: "references/setup.md",
      }),
    );
  }

  if (packageName && !PACKAGE_RE.test(packageName)) {
    findings.push(
      finding({
        id: "account.credentials.packageName.malformed",
        severity: Severity.BLOCKER,
        category: Category.ACCOUNT,
        title: "PLAY_PACKAGE_NAME is not an Android package name",
        detail: `Got "${packageName}". Expected something like com.example.app — at least two dot-separated segments.`,
        fixOwner: FixOwner.EXTERNAL,
        fix: "Copy applicationId from android/app/build.gradle (or appId from capacitor.config).",
      }),
    );
  }

  if (!source) return { credentials: null, findings };

  const { json } = toJson(source);

  if (json.type !== "service_account") {
    findings.push(
      finding({
        id: "account.credentials.type",
        severity: Severity.BLOCKER,
        category: Category.ACCOUNT,
        title: "The JSON is not a service account key",
        detail: `Its "type" is ${JSON.stringify(json.type)}; a key downloaded from IAM → Service accounts → Keys says "service_account".`,
        fixOwner: FixOwner.EXTERNAL,
        fix: "Create a JSON key for the service account in Google Cloud Console and use that file.",
        docs: "references/setup.md#service-account",
      }),
    );
  }
  const clientEmail = json.client_email;
  if (typeof clientEmail !== "string" || !SA_EMAIL_RE.test(clientEmail)) {
    findings.push(
      finding({
        id: "account.credentials.clientEmail",
        severity: Severity.BLOCKER,
        category: Category.ACCOUNT,
        title: "The service account has no usable client_email",
        detail: `Expected an address ending in .iam.gserviceaccount.com, got ${JSON.stringify(clientEmail)}.`,
        fixOwner: FixOwner.EXTERNAL,
        fix: "Use the JSON key of a service account, not an OAuth client or an API key.",
      }),
    );
  }
  const privateKey = json.private_key;
  if (typeof privateKey !== "string" || !privateKey.includes(PEM_MARKER)) {
    findings.push(
      finding({
        id: "account.credentials.privateKey",
        severity: Severity.BLOCKER,
        category: Category.ACCOUNT,
        title: "The service account JSON carries no private key",
        detail: "private_key must be a PKCS#8 PEM block. A key created without downloading it has none.",
        fixOwner: FixOwner.EXTERNAL,
        fix: "Create a new JSON key in Google Cloud Console → IAM → Service accounts → Keys → Add key.",
      }),
    );
  }

  if (findings.some((f) => f.severity === Severity.BLOCKER)) return { credentials: null, findings };

  const credentials = { clientEmail, projectId: json.project_id, packageName, privateKey };
  // Keep the key out of console.log, JSON.stringify, --json output and MCP results.
  Object.defineProperty(credentials, "privateKey", { value: privateKey, enumerable: false, writable: false });
  return { credentials, findings };
}
