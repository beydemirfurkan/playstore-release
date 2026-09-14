// Subscriptions through the monetization API: create or update each product the
// config declares, then activate its base plan. Skipped when the config has none.
//
// Play's subscription model is deep (base plans → offers → regional prices); this
// covers the shape a typical app needs — one auto-renewing base plan per
// product, priced explicitly per region, other regions derived by Play.

import { Status } from "../core/status.mjs";

/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "subscriptions",
  title: "Subscriptions",
  phase: "listing",
  needs: [],
  edit: false,
  mutates: true,
  args: {
    activate: { type: "boolean", default: true, description: "activate base plans that are not ACTIVE" },
  },
};

const REGIONS_VERSION = "regionsVersion.version=2022%2F02";

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {{ activate?: boolean }} [args]
 */
export async function run({ client, config, packageName, dryRun }, args = {}) {
  const wanted = config?.subscriptions ?? [];
  if (!wanted.length) return { status: Status.SKIPPED, message: "no subscriptions configured" };

  const changed = [];
  for (const sub of wanted) {
    const body = toResource(sub, packageName);
    const current = await client.get(`/subscriptions/${encodeURIComponent(sub.productId)}`, { throwOnError: false });
    let remote = current.error ? null : current;

    if (!remote) {
      await client.post(`/subscriptions?productId=${encodeURIComponent(sub.productId)}&${REGIONS_VERSION}`, body);
      changed.push(`${sub.productId}: created`);
      remote = dryRun ? null : body;
    } else if (!sameSubscription(remote, body)) {
      await client.patch(
        `/subscriptions/${encodeURIComponent(sub.productId)}?updateMask=listings,basePlans&${REGIONS_VERSION}`,
        body,
      );
      changed.push(`${sub.productId}: updated`);
    }

    if (args.activate !== false) {
      const plan = (remote?.basePlans ?? []).find((b) => b.basePlanId === sub.basePlanId);
      if (!plan || plan.state !== "ACTIVE") {
        await client.post(
          `/subscriptions/${encodeURIComponent(sub.productId)}/basePlans/${encodeURIComponent(sub.basePlanId)}:activate`,
          {},
        );
        changed.push(`${sub.productId}/${sub.basePlanId}: activated`);
      }
    }
  }

  if (!changed.length) return { status: Status.OK, message: `${wanted.length} subscription(s) already correct` };
  return { status: Status.CHANGED, message: changed.join(" · "), details: { changed } };
}

/** The API resource the config describes. */
export function toResource(sub, packageName) {
  const regionalConfigs = Object.entries(sub.prices ?? {}).map(([regionCode, price]) => ({
    regionCode,
    newSubscriberAvailability: true,
    price: { currencyCode: price.currencyCode, units: String(price.units), nanos: price.nanos ?? 0 },
  }));
  return {
    packageName,
    productId: sub.productId,
    basePlans: [
      {
        basePlanId: sub.basePlanId,
        autoRenewingBasePlanType: {
          billingPeriodDuration: sub.billingPeriod,
          gracePeriodDuration: sub.gracePeriod ?? "P7D",
          resubscribeState: "RESUBSCRIBE_STATE_ACTIVE",
          prorationMode: "SUBSCRIPTION_PRORATION_MODE_CHARGE_ON_NEXT_BILLING_DATE",
          legacyCompatible: false,
        },
        regionalConfigs,
        otherRegionsConfig: { newSubscriberAvailability: true },
      },
    ],
    listings: Object.entries(sub.listings ?? {}).map(([languageCode, l]) => ({
      languageCode,
      title: l.title,
      description: l.description ?? "",
      benefits: l.benefits ?? [],
    })),
  };
}

/** Compare only what we manage; Play echoes many derived fields. */
function sameSubscription(remote, wanted) {
  const listings = (r) =>
    JSON.stringify(
      (r.listings ?? [])
        .map((l) => ({
          languageCode: l.languageCode,
          title: l.title,
          description: l.description ?? "",
          benefits: l.benefits ?? [],
        }))
        .sort((a, b) => a.languageCode.localeCompare(b.languageCode)),
    );
  if (listings(remote) !== listings(wanted)) return false;
  const plan = (remote.basePlans ?? []).find((b) => b.basePlanId === wanted.basePlans[0].basePlanId);
  if (!plan) return false;
  const w = wanted.basePlans[0];
  if (plan.autoRenewingBasePlanType?.billingPeriodDuration !== w.autoRenewingBasePlanType.billingPeriodDuration)
    return false;
  const prices = (b) =>
    JSON.stringify(
      (b.regionalConfigs ?? [])
        .map((c) => ({
          r: c.regionCode,
          c: c.price?.currencyCode,
          u: String(c.price?.units ?? "0"),
          n: c.price?.nanos ?? 0,
        }))
        .sort((a, b2) => a.r.localeCompare(b2.r)),
    );
  return prices(plan) === prices(w);
}
