// Subscriptions, only when the config declares any.

import { finding, Severity, Category, FixOwner } from "../../core/findings.mjs";

export const section = { id: "subscriptions", title: "Subscriptions" };

/** @param {{ snapshot: any, config: any }} input */
export function check({ snapshot, config }) {
  const out = [];
  const wanted = config?.subscriptions ?? [];
  if (!wanted.length || snapshot.access?.status !== 200) return out;

  for (const sub of wanted) {
    const remote = (snapshot.subscriptions ?? []).find((s) => s.productId === sub.productId);
    if (!remote) {
      out.push(
        finding({
          id: `subscription.missing.${sub.productId}`,
          category: Category.STORE_STATE,
          title: `Subscription ${sub.productId} does not exist on Play`,
          detail: "The config declares it; Play has no product with that id.",
          fix: "Create it from the config.",
          fixCommand: "playstore-release subscriptions",
        }),
      );
      continue;
    }
    const plan = (remote.basePlans ?? []).find((b) => b.basePlanId === sub.basePlanId);
    if (!plan) {
      out.push(
        finding({
          id: `subscription.base-plan.missing.${sub.productId}`,
          category: Category.STORE_STATE,
          title: `${sub.productId} has no base plan ${sub.basePlanId}`,
          fix: "Create it from the config.",
          fixCommand: "playstore-release subscriptions",
        }),
      );
    } else if (plan.state !== "ACTIVE") {
      out.push(
        finding({
          id: `subscription.base-plan.inactive.${sub.productId}`,
          category: Category.STORE_STATE,
          title: `${sub.productId} base plan ${sub.basePlanId} is ${plan.state}`,
          detail: "Nobody can buy an inactive base plan.",
          fix: "Activate it.",
          fixCommand: "playstore-release subscriptions",
        }),
      );
    }
    for (const lang of Object.keys(sub.listings ?? {})) {
      if ((remote.listings ?? []).some((l) => l.languageCode === lang)) continue;
      out.push(
        finding({
          id: `subscription.listing.missing.${sub.productId}.${lang}`,
          severity: Severity.WARNING,
          category: Category.STORE_STATE,
          title: `${sub.productId} has no ${lang} listing`,
          fixOwner: FixOwner.CLI,
          fix: "Write it from the config.",
          fixCommand: "playstore-release subscriptions",
        }),
      );
    }
  }
  return out;
}
