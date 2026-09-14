// The tool surface, deliberately small.
//
// Raw endpoint coverage is not the scarce thing: an agent that can call
// PUT edits/{id}/tracks/production still does not know that the first bundle
// must go through the Console, that 1290×2796 screenshots are rejected, or
// that a completed production release cannot be recalled. These tools defuse
// those; each earns its place by being an outcome someone wants.

import { createContext } from "../core/context.mjs";
import { runOperation, runPipeline } from "../index.mjs";
import { getAppSnapshot } from "../report/snapshot.mjs";
import { getReadinessReport } from "../report/report.mjs";
import { renderReportMarkdown, renderSnapshotText } from "../report/render.mjs";
import { validateConfig } from "../core/requirements.mjs";
import { loadConfig, findConfigPath } from "../core/config.mjs";
import { PIPELINE } from "../ops/registry.mjs";
import { Severity } from "../core/findings.mjs";

/** @param {string} description */
const str = (description) => ({ type: "string", description });
/** @param {string} description @param {boolean} [dflt] */
const bool = (description, dflt) => ({
  type: "boolean",
  description,
  ...(dflt === undefined ? {} : { default: dflt }),
});
/** @param {string} description */
const num = (description) => ({ type: "number", description });

/**
 * Required on every mutating tool. A literal `true` cannot be produced by
 * accident, and the description tells the host what it is confirming.
 */
const confirm = {
  type: "boolean",
  const: true,
  description: "Must be true. Set it only after the human has approved this change to a live Google Play listing.",
};

const packageName = str("Android package name. Defaults to PLAY_PACKAGE_NAME or config.packageName.");
const configPath = str("Path to the config file. Defaults to the usual discovery order.");

