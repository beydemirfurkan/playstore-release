// Read an image's dimensions and alpha channel from its header, with no
// dependency and no `sips` — so asset validation works on Linux and in CI.
//
// PNG: the IHDR chunk is always first and always 13 bytes, so 33 bytes suffice.
// JPEG: walk the marker segments until the first SOF (start of frame), which
// carries height, width and component count.

import { openSync, readSync, closeSync, statSync } from "node:fs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG colour types that carry an alpha channel. */
const ALPHA_COLOR_TYPES = new Set([4, 6]);

/**
 * @typedef {Object} ImageInfo
 * @property {"png"|"jpeg"} format
 * @property {number} width
 * @property {number} height
 * @property {boolean} hasAlpha
 * @property {number} size          bytes on disk
 */

/**
 * @param {string} filePath
 * @returns {ImageInfo|null} null when the file is unreadable or neither PNG nor JPEG
 */
export function readImage(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = statSync(filePath).size;
    const head = Buffer.alloc(33);
    const read = readSync(fd, head, 0, 33, 0);
    if (read >= 33 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(head, size);
    if (read >= 4 && head[0] === 0xff && head[1] === 0xd8) return readJpeg(fd, size);
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** @param {Buffer} head @param {number} size @returns {ImageInfo|null} */
function readPng(head, size) {
  if (head.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const colorType = head.readUInt8(25);
  return {
    format: "png",
    width: head.readUInt32BE(16),
    height: head.readUInt32BE(20),
    hasAlpha: ALPHA_COLOR_TYPES.has(colorType),
    size,
  };
}

/** SOF markers: baseline, extended, progressive, lossless and their differential forms. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** @param {number} fd @param {number} size @returns {ImageInfo|null} */
function readJpeg(fd, size) {
  let offset = 2;
  const marker = Buffer.alloc(4);
  const frame = Buffer.alloc(6);
  // Bound the walk: a corrupt file must not spin forever.
  for (let i = 0; i < 1024 && offset + 4 <= size; i++) {
    if (readSync(fd, marker, 0, 4, offset) < 4) return null;
    if (marker[0] !== 0xff) return null;
    const code = marker[1];
    if (code === 0xd8 || (code >= 0xd0 && code <= 0xd7) || code === 0x01 || code === 0xff) {
      // Standalone markers carry no length.
      offset += code === 0xff ? 1 : 2;
      continue;
    }
    const length = marker.readUInt16BE(2);
    if (SOF.has(code)) {
      if (readSync(fd, frame, 0, 6, offset + 4) < 6) return null;
      // frame: precision(1) height(2) width(2) components(1)
      return { format: "jpeg", width: frame.readUInt16BE(3), height: frame.readUInt16BE(1), hasAlpha: false, size };
    }
    if (code === 0xda) return null; // start of scan before any SOF: malformed
    offset += 2 + length;
  }
  return null;
}

/**
 * What Google Play accepts per image type. Sizes in pixels; `exact` means the
 * dimensions must match precisely, otherwise `min`/`max` bound each side and
 * `ratio` bounds long side ÷ short side.
 *
 * Play's own words: "The maximum dimension of your screenshot can't be more than
 * twice as long as the minimum dimension." An iPhone 6.7" shot (1290×2796,
 * ratio 2.17) fails that; 1080×1920 passes.
 */
export const IMAGE_RULES = Object.freeze({
  icon: { exact: { width: 512, height: 512 }, formats: ["png"], alpha: true, maxBytes: 1024 * 1024, min: 1, max: 1 },
  featureGraphic: { exact: { width: 1024, height: 500 }, formats: ["png", "jpeg"], alpha: false, min: 1, max: 1 },
  phoneScreenshots: { side: { min: 320, max: 3840 }, ratio: 2, formats: ["png", "jpeg"], alpha: false, min: 2, max: 8 },
  sevenInchScreenshots: {
    side: { min: 320, max: 3840 },
    ratio: 2,
    formats: ["png", "jpeg"],
    alpha: false,
    min: 0,
    max: 8,
  },
  tenInchScreenshots: {
    side: { min: 320, max: 3840 },
    ratio: 2,
    formats: ["png", "jpeg"],
    alpha: false,
    min: 0,
    max: 8,
  },
});

/** Image types Play accepts, in the order they are reconciled. */
export const IMAGE_TYPES = Object.freeze(Object.keys(IMAGE_RULES));

/** Single-file image types: the config names a file, not a directory. */
export const SINGLE_IMAGE_TYPES = Object.freeze(["icon", "featureGraphic"]);

/**
 * Every rule an image breaks, as short human strings — empty when it is fine.
 *
 * @param {string} imageType
 * @param {ImageInfo|null} info
 * @returns {string[]}
 */
export function imageProblems(imageType, info) {
  const rule = IMAGE_RULES[imageType];
  if (!rule) return [];
  if (!info) return ["is not a readable PNG or JPEG"];
  const out = [];
  if (!rule.formats.includes(info.format))
    out.push(`is ${info.format.toUpperCase()}; Play accepts ${rule.formats.join("/")}`);
  if (rule.exact && (info.width !== rule.exact.width || info.height !== rule.exact.height)) {
    out.push(`is ${info.width}×${info.height}, not ${rule.exact.width}×${rule.exact.height}`);
  }
  if (rule.side) {
    const sides = [info.width, info.height];
    if (sides.some((s) => s < rule.side.min || s > rule.side.max)) {
      out.push(`is ${info.width}×${info.height}; each side must be ${rule.side.min}–${rule.side.max} px`);
    }
    const ratio = Math.max(...sides) / Math.min(...sides);
    if (rule.ratio && ratio > rule.ratio + 1e-9) {
      out.push(`has a ${ratio.toFixed(2)}:1 aspect ratio; the long side may be at most ${rule.ratio}× the short side`);
    }
  }
  if (!rule.alpha && info.hasAlpha) out.push("has an alpha channel; Play wants 24-bit PNG or JPEG here");
  if (rule.maxBytes && info.size > rule.maxBytes)
    out.push(`is ${Math.round(info.size / 1024)} KB; the limit is ${rule.maxBytes / 1024} KB`);
  return out;
}
