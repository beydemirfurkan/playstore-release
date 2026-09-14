// One read-only pass over Google Play, producing a plain object. No judgement
// lives here — the checks in ./checks/ decide what any of it means.
//
// Every read on this API happens inside an edit, so the snapshot opens one
// through ctx.edit (lazily) and leaves it for the orchestrator to discard.
// Each section is independently guarded: a 403 on one endpoint must still
// leave a usable report for the rest, with the gap named in `errors`.

import { localeCodes } from "../core/locales.mjs";
import { IMAGE_TYPES } from "../play/imagemeta.mjs";
import { PlayApiError } from "../play/client.mjs";

/**
 * @typedef {Object} AppSnapshot
 * @property {string} generatedAt
 * @property {string} packageName
 * @property {{ status: number, reason?: string }} access   whether the edit could be opened at all
 * @property {Array<{versionCode: number, sha1?: string, sha256?: string}>} bundles
 * @property {Array<{track: string, releases: any[]}>} tracks
 * @property {Record<string, any>} listings            by language
 * @property {Record<string, Record<string, Array<{id: string, sha1?: string}>>>} images   by language, then image type
 * @property {any} details
 * @property {Record<string, string[]>} testers        by track
 * @property {{ total: number, unreplied: number } | null} reviews
 * @property {any[]} subscriptions
 * @property {string|null} locale
 * @property {string[]} locales
 * @property {string[]} errors
 */

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ locale?: string }} [opts]
 * @returns {Promise<AppSnapshot>}
 */
export async function getAppSnapshot(ctx, { locale } = {}) {
  const { client, edit, config, packageName } = ctx;
  const configured = localeCodes(config);
  const wanted = locale ? [locale] : configured;
  const primary = wanted[0] ?? null;
  /** @type {string[]} */
  const errors = [];

  /** Run a section, recording rather than propagating its failure. */
  const section = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  /** @type {AppSnapshot["access"]} */
  let access = { status: 200 };
  try {
    await edit.ensure();
  } catch (e) {
    access =
      e instanceof PlayApiError ? { status: e.status, reason: e.googleMessage } : { status: 0, reason: String(e) };
    errors.push(`edit: ${e instanceof Error ? e.message : String(e)}`);
  }

  const empty = {
    generatedAt: new Date().toISOString(),
    packageName,
    access,
    bundles: [],
    tracks: [],
    listings: {},
    images: {},
    details: null,
    testers: {},
    reviews: null,
    subscriptions: [],
    locale: primary,
    locales: wanted,
    errors,
  };
  if (access.status !== 200) return empty;

  const bundles = await section("bundles", async () => (await edit.get("/bundles")).bundles ?? [], []);
  const tracks = await section("tracks", async () => (await edit.get("/tracks")).tracks ?? [], []);

  const listings = await section(
    "listings",
    async () => {
      const all = (await edit.get("/listings")).listings ?? [];
      return Object.fromEntries(all.map((l) => [l.language, l]));
    },
    {},
  );

  const images = await section(
    "images",
    async () => {
      /** @type {AppSnapshot["images"]} */
      const out = {};
      for (const lang of wanted) {
        if (!listings[lang]) continue; // Play 404s image reads for a language without a listing
        out[lang] = {};
        for (const type of IMAGE_TYPES) {
          const r = await edit.get(`/listings/${encodeURIComponent(lang)}/${type}`, { throwOnError: false });
          out[lang][type] = r.error ? [] : (r.images ?? []).map((i) => ({ id: i.id, sha1: i.sha1 }));
        }
      }
      return out;
    },
    {},
  );

  const details = await section("details", () => edit.get("/details"), null);

  const testers = await section(
    "testers",
    async () => {
      /** @type {Record<string, string[]>} */
      const out = {};
      for (const track of Object.keys(config?.testers ?? {})) {
        if (track.startsWith("$")) continue;
        const r = await edit.get(`/testers/${track}`, { throwOnError: false });
        out[track] = r.error ? [] : (r.googleGroups ?? []);
      }
      return out;
    },
    {},
  );

  // Outside the edit: reviews are read-only and cheap, but need their own
  // permission — a 403 here is a gap in the report, not a failure of it.
  const reviews = await section(
    "reviews",
    async () => {
      const r = await client.get("/reviews?maxResults=50", { throwOnError: false });
      if (r.error) {
        if (r.error.status === 403) return null;
        throw r.error;
      }
      const list = r.reviews ?? [];
      const unreplied = list.filter((rv) => !(rv.comments ?? []).some((c) => c.developerComment)).length;
      return { total: list.length, unreplied };
    },
    null,
  );

  const subscriptions =
    (config?.subscriptions?.length ?? 0)
      ? await section("subscriptions", async () => (await client.get("/subscriptions")).subscriptions ?? [], [])
      : [];

  return { ...empty, bundles, tracks, listings, images, details, testers, reviews, subscriptions, errors };
}

/** Highest versionCode Play knows for this app, on any track or merely uploaded. */
export function newestVersionCode(snapshot) {
  const codes = [
    ...snapshot.bundles.map((b) => Number(b.versionCode)),
    ...snapshot.tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number))),
  ].filter((n) => Number.isFinite(n));
  return codes.length ? Math.max(...codes) : null;
}

/** The release on a track that serves a versionCode, if any. */
export function releaseFor(snapshot, track, versionCode) {
  const t = snapshot.tracks.find((x) => x.track === track);
  return (t?.releases ?? []).find((r) => (r.versionCodes ?? []).map(Number).includes(Number(versionCode))) ?? null;
}
