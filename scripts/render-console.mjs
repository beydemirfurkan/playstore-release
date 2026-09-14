#!/usr/bin/env node
// src/core/console.mjs is the single source of truth for the Console-only
// steps. This writes its table into references/console.md between markers,
// and with --check fails instead of writing — the CI gate against drift.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CONSOLE_STEPS } from "../src/core/console.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "skills/playstore-release/references/console.md");
const START = "<!-- generated:start -->";
const END = "<!-- generated:end -->";
const check = process.argv.includes("--check");

const generated = [
  START,
  "",
  "| key | step | detectable by the API | answers come from |",
  "| --- | --- | --- | --- |",
  ...CONSOLE_STEPS.map(
    (s) =>
      `| \`${s.key}\` | ${s.title} | ${s.detectable ? "yes" : "no — mark it in `console.done`"} | ${s.configKeys.map((k) => `\`${k}\``).join(", ") || "—"} |`,
  ),
  "",
  ...CONSOLE_STEPS.flatMap((s) => [
    `### ${s.key}`,
    "",
    `**${s.title}.** ${s.why}`,
    "",
    `URL: \`${s.url}\``,
    "",
    `Clicks: ${s.clicks.map((c) => `**${c}**`).join(" → ")}`,
    "",
  ]),
  END,
].join("\n");

const current = readFileSync(FILE, "utf8");
const a = current.indexOf(START);
const b = current.indexOf(END);
if (a === -1 || b === -1) {
  console.error(`✗ ${FILE} is missing the ${START} / ${END} markers`);
  process.exit(1);
}
const next = current.slice(0, a) + generated + current.slice(b + END.length);
if (next === current) {
  console.error("✓ references/console.md is in sync with src/core/console.mjs");
} else if (check) {
  console.error("✗ references/console.md is stale — run: node scripts/render-console.mjs");
  process.exit(1);
} else {
  writeFileSync(FILE, next);
  console.error("✓ rewrote the generated section of references/console.md");
}
