// Put a versionCode on a track with the configured status, rollout share and
// release notes. Writes the whole `releases` array back, as the API requires —
// keeping a still-serving completed release alongside a staged one so users
// outside the rollout keep getting the previous version.

import { Status } from "../core/status.mjs";
import { finding, Category, FixOwner } from "../core/findings.mjs";
import { resolveLocales } from "../core/locales.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "release",
  title: "Track release",
  phase: "release",
  needs: [],
  edit: true,
  mutates: true,
  args: {
    track: { type: "string", description: "override config.release.track" },
    versionCode: {
      type: "number",
      description: "override the versionCode (default: the one uploaded in this edit, else the newest on Play)",
    },
    status: { type: "string", description: "override config.release.status (draft | inProgress | halted | completed)" },
    userFraction: { type: "number", description: "override config.release.userFraction" },
    notes: { type: "boolean", default: true, description: "write releaseNotes from the config's listings" },
  },
};

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ track?: string, versionCode?: number, status?: string, userFraction?: number, notes?: boolean }} [args]
 */
export async function run(ctx, args = {}) {
  const { edit, config, dryRun } = ctx;
  const cfg = config?.release ?? {};
  const track = args.track ?? cfg.track ?? "internal";
  const status = args.status ?? cfg.status ?? "completed";
  const userFraction = args.userFraction ?? cfg.userFraction;

  const versionCode = args.versionCode ?? edit.notes.versionCode ?? (await newestUploaded(edit));
  if (versionCode == null) {
    return {
      status: Status.ERROR,
      message: "no versionCode to release — upload a bundle first",
      findings: [
        finding({
          id: "bundle.none",
          category: Category.BINARY,
          title: "No bundle to release",
          detail: "Play holds no bundle for this app and none was uploaded in this edit.",
          fixOwner: FixOwner.EXTERNAL,
          fix: "Upload one (playstore-release upload-bundle --file app.aab, or let CI publish to internal).",
        }),
      ],
    };
  }
  if (versionCode === "dry") {
    return {
      status: Status.CHANGED,
      message: `would release the uploaded bundle on ${track} as ${status}`,
      details: { track, status },
    };
  }

  const wanted = desiredRelease({ config, versionCode, status, userFraction, notes: args.notes !== false });

  const current = await edit.get(`/tracks/${encodeURIComponent(track)}`, { throwOnError: false });
  const releases = current.error ? [] : (current.releases ?? []);
  const existing = releases.find((r) => (r.versionCodes ?? []).map(Number).includes(Number(versionCode)));

  if (existing && sameRelease(existing, wanted)) {
    return {
      status: Status.OK,
      message: `versionCode ${versionCode} already ${wanted.status} on ${track}`,
      details: { track, release: existing },
    };
  }

  // Everything that is not about this versionCode stays as it is — with one
  // exception: a full (completed) release supersedes any other completed one.
  const others = releases.filter((r) => r !== existing);
  const kept =
    wanted.status === "completed"
      ? others.filter((r) => r.status !== "completed" && r.status !== "inProgress" && r.status !== "halted")
      : others.filter((r) => r.status === "completed");
  await edit.put(`/tracks/${encodeURIComponent(track)}`, { track, releases: [wanted, ...kept] });

  const share = wanted.userFraction != null ? ` to ${Math.round(wanted.userFraction * 100)}%` : "";
  return {
    status: Status.CHANGED,
    message: dryRun
      ? `would set versionCode ${versionCode} ${wanted.status}${share} on ${track}`
      : `versionCode ${versionCode} is now ${wanted.status}${share} on ${track}`,
    details: { track, release: wanted, replaced: existing ?? null },
  };
}

/**
 * Build the release object the config describes.
 * @param {{ config: any, versionCode: number|string, status: string, userFraction?: number, notes?: boolean, name?: string }} p
 */
export function desiredRelease({ config, versionCode, status, userFraction, notes = true, name }) {
  /** @type {any} */
  const release = { versionCodes: [String(versionCode)], status };
  const releaseName = name ?? config?.release?.name;
  if (releaseName) release.name = releaseName;
  if (status === "inProgress" && userFraction != null) release.userFraction = userFraction;
  if (config?.release?.inAppUpdatePriority != null) release.inAppUpdatePriority = config.release.inAppUpdatePriority;
  if (notes) {
    const releaseNotes = resolveLocales(config)
      .filter((l) => l.listing.releaseNotes)
      .map((l) => ({ language: l.locale, text: l.listing.releaseNotes }));
    if (releaseNotes.length) release.releaseNotes = releaseNotes;
  }
  return release;
}

/** The fields we manage, compared loosely enough that Play's echo counts as equal. */
export function sameRelease(current, wanted) {
  if (current.status !== wanted.status) return false;
  if ((current.userFraction ?? null) !== (wanted.userFraction ?? null)) return false;
  if (wanted.name && current.name !== wanted.name) return false;
  if (wanted.inAppUpdatePriority != null && (current.inAppUpdatePriority ?? 0) !== wanted.inAppUpdatePriority)
    return false;
  const notesOf = (r) =>
    JSON.stringify([...(r.releaseNotes ?? [])].sort((a, b) => a.language.localeCompare(b.language)));
  if (wanted.releaseNotes && notesOf(current) !== notesOf(wanted)) return false;
  return true;
}

async function newestUploaded(edit) {
  const { bundles = [] } = await edit.get("/bundles");
  const codes = bundles.map((b) => Number(b.versionCode)).filter(Number.isFinite);
  return codes.length ? Math.max(...codes) : null;
}
