// Bundles: is there one, is the newest one on a track, is the local one newer.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { finding, Severity, Category, FixOwner } from "../../core/findings.mjs";
import { readAsset } from "../../play/uploads.mjs";
import { newestVersionCode } from "../snapshot.mjs";

export const section = { id: "bundle", title: "Bundles" };

/** @param {{ snapshot: any, config: any, resolvePath?: (p: string, purpose?: string) => string }} input */
export function check({ snapshot, config, resolvePath }) {
  const out = [];
  if (snapshot.access?.status !== 200) return out;

  const newest = newestVersionCode(snapshot);
  if (newest == null) return out; // the console check owns "no bundle at all"

  const onTrack = snapshot.tracks.some((t) =>
    (t.releases ?? []).some((r) => (r.versionCodes ?? []).map(Number).includes(newest)),
  );
  if (!onTrack) {
    out.push(
      finding({
        id: "bundle.unassigned",
        category: Category.STORE_STATE,
        title: `versionCode ${newest} is uploaded but on no track`,
        detail: "An uploaded bundle serves nobody until a release on a track names it.",
        fix: "Create the release from your config.",
        fixCommand: "playstore-release release",
        evidence: { resource: "bundles", id: String(newest) },
      }),
    );
  }

  // Local bundle, if the config names one.
  const local = localBundle(config, resolvePath);
  if (local === undefined) return out;
  if (local === null) {
    out.push(
      finding({
        id: "bundle.local.missing",
        severity: Severity.WARNING,
        category: Category.BINARY,
        title: "config.bundle points at nothing",
        detail: "No .aab was found at the configured path or directory.",
        fixOwner: FixOwner.EXTERNAL,
        fix: "Build the bundle (./gradlew bundleRelease, or download the CI artefact) or fix config.bundle.",
      }),
    );
    return out;
  }
  const { sha1 } = readAsset(local);
  if (!snapshot.bundles.some((b) => b.sha1 === sha1)) {
    out.push(
      finding({
        id: "bundle.local.newer",
        severity: Severity.WARNING,
        category: Category.BINARY,
        title: "The local .aab has not been uploaded",
        detail: `${local} is not among the bundles Play holds.`,
        fixOwner: FixOwner.CLI,
        fix: "Upload it.",
        fixCommand: "playstore-release upload-bundle",
      }),
    );
  }
  return out;
}

/**
 * The bundle the config names: a path, or the newest .aab in a directory.
 * undefined when the config says nothing, null when it names something absent.
 */
export function localBundle(config, resolvePath) {
  const cfg = config?.bundle;
  if (!cfg || !resolvePath) return undefined;
  try {
    if (cfg.path) {
      const p = resolvePath(cfg.path, "config.bundle.path");
      return existsSync(p) ? p : null;
    }
    if (cfg.dir) {
      const dir = resolvePath(cfg.dir, "config.bundle.dir");
      if (!existsSync(dir)) return null;
      const files = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".aab"))
        .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return files.length ? join(dir, files[0].f) : null;
    }
  } catch {
    return null;
  }
  return undefined;
}
