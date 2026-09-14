// Google Groups allowed on each testing track.

import { Status } from "../core/status.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "testers",
  title: "Testers",
  phase: "release",
  needs: [],
  edit: true,
  mutates: true,
  args: {
    track: { type: "string", description: "only this track (default: every track in config.testers)" },
  },
};

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ track?: string }} [args]
 */
export async function run({ edit, config }, args = {}) {
  if (!config?.testers || typeof config.testers !== "object") {
    return { status: Status.SKIPPED, message: "no testers configured (config.testers)" };
  }
  const tracks = Object.keys(config.testers).filter((t) => !t.startsWith("$") && (!args.track || t === args.track));
  const changed = [];
  for (const track of tracks) {
    const wanted = [...new Set(config.testers[track] ?? [])].sort();
    const current = await edit.get(`/testers/${track}`, { throwOnError: false });
    const remote = current.error ? [] : [...(current.googleGroups ?? [])].sort();
    if (remote.length === wanted.length && remote.every((g, i) => g === wanted[i])) continue;
    await edit.put(`/testers/${track}`, { googleGroups: wanted });
    changed.push(track);
  }
  if (!changed.length) return { status: Status.OK, message: `${tracks.join(", ") || "no tracks"}: already up to date` };
  return { status: Status.CHANGED, message: `updated ${changed.join(", ")}`, details: { changed } };
}
