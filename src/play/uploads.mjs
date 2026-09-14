// Media uploads inside an edit: store images and app bundles. Play takes the
// bytes in one request and answers with the stored object, including the sha1
// it computed — which is what makes "is this file already there" a cheap
// comparison instead of a re-upload.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/**
 * Hash a local file the way Play reports it.
 * @param {string} filePath
 * @returns {{ bytes: Buffer, sha1: string, sha256: string, size: number }}
 */
export function readAsset(filePath) {
  const bytes = readFileSync(filePath);
  return {
    bytes,
    sha1: crypto.createHash("sha1").update(bytes).digest("hex"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

export class ImageUploader {
  /**
   * @param {import("./client.mjs").PlayClient} client
   * @param {import("./edits.mjs").EditManager} edit
   */
  constructor(client, edit) {
    this.client = client;
    this.edit = edit;
  }

  /**
   * @param {{ language: string, imageType: string, filePath: string }} p
   * @returns {Promise<{ id?: string, sha1?: string, url?: string }>}
   */
  async upload({ language, imageType, filePath }) {
    // Read before anything else, so a missing file fails locally rather than
    // after the edit was opened. Under dry run this is the whole point.
    const { bytes, sha1 } = readAsset(filePath);
    const contentType = MIME[extname(filePath).toLowerCase()] ?? "image/png";
    const res = await this.edit.upload(`/listings/${encodeURIComponent(language)}/${imageType}`, {
      bytes,
      contentType,
    });
    const image = res.image ?? {};
    return { id: image.id, sha1: image.sha1 ?? (this.client.dryRun ? sha1 : undefined), url: image.url };
  }
}

export class BundleUploader {
  /**
   * @param {import("./client.mjs").PlayClient} client
   * @param {import("./edits.mjs").EditManager} edit
   */
  constructor(client, edit) {
    this.client = client;
    this.edit = edit;
  }

  /**
   * @param {{ filePath: string, ackWarnings?: boolean }} p
   * @returns {Promise<{ versionCode?: number, sha1?: string, sha256?: string }>}
   */
  async upload({ filePath, ackWarnings = false }) {
    const { bytes, sha1, sha256 } = readAsset(filePath);
    const query = ackWarnings ? "?ackBundleInstallationWarning=true" : "";
    const res = await this.edit.upload(`/bundles${query}`, {
      bytes,
      contentType: "application/octet-stream",
    });
    return { versionCode: res.versionCode, sha1: res.sha1 ?? (this.client.dryRun ? sha1 : undefined), sha256 };
  }
}
