// One config can describe several Play Store languages.
//
// `config.defaultLanguage` + `config.listing` is the single-language shorthand;
// `config.locales` is the full form. Play requires a listing for the default
// language and accepts any number of others — a half-filled one is what the
// Console shows as "missing translation" and what a commit rejects.

/**
 * @typedef {Object} LocaleEntry
 * @property {string} locale            BCP-47 as Play spells it: en-US, tr-TR, de-DE
 * @property {Record<string, any>} listing   the shared listing with this language's overrides applied
 * @property {boolean} primary          the default language
 */

/**
 * Every language this config describes, default language first.
 *
 * `config.listing` acts as the default for all of them, and each entry in
 * `config.locales` overrides it — so shared fields (a video URL, say) are
 * written once.
 *
 * @param {object|null} config
 * @returns {LocaleEntry[]}
 */
export function resolveLocales(config) {
  if (!config) return [];
  const base = config.listing ?? {};
  const primary = config.defaultLanguage;

  if (!config.locales || Object.keys(config.locales).filter((k) => !k.startsWith("$")).length === 0) {
    return primary ? [{ locale: primary, listing: base, primary: true }] : [];
  }

  const entries = Object.entries(config.locales)
    .filter(([locale]) => !locale.startsWith("$")) // $comment and friends are not languages
    .map(([locale, overrides]) => ({
      locale,
      listing: { ...base, ...(overrides ?? {}) },
      primary: locale === primary,
    }));

  // Default language first: it is the one Play falls back to for every
  // language the listing does not cover, and the one a commit checks hardest.
  entries.sort((a, b) => Number(b.primary) - Number(a.primary));

  // A `defaultLanguage` naming something absent from `locales` is almost
  // certainly a mistake, but writing nothing at all would be worse — include it.
  if (primary && !entries.some((e) => e.locale === primary)) {
    entries.unshift({ locale: primary, listing: base, primary: true });
  }
  return entries;
}

/** Just the language codes, default first. @param {object|null} config */
export const localeCodes = (config) => resolveLocales(config).map((e) => e.locale);

/** The language a report defaults to when the caller did not name one. */
export const primaryLocale = (config) => resolveLocales(config)[0]?.locale ?? null;
