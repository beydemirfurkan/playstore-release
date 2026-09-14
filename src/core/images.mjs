// Which local files belong to which Play image type and language.
//
// One base directory with conventional names covers the common case:
//
//   images/
//     icon.png              512×512
//     feature-graphic.png   1024×500
//     phone/*.png|jpg       2–8 screenshots, filename order = display order
//     tablet-7/  tablet-10/ optional
//
// Each key in config.images overrides one of those paths. A language
// subdirectory (phone/tr-TR/) overrides the base for that language, which is
// what keeps a multi-language config from becoming a matrix written by hand.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { IMAGE_TYPES, SINGLE_IMAGE_TYPES } from "../play/imagemeta.mjs";

/** Conventional locations inside `images.dir`. */
export const DEFAULT_IMAGE_PATHS = Object.freeze({
  icon: "icon.png",
  featureGraphic: "feature-graphic.png",
  phoneScreenshots: "phone",
  sevenInchScreenshots: "tablet-7",
  tenInchScreenshots: "tablet-10",
});

const EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

/**
 * @typedef {Object} ImageSet
 * @property {string} imageType
 * @property {string} locale
 * @property {string} dir            absolute directory holding the files
 * @property {string[]} files        filenames, in display order
 */

/**
 * Every set this config asks for, resolved against the filesystem. Only image
 * types the config names (explicitly, or through a base directory that contains
 * them) are returned — an absent tablet directory is not an error.
 *
 * @param {object} config
 * @param {(p: string, purpose?: string) => string} resolvePath
 * @param {string[]} locales
 * @param {{ types?: string[] }} [opts]
 * @returns {{ sets: ImageSet[], missing: Array<{imageType: string, locale: string, path: string}> }}
 */
export function resolveImageSets(config, resolvePath, locales, { types } = {}) {
  const cfg = config.images ?? {};
  const base = cfg.dir ? resolvePath(cfg.dir, "config.images.dir") : null;
  const wantedTypes = types?.length ? types : IMAGE_TYPES;

  /** @type {ImageSet[]} */
  const sets = [];
  /** @type {Array<{imageType: string, locale: string, path: string}>} */
  const missing = [];

  for (const imageType of wantedTypes) {
    const explicit = cfg[imageType] ? resolvePath(cfg[imageType], `config.images.${imageType}`) : null;
    const target = explicit ?? (base ? join(base, DEFAULT_IMAGE_PATHS[imageType]) : null);
    if (!target) continue;
    // Conventional locations are optional; a path the config spelled out is not.
    const required =
      Boolean(explicit) || imageType === "icon" || imageType === "featureGraphic" || imageType === "phoneScreenshots";

    for (const locale of locales) {
      if (SINGLE_IMAGE_TYPES.includes(imageType)) {
        // icon.png next to a tr-TR/icon.png: the language-specific file wins.
        const localized = join(dirname(target), locale, basename(target));
        const file = existsSync(localized) ? localized : target;
        if (!existsSync(file)) {
          if (required) missing.push({ imageType, locale, path: target });
          continue;
        }
        sets.push({ imageType, locale, dir: dirname(file), files: [basename(file)] });
        continue;
      }

      const localeDir = join(target, locale);
      const dir = isDirectory(localeDir) ? localeDir : target;
      if (!isDirectory(dir)) {
        if (required) missing.push({ imageType, locale, path: target });
        continue;
      }
      const files = readdirSync(dir)
        .filter((f) => EXTENSIONS.has(extOf(f)))
        .sort(); // filename order is display order
      if (!files.length) {
        if (required) missing.push({ imageType, locale, path: dir });
        continue;
      }
      sets.push({ imageType, locale, dir, files });
    }
  }

  return { sets, missing };
}

const extOf = (f) => f.slice(f.lastIndexOf(".")).toLowerCase();

function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when the config names any image source at all. @param {object|null} config */
export const declaresImages = (config) => {
  const cfg = config?.images;
  return Boolean(cfg && (cfg.dir || IMAGE_TYPES.some((t) => cfg[t])));
};
