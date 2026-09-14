// The Play Console steps Google exposes no API for, as one table.
//
// Everything here is rendered — into `check` findings, into references/console.md,
// into the MCP `console` resource — and never sent anywhere. The table is the
// single source of truth so the three renderings cannot disagree about what a
// person (or a browser agent driving the Console) still has to click.
//
// URL patterns use <dev> and <app>, filled from config.console.developerId and
// config.console.appId when known.

/**
 * @typedef {Object} ConsoleStep
 * @property {string} key             stable id, also what config.console.done lists
 * @property {"bootstrap"|"declaration"|"store"} group
 * @property {string} title
 * @property {string} why             one sentence on what Google wants here
 * @property {string} url             Console URL pattern
 * @property {string[]} clicks        ordered UI path from the app's dashboard
 * @property {string[]} configKeys    which config.console fields answer this form
 * @property {boolean} detectable     whether the API can see that it is done
 */

/** @type {readonly ConsoleStep[]} */
export const CONSOLE_STEPS = Object.freeze([
  {
    key: "app",
    group: "bootstrap",
    title: "Create the app in the Play Console",
    why: "The API can only edit an app that already exists; creation is Console-only.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app-list",
    clicks: [
      "Play Console",
      "Create app",
      "App name",
      "Default language",
      "App or game",
      "Free or paid",
      "Declarations",
      "Create app",
    ],
    configKeys: ["listing.title", "defaultLanguage", "console.pricing"],
    detectable: true,
  },
  {
    key: "serviceAccount",
    group: "bootstrap",
    title: "Invite the service account and grant it app permissions",
    why: "Every API call runs as the service account; without an invitation Play answers 403.",
    url: "https://play.google.com/console/u/0/developers/<dev>/users-and-permissions",
    clicks: [
      "Users and permissions",
      "Invite new users",
      "<client_email>",
      "App permissions",
      "Add app",
      "Release to testing tracks",
      "Release to production",
      "Manage store presence",
      "Invite user",
    ],
    configKeys: [],
    detectable: true,
  },
  {
    key: "firstBundle",
    group: "bootstrap",
    title: "Upload the first .aab through the Console",
    why: "Google requires the very first bundle of an app to be uploaded in the Console; the API refuses it.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/tracks/internal-testing",
    clicks: [
      "Testing",
      "Internal testing",
      "Create new release",
      "Upload",
      "<app-release.aab>",
      "Release name",
      "Next",
      "Save and publish",
    ],
    configKeys: ["bundle.path"],
    detectable: true,
  },
  {
    key: "privacyPolicy",
    group: "declaration",
    title: "Privacy policy URL",
    why: "Required for every app; the URL must be public and reachable.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/privacy-policy",
    clicks: ["Policy and programs", "App content", "Privacy policy", "Start", "<URL>", "Save"],
    configKeys: ["console.privacyPolicyUrl"],
    detectable: false,
  },
  {
    key: "appAccess",
    group: "declaration",
    title: "App access (demo login for reviewers)",
    why: "An app with a login wall is rejected unless reviewers get working credentials.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/testing-credentials",
    clicks: [
      "Policy and programs",
      "App content",
      "App access",
      "Start",
      "All or some functionality is restricted",
      "Add new instructions",
      "<username / password / instructions>",
      "Apply",
      "Save",
    ],
    configKeys: [
      "console.appAccess.restricted",
      "console.appAccess.username",
      "console.appAccess.password",
      "console.appAccess.instructions",
    ],
    detectable: false,
  },
  {
    key: "ads",
    group: "declaration",
    title: "Ads declaration",
    why: "Play labels the listing 'Contains ads' from this answer.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/ads-declaration",
    clicks: ["Policy and programs", "App content", "Ads", "Start", "<Yes / No>", "Save"],
    configKeys: ["console.ads"],
    detectable: false,
  },
  {
    key: "contentRating",
    group: "declaration",
    title: "Content rating questionnaire (IARC)",
    why: "An unrated app cannot be published and is removed from Play.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/content-rating",
    clicks: [
      "Policy and programs",
      "App content",
      "Content ratings",
      "Start questionnaire",
      "<email>",
      "<category>",
      "<answers>",
      "Save",
      "Next",
      "Submit",
    ],
    configKeys: ["console.contentRating"],
    detectable: false,
  },
  {
    key: "targetAudience",
    group: "declaration",
    title: "Target audience and content",
    why: "Anything that includes under-13s triggers the Families policy; most business apps answer 18+.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/target-audience-content",
    clicks: [
      "Policy and programs",
      "App content",
      "Target audience and content",
      "Start",
      "<age groups>",
      "Next",
      "<appeal to children: No>",
      "Save",
    ],
    configKeys: ["console.targetAudience"],
    detectable: false,
  },
  {
    key: "news",
    group: "declaration",
    title: "News app declaration",
    why: "Asked of every app; answer No unless the app is a news publication.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/news-app",
    clicks: ["Policy and programs", "App content", "News apps", "Start", "<Yes / No>", "Save"],
    configKeys: ["console.containsNews"],
    detectable: false,
  },
  {
    key: "dataSafety",
    group: "declaration",
    title: "Data safety",
    why: "Required; the first version is filled in the Console, exported as CSV, and re-applied by `data-safety` on later releases.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/data-privacy-security",
    clicks: [
      "Policy and programs",
      "App content",
      "Data safety",
      "Start",
      "<questionnaire>",
      "Save",
      "Submit",
      "then: Export to CSV",
    ],
    configKeys: ["dataSafety.csvPath"],
    detectable: false,
  },
  {
    key: "government",
    group: "declaration",
    title: "Government app declaration",
    why: "Asked of every app; answer No unless developed for or by a government.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/government-apps",
    clicks: ["Policy and programs", "App content", "Government apps", "Start", "<Yes / No>", "Save"],
    configKeys: ["console.isGovernmentApp"],
    detectable: false,
  },
  {
    key: "financialFeatures",
    group: "declaration",
    title: "Financial features declaration",
    why: "Apps touching payments, loans or banking must declare which features they offer; a POS app must answer this honestly.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/financial-features",
    clicks: [
      "Policy and programs",
      "App content",
      "Financial features",
      "Start",
      "<features or 'My app doesn't provide any financial features'>",
      "Save",
    ],
    configKeys: ["console.financialFeatures"],
    detectable: false,
  },
  {
    key: "health",
    group: "declaration",
    title: "Health apps declaration",
    why: "Asked of every app; answer No unless the app handles health data.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/health",
    clicks: ["Policy and programs", "App content", "Health", "Start", "<Yes / No>", "Save"],
    configKeys: ["console.healthApp"],
    detectable: false,
  },
  {
    key: "category",
    group: "store",
    title: "App category and tags",
    why: "Store settings hold the category; the API only covers contact details on that page.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/store-settings",
    clicks: ["Grow users", "Store presence", "Store settings", "App category", "<category>", "Tags", "Save"],
    configKeys: ["console.category", "console.tags"],
    detectable: false,
  },
  {
    key: "countries",
    group: "store",
    title: "Countries / regions for production",
    why: "A production track with no countries serves nobody. Set once; the API can only read it.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/tracks/production",
    clicks: [
      "Release",
      "Production",
      "Countries / regions",
      "Add countries / regions",
      "<select>",
      "Add countries / regions",
    ],
    configKeys: ["console.countries"],
    detectable: false,
  },
  {
    key: "pricing",
    group: "store",
    title: "Pricing (free / paid)",
    why: "Free is permanent: a free app can never become paid. Set at creation or under Monetize.",
    url: "https://play.google.com/console/u/0/developers/<dev>/app/<app>/monetization-setup",
    clicks: ["Monetize", "Products", "App pricing", "<Free / Paid>", "Save"],
    configKeys: ["console.pricing"],
    detectable: false,
  },
]);

/** @param {string} key */
export const consoleStep = (key) => CONSOLE_STEPS.find((s) => s.key === key) ?? null;

/**
 * Fill the URL pattern from the config, leaving placeholders when unknown so a
 * reader still sees where the ids go.
 *
 * @param {ConsoleStep} step
 * @param {object|null} config
 */
export function consoleUrl(step, config) {
  const dev = config?.console?.developerId ?? "<dev>";
  const app = config?.console?.appId ?? "<app>";
  return step.url.replace("<dev>", dev).replace("<app>", app);
}
