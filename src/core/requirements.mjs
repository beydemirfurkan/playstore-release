// What each operation needs from the config, declared once instead of re-checked
// ad hoc inside every operation. `meta.needs` is enforced by runOperation before
// the network is touched, so a missing field surfaces as "config.details.contactEmail
// is required" rather than as a 400 from Google after an edit was opened.

import { createRequire } from "node:module";

import { finding, Severity, Category, FixOwner } from "./findings.mjs";
import { validateAgainstSchema } from "./schema.mjs";
import { resolveLocales } from "./locales.mjs";

/** The published schema, also served by `playstore-release schema`. */
export const CONFIG_SCHEMA = createRequire(import.meta.url)("../../schemas/config.schema.json");

/** Config concerns → the key paths that must be present. */
export const REQUIREMENTS = Object.freeze({
  // listing is handled separately: it is required once per configured language.
  listing: [],
  details: ["details.contactEmail"],
  // images and bundle accept several spellings; see checkShapes below.
  images: [],
  bundle: [],
  release: ["release.track"],
  testers: ["testers"],
  dataSafety: ["dataSafety.csvPath"],
  subscriptions: [],
});

/** @typedef {keyof typeof REQUIREMENTS} Concern */

/** Fields every configured language must carry. */
export const LOCALE_REQUIRED = Object.freeze(["title", "shortDescription", "fullDescription"]);

/** @param {object|null} config @param {string} path */
const at = (config, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), config);

/** Every key path required by a set of concerns, plus the always-required ones. */
export function requirementsFor(needs = []) {
  // An operation that declares no concern (status, check, promote, reviews)
  // runs without any config at all — it reads Play, not the config.
  if (!needs.length) return [];
  const paths = ["defaultLanguage"];
  for (const need of needs) paths.push(...(REQUIREMENTS[need] ?? []));
  return [...new Set(paths)];
}

/**
 * Findings for everything an operation needs and does not have.
 *
 * @param {object|null} config
 * @param {string[]} needs
 * @returns {import("./findings.mjs").Finding[]}
 */
export function checkRequirements(config, needs = []) {
  if (!needs.length) return [];
  if (!config) {
    return [
      finding({
        id: "config.missing",
        category: Category.CONFIG,
        title: "No config file",
        detail: "This operation is config-driven and no config was found.",
        fixOwner: FixOwner.CLI,
        fix: "Create one with `playstore-release init`, or point --config at an existing file.",
      }),
    ];
  }
  const findings = requirementsFor(needs)
    .filter((path) => at(config, path) == null || at(config, path) === "")
    .map((path) =>
      finding({
        id: `config.${path}.missing`,
        category: Category.CONFIG,
        title: `config.${path} is required`,
        detail: `The operation cannot run without config.${path}.`,
        fixOwner: FixOwner.CLI,
        fix: `Add "${path}" to your config. See \`playstore-release schema\` for its shape.`,
        evidence: { resource: "config", expected: path },
      }),
    );

  if (needs.includes("listing")) findings.push(...checkLocaleRequirements(config));
  if (needs.includes("images") && !config.images?.dir && !hasAnyImageKey(config)) {
    findings.push(
      finding({
        id: "config.images.missing",
        category: Category.CONFIG,
        title: "config.images is required",
        detail: "Name a base directory (images.dir) or at least one of icon, featureGraphic, phoneScreenshots.",
        fixOwner: FixOwner.CLI,
        fix: 'Add "images": { "dir": "./images" } and put icon.png, feature-graphic.png and phone/ inside it.',
        docs: "references/assets.md",
      }),
    );
  }
  if (needs.includes("bundle") && !config.bundle?.path && !config.bundle?.dir) {
    findings.push(
      finding({
        id: "config.bundle.missing",
        category: Category.CONFIG,
        title: "config.bundle is required",
        detail: "Name the .aab with bundle.path, or the directory holding it with bundle.dir.",
        fixOwner: FixOwner.CLI,
        fix: 'Add "bundle": { "path": "./build/app-release.aab" } — or pass --file to upload-bundle.',
      }),
    );
  }
  return findings;
}

