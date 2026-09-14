// The store listing per configured language: present, complete, and matching
// the config.

import { finding, Severity, Category, FixOwner } from "../../core/findings.mjs";
import { resolveLocales } from "../../core/locales.mjs";
import { LOCALE_REQUIRED } from "../../core/requirements.mjs";

export const section = { id: "listing", title: "Store listing" };

const FIELDS = ["title", "shortDescription", "fullDescription", "video"];

/** @param {{ snapshot: any, config: any }} input */
export function check({ snapshot, config }) {
  const out = [];
  if (snapshot.access?.status !== 200) return out;
  const locales = resolveLocales(config);
  if (!locales.length) return out;
  const multi = locales.length > 1;
  const suffix = (locale) => (multi ? `.${locale}` : "");

  for (const { locale, listing, primary } of locales) {
    const remote = snapshot.listings?.[locale];
    if (!remote) {
      out.push(
        finding({
          id: `listing.missing${suffix(locale)}`,
          category: Category.STORE_STATE,
          title: multi ? `No ${locale} listing` : "No store listing",
          detail: primary
            ? "The default language has no listing, so the app has no store page at all."
            : `Play has no listing for ${locale}.`,
          fix: "Write the listing from the config.",
          fixCommand: "playstore-release listing",
        }),
      );
      continue;
    }

    const empty = LOCALE_REQUIRED.filter((f) => !remote[f]);
    for (const field of empty) {
      out.push(
        finding({
          id: `listing.field.missing.${field}${suffix(locale)}`,
          category: Category.STORE_STATE,
          title: `${multi ? `${locale}: ` : ""}no ${field} on the listing`,
          detail: "Play requires title, short description and full description.",
          fix: "Write the listing from the config.",
          fixCommand: "playstore-release listing",
        }),
      );
    }

    const differs = FIELDS.filter((f) => listing[f] !== undefined && (remote[f] ?? "") !== (listing[f] ?? ""));
    if (differs.length && !empty.length) {
      out.push(
        finding({
          id: `listing.differs${suffix(locale)}`,
          severity: Severity.WARNING,
          category: Category.STORE_STATE,
          title: `${multi ? `${locale}: ` : ""}listing differs from the config (${differs.join(", ")})`,
          detail: "Play holds different text than the config; running listing will overwrite Play's copy.",
          fixOwner: FixOwner.CLI,
          fix: "Write the config's text, or copy Play's text into the config if that is the newer one.",
          fixCommand: "playstore-release listing",
        }),
      );
    }
  }

  return out;
}
