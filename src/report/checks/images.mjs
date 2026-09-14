// Store graphics, checked on both sides: what Play holds for each language, and
// whether the local files are even the right shape to upload.

import { finding, Severity, Category, FixOwner } from "../../core/findings.mjs";
import { readImage, imageProblems, IMAGE_RULES, IMAGE_TYPES } from "../../play/imagemeta.mjs";
import { localeCodes } from "../../core/locales.mjs";
import { resolveImageSets, declaresImages } from "../../core/images.mjs";
import { readAsset } from "../../play/uploads.mjs";

export const section = { id: "images", title: "Graphics" };

const LABEL = {
  icon: "app icon",
  featureGraphic: "feature graphic",
  phoneScreenshots: "phone screenshots",
  sevenInchScreenshots: "7-inch tablet screenshots",
  tenInchScreenshots: "10-inch tablet screenshots",
};

/** @param {{ snapshot: any, config: any, resolvePath?: (p: string, purpose?: string) => string }} input */
export function check({ snapshot, config, resolvePath }) {
  const out = [];
  if (snapshot.access?.status !== 200) return out;
  const locales = snapshot.locales?.length ? snapshot.locales : localeCodes(config);
  const multi = locales.length > 1;
  const suffix = (locale) => (multi ? `.${locale}` : "");

  // ── Remote: what Play holds ────────────────────────────────────────────────
  for (const locale of locales) {
    if (!snapshot.listings?.[locale]) continue; // listing check owns this
    const remote = snapshot.images?.[locale] ?? {};
    for (const type of ["icon", "featureGraphic", "phoneScreenshots"]) {
      const count = (remote[type] ?? []).length;
      const rule = IMAGE_RULES[type];
      if (count >= rule.min && count <= rule.max) continue;
      out.push(
        finding({
          id: `images.${type}.${count ? "count" : "missing"}${suffix(locale)}`,
          category: Category.STORE_STATE,
          title: count
            ? `${multi ? `${locale}: ` : ""}${count} ${LABEL[type]}; Play wants ${rule.min}–${rule.max}`
            : `${multi ? `${locale}: ` : ""}no ${LABEL[type]}`,
          detail:
            type === "featureGraphic"
              ? "Play refuses to commit a listing without a 1024×500 feature graphic."
              : type === "icon"
                ? "Play requires a 512×512 icon on the listing."
                : "Play requires at least two phone screenshots.",
          fix: "Put the files in the images directory and upload them.",
          fixCommand: "playstore-release images",
          docs: `references/assets.md#${type.toLowerCase()}`,
        }),
      );
    }
  }

  // ── Local: are the files uploadable, and do they match what is up there ────
  if (!resolvePath || !declaresImages(config)) return out;

  const { sets, missing } = resolveImageSets(config, resolvePath, locales);
  for (const m of missing) {
    out.push(
      finding({
        id: `images.local.missing.${m.imageType}${suffix(m.locale)}`,
        category: Category.ASSET,
        title: `No local ${LABEL[m.imageType]}${multi ? ` for ${m.locale}` : ""}`,
        detail: `Looked at ${m.path}.`,
        fixOwner: FixOwner.EXTERNAL,
        fix: "Produce the file(s) — see references/assets.md for exact sizes.",
        docs: "references/assets.md",
      }),
    );
  }

  for (const set of sets) {
    const rule = IMAGE_RULES[set.imageType];
    if (rule && (set.files.length < rule.min || set.files.length > rule.max)) {
      out.push(
        finding({
          id: `images.local.count.${set.imageType}${suffix(set.locale)}`,
          category: Category.ASSET,
          title: `${set.files.length} local ${LABEL[set.imageType]}; Play wants ${rule.min}–${rule.max}`,
          detail: `In ${set.dir}.`,
          fixOwner: FixOwner.EXTERNAL,
          fix: rule.max === 1 ? "Keep exactly one file." : `Keep between ${rule.min} and ${rule.max} files.`,
        }),
      );
    }
    const localHashes = [];
    for (const file of set.files) {
      const path = `${set.dir}/${file}`;
      const info = readImage(path);
      const problems = imageProblems(set.imageType, info);
      if (problems.length) {
        out.push(
          finding({
            id: `images.invalid.${set.imageType}.${file}${suffix(set.locale)}`,
            category: Category.ASSET,
            title: `${file} ${problems[0]}`,
            detail: problems.length > 1 ? `Also: ${problems.slice(1).join("; ")}.` : `Play rejects it at upload.`,
            fixOwner: FixOwner.EXTERNAL,
            fix: `Re-render ${file} to Play's rules.`,
            evidence: {
              resource: set.imageType,
              actual: info && { width: info.width, height: info.height, hasAlpha: info.hasAlpha },
            },
            docs: `references/assets.md#${set.imageType.toLowerCase()}`,
          }),
        );
        continue;
      }
      if (set.imageType === "phoneScreenshots" && info && Math.min(info.width, info.height) < 1080) {
        out.push(
          finding({
            id: `images.lowres.${file}${suffix(set.locale)}`,
            severity: Severity.INFO,
            category: Category.ASSET,
            title: `${file} is below 1080 px on its short side`,
            detail: "Accepted, but Play only promotes listings whose screenshots are at least 1080×1920.",
            fixOwner: FixOwner.EXTERNAL,
            fix: "Re-render at 1080×1920 or larger if featuring matters.",
          }),
        );
      }
      localHashes.push(readAsset(path).sha1);
    }

    const remote = (snapshot.images?.[set.locale]?.[set.imageType] ?? []).map((i) => i.sha1);
    if (!remote.length && !snapshot.listings?.[set.locale]) continue; // nothing to compare against yet
    const sameSet = localHashes.length === remote.length && localHashes.every((h) => remote.includes(h));
    if (!sameSet) {
      if (remote.length || localHashes.length) {
        out.push(
          finding({
            id: `images.differs.${set.imageType}${suffix(set.locale)}`,
            severity: remote.length ? Severity.WARNING : Severity.BLOCKER,
            category: Category.STORE_STATE,
            title: `${multi ? `${set.locale}: ` : ""}local ${LABEL[set.imageType]} differ from Play's`,
            detail: `${localHashes.length} local, ${remote.length} on Play, ${localHashes.filter((h) => remote.includes(h)).length} in common.`,
            fixOwner: FixOwner.CLI,
            fix: "Upload what is missing and prune what is stale.",
            fixCommand: "playstore-release images",
          }),
        );
      }
    } else if (localHashes.some((h, i) => h !== remote[i])) {
      out.push(
        finding({
          id: `images.order.differs.${set.imageType}${suffix(set.locale)}`,
          severity: Severity.WARNING,
          category: Category.STORE_STATE,
          title: `${multi ? `${set.locale}: ` : ""}${LABEL[set.imageType]} are in a different order on Play`,
          detail: "Play has no reorder call; matching the local order means deleting and re-uploading the set.",
          fixOwner: FixOwner.CLI,
          fix: "Re-upload in order.",
          fixCommand: "playstore-release images --reorder",
          docs: "references/gotchas.md#images",
        }),
      );
    }
  }

  // Types Play holds that the config does not manage, so they are not silently
  // left looking managed.
  for (const locale of locales) {
    const remote = snapshot.images?.[locale] ?? {};
    const configured = new Set(sets.filter((s) => s.locale === locale).map((s) => s.imageType));
    for (const type of IMAGE_TYPES) {
      if (configured.has(type) || !(remote[type] ?? []).length) continue;
      if (["icon", "featureGraphic", "phoneScreenshots"].includes(type)) continue; // required ones are reported as missing locally above
      out.push(
        finding({
          id: `images.unmanaged.${type}${suffix(locale)}`,
          severity: Severity.INFO,
          category: Category.CONFIG,
          title: `${LABEL[type]} exist on Play but are not in the config`,
          detail: "They will not be checked or updated here.",
          fixOwner: FixOwner.CLI,
          fix: `Add images.${type} to manage them.`,
        }),
      );
    }
  }

  return out;
}
