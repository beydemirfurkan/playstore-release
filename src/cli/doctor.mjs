// Answer "is this machine set up correctly" before anything touches an app.
//
// Deliberately never prints a credential — only whether one is present, and
// whether Google accepts it. The probe is `edits.insert` + `edits.delete`: the
// exact permission every other operation needs, two cheap calls, no side effect.

import { createContext } from "../core/context.mjs";
import { Exit } from "../core/status.mjs";
import { Severity } from "../core/findings.mjs";
import { validateConfig } from "../core/requirements.mjs";
import { findConfigPath } from "../core/config.mjs";
import { PlayApiError } from "../play/client.mjs";
import { TokenError } from "../play/auth.mjs";

const MIN_NODE = [20, 11];

/**
 * @param {{ stdout: any, stderr: any, env: any, cwd: string, config?: string, packageName?: string, serviceAccount?: string, fetchImpl?: typeof fetch }} io
 */
export async function doctorCommand({ stdout, stderr, env, cwd, config, packageName, serviceAccount, fetchImpl }) {
  /** @type {string[]} */
  const lines = [];
  /** @type {number} */
  let worst = Exit.OK;

  const ok = (label, detail = "") => lines.push(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  const warn = (label, detail) => lines.push(`· ${label}${detail ? ` — ${detail}` : ""}`);
  /** @param {string} label @param {string} detail @param {number} [code] */
  const bad = (label, detail, code = Exit.CONFIG) => {
    lines.push(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
    worst = Math.max(worst, code);
  };

  // 1. Runtime
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) ok("Node", process.versions.node);
  else bad("Node", `${process.versions.node} is below the required ${MIN_NODE.join(".")}`);

  // 2. Config
  const configPath = findConfigPath({ explicit: config, env, cwd });
  if (!configPath) {
    warn("config", "none found — run `playstore-release init`");
  } else {
    const ctxForConfig = await createContext({ config: configPath, runtime: { env, cwd } }).catch(() => null);
    if (!ctxForConfig) {
      bad("config", `${configPath} could not be parsed`);
    } else {
      const { valid, findings } = validateConfig(ctxForConfig.config);
      if (valid) ok("config", configPath);
      else
        bad("config", `${findings.filter((f) => f.severity === Severity.BLOCKER).length} problem(s) in ${configPath}`);
      for (const f of findings) lines.push(`    ${f.severity === Severity.BLOCKER ? "✗" : "·"} ${f.title}`);
    }
  }

  // 3. Credentials — presence and shape, then whether Google accepts them
  let ctx;
  try {
    ctx = await createContext({
      credentials: { packageName, serviceAccount },
      config: configPath ?? undefined,
      fetchImpl,
      runtime: { env, cwd },
    });
  } catch (e) {
    bad("credentials", e instanceof Error ? e.message : String(e));
    return finish();
  }
  const credentialFindings = ctx.findings.filter((f) => f.severity === Severity.BLOCKER);
  if (credentialFindings.length) {
    for (const f of credentialFindings) bad(f.title, f.fix);
    return finish();
  }
  ok(
    "service account",
    `${ctx.credentials.clientEmail}${ctx.credentials.projectId ? ` (project ${ctx.credentials.projectId})` : ""}`,
  );

  if (!ctx.packageName) {
    warn("package", "PLAY_PACKAGE_NAME / config.packageName is not set — every command needs it");
    return finish();
  }
  ok("package", ctx.packageName);

  // 4. Token, then the edit probe
  try {
    await ctx.client.post("/edits", {}, { lifecycle: true }).then((e) => (ctx.edit.id = e.id));
    await ctx.edit.discard();
    ok("Google Play", `authenticated; can open an edit for ${ctx.packageName}`);
  } catch (e) {
    if (e instanceof TokenError) {
      bad(
        "Google Play",
        e.code === "invalid_grant"
          ? "invalid_grant — the private key does not belong to client_email, or this machine's clock is off"
          : e.message,
        Exit.API,
      );
    } else if (e instanceof PlayApiError && e.status === 401) {
      bad("Google Play", "401 — the token was not accepted; the key may be revoked", Exit.API);
    } else if (e instanceof PlayApiError && e.status === 403) {
      bad(
        "Google Play",
        /not been used|disabled|accessNotConfigured/i.test(e.googleMessage)
          ? "403 — enable the Google Play Android Developer API in the service account's Cloud project"
          : "403 — the service account is not invited to this app in Play Console → Users and permissions (grants can take up to 24 h)",
        Exit.API,
      );
    } else if (e instanceof PlayApiError && e.status === 404) {
      bad(
        "Google Play",
        `404 — Play has no app "${ctx.packageName}", or its first bundle was never uploaded through the Console`,
        Exit.API,
      );
    } else {
      bad("Google Play", e instanceof Error ? e.message : String(e), Exit.API);
    }
  }

  return finish();

  function finish() {
    const stream = worst === Exit.OK ? stdout : stderr;
    stream.write(lines.join("\n") + "\n");
    return worst;
  }
}
