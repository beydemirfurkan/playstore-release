// Sync local graphics to the listing — icon, feature graphic and screenshots,
// per language. Play reports the sha1 of every stored image, so "already
// correct" is an exact, cheap answer and an unchanged run sends nothing.
//
// One thing Play cannot do: reorder. Uploads append, and there is no call to
// move an image. When the order differs the operation says so; `--reorder`
// deletes the set and re-uploads it in filename order.

import { Status } from "../core/status.mjs";
import { finding, Severity, Category, FixOwner } from "../core/findings.mjs";
import { localeCodes } from "../core/locales.mjs";
import { resolveImageSets, declaresImages } from "../core/images.mjs";
import { readImage, imageProblems, SINGLE_IMAGE_TYPES, IMAGE_TYPES } from "../play/imagemeta.mjs";
import { readAsset } from "../play/uploads.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "images",
  title: "Store graphics",
  phase: "listing",
  needs: [],
  edit: true,
  mutates: true,
  destructive: true,
  args: {
    prune: { type: "boolean", default: true, description: "delete remote images that have no local counterpart" },
    reorder: {
      type: "boolean",
      default: false,
      description: "delete and re-upload a set whose order differs from the local one",
    },
    types: { type: "string", description: `comma-separated subset of ${IMAGE_TYPES.join(",")}` },
  },
};

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ prune?: boolean, reorder?: boolean, types?: string }} [args]
 */
export async function run(ctx, args = {}) {
  const { edit, images, config, resolvePath } = ctx;
  if (!declaresImages(config)) {
    return {
      status: Status.SKIPPED,
      message: "no graphics configured (config.images) — check will say what Play is missing",
    };
  }
  const locales = localeCodes(config);
  const types = args.types
    ? args.types
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const { sets, missing } = resolveImageSets(config, resolvePath, locales, { types });

  /** @type {import("../core/findings.mjs").Finding[]} */
  const findings = missing.map((m) =>
    finding({
      id: `images.local.missing.${m.imageType}.${m.locale}`,
      category: Category.ASSET,
      title: `No local ${m.imageType} for ${m.locale}`,
      detail: `Looked at ${m.path}.`,
      fixOwner: FixOwner.EXTERNAL,
      fix: "Produce the file(s) — see references/assets.md for the exact rules.",
      docs: "references/assets.md",
    }),
  );
  if (!sets.length) return { status: Status.ERROR, message: "no images found for any configured language", findings };

  // Validate every file locally before touching the network — a wrongly shaped
  // file otherwise costs an upload and comes back as an opaque 400.
  const prepared = [];
  let invalid = 0;
  for (const set of sets) {
    const local = [];
    for (const file of set.files) {
      const path = `${set.dir}/${file}`;
      const problems = imageProblems(set.imageType, readImage(path));
      if (problems.length) {
        invalid += 1;
        findings.push(
          finding({
            id: `images.invalid.${set.imageType}.${file}.${set.locale}`,
            category: Category.ASSET,
            title: `${file} ${problems[0]}`,
            detail: problems.length > 1 ? `Also: ${problems.slice(1).join("; ")}.` : "",
            fixOwner: FixOwner.EXTERNAL,
            fix: `Re-render ${file} to Play's rules for ${set.imageType}.`,
            docs: `references/assets.md#${set.imageType.toLowerCase()}`,
          }),
        );
        continue;
      }
      local.push({ file, path, sha1: readAsset(path).sha1 });
    }
    prepared.push({ set, local });
  }
  if (invalid) return { status: Status.ERROR, message: `${invalid} image(s) break Play's rules`, findings };

  // Play 404s image calls for a language without a listing; say so plainly
  // instead of failing on the first upload.
  const listings = (await edit.get("/listings")).listings ?? [];
  const known = new Set(listings.map((l) => l.language));
  const summary = [];
  let anyChange = false;
  for (const { set, local } of prepared) {
    if (!known.has(set.locale) && !ctx.dryRun) {
      findings.push(
        finding({
          id: `images.listing.missing.${set.locale}`,
          category: Category.STORE_STATE,
          title: `No ${set.locale} listing yet — images cannot be attached to it`,
          detail: "Play stores graphics per listing.",
          fix: "Write the listing first, then the images.",
          fixCommand: "playstore-release listing",
        }),
      );
      continue;
    }
    const result = await syncSet(
      { edit, images, dryRun: ctx.dryRun },
      { set, local, prune: args.prune, reorder: args.reorder, findings },
    );
    summary.push(result);
    anyChange ||= result.changed;
  }

  const uploaded = summary.reduce((n, s) => n + s.uploaded.length, 0);
  const deleted = summary.reduce((n, s) => n + s.deleted, 0);
  const unchanged = summary.reduce((n, s) => n + s.unchanged, 0);
  const details = { sets: summary, uploaded, deleted, unchanged };

  if (findings.some((f) => f.id.startsWith("images.listing.missing"))) {
    return { status: Status.ERROR, message: "some languages have no listing yet", details, findings };
  }
  if (!anyChange) {
    return {
      status: Status.OK,
      message: `${unchanged} image(s) already correct across ${summary.length} set(s)`,
      details,
      findings,
    };
  }
  return {
    status: Status.CHANGED,
    message: `${uploaded} uploaded, ${unchanged} unchanged${deleted ? `, ${deleted} removed` : ""} across ${summary.length} set(s)`,
    details,
    findings,
  };
}

