// The Play Console steps Google exposes no API for. Three of them are
// detectable from the API's behaviour (no app, no permission, no bundle); the
// rest are reported until the config says they are done, or until Play itself
// proves it by accepting a production release — which it never does while a
// declaration is missing.

import { finding, Severity, Category, FixOwner } from "../../core/findings.mjs";
import { CONSOLE_STEPS, consoleUrl } from "../../core/console.mjs";
import { existsSync } from "node:fs";

export const section = { id: "console", title: "Play Console (no API)" };

/** @param {{ snapshot: any, config: any, resolvePath?: (p: string, purpose?: string) => string }} input */
export function check({ snapshot, config, resolvePath }) {
  const out = [];
  const done = new Set(config?.console?.done ?? []);
  const status = snapshot.access?.status ?? 200;

  const human = (step, overrides = {}) =>
    finding({
      id: `console.${step.key}`,
      category: Category.STORE_STATE,
      title: step.title,
      detail: step.why,
      fixOwner: FixOwner.UI,
      uiOnly: true,
      fix: `${consoleUrl(step, config)} — then add "${step.key}" to config.console.done`,
      fixClicks: step.clicks,
      docs: `references/console.md#${step.key.toLowerCase()}`,
      ...overrides,
    });
  const info = (step, detail) =>
    finding({
      id: `console.${step.key}.done`,
      severity: Severity.INFO,
      category: Category.STORE_STATE,
      title: `${step.title} — done`,
      detail,
      fixOwner: FixOwner.UI,
      fix: "",
    });

  const byKey = Object.fromEntries(CONSOLE_STEPS.map((s) => [s.key, s]));

  // ── Bootstrap: what the API can see ────────────────────────────────────────
  if (status === 404) {
    out.push(
      human(byKey.app),
      human(byKey.firstBundle, {
        detail: "Play answers 404 for this package: either the app was never created, or it exists with no bundle yet.",
      }),
    );
    return out; // nothing else can be judged
  }
  if (status === 403) {
    out.push(
      human(byKey.serviceAccount, {
        detail: `Play answered 403${snapshot.access.reason ? `: ${snapshot.access.reason}` : ""}. Permissions granted in the Console can take up to 24 hours to apply.`,
      }),
    );
    return out;
  }
  if (status !== 200) return out; // network/other: reported in errors[]

  if (!snapshot.bundles?.length && !snapshot.tracks?.some((t) => t.releases?.length)) {
    out.push(human(byKey.firstBundle));
  }

  // ── Declarations: what only the config or a production release can tell us ─
  const production = snapshot.tracks?.find((t) => t.track === "production");
  const accepted = (production?.releases ?? []).some((r) => ["inProgress", "completed"].includes(r.status));

  for (const step of CONSOLE_STEPS.filter((s) => s.group !== "bootstrap")) {
    if (done.has(step.key)) {
      out.push(info(step, "Marked done in config.console.done."));
      continue;
    }
    if (accepted) {
      out.push(
        info(step, "Play has accepted a production release, which it does not do while a declaration is missing."),
      );
      continue;
    }
    if (step.key === "dataSafety" && config?.dataSafety?.csvPath && resolvePath) {
      // The questionnaire is filled once by hand and exported; from then on the
      // CSV is the source of truth and `data-safety` applies it.
      const path = safeResolve(resolvePath, config.dataSafety.csvPath);
      if (path && existsSync(path)) {
        out.push(
          finding({
            id: "console.dataSafety.csv",
            category: Category.STORE_STATE,
            title: "Data safety comes from the CSV",
            detail: `${config.dataSafety.csvPath} will be applied by the data-safety operation.`,
            fix: "Apply the exported questionnaire.",
            fixCommand: "playstore-release data-safety",
            docs: "references/console.md#datasafety",
          }),
        );
        continue;
      }
    }
    out.push(human(step));
  }

  return out;
}

function safeResolve(resolvePath, p) {
  try {
    return resolvePath(p, "config.dataSafety.csvPath");
  } catch {
    return null;
  }
}
