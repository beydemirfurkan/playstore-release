// Store settings → contact details and the default language.

import { Status } from "../core/status.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "details",
  title: "Contact details",
  phase: "listing",
  needs: ["details"],
  edit: true,
  mutates: true,
};

const FIELDS = ["defaultLanguage", "contactEmail", "contactPhone", "contactWebsite"];

/** @param {import("../core/context.mjs").Context} ctx */
export async function run({ edit, config }) {
  const wanted = pick({ defaultLanguage: config.defaultLanguage, ...config.details }, FIELDS);
  const current = await edit.get("/details", { throwOnError: false });
  const remote = current.error ? {} : current;

  const changes = diff(remote, wanted);
  if (!Object.keys(changes).length) return { status: Status.OK, message: "already up to date" };

  await edit.patch("/details", changes);
  return {
    status: Status.CHANGED,
    message: Object.keys(changes).join(", "),
    details: { changed: changes },
  };
}

export const pick = (source, fields) =>
  Object.fromEntries(fields.filter((f) => source[f] !== undefined && source[f] !== null).map((f) => [f, source[f]]));

/** Only the fields whose value would actually change. */
export function diff(current, wanted) {
  const out = {};
  for (const [key, value] of Object.entries(wanted)) {
    if ((current[key] ?? "") !== (value ?? "")) out[key] = value;
  }
  return out;
}
