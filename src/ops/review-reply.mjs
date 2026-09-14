// Reply to one review. Public, permanent, and sent under the developer's name —
// hence irreversible and behind --yes.

import { Status } from "../core/status.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "review-reply",
  title: "Reply to a review",
  phase: "release",
  needs: [],
  edit: false,
  mutates: true,
  irreversible: true,
  args: {
    review: { type: "string", description: "the review id (from `reviews`)" },
    text: { type: "string", description: "the reply, at most 350 characters" },
  },
};

const MAX = 350;

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ review?: string, text?: string }} [args]
 */
export async function run({ client, dryRun }, args = {}) {
  if (!args.review || !args.text)
    return { status: Status.ERROR, message: "--review <id> and --text <reply> are both required" };
  if (args.text.length > MAX)
    return { status: Status.ERROR, message: `the reply is ${args.text.length} characters; Play allows ${MAX}` };
  const res = await client.post(`/reviews/${encodeURIComponent(args.review)}:reply`, { replyText: args.text });
  return {
    status: Status.CHANGED,
    message: dryRun ? `would reply to ${args.review}` : `replied to ${args.review}`,
    details: { review: args.review, result: res.result ?? null },
  };
}
