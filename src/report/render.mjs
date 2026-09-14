// Three renderings of one object: terminal text, markdown for a model, and the
// raw object for --json and MCP structuredContent. Computed once, shown three
// ways — so the CLI and an agent can never disagree about what is wrong.

import { Severity } from "../core/findings.mjs";

const VERDICT_LINE = {
  ready: "READY — nothing is blocking; promote when you want it live",
  blocked: "BLOCKED — there is still work this tool can do",
  "needs-human": "NEEDS YOU — only the Play Console can finish these",
  "rolling-out": "ROLLING OUT — a staged production release is in progress",
  halted: "HALTED — the production rollout is paused",
  live: "LIVE — the newest bundle is fully released to production",
};

/**
 * @param {import("./report.mjs").ReadinessReport} report
 * @returns {string}
 */
export function renderReportText(report) {
  const lines = [];
  const rule = "─".repeat(58);

  const vc = report.release?.newestVersionCode;
  lines.push(
    `\nReadiness — ${report.app?.title ?? report.app?.packageName ?? "app"} · ${vc != null ? `versionCode ${vc}` : "no bundle"}`,
    rule,
  );
  lines.push(VERDICT_LINE[report.verdict] ?? report.verdict);

  lines.push("");
  for (const s of report.sections) {
    const icon = s.state === "ok" ? "✓" : s.state === "incomplete" ? "·" : "✗";
    lines.push(`${icon} ${s.title}`);
  }

  const shown = report.findings.filter((f) => f.severity !== Severity.INFO);
  if (shown.length) {
    lines.push("", `Findings (${report.summary.blockers} blocking, ${report.summary.warnings} warnings)`, rule);
    for (const f of shown) {
      const tag = f.severity === Severity.BLOCKER ? (f.uiOnly ? "[you]" : "[fix]") : "[warn]";
      lines.push(`${tag} ${f.title}`);
      if (f.detail) lines.push(`      ${f.detail}`);
    }
  }

  if (report.nextActions.length) {
    lines.push("", "Next, in order", rule);
    for (const a of report.nextActions) {
      lines.push(`${a.order}. ${a.label}`);
      if (a.command) lines.push(`   $ ${a.command}`);
      if (a.clicks?.length) lines.push(`   ${a.clicks.join(" → ")}`);
    }
  }

  if (report.errors.length) {
    lines.push("", "Could not read", rule, ...report.errors.map((e) => `  ${e}`));
  }

  return lines.join("\n");
}

/**
 * Markdown for a model. Deliberately not raw JSON: language models follow a
 * numbered list and a small table far more reliably than a nested object.
 *
 * @param {import("./report.mjs").ReadinessReport} report
 * @returns {string}
 */
export function renderReportMarkdown(report) {
  const out = [];
  const vc = report.release?.newestVersionCode;

  out.push(
    `# Readiness: ${report.app?.title ?? report.app?.packageName ?? "app"} — ${vc != null ? `versionCode ${vc}` : "no bundle"}`,
  );
  out.push("");
  out.push(`**Verdict: ${report.verdict}** — ${VERDICT_LINE[report.verdict] ?? ""}`);
  out.push(
    `${report.summary.blockers} blocking · ${report.summary.warnings} warnings · ` +
      `${report.summary.uiOnly} that only a human can resolve`,
  );

  const blocking = report.findings.filter((f) => f.severity === Severity.BLOCKER);
  if (blocking.length) {
    out.push("", "## Blocking", "", "| what | who fixes it | how |", "| --- | --- | --- |");
    for (const f of blocking) {
      const who = f.uiOnly ? "you (no API exists)" : "this tool";
      const how = f.fixCommand ? `\`${f.fixCommand}\`` : f.fixClicks?.length ? f.fixClicks.join(" → ") : f.fix;
      out.push(`| ${f.title} | ${who} | ${how} |`);
    }
  }

  const warnings = report.findings.filter((f) => f.severity === Severity.WARNING);
  if (warnings.length) {
    out.push("", "## Warnings", "");
    for (const f of warnings) out.push(`- **${f.title}** — ${f.detail} _${f.fix}_`);
  }

  if (report.nextActions.length) {
    out.push("", "## Do this next, in order", "");
    for (const a of report.nextActions) {
      const suffix = a.command ? ` — \`${a.command}\`` : a.clicks?.length ? ` — ${a.clicks.join(" → ")}` : "";
      out.push(`${a.order}. ${a.label}${suffix}`);
    }
  }

  if (report.errors.length) {
    out.push("", "## Could not read", "", ...report.errors.map((e) => `- ${e}`));
  }

  return out.join("\n");
}

