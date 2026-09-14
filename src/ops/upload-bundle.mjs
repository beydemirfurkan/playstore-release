// Put the signed .aab into the edit — unless Play already holds these exact
// bytes, which its sha1 tells us without a re-upload.

import { Status } from "../core/status.mjs";
import { finding, Category, FixOwner } from "../core/findings.mjs";
import { readAsset } from "../play/uploads.mjs";
import { localBundle } from "../report/checks/bundle.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "upload-bundle",
  title: "Upload bundle",
  phase: "build",
  needs: [],
  edit: true,
  mutates: true,
  args: {
    file: {
      type: "string",
      description: "path to the .aab (default: config.bundle.path, or the newest in config.bundle.dir)",
    },
    ackWarnings: {
      type: "boolean",
      default: false,
      description: "acknowledge Play's installation warnings for this bundle",
    },
  },
};

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ file?: string, ackWarnings?: boolean }} [args]
 */
export async function run(ctx, args = {}) {
  const { edit, bundles, config, resolvePath, dryRun } = ctx;

  const path = args.file ? resolvePath(args.file, "--file") : localBundle(config, resolvePath);
  if (path === undefined) {
    return {
      status: Status.SKIPPED,
      message: "no bundle configured (config.bundle) and no --file given — CI uploads it, or run with --file",
    };
  }
  if (path === null) {
    return {
      status: Status.ERROR,
      message: "config.bundle names a file or directory that holds no .aab",
      findings: [
        finding({
          id: "bundle.local.missing",
          category: Category.BINARY,
          title: "No local .aab",
          detail: `Nothing at ${config?.bundle?.path ?? config?.bundle?.dir}.`,
          fixOwner: FixOwner.EXTERNAL,
          fix: "Build it (./gradlew bundleRelease) or download the CI artefact, then re-run.",
        }),
      ],
    };
  }

  // Hash before opening anything: an unreadable file fails here, locally.
  const { sha1, size } = readAsset(path);

  const existing = (await edit.get("/bundles")).bundles ?? [];
  const match = existing.find((b) => b.sha1 === sha1);
  if (match) {
    edit.note("versionCode", Number(match.versionCode));
    return {
      status: Status.OK,
      message: `versionCode ${match.versionCode} already uploaded (${mb(size)})`,
      details: { versionCode: Number(match.versionCode), sha1, path, uploaded: false },
    };
  }

  const res = await bundles.upload({ filePath: path, ackWarnings: args.ackWarnings });
  if (res.versionCode != null) edit.note("versionCode", Number(res.versionCode));
  else if (dryRun) edit.note("versionCode", "dry");

  return {
    status: Status.CHANGED,
    message: dryRun ? `would upload ${mb(size)} from ${path}` : `uploaded versionCode ${res.versionCode} (${mb(size)})`,
    details: { versionCode: res.versionCode ?? null, sha1, path, uploaded: true },
  };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
