// Move a versionCode from one track to another — typically internal →
// production — or steer a production rollout: halt, resume, widen, complete.
//
// Irreversible in the sense that matters: a completed production release
// cannot be recalled through the API, only halted (if staged) or superseded.

import { Status } from "../core/status.mjs";
import { getReadinessReport } from "../report/report.mjs";
import { desiredRelease, sameRelease } from "./release.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "promote",
  title: "Promote",
  phase: "release",
  needs: [],
  edit: true,
  mutates: true,
  irreversible: true,
  args: {
    from: { type: "string", default: "internal", description: "source track" },
    to: { type: "string", default: "production", description: "target track" },
    versionCode: { type: "number", description: "which bundle (default: the newest released on --from)" },
    userFraction: { type: "number", description: "staged rollout share, 0 < x < 1 (default: full release)" },
    draft: {
      type: "boolean",
      default: false,
      description:
        "create the release as a draft — required for an app that has never been published; submit it afterwards from the Console's publishing overview",
    },
    halt: { type: "boolean", default: false, description: "halt the in-progress rollout on --to" },
    resume: { type: "boolean", default: false, description: "resume a halted rollout on --to" },
    complete: { type: "boolean", default: false, description: "complete the in-progress rollout on --to" },
    force: { type: "boolean", default: false, description: "promote even though the readiness report is not ready" },
  },
};

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ from?: string, to?: string, versionCode?: number, userFraction?: number, draft?: boolean, halt?: boolean, resume?: boolean, complete?: boolean, force?: boolean }} [args]
 */
export async function run(ctx, args = {}) {
  const { edit, config, dryRun } = ctx;
  const to = args.to ?? "production";

  // ── Steering an existing rollout ───────────────────────────────────────────
  if (args.halt || args.resume || args.complete) {
    const current = await edit.get(`/tracks/${encodeURIComponent(to)}`, { throwOnError: false });
    const releases = current.error ? [] : (current.releases ?? []);
    const target = releases.find((r) => ["inProgress", "halted"].includes(r.status));
    if (!target)
      return {
        status: Status.ERROR,
        message: `no staged rollout on ${to} to ${args.halt ? "halt" : args.resume ? "resume" : "complete"}`,
      };
    const status = args.halt ? "halted" : args.resume ? "inProgress" : "completed";
    if (target.status === status) return { status: Status.OK, message: `${to} rollout is already ${status}` };
    const updated = { ...target, status };
    if (status === "completed") delete updated.userFraction;
    if (status === "inProgress" && args.userFraction != null) updated.userFraction = args.userFraction;
    const kept = status === "completed" ? [] : releases.filter((r) => r !== target && r.status === "completed");
    await edit.put(`/tracks/${encodeURIComponent(to)}`, { track: to, releases: [updated, ...kept] });
    return {
      status: Status.CHANGED,
      message: `${to} rollout ${dryRun ? "would be" : "is now"} ${status}`,
      details: { track: to, release: updated },
    };
  }

  // ── Promotion ──────────────────────────────────────────────────────────────
  // The guardrail a plain API wrapper cannot offer: we know what "ready" means,
  // so we can decline to send Google a production release it will bounce.
  if (!args.force) {
    const report = await getReadinessReport(ctx);
    if (!["ready", "live", "rolling-out"].includes(report.verdict)) {
      return {
        status: Status.ERROR,
        message: `not ready to promote (${report.verdict}); pass --force to promote anyway`,
        details: report,
        findings: report.findings,
      };
    }
  }

  const from = args.from ?? "internal";
  const source = await edit.get(`/tracks/${encodeURIComponent(from)}`, { throwOnError: false });
  const sourceReleases = source.error ? [] : (source.releases ?? []);
  const sourceRelease = args.versionCode
    ? sourceReleases.find((r) => (r.versionCodes ?? []).map(Number).includes(Number(args.versionCode)))
    : newestRelease(sourceReleases);
  if (!sourceRelease) {
    return {
      status: Status.ERROR,
      message: `nothing on ${from} to promote${args.versionCode ? ` (versionCode ${args.versionCode})` : ""}`,
    };
  }
  const versionCode = Math.max(...(sourceRelease.versionCodes ?? []).map(Number));

  // A never-published ("draft") app refuses any release that is not a draft:
  // 400 "Only releases with status draft may be created on draft app".
  const status = args.draft ? "draft" : args.userFraction != null ? "inProgress" : "completed";
  const wanted = desiredRelease({
    config,
    versionCode,
    status,
    userFraction: args.userFraction,
    name: sourceRelease.name,
  });
  // Carry the source's release notes when the config has none.
  if (!wanted.releaseNotes && sourceRelease.releaseNotes?.length) wanted.releaseNotes = sourceRelease.releaseNotes;

  const target = await edit.get(`/tracks/${encodeURIComponent(to)}`, { throwOnError: false });
  const targetReleases = target.error ? [] : (target.releases ?? []);
  const existing = targetReleases.find((r) => (r.versionCodes ?? []).map(Number).includes(versionCode));
  if (existing && sameRelease(existing, wanted)) {
    return { status: Status.OK, message: `versionCode ${versionCode} already ${wanted.status} on ${to}` };
  }
  const others = targetReleases.filter((r) => r !== existing);
  const kept = wanted.status === "completed" ? [] : others.filter((r) => r.status === "completed");
  await edit.put(`/tracks/${encodeURIComponent(to)}`, { track: to, releases: [wanted, ...kept] });

  const share = wanted.userFraction != null ? ` at ${Math.round(wanted.userFraction * 100)}%` : "";
  const draftNote = args.draft ? " as a draft — submit it from the Console: Publishing overview → Send for review" : "";
  return {
    status: Status.CHANGED,
    message: `${dryRun ? "would promote" : "promoted"} versionCode ${versionCode} from ${from} to ${to}${share}${draftNote}`,
    details: { from, to, versionCode, release: wanted, draft: Boolean(args.draft) },
  };
}

function newestRelease(releases) {
  return releases
    .filter((r) => (r.versionCodes ?? []).length)
    .sort((a, b) => Math.max(...b.versionCodes.map(Number)) - Math.max(...a.versionCodes.map(Number)))[0];
}
