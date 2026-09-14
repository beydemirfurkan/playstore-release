// Store settings → contact details. A contact email is the one field Play
// insists on before a listing goes live.

import { finding, Severity, Category, FixOwner } from "../../core/findings.mjs";

export const section = { id: "details", title: "Contact details" };

const FIELDS = ["contactEmail", "contactPhone", "contactWebsite"];

/** @param {{ snapshot: any, config: any }} input */
export function check({ snapshot, config }) {
  const out = [];
  if (snapshot.access?.status !== 200 || !snapshot.details) return out;
  const remote = snapshot.details;

  if (!remote.contactEmail) {
    out.push(
      finding({
        id: "details.email.missing",
        category: Category.STORE_STATE,
        title: "No contact email",
        detail: "Play shows it on the listing and refuses to publish without one.",
        fix: "Set details.contactEmail in the config and write it.",
        fixCommand: "playstore-release details",
      }),
    );
  }

  const wantedLang = config?.defaultLanguage;
  if (wantedLang && remote.defaultLanguage && remote.defaultLanguage !== wantedLang) {
    out.push(
      finding({
        id: "details.default-language.differs",
        severity: Severity.WARNING,
        category: Category.STORE_STATE,
        title: `Play's default language is ${remote.defaultLanguage}, config says ${wantedLang}`,
        detail: "Every language the listing does not cover falls back to the default.",
        fixOwner: FixOwner.CLI,
        fix: "Align them: change config.defaultLanguage, or write the config's value.",
        fixCommand: "playstore-release details",
      }),
    );
  }

  const wanted = config?.details ?? {};
  const differs = FIELDS.filter((f) => wanted[f] !== undefined && (remote[f] ?? "") !== wanted[f]);
  if (differs.length && !(differs.length === 1 && differs[0] === "contactEmail" && !remote.contactEmail)) {
    out.push(
      finding({
        id: "details.differs",
        severity: Severity.WARNING,
        category: Category.STORE_STATE,
        title: `Contact details differ from the config (${differs.join(", ")})`,
        detail: differs.map((f) => `${f}: Play has "${remote[f] ?? ""}", config has "${wanted[f]}"`).join("; "),
        fixOwner: FixOwner.CLI,
        fix: "Write the config's values.",
        fixCommand: "playstore-release details",
      }),
    );
  }

  return out;
}