/**
 * The inventory, as text. Used by `status`.
 * @param {import("./snapshot.mjs").AppSnapshot} s
 */
export function renderSnapshotText(s) {
  const lines = [];
  const rule = "─".repeat(58);
  const push = (title, rows) => {
    lines.push("", title, rule);
    lines.push(...(rows.length ? rows : ["  (none)"]));
  };

  const primary = s.listings?.[s.locale ?? ""] ?? Object.values(s.listings ?? {})[0];
  lines.push(`\n${primary?.title ?? "(no listing)"} · ${s.packageName} · default ${s.details?.defaultLanguage ?? "?"}`);
  if (s.access.status !== 200)
    lines.push(`access: HTTP ${s.access.status}${s.access.reason ? ` — ${s.access.reason}` : ""}`);

  push(
    "Tracks",
    (s.tracks ?? []).flatMap((t) =>
      (t.releases ?? []).length
        ? t.releases.map(
            (r) =>
              `  ${t.track.padEnd(11)} ${r.status ?? "?"}` +
              ` · versionCodes ${(r.versionCodes ?? []).join(",") || "-"}` +
              (r.userFraction != null ? ` · ${Math.round(r.userFraction * 100)}%` : "") +
              (r.name ? ` · ${r.name}` : ""),
          )
        : [`  ${t.track.padEnd(11)} (no release)`],
    ),
  );

  push(
    "Bundles",
    (s.bundles ?? [])
      .slice()
      .sort((a, b) => Number(b.versionCode) - Number(a.versionCode))
      .slice(0, 8)
      .map((b) => `  versionCode ${b.versionCode} · sha1 ${(b.sha1 ?? "").slice(0, 12)}`),
  );

  push(
    "Listings",
    Object.values(s.listings ?? {}).map(
      (l) =>
        `  ${l.language.padEnd(7)} ${l.title ?? "(no title)"} · short ${(l.shortDescription ?? "").length} · full ${(l.fullDescription ?? "").length}`,
    ),
  );

  push(
    "Images",
    Object.entries(s.images ?? {}).flatMap(([lang, types]) =>
      Object.entries(types)
        .filter(([, arr]) => arr.length)
        .map(([type, arr]) => `  ${lang.padEnd(7)} ${type.padEnd(22)} ${arr.length}`),
    ),
  );

  lines.push(
    "",
    "Details",
    rule,
    `  contact: ${s.details?.contactEmail ?? "NOT SET"}${s.details?.contactWebsite ? ` · ${s.details.contactWebsite}` : ""}`,
  );

  if (Object.keys(s.testers ?? {}).length) {
    push(
      "Testers",
      Object.entries(s.testers).map(([t, g]) => `  ${t.padEnd(11)} ${g.length ? g.join(", ") : "(none)"}`),
    );
  }
  if (s.reviews)
    lines.push("", "Reviews", rule, `  ${s.reviews.total} recent · ${s.reviews.unreplied} without a reply`);
  if (s.subscriptions?.length) {
    push(
      "Subscriptions",
      s.subscriptions.map(
        (sub) => `  ${sub.productId} · ${(sub.basePlans ?? []).map((b) => `${b.basePlanId}:${b.state}`).join(" ")}`,
      ),
    );
  }

  if (s.errors.length)
    push(
      "Could not read",
      s.errors.map((e) => `  ${e}`),
    );

  return lines.join("\n");
}
