// Recent user reviews, read-only. The reply lives in review-reply so the
// irreversible action carries its own confirmation.

import { Status } from "../core/status.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "reviews",
  title: "Reviews",
  phase: "release",
  needs: [],
  edit: false,
  mutates: false,
  args: {
    max: { type: "number", default: 20, description: "how many recent reviews to list (max 100)" },
    translation: { type: "string", description: "translate review text into this language, e.g. en" },
    unreplied: { type: "boolean", default: false, description: "only reviews without a developer reply" },
  },
};

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ max?: number, translation?: string, unreplied?: boolean }} [args]
 */
export async function run({ client, log }, args = {}) {
  const max = Math.min(Math.max(Number(args.max) || 20, 1), 100);
  const query = [
    `maxResults=${max}`,
    args.translation ? `translationLanguage=${encodeURIComponent(args.translation)}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const res = await client.get(`/reviews?${query}`);
  const reviews = (res.reviews ?? [])
    .map((r) => {
      const user = (r.comments ?? []).find((c) => c.userComment)?.userComment ?? {};
      const dev = (r.comments ?? []).find((c) => c.developerComment)?.developerComment ?? null;
      return {
        id: r.reviewId,
        author: r.authorName,
        stars: user.starRating,
        text: user.text?.trim() ?? "",
        language: user.reviewerLanguage,
        appVersion: user.appVersionName,
        device: user.device,
        at: user.lastModified?.seconds ? new Date(Number(user.lastModified.seconds) * 1000).toISOString() : null,
        replied: Boolean(dev),
        reply: dev?.text ?? null,
      };
    })
    .filter((r) => !args.unreplied || !r.replied);

  for (const r of reviews) {
    log.info(
      `${"★".repeat(r.stars ?? 0).padEnd(5, "☆")} ${r.at?.slice(0, 10) ?? "?"} ${r.author ?? "?"} (${r.language ?? "?"}) ${r.replied ? "· replied" : ""}`,
    );
    if (r.text) log.info(`      ${r.text.replace(/\s+/g, " ").slice(0, 200)}`);
    log.info(`      id ${r.id}`);
  }
  return {
    status: Status.OK,
    message: `${reviews.length} review(s), ${reviews.filter((r) => !r.replied).length} unreplied`,
    details: { reviews },
  };
}
