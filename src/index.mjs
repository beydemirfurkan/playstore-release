// Public library API. Everything the CLI and the MCP server do, they do through
// these functions — so the two surfaces cannot drift apart in behaviour.

import { OPERATIONS, PIPELINE, getOperation, operationIds } from "./ops/registry.mjs";
import { validateConfig } from "./core/requirements.mjs";
import { Status } from "./core/status.mjs";
import { PlayApiError } from "./play/client.mjs";
import { withHints } from "./play/hints.mjs";
import { finding, Category, FixOwner } from "./core/findings.mjs";

export { createContext, isUsable } from "./core/context.mjs";
export { resolveCredentials, CredentialsError } from "./core/credentials.mjs";
export { loadConfig, findConfigPath, ConfigError, CONFIG_CANDIDATES } from "./core/config.mjs";
export { validateConfig, REQUIREMENTS, requirementsFor, CONFIG_SCHEMA } from "./core/requirements.mjs";
export { finding, Severity, Category, FixOwner, blockers, uiOnly, actionable } from "./core/findings.mjs";
export { Status, Exit } from "./core/status.mjs";
export { EventType } from "./core/events.mjs";
export { CONSOLE_STEPS, consoleUrl } from "./core/console.mjs";
export { PlayApiError, PlayClient } from "./play/client.mjs";
export { EditManager } from "./play/edits.mjs";
export { PIPELINE } from "./ops/registry.mjs";
export { getAppSnapshot } from "./report/snapshot.mjs";
export { getReadinessReport, buildReport } from "./report/report.mjs";
export { renderReportText, renderReportMarkdown } from "./report/render.mjs";

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/** Describe every operation, for help screens and MCP tool definitions. */
export function listOperations() {
  return operationIds().map((id) => ({ ...OPERATIONS[id].meta }));
}

/**
 * Run one operation. Validates the config it declares it needs *before* touching
 * the network, so a missing field is reported as "config.details.contactEmail is
 * required" rather than as a 400 from Google after an edit was opened.
 *
 * Owns the edit's fate when no pipeline does: a standalone operation that
 * mutated the edit gets it validated and committed here; one that failed gets
 * it discarded. Never throws for an operation failure — the result carries the
 * error, so a pipeline keeps going and the caller sees everything at once.
 *
 * @param {string} id
 * @param {import("./core/context.mjs").Context} ctx
 * @param {Record<string, any>} [args]
 * @returns {Promise<import("./core/events.mjs").OperationResult>}
 */
export async function runOperation(id, ctx, args = {}) {
  const op = getOperation(id);
  if (!op) throw new Error(`Unknown operation: ${id}. Known: ${operationIds().join(", ")}`);

  const started = Date.now();
  const requestsBefore = ctx.client.requestCount;
  const base = { id: op.meta.id, title: op.meta.title };

  const { findings } = validateConfig(ctx.config, { needs: op.meta.needs ?? [] });
  const missing = findings.filter((f) => f.severity === "blocker");
  if (missing.length) {
    return ctx.log.result({
      ...base,
      status: Status.ERROR,
      message: missing.map((f) => f.title).join("; "),
      findings,
      changes: [],
      durationMs: Date.now() - started,
      requestCount: 0,
    });
  }

  const argsWithDefaults = withDefaults(op.meta, args);

  try {
    const res = await op.run(ctx, argsWithDefaults);
    let edit;
    if (op.meta.edit && !ctx.edit.held) {
      edit = res.status === Status.ERROR ? await discard(ctx) : await commit(ctx);
    }
    // Under dry run an operation that reports CHANGED did not actually change
    // anything, so say so rather than claiming a mutation that never happened.
    const status = ctx.dryRun && res.status === Status.CHANGED ? Status.PLANNED : res.status;
    return ctx.log.result({
      ...base,
      ...res,
      status,
      details: edit ? { ...(res.details ?? {}), edit } : res.details,
      findings: [...findings, ...(res.findings ?? [])],
      changes: res.changes ?? [],
      durationMs: Date.now() - started,
      requestCount: ctx.client.requestCount - requestsBefore,
    });
  } catch (e) {
    withHints(e);
    if (op.meta.edit && !ctx.edit.held) await discard(ctx);
    return ctx.log.result({
      ...base,
      status: Status.ERROR,
      message: messageOf(e),
      findings: [...findings, ...(e instanceof PlayApiError ? e.hints : [])],
      changes: [],
      durationMs: Date.now() - started,
      requestCount: ctx.client.requestCount - requestsBefore,
    });
  }
}

