// The textual store listing for every configured language.

import { Status } from "../core/status.mjs";
import { resolveLocales } from "../core/locales.mjs";
import { pick, diff } from "./details.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "listing",
  title: "Store listing",
  phase: "listing",
  needs: ["listing"],
  edit: true,
  mutates: true,
};

const FIELDS = ["title", "shortDescription", "fullDescription", "video"];

// runOperation validates `meta.needs` before we get here, so every configured
// language has title/shortDescription/fullDescription — no defensive re-check.
/** @param {import("../core/context.mjs").Context} ctx */
export async function run({ edit, config }) {
  const locales = resolveLocales(config);
  /** @type {Record<string, string[]>} */
  const changedByLocale = {};

  for (const { locale, listing } of locales) {
    const current = await edit.get(`/listings/${encodeURIComponent(locale)}`, { throwOnError: false });
    const remote = current.error ? {} : current;
    const wanted = pick(listing, FIELDS);
    const changes = diff(remote, wanted);
    if (!Object.keys(changes).length) continue;

    // PUT the whole listing: a language with no listing yet cannot be PATCHed.
    await edit.put(`/listings/${encodeURIComponent(locale)}`, {
      language: locale,
      ...pick(remote, FIELDS),
      ...wanted,
    });
    changedByLocale[locale] = Object.keys(changes);
  }

  const touched = Object.keys(changedByLocale);
  const scope = locales.length === 1 ? locales[0].locale : `${locales.length} languages`;
  if (!touched.length) {
    return {
      status: Status.OK,
      message: `${scope}: already up to date`,
      details: { locales: locales.map((l) => l.locale) },
    };
  }
  return {
    status: Status.CHANGED,
    message: touched.map((l) => `${l}: ${changedByLocale[l].join(", ")}`).join(" · "),
    details: { locales: locales.map((l) => l.locale), changed: changedByLocale },
  };
}
