// Resources an agent can read on demand. The gotchas and console files are the
// most valuable things in this package: the accumulated cost of every Google
// Play surprise, and the exact clicks for what Google keeps Console-only.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

/** @type {Array<{uri: string, name: string, title: string, description: string, mimeType: string, load: () => string}>} */
export const RESOURCES = [
  {
    uri: "playstore-release://gotchas",
    name: "gotchas",
    title: "Google Play pitfalls",
    description:
      "Every failure mode hit in practice, with the exact error text and the fix: the first bundle that must go " +
      "through the Console, permissions that take a day to apply, the screenshot aspect rule, the missing " +
      "feature graphic, tracks and staged rollouts. Read this before diagnosing any 400/403/404.",
    mimeType: "text/markdown",
    load: () => read("skills/playstore-release/references/gotchas.md"),
  },
  {
    uri: "playstore-release://console",
    name: "console",
    title: "Play Console steps with no API",
    description:
      "Every form Google exposes only in the Play Console — app creation, declarations, content rating, app " +
      "access, category, pricing, countries — as URL + click sequence + which config field answers each box. " +
      "Written so a browser agent can execute it.",
    mimeType: "text/markdown",
    load: () => read("skills/playstore-release/references/console.md"),
  },
  {
    uri: "playstore-release://runbook",
    name: "runbook",
    title: "Publishing runbook",
    description: "The end-to-end procedure for getting an Android app live on Google Play.",
    mimeType: "text/markdown",
    load: () => read("skills/playstore-release/SKILL.md"),
  },
  {
    uri: "playstore-release://config-schema",
    name: "config-schema",
    title: "Config JSON Schema",
    description: "The full shape of the config file, with a description on every field. Use it to author one.",
    mimeType: "application/json",
    load: () => JSON.stringify(require("../../schemas/config.schema.json"), null, 2),
  },
  {
    uri: "playstore-release://config-template",
    name: "config-template",
    title: "Config template",
    description: "A filled-in starting point matching the schema.",
    mimeType: "application/json",
    load: () => read("skills/playstore-release/references/config-template.json"),
  },
  {
    uri: "playstore-release://references/assets",
    name: "assets-guide",
    title: "Producing Play Store graphics",
    description: "Exact rules for the icon, feature graphic and screenshots, and how to render them.",
    mimeType: "text/markdown",
    load: () => read("skills/playstore-release/references/assets.md"),
  },
  {
    uri: "playstore-release://references/setup",
    name: "setup-guide",
    title: "Service account and permissions",
    description: "Creating the service account, enabling the API, inviting it in the Play Console.",
    mimeType: "text/markdown",
    load: () => read("skills/playstore-release/references/setup.md"),
  },
];

/** @param {string} rel */
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
