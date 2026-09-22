// Turn the strings Google puts in a 400/403/404 into findings that say who fixes
// what. These are the messages actually seen in practice; a message not listed
// here still surfaces verbatim, it just carries no hint.

import { finding, Severity, Category, FixOwner } from "../core/findings.mjs";
import { PlayApiError } from "./client.mjs";

/** @type {Array<{ test: RegExp, hint: (m: RegExpExecArray, e: PlayApiError) => import("../core/findings.mjs").Finding }>} */
const RULES = [
  {
    test: /has not been uploaded (?:via|through) (?:the )?(?:Google Play )?Console|first (?:APK|app bundle|bundle)/i,
    hint: () =>
      finding({
        id: "bundle.first.console",
        category: Category.STORE_STATE,
        title: "The first bundle must be uploaded in the Play Console",
        detail: "Google rejects an API upload until one bundle has gone through the Console once.",
        fixOwner: FixOwner.UI,
        uiOnly: true,
        fix: "Upload the .aab once by hand to Internal testing, then re-run.",
        fixClicks: ["Testing", "Internal testing", "Create new release", "Upload"],
        docs: "references/console.md#firstbundle",
      }),
  },
  {
    test: /Only releases with status draft may be created on draft app/i,
    hint: () =>
      finding({
        id: "track.draft-app",
        category: Category.STORE_STATE,
        title: "An app that has never been published only accepts draft releases",
        detail:
          "Play calls an app that has not completed its first review a draft app. Every release on it must have status " +
          "draft; the first publication is then sent for review from the Console, not through the API.",
        fixOwner: FixOwner.CLI,
        fix: "Create the release as a draft, then send it for review in the Console (Publishing overview → Send for review).",
        fixCommand: "playstore-release promote --to production --draft --yes",
        docs: "references/gotchas.md#tracks-and-rollouts",
      }),
  },
  {
    test: /feature graphic/i,
    hint: () =>
      finding({
        id: "images.featureGraphic.missing",
        category: Category.STORE_STATE,
        title: "No feature graphic",
        detail: "Play requires a 1024×500 feature graphic before a listing can be committed.",
        fix: "Put feature-graphic.png in the images directory and upload it.",
        fixCommand: "playstore-release images",
        docs: "references/assets.md#feature-graphic",
      }),
  },
  {
    test: /version code (\d+) has already been used|different version code/i,
    hint: (m) =>
      finding({
        id: "bundle.versionCode.used",
        category: Category.BINARY,
        title: `versionCode ${m[1] ?? ""} has already been used`.replace("  ", " "),
        detail: "Every upload needs a versionCode higher than anything Play has seen for this app.",
        fixOwner: FixOwner.EXTERNAL,
        fix: "Bump versionCode in android/app/build.gradle (or let CI derive it from Play) and rebuild.",
        docs: "references/gotchas.md#bundles",
      }),
  },
  {
    test: /insufficient permissions|not have permission|does not have access/i,
    hint: () =>
      finding({
        id: "account.permissions",
        category: Category.ACCOUNT,
        title: "The service account is not allowed to do this",
        detail:
          "Play answered 403. Either the account was never invited to this app, or its permissions stop short of this action. New permissions can take up to 24 hours to apply.",
        fixOwner: FixOwner.UI,
        uiOnly: true,
        fix: "Play Console → Users and permissions → the service account → App permissions → grant release + store presence.",
        fixClicks: [
          "Users and permissions",
          "<client_email>",
          "App permissions",
          "Release to production",
          "Manage store presence",
        ],
        docs: "references/setup.md#service-account",
      }),
  },
  {
    test: /Google Play Android Developer API has not been used|is disabled|accessNotConfigured/i,
    hint: () =>
      finding({
        id: "account.api.disabled",
        category: Category.ACCOUNT,
        title: "The Google Play Android Developer API is not enabled for this project",
        detail: "The service account's Cloud project has the API switched off.",
        fixOwner: FixOwner.EXTERNAL,
        fix: "gcloud services enable androidpublisher.googleapis.com --project <project>",
        docs: "references/setup.md#service-account",
      }),
  },
  {
    test: /Package not found|applicationNotFound|No application was found/i,
    hint: () =>
      finding({
        id: "app.missing",
        category: Category.STORE_STATE,
        title: "Play has no app with this package name (or its first bundle is missing)",
        detail: "The API answers 404 both when the app was never created and when it exists without any bundle.",
        fixOwner: FixOwner.UI,
        uiOnly: true,
        fix: "Create the app in the Play Console and upload the first .aab by hand.",
        fixClicks: ["Play Console", "Create app"],
        docs: "references/console.md#app",
      }),
  },
  {
    test: /screenshot|image/i,
    hint: (_, e) =>
      finding({
        id: "images.rejected",
        category: Category.ASSET,
        title: "Play rejected an image",
        detail: e.googleMessage,
        fixOwner: FixOwner.EXTERNAL,
        fix: "Check the size, aspect ratio and alpha rules in references/assets.md and re-render.",
        docs: "references/assets.md",
      }),
  },
  {
    test: /short description|full description|title/i,
    hint: (_, e) =>
      finding({
        id: "listing.rejected",
        category: Category.CONFIG,
        title: "Play rejected a listing field",
        detail: e.googleMessage,
        fixOwner: FixOwner.CLI,
        fix: "Fix the field in the config and run listing again.",
        docs: "references/gotchas.md#listing",
      }),
  },
];

/**
 * Attach hints to an error, in place, and return it — so `throw withHints(e)`
 * reads naturally.
 *
 * @template T
 * @param {T} error
 * @returns {T}
 */
export function withHints(error) {
  if (!(error instanceof PlayApiError) || error.hints.length) return error;
  const haystack = `${error.googleMessage} ${error.reasons.join(" ")} ${error.googleStatus ?? ""}`;
  for (const rule of RULES) {
    const m = rule.test.exec(haystack);
    if (!m) continue;
    const hint = rule.hint(m, error);
    if (!error.hints.some((h) => h.id === hint.id)) error.hints.push(hint);
  }
  // A 403/404 with no recognised text still deserves the generic diagnosis.
  // Looked up by the finding it produces, never by index: a new rule in the
  // middle of the table used to silently repoint these.
  const fallback = (id) => RULES.find((r) => r.hint(/** @type {any} */ ([]), error).id === id);
  if (!error.hints.length && error.status === 403)
    error.hints.push(fallback("account.permissions").hint(/** @type {any} */ ([]), error));
  if (!error.hints.length && error.status === 404)
    error.hints.push(fallback("app.missing").hint(/** @type {any} */ ([]), error));
  return error;
}

/** Severity is always BLOCKER for hints; exported for symmetry with findings. */
export { Severity };