const IMAGE_KEYS = ["icon", "featureGraphic", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots"];
const hasAnyImageKey = (config) => IMAGE_KEYS.some((k) => config.images?.[k]);

/**
 * Every configured language needs a complete listing. Reporting only the default
 * one would let the others ship empty, which the Console then flags as missing
 * translations and a commit may reject.
 *
 * @param {object} config
 * @returns {import("./findings.mjs").Finding[]}
 */
function checkLocaleRequirements(config) {
  const locales = resolveLocales(config);
  if (!locales.length) return [];

  const single = locales.length === 1;
  const out = [];
  for (const { locale, listing } of locales) {
    for (const field of LOCALE_REQUIRED) {
      if (listing[field] != null && listing[field] !== "") continue;
      // Name the key the user would actually edit: the flat one when there is
      // only a single language, the nested one otherwise.
      const path = single ? `listing.${field}` : `locales.${locale}.${field}`;
      out.push(
        finding({
          id: `config.${path}.missing`,
          category: Category.CONFIG,
          title: `config.${path} is required`,
          detail: single
            ? `The listing cannot be written without ${field}.`
            : `The ${locale} listing has no ${field}; Play rejects a half-filled listing.`,
          fixOwner: FixOwner.CLI,
          fix: `Add "${path}" to your config, or set listing.${field} to share one value across languages.`,
          evidence: { resource: "config", expected: path, actual: locale },
        }),
      );
    }
  }
  return out;
}

// ── Semantic rules Google enforces but does not document in one place ─────────

/** Per-listing limits, applied to every language. */
export const LIMITS = Object.freeze([
  { field: "title", max: 30 },
  { field: "shortDescription", max: 80 },
  { field: "fullDescription", max: 4000 },
  { field: "releaseNotes", max: 500 },
]);

/**
 * @param {object|null} config
 * @returns {import("./findings.mjs").Finding[]}
 */
export function checkSemantics(config) {
  if (!config) return [];
  const out = [];

  const locales = resolveLocales(config);
  const single = locales.length <= 1;
  for (const { locale, listing } of locales) {
    const keyFor = (field) => (single ? `listing.${field}` : `locales.${locale}.${field}`);
    for (const { field, max } of LIMITS) {
      const value = listing[field];
      if (typeof value !== "string" || value.length <= max) continue;
      const path = keyFor(field);
      out.push(
        finding({
          id: `config.${path}.too-long`,
          category: Category.CONFIG,
          title: `config.${path} exceeds ${max} characters`,
          detail: `It is ${value.length} characters. Google Play rejects the edit at validation with a 400.`,
          fixOwner: FixOwner.CLI,
          fix: `Shorten config.${path} to ${max} characters or fewer.`,
          evidence: { expected: max, actual: value.length },
          docs: "references/gotchas.md#listing",
        }),
      );
    }
  }

  const release = config.release;
  if (release && typeof release === "object") {
    const fraction = release.userFraction;
    if (fraction != null && release.status && release.status !== "inProgress") {
      out.push(
        finding({
          id: "config.release.userFraction.status",
          category: Category.CONFIG,
          title: "config.release.userFraction only applies to a staged rollout",
          detail: `status is "${release.status}"; Google accepts userFraction only with status "inProgress".`,
          fixOwner: FixOwner.CLI,
          fix: 'Set release.status to "inProgress", or remove userFraction.',
          docs: "references/gotchas.md#tracks-and-rollouts",
        }),
      );
    }
    if (fraction != null && !(fraction > 0 && fraction < 1)) {
      out.push(
        finding({
          id: "config.release.userFraction.range",
          category: Category.CONFIG,
          title: "config.release.userFraction must be strictly between 0 and 1",
          detail: `Got ${fraction}. A full rollout is status "completed", not userFraction 1.`,
          fixOwner: FixOwner.CLI,
          fix: "Use a share like 0.1 for 10%, or switch status to completed.",
        }),
      );
    }
    if (release.status === "inProgress" && fraction == null) {
      out.push(
        finding({
          id: "config.release.userFraction.missing",
          category: Category.CONFIG,
          title: "config.release.status inProgress needs a userFraction",
          detail: "A staged rollout without a share is rejected by Google.",
          fixOwner: FixOwner.CLI,
          fix: "Add release.userFraction (e.g. 0.1), or use status completed.",
        }),
      );
    }
  }

  return out;
}

/**
 * Everything wrong with a config, for a given set of concerns.
 *
 * Three layers, cheapest first: the schema catches shape and typos, the
 * requirements catch what this particular operation needs, and the semantic
 * rules catch what Google enforces but no schema can express.
 *
 * @param {object|null} config
 * @param {{ needs?: string[], schema?: boolean }} [opts]
 * @returns {{ valid: boolean, findings: import("./findings.mjs").Finding[] }}
 */
export function validateConfig(config, { needs = [], schema = true } = {}) {
  const findings = [
    ...(schema && config ? validateAgainstSchema(config, CONFIG_SCHEMA) : []),
    ...checkRequirements(config, needs),
    ...checkSemantics(config),
  ];
  // One key can trip several layers; report each problem once.
  const seen = new Set();
  const unique = findings.filter((f) => !seen.has(f.id) && seen.add(f.id));
  return { valid: !unique.some((f) => f.severity === Severity.BLOCKER), findings: unique };
}