/** Diff and reconcile one image type in one language. */
async function syncSet({ edit, images, dryRun }, { set, local, prune, reorder, findings }) {
  const base = `/listings/${encodeURIComponent(set.locale)}/${set.imageType}`;
  const current = await edit.get(base, { throwOnError: false });
  const remote = current.error ? [] : (current.images ?? []);
  const single = SINGLE_IMAGE_TYPES.includes(set.imageType);

  const claimed = new Set();
  const matchFor = (item) => remote.find((r) => !claimed.has(r.id) && r.sha1 === item.sha1);

  const matched = [];
  const toUpload = [];
  for (const item of local) {
    const match = matchFor(item);
    if (match) {
      claimed.add(match.id);
      matched.push(match.id);
    } else toUpload.push(item);
  }
  const orphans = remote.filter((r) => !claimed.has(r.id));

  // Order: only meaningful for multi-image sets, and only judged when the sets
  // would otherwise be identical — an upload changes the order anyway.
  const remoteOrder = remote.map((r) => r.sha1);
  const localOrder = local.map((l) => l.sha1);
  const sameMembers = !toUpload.length && !orphans.length;
  const orderDiffers = !single && sameMembers && localOrder.some((h, i) => h !== remoteOrder[i]);

  let deleted = 0;
  const uploaded = [];

  if (orderDiffers && reorder) {
    await edit.delete(base);
    deleted += remote.length;
    for (const item of local) {
      await images.upload({ language: set.locale, imageType: set.imageType, filePath: item.path });
      uploaded.push(item.file);
    }
  } else {
    // Single-file types are replaced by uploading; deleting first keeps Play
    // from holding two icons for a moment and avoids the "one only" 400.
    if (single && toUpload.length && orphans.length) {
      await edit.delete(base);
      deleted += orphans.length;
    } else if (prune && orphans.length) {
      for (const r of orphans) await edit.delete(`${base}/${r.id}`, { throwOnError: false });
      deleted += orphans.length;
    }
    for (const item of toUpload) {
      await images.upload({ language: set.locale, imageType: set.imageType, filePath: item.path });
      uploaded.push(item.file);
    }
  }

  if (!prune && !single && orphans.length) {
    findings.push(
      finding({
        id: `images.orphans.kept.${set.imageType}.${set.locale}`,
        severity: Severity.WARNING,
        category: Category.STORE_STATE,
        title: `${orphans.length} remote ${set.imageType} for ${set.locale} have no local counterpart`,
        detail: orphans.map((r) => r.id).join(", "),
        fixOwner: FixOwner.CLI,
        fix: "Re-run with prune enabled to remove them, or add the matching files locally.",
      }),
    );
  }
  if (orderDiffers && !reorder) {
    findings.push(
      finding({
        id: `images.order.differs.${set.imageType}.${set.locale}`,
        severity: Severity.WARNING,
        category: Category.STORE_STATE,
        title: `${set.imageType} for ${set.locale} are in a different order on Play`,
        detail: "Play has no reorder call; matching the local order means deleting and re-uploading the set.",
        fixOwner: FixOwner.CLI,
        fix: "Re-upload in order.",
        fixCommand: "playstore-release images --reorder",
        docs: "references/gotchas.md#images",
      }),
    );
  }

  return {
    imageType: set.imageType,
    locale: set.locale,
    total: local.length,
    uploaded,
    deleted,
    unchanged: local.length - uploaded.length,
    reordered: Boolean(orderDiffers && reorder),
    orderDiffers,
    changed: Boolean(uploaded.length || deleted),
    dryRun: Boolean(dryRun),
  };
}
