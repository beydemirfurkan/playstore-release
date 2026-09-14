// The operation registry. One import list, one map, one pipeline order — so
// `listOperations()` can describe the whole surface to a CLI, an MCP server or a
// help screen without any of them hardcoding the set.

import * as status from "./status.mjs";
import * as check from "./check.mjs";
import * as uploadBundle from "./upload-bundle.mjs";
import * as details from "./details.mjs";
import * as listing from "./listing.mjs";
import * as images from "./images.mjs";
import * as release from "./release.mjs";
import * as testers from "./testers.mjs";
import * as promote from "./promote.mjs";
import * as dataSafety from "./data-safety.mjs";
import * as subscriptions from "./subscriptions.mjs";
import * as reviews from "./reviews.mjs";
import * as reviewReply from "./review-reply.mjs";

/**
 * @typedef {Object} OperationMeta
 * @property {string} id
 * @property {string} title
 * @property {"build"|"listing"|"release"} phase
 * @property {string[]} needs                    config concerns, enforced before the operation runs
 * @property {boolean} [edit]                    true: works inside ctx.edit (committed by the orchestrator)
 * @property {boolean} [mutates]
 * @property {boolean} [destructive]             can delete data that already exists on Play
 * @property {boolean} [irreversible]            cannot be undone through the API
 * @property {Record<string, import("../cli/args.mjs").FlagSpec>} [args]
 */

/** @typedef {{ meta: OperationMeta, run: (ctx: any, args?: any) => Promise<any> }} Operation */

/** @type {Record<string, Operation>} */
export const OPERATIONS = {
  status,
  check,
  "upload-bundle": uploadBundle,
  details,
  listing,
  images,
  release,
  testers,
  promote,
  "data-safety": dataSafety,
  subscriptions,
  reviews,
  "review-reply": reviewReply,
};

/**
 * Order of the publishing pipeline (`publish`). Every step is idempotent and all
 * of them share ONE edit, committed once at the end:
 *   - release needs the versionCode upload-bundle put into the edit;
 *   - images 404 for a language with no listing, so listing goes first;
 *   - details carries defaultLanguage, which listing relies on.
 */
export const PIPELINE = Object.freeze(["upload-bundle", "details", "listing", "images", "release", "testers"]);

/** @param {string} id */
export const getOperation = (id) => OPERATIONS[id] ?? null;

export const operationIds = () => Object.keys(OPERATIONS);