const input = (properties, required = []) => ({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/** Shared prelude: build a context, or explain why we cannot. */
async function contextOrRefusal({ packageName: pkg, configPath: cfg, dryRun = false }, env) {
  const ctx = await createContext({ credentials: { packageName: pkg }, config: cfg, dryRun, runtime: { env } });
  const blocking = ctx.findings.filter((f) => f.severity === Severity.BLOCKER);
  if (blocking.length || !ctx.packageName) {
    return {
      refusal: structured(
        [
          "Google Play credentials are not configured for this server.",
          "",
          ...blocking.map((f) => `- **${f.title}** — ${f.fix}`),
          ...(ctx.packageName ? [] : ["- **No package name** — set PLAY_PACKAGE_NAME or config.packageName."]),
          "",
          "These are read from the MCP server's own environment, never from tool arguments:",
          "PLAY_SERVICE_ACCOUNT_JSON, PLAY_PACKAGE_NAME, PLAYSTORE_CONFIG.",
        ].join("\n"),
        { configured: false, findings: blocking },
      ),
    };
  }
  return { ctx };
}

/** A tool result carrying both a readable rendering and the raw object. */
function structured(text, data) {
  return { content: [{ type: "text", text }], structuredContent: data };
}

/** Run one operation and make sure no edit outlives the call. */
async function runAndSettle(ctx, id, args) {
  try {
    return await runOperation(id, ctx, args);
  } finally {
    await ctx.edit.discard().catch(() => {});
  }
}

const summarizeResults = (results) =>
  results.map((r) => `- ${r.status.toUpperCase()} **${r.title}**${r.message ? ` — ${r.message}` : ""}`).join("\n");

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {{readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean}} annotations
 * @property {Record<string, any>} inputSchema
 * @property {(args: any) => Promise<any>} run
 */

/**
 * Build every tool definition. Kept as data so the server, the tests and the
 * docs all read from one list.
 *
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 * @returns {ToolDef[]}
 */
export function buildTools({ env = process.env } = {}) {
  return [
    {
      name: "play_readiness_report",
      title: "Google Play readiness report",
      description:
        "The main tool. Answers 'is this app ready to go live on Google Play, and if not, what exactly is in the way, " +
        "in what order'. Read-only. Returns findings with a verdict and an ordered list of next actions, each marked as " +
        "something this tool can fix or something only a human in the Play Console can (with the clicks). Start here.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: input({ packageName, configPath, locale: str("Language to report on, e.g. tr-TR.") }),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        try {
          const report = await getReadinessReport(ctx, { locale: args.locale });
          return structured(renderReportMarkdown(report), report);
        } finally {
          await ctx.edit.discard().catch(() => {});
        }
      },
    },

    {
      name: "play_app_overview",
      title: "Google Play inventory",
      description:
        "Read-only inventory: tracks and releases, bundles, listings, graphics, contact details, testers, recent " +
        "reviews. Use it to answer questions about current state; use play_readiness_report to decide what to do.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: input({ packageName, configPath, locale: str("Language to inspect.") }),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        try {
          const snapshot = await getAppSnapshot(ctx, { locale: args.locale });
          return structured(renderSnapshotText(snapshot), snapshot);
        } finally {
          await ctx.edit.discard().catch(() => {});
        }
      },
    },

    {
      name: "play_validate_config",
      title: "Validate a config",
      description:
        "Check a config against the schema and against the rules Google enforces but does not document in one " +
        "place — listing lengths, release-note length, rollout fractions. Touches no network and needs no credentials.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: input({
        config: { type: "object", description: "The config object itself." },
        configPath: str("Or a path to read it from."),
      }),
      async run(args) {
        let config = args.config ?? null;
        if (!config) {
          const path = args.configPath ?? findConfigPath({ env });
          if (!path) return structured("No config given and none found on disk.", { valid: false, findings: [] });
          ({ config } = loadConfig(path));
        }
        const { valid, findings } = validateConfig(config);
        const text = valid
          ? "Valid. Nothing in this config will be rejected by Google Play for shape or content."
          : ["Problems found:", "", ...findings.map((f) => `- **${f.title}** — ${f.fix}`)].join("\n");
        return structured(text, { valid, findings });
      },
    },

    {
      name: "play_plan_publish",
      title: "Plan the publishing pipeline",
      description:
        "Dry-run the whole pipeline and return the exact changes it would put into an edit. Opens an edit to read " +
        "state and discards it; commits nothing. Call this before play_apply_publish so the human sees the diff first.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: input({
        packageName,
        configPath,
        only: { type: "array", items: { type: "string" }, description: `Subset of: ${PIPELINE.join(", ")}` },
      }),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal({ ...args, dryRun: true }, env);
        if (refusal) return refusal;
        const ids = args.only?.length ? args.only : PIPELINE;
        const { results, changes } = await runPipeline(ids, ctx);
        const planned = changes.filter((c) => !c.applied);
        const text = [
          `# Plan (${planned.length} change${planned.length === 1 ? "" : "s"}, nothing committed)`,
          "",
          summarizeResults(results),
          "",
          planned.length ? "## Would change" : "No changes needed — everything already matches the config.",
          ...planned.map((c) => `- ${c.action} ${c.resource}`),
        ].join("\n");
        return structured(text, { dryRun: true, results, changes });
      },
    },

    {
      name: "play_apply_publish",
      title: "Apply the publishing pipeline",
      description:
        "Write everything to Google Play in one edit: bundle, contact details, listing, graphics, the track release " +
        "and testers — then commit. Idempotent: re-running when everything already matches commits nothing. " +
        "Does not touch production; use play_promote for that.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: input(
        {
          packageName,
          configPath,
          only: { type: "array", items: { type: "string" }, description: `Subset of: ${PIPELINE.join(", ")}` },
          confirm,
        },
        ["confirm"],
      ),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        const ids = args.only?.length ? args.only : PIPELINE;
        const { results, changes } = await runPipeline(ids, ctx);
        let report;
        try {
          report = await getReadinessReport(ctx);
        } finally {
          await ctx.edit.discard().catch(() => {});
        }
        const text = [`# Applied`, "", summarizeResults(results), "", renderReportMarkdown(report)].join("\n");
        return structured(text, { results, changes, report });
      },
    },

    {
      name: "play_upload_images",
      title: "Upload store graphics",
      description:
        "Upload the icon, feature graphic and screenshots from the configured directory. Deletes remote images " +
        "that have no local counterpart only when prune is true, which it is not by default.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: input(
        {
          packageName,
          configPath,
          // The CLI prunes by default because the human typed the command; a model
          // should not discover deletion by omitting an argument.
          prune: bool("Delete remote images with no local counterpart.", false),
          reorder: bool("Delete and re-upload a set whose order differs.", false),
          confirm,
        },
        ["confirm"],
      ),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        const res = await runAndSettle(ctx, "images", { prune: args.prune, reorder: args.reorder });
        return structured(`${res.status.toUpperCase()} — ${res.message}`, res);
      },
    },

    {
      name: "play_promote",
      title: "Promote to a track",
      description:
        "Move the newest released bundle from one track to another — typically internal → production — or steer a " +
        "staged rollout (halt / resume / complete). A completed production release cannot be recalled; this tool " +
        "computes the readiness report first and refuses unless the verdict allows it, unless force is set.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: input(
        {
          packageName,
          configPath,
          from: str("Source track (default internal)."),
          to: str("Target track (default production)."),
          versionCode: num("Which bundle; default the newest on the source track."),
          userFraction: num("Staged rollout share, 0 < x < 1. Omit for a full release."),
          halt: bool("Halt the in-progress rollout on the target track.", false),
          resume: bool("Resume a halted rollout.", false),
          complete: bool("Complete the in-progress rollout.", false),
          force: bool("Promote even though the readiness report is not ready.", false),
          confirm,
        },
        ["confirm"],
      ),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        const { confirm: _c, packageName: _p, configPath: _cfg, ...opArgs } = args;
        const res = await runAndSettle(ctx, "promote", opArgs);
        return structured(`${res.status.toUpperCase()} — ${res.message}`, res);
      },
    },

    {
      name: "play_reviews",
      title: "Recent reviews",
      description: "List recent user reviews with ids, stars, text and whether a developer reply exists.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: input({
        packageName,
        configPath,
        max: num("How many (max 100, default 20)."),
        unreplied: bool("Only reviews without a reply.", false),
        translation: str("Translate review text into this language, e.g. en."),
      }),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        const res = await runAndSettle(ctx, "reviews", {
          max: args.max,
          unreplied: args.unreplied,
          translation: args.translation,
        });
        const lines = (res.details?.reviews ?? []).map(
          (r) =>
            `- ${"★".repeat(r.stars ?? 0)} ${r.author ?? "?"} (${r.id}) ${r.replied ? "[replied]" : ""}: ${r.text.slice(0, 200)}`,
        );
        return structured(lines.join("\n") || "No reviews.", res);
      },
    },

    {
      name: "play_reply_review",
      title: "Reply to a review",
      description: "Post a public developer reply to one review. Permanent and visible to everyone.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: input(
        { packageName, configPath, review: str("The review id."), text: str("The reply, ≤ 350 characters."), confirm },
        ["review", "text", "confirm"],
      ),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        const res = await runAndSettle(ctx, "review-reply", { review: args.review, text: args.text });
        return structured(`${res.status.toUpperCase()} — ${res.message}`, res);
      },
    },

    {
      name: "play_configure_subscriptions",
      title: "Configure subscriptions",
      description: "Create or update the subscriptions the config declares and activate their base plans.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: input({ packageName, configPath, confirm }, ["confirm"]),
      async run(args) {
        const { ctx, refusal } = await contextOrRefusal(args, env);
        if (refusal) return refusal;
        const res = await runAndSettle(ctx, "subscriptions", {});
        return structured(`${res.status.toUpperCase()} — ${res.message}`, res);
      },
    },
  ];
}

export { structured };