/**
 * Run several operations in order inside ONE edit, committed once at the end.
 * Fails soft: one broken step should not hide what the remaining ones would
 * have told you — but a single ERROR means the edit is discarded, so nothing
 * half-done ever reaches Play.
 *
 * @param {readonly string[]} ids
 * @param {import("./core/context.mjs").Context} ctx
 * @param {{ stopOnError?: boolean, args?: Record<string, any> }} [opts]
 */
export async function runPipeline(ids = PIPELINE, ctx, { stopOnError = false, args = {} } = {}) {
  const results = [];
  ctx.edit.hold();
  try {
    for (const id of ids) {
      const res = await runOperation(id, ctx, args[id] ?? {});
      results.push(res);
      if (stopOnError && res.status === Status.ERROR) break;
    }
  } finally {
    ctx.edit.unhold();
  }

  const failed = results.some((r) => r.status === Status.ERROR);
  const base = { id: "edit", title: "Edit" };
  try {
    if (failed) {
      await ctx.edit.discard();
      results.push(
        ctx.log.result({ ...base, status: Status.ERROR, message: "edit discarded — nothing was committed" }),
      );
    } else {
      const edit = await commit(ctx);
      results.push(
        ctx.log.result({
          ...base,
          status:
            edit.outcome === "committed" ? Status.CHANGED : edit.outcome === "planned" ? Status.PLANNED : Status.OK,
          message:
            edit.outcome === "committed"
              ? `committed edit ${edit.id}`
              : edit.outcome === "planned"
                ? "dry run — edit discarded, nothing sent"
                : "nothing to commit",
          details: edit,
        }),
      );
    }
  } catch (e) {
    withHints(e);
    await ctx.edit.discard();
    results.push(
      ctx.log.result({
        ...base,
        status: Status.ERROR,
        message: `commit refused — ${messageOf(e)}`,
        findings: e instanceof PlayApiError ? e.hints : [],
      }),
    );
  }
  return { results, changes: ctx.log.changes() };
}

/** Commit options come from the config; `--keep-edit` from the caller. */
async function commit(ctx) {
  if (ctx.keepEdit && ctx.edit.id) {
    const id = ctx.edit.id;
    ctx.log.warn(`edit ${id} left open on request (--keep-edit); it expires on its own`);
    return { outcome: "kept", id };
  }
  try {
    return await ctx.edit.commit({ changesNotSentForReview: Boolean(ctx.config?.release?.changesNotSentForReview) });
  } catch (e) {
    throw await explainCommitRefusal(ctx, e);
  }
}

/**
 * Google answers validate/commit on an app that has never had a bundle with a
 * bare 403 "The caller does not have permission" — the same text as a missing
 * grant. The edit is still open when that happens, so one read tells the two
 * apart, and the finding names the real cause instead of sending the user to
 * re-check permissions that are fine.
 */
async function explainCommitRefusal(ctx, e) {
  if (!(e instanceof PlayApiError) || e.status !== 403 || !ctx.edit.id) return e;
  const bundles = await ctx.edit.get("/bundles", { throwOnError: false });
  if (bundles.error || (bundles.bundles ?? []).length) return e;
  e.hints = [
    finding({
      id: "bundle.first.console",
      category: Category.STORE_STATE,
      title: "The first bundle must be uploaded in the Play Console before any edit can be committed",
      detail:
        "Play refuses validate/commit with a 403 until one .aab has gone through the Console — the message is the " +
        "same as a missing permission, but this app has no bundle at all. Everything written into this edit was discarded.",
      fixOwner: FixOwner.UI,
      uiOnly: true,
      fix: "Upload the .aab once by hand to Internal testing, then re-run publish.",
      fixClicks: ["Testing", "Internal testing", "Create new release", "Upload"],
      docs: "references/console.md#firstbundle",
    }),
  ];
  return e;
}

async function discard(ctx) {
  const id = ctx.edit.id;
  await ctx.edit.discard();
  return { outcome: "discarded", id };
}

/** Apply the declared defaults from `meta.args` to what the caller passed. */
function withDefaults(meta, args) {
  const out = { ...args };
  for (const [name, spec] of Object.entries(meta.args ?? {})) {
    if (out[name] === undefined && spec.default !== undefined) out[name] = spec.default;
  }
  return out;
}
