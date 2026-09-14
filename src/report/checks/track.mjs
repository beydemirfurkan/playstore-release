// Is the newest bundle released where the config says, in the state it says.

import { finding, Severity, Category, FixOwner } from "../../core/findings.mjs";
import { resolveLocales } from "../../core/locales.mjs";
import { newestVersionCode, releaseFor } from "../snapshot.mjs";

export const section = { id: "track", title: "Release" };

/** @param {{ snapshot: any, config: any }} input */
export function check({ snapshot, config }) {
  const out = [];
  if (snapshot.access?.status !== 200) return out;
  const newest = newestVersionCode(snapshot);
  if (newest == null) return out;

  const wantedTrack = config?.release?.track ?? "internal";
  const release = releaseFor(snapshot, wantedTrack, newest);

  if (!release) {
    const elsewhere = snapshot.tracks.find((t) => releaseFor(snapshot, t.track, newest));
    out.push(
      finding({
        id: "track.release.missing",
        category: Category.STORE_STATE,
        title: `versionCode ${newest} is not released on ${wantedTrack}`,
        detail: elsewhere
          ? `It is on ${elsewhere.track}. Promote it, or set config.release.track to ${elsewhere.track}.`
          : `No release on ${wantedTrack} serves it.`,
        fix: elsewhere ? `Promote it to ${wantedTrack}.` : `Create the ${wantedTrack} release.`,
        fixCommand: elsewhere
          ? `playstore-release promote --from ${elsewhere.track} --to ${wantedTrack}`
          : "playstore-release release",
        docs: "references/gotchas.md#tracks-and-rollouts",
      }),
    );
  } else {
    const wantedStatus = config?.release?.status;
    if (wantedStatus && release.status !== wantedStatus) {
      out.push(
        finding({
          id: "track.status.differs",
          severity: Severity.WARNING,
          category: Category.STORE_STATE,
          title: `The ${wantedTrack} release is ${release.status}, config wants ${wantedStatus}`,
          detail: `versionCode ${newest} on ${wantedTrack}.`,
          fixOwner: FixOwner.CLI,
          fix: "Re-apply the release from the config.",
          fixCommand: "playstore-release release",
        }),
      );
    }
    // Release notes for every configured language that has any.
    const notesWanted = resolveLocales(config).filter((l) => l.listing.releaseNotes);
    const notesHave = new Set((release.releaseNotes ?? []).map((n) => n.language));
    for (const { locale } of notesWanted) {
      if (notesHave.has(locale)) continue;
      out.push(
        finding({
          id: `track.notes.missing.${locale}`,
          severity: Severity.WARNING,
          category: Category.STORE_STATE,
          title: `No ${locale} release notes on the ${wantedTrack} release`,
          detail: "The config has releaseNotes for this language; the release does not.",
          fixOwner: FixOwner.CLI,
          fix: "Write them onto the release.",
          fixCommand: "playstore-release release",
        }),
      );
    }
  }

  // Production, whatever the configured track: a staged or halted rollout is
  // worth knowing about in every report.
  const production = snapshot.tracks.find((t) => t.track === "production");
  for (const r of production?.releases ?? []) {
    if (r.status === "inProgress") {
      out.push(
        finding({
          id: "track.rollout.in-progress",
          severity: Severity.INFO,
          category: Category.STORE_STATE,
          title: `Production rollout at ${Math.round((r.userFraction ?? 0) * 100)}%`,
          detail: `versionCodes ${(r.versionCodes ?? []).join(", ")} are being served to ${Math.round((r.userFraction ?? 0) * 100)}% of users. Complete it when crash rates look fine.`,
          fixOwner: FixOwner.CLI,
          fix: "Widen or complete the rollout.",
          fixCommand: "playstore-release promote --complete",
        }),
      );
    }
    if (r.status === "halted") {
      out.push(
        finding({
          id: "track.rollout.halted",
          severity: Severity.WARNING,
          category: Category.STORE_STATE,
          title: "The production rollout is halted",
          detail: `versionCodes ${(r.versionCodes ?? []).join(", ")} are no longer served to new users.`,
          fixOwner: FixOwner.CLI,
          fix: "Resume it, or upload a fixed bundle.",
          fixCommand: "playstore-release promote --resume",
        }),
      );
    }
  }

  return out;
}
