// Apply the Data safety questionnaire from the CSV the Console exports. The
// endpoint is write-only, so idempotency is local: the hash of the last CSV
// applied lives next to the config.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Status } from "../core/status.mjs";
import { finding, Category, FixOwner } from "../core/findings.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "data-safety",
  title: "Data safety",
  phase: "listing",
  needs: ["dataSafety"],
  edit: false,
  mutates: true,
  args: {
    force: { type: "boolean", default: false, description: "re-apply even if the CSV is unchanged since the last run" },
  },
};

export const STAMP = ".playstore-release/data-safety.sha256";

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ force?: boolean }} [args]
 */
export async function run({ client, config, resolvePath, projectRoot, dryRun }, args = {}) {
  const path = resolvePath(config.dataSafety.csvPath, "config.dataSafety.csvPath");
  if (!existsSync(path)) {
    return {
      status: Status.ERROR,
      message: `no CSV at ${path}`,
      findings: [
        finding({
          id: "dataSafety.csv.missing",
          category: Category.ASSET,
          title: "The Data safety CSV does not exist",
          detail: `config.dataSafety.csvPath points at ${path}.`,
          fixOwner: FixOwner.UI,
          uiOnly: true,
          fix: "Fill the questionnaire once in the Play Console, then App content → Data safety → Export to CSV.",
          fixClicks: ["Policy and programs", "App content", "Data safety", "Export"],
          docs: "references/console.md#datasafety",
        }),
      ],
    };
  }
  const csv = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(csv).digest("hex");
  const stampPath = join(projectRoot, STAMP);
  const last = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : null;

  if (last === hash && !args.force) return { status: Status.OK, message: "CSV unchanged since the last apply" };

  await client.post("/dataSafety", { safetyLabels: csv });
  if (!dryRun) {
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, hash + "\n");
  }
  return {
    status: Status.CHANGED,
    message: dryRun ? `would apply ${config.dataSafety.csvPath}` : `applied ${config.dataSafety.csvPath}`,
    details: { sha256: hash },
    findings: [
      finding({
        id: "dataSafety.review",
        category: Category.STORE_STATE,
        title: "Data safety was written; the Console still shows it as a draft until the next release is reviewed",
        severity: "info",
        fixOwner: FixOwner.UI,
        fix: "",
      }),
    ],
  };
}
