// Turn an inventory into a verdict and an ordered list of what to do next.
//
// `verdict` is the single value an agent branches on; `nextActions` is the
// runbook derived from the findings.

import { Severity } from "../core/findings.mjs";
import { getAppSnapshot, newestVersionCode } from "./snapshot.mjs";

import * as bundle from "./checks/bundle.mjs";
import * as track from "./checks/track.mjs";
import * as details from "./checks/details.mjs";
import * as listing from "./checks/listing.mjs";
import * as images from "./checks/images.mjs";
import * as consoleSteps from "./checks/console.mjs";
import * as subscriptions from "./checks/subscriptions.mjs";

/** Order matters: it is the order the sections are reported and acted on. */
export const CHECKS = [consoleSteps, bundle, track, details, listing, images, subscriptions];

/**
 * @typedef {"ready"|"blocked"|"needs-human"|"rolling-out"|"halted"|"live"} Verdict
 */

/**
 * @typedef {Object} ReadinessReport
 * @property {"1"} schemaVersion
 * @property {string} generatedAt
 * @property {{ packageName: string, title?: string, defaultLanguage?: string }} app
 * @property {{ newestVersionCode: number|null, production: any|null }} release
 * @property {Array<{id: string, title: string, state: string, findingIds: string[]}>} sections
 * @property {import("../core/findings.mjs").Finding[]} findings
 * @property {{blockers: number, warnings: number, uiOnly: number, checked: number}} summary
 * @property {Verdict} verdict
 * @property {Array<{order: number, kind: "run"|"human"|"wait", label: string, command?: string, clicks?: string[], findingIds: string[]}>} nextActions
 * @property {string[]} errors
 */

/**
 * Judge a snapshot. Pure — no network, so it is testable against a fixture.
 *
 * @param {{ snapshot: any, config?: any, resolvePath?: (p: string, purpose?: string) => string }} input
 * @returns {ReadinessReport}
 */
export function buildReport({ snapshot, config = null, resolvePath }) {
  const findings = [];
  const sections = [];

  for (const check of CHECKS) {
    const produced = check.check({ snapshot, config, resolvePath });
    findings.push(...produced);
    sections.push({
      id: check.section.id,
      title: check.section.title,
      state: sectionState(produced),
      findingIds: produced.map((f) => f.id),
    });
  }

  const blockers = findings.filter((f) => f.severity === Severity.BLOCKER);
  const summary = {
    blockers: blockers.length,
    warnings: findings.filter((f) => f.severity === Severity.WARNING).length,
    uiOnly: findings.filter((f) => f.uiOnly).length,
    checked: CHECKS.length,
  };

  const primary =
    snapshot.listings?.[snapshot.locale ?? ""] ?? snapshot.listings?.[snapshot.details?.defaultLanguage ?? ""];
  const production = snapshot.tracks?.find((t) => t.track === "production") ?? null;

  return {
    schemaVersion: "1",
    generatedAt: snapshot.generatedAt,
    app: {
      packageName: snapshot.packageName,
      title: primary?.title,
      defaultLanguage: snapshot.details?.defaultLanguage,
    },
    release: { newestVersionCode: newestVersionCode(snapshot), production },
    sections,
    findings,
    summary,
    verdict: verdictFor(snapshot, findings),
    nextActions: nextActions(findings),
    errors: snapshot.errors ?? [],
  };
}

/**
 * Fetch and judge in one call.
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ locale?: string }} [opts]
 * @returns {Promise<ReadinessReport>}
 */
export async function getReadinessReport(ctx, { locale } = {}) {
  const snapshot = await getAppSnapshot(ctx, { locale });
  return buildReport({ snapshot, config: ctx.config, resolvePath: ctx.resolvePath });
}

function sectionState(findings) {
  if (findings.some((f) => f.severity === Severity.BLOCKER)) return "blocked";
  if (findings.some((f) => f.severity === Severity.WARNING)) return "incomplete";
  return "ok";
}

/**
 * The state of the world in one word. "blocked" and "needs-human" are kept apart
 * on purpose: the first means this tool can still do something, the second means
 * only a person in the Play Console can.
 *
 * @returns {Verdict}
 */
function verdictFor(snapshot, findings) {
  const blockers = findings.filter((f) => f.severity === Severity.BLOCKER);
  if (blockers.some((f) => !f.uiOnly)) return "blocked";
  if (blockers.length) return "needs-human";

  const production = snapshot.tracks?.find((t) => t.track === "production");
  const releases = production?.releases ?? [];
  if (releases.some((r) => r.status === "halted")) return "halted";
  if (releases.some((r) => r.status === "inProgress")) return "rolling-out";

  const newest = newestVersionCode(snapshot);
  const live = releases.find((r) => r.status === "completed" && (r.versionCodes ?? []).map(Number).includes(newest));
  if (newest != null && live) return "live";
  return "ready";
}

/**
 * Deduplicate findings into an ordered plan: everything this tool can fix,
 * collapsed per command, then the handful only a person can do.
 */
function nextActions(findings) {
  /** @type {ReadinessReport["nextActions"]} */
  const actions = [];
  const byCommand = new Map();

  for (const f of findings) {
    if (f.severity !== Severity.BLOCKER) continue;
    if (f.uiOnly) continue;
    const key = f.fixCommand ?? `fix:${f.id}`;
    if (!byCommand.has(key)) byCommand.set(key, { command: f.fixCommand, label: f.fix || f.title, findingIds: [] });
    byCommand.get(key).findingIds.push(f.id);
  }

  for (const [, entry] of byCommand) {
    actions.push({
      order: actions.length + 1,
      kind: "run",
      label: entry.command ? `Run ${entry.command}` : entry.label,
      command: entry.command,
      findingIds: entry.findingIds,
    });
  }

  for (const f of findings.filter((f) => f.uiOnly && f.severity === Severity.BLOCKER)) {
    actions.push({
      order: actions.length + 1,
      kind: "human",
      label: f.fix || f.title,
      clicks: f.fixClicks,
      findingIds: [f.id],
    });
  }

  const waiting = findings.find((f) => f.id === "track.rollout.in-progress");
  if (waiting) {
    actions.push({ order: actions.length + 1, kind: "wait", label: waiting.detail, findingIds: [waiting.id] });
  }

  return actions;
}
