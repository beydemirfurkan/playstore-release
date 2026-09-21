# Play Console — the steps with no API

Everything on this page is something Google exposes only in the Play Console. `playstore-release check` reports each open one as a `[you]` finding with the same key; when it is done, add the key to `config.console.done` so the report stops asking.

This file is written so that an agent driving a browser (the user signed in to `play.google.com/console`) can execute it: every section names the URL, the clicks in order, and which `config.console` field supplies each answer. **Never type a value that is not in the config — ask the user.** Never click a final _Publish_ / _Send for review_ on production without the user saying so.

Replace `<dev>` and `<app>` with `config.console.developerId` and `config.console.appId` (the numbers in any Console URL: `developers/<dev>/app/<app>/`).

<!-- generated:start -->

| key | step | detectable by the API | answers come from |
| --- | --- | --- | --- |
| `app` | Create the app in the Play Console | yes | `listing.title`, `defaultLanguage`, `console.pricing` |
| `serviceAccount` | Invite the service account and grant it app permissions | yes | — |
| `firstBundle` | Upload the first .aab through the Console | yes | `bundle.path` |
| `privacyPolicy` | Privacy policy URL | no — mark it in `console.done` | `console.privacyPolicyUrl` |
| `appAccess` | App access (demo login for reviewers) | no — mark it in `console.done` | `console.appAccess.restricted`, `console.appAccess.username`, `console.appAccess.password`, `console.appAccess.instructions` |
| `ads` | Ads declaration | no — mark it in `console.done` | `console.ads` |
| `contentRating` | Content rating questionnaire (IARC) | no — mark it in `console.done` | `console.contentRating` |
| `targetAudience` | Target audience and content | no — mark it in `console.done` | `console.targetAudience` |
| `news` | News app declaration | no — mark it in `console.done` | `console.containsNews` |
| `dataSafety` | Data safety | no — mark it in `console.done` | `dataSafety.csvPath` |
| `government` | Government app declaration | no — mark it in `console.done` | `console.isGovernmentApp` |
| `financialFeatures` | Financial features declaration | no — mark it in `console.done` | `console.financialFeatures` |
| `health` | Health apps declaration | no — mark it in `console.done` | `console.healthApp` |
| `category` | App category and tags | no — mark it in `console.done` | `console.category`, `console.tags` |
| `countries` | Countries / regions for production | no — mark it in `console.done` | `console.countries` |
| `pricing` | Pricing (free / paid) | no — mark it in `console.done` | `console.pricing` |

### app

**Create the app in the Play Console.** The API can only edit an app that already exists; creation is Console-only.

URL: `https://play.google.com/console/u/0/developers/<dev>/app-list`

Clicks: **Play Console** → **Create app** → **App name** → **Default language** → **App or game** → **Free or paid** → **Declarations** → **Create app**

### serviceAccount

**Invite the service account and grant it app permissions.** Every API call runs as the service account; without an invitation Play answers 403. Until the app's first review, it is a DRAFT app — store-listing edits also need 'Create, edit and delete draft apps'.

URL: `https://play.google.com/console/u/0/developers/<dev>/users-and-permissions`

Clicks: **Users and permissions** → **Invite new users** → **<client_email>** → **App permissions** → **Add app** → **Release to testing tracks** → **Release to production** → **Manage store presence** → **Invite user**

### firstBundle

**Upload the first .aab through the Console.** Google requires the very first bundle of an app to be uploaded in the Console; the API refuses it.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/tracks/internal-testing`

Clicks: **Testing** → **Internal testing** → **Create new release** → **Upload** → **<app-release.aab>** → **Release name** → **Next** → **Save and publish**

### privacyPolicy

**Privacy policy URL.** Required for every app; the URL must be public and reachable.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/privacy-policy`

Clicks: **Policy and programs** → **App content** → **Privacy policy** → **Start** → **<URL>** → **Save**

### appAccess

**App access (demo login for reviewers).** An app with a login wall is rejected unless reviewers get working credentials.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/testing-credentials`

Clicks: **Policy and programs** → **App content** → **App access** → **Start** → **All or some functionality is restricted** → **Add new instructions** → **<username / password / instructions>** → **Apply** → **Save**

### ads

**Ads declaration.** Play labels the listing 'Contains ads' from this answer.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/ads-declaration`

Clicks: **Policy and programs** → **App content** → **Ads** → **Start** → **<Yes / No>** → **Save**

### contentRating

**Content rating questionnaire (IARC).** An unrated app cannot be published and is removed from Play.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/content-rating`

Clicks: **Policy and programs** → **App content** → **Content ratings** → **Start questionnaire** → **<email>** → **<category>** → **<answers>** → **Save** → **Next** → **Submit**

### targetAudience

**Target audience and content.** Anything that includes under-13s triggers the Families policy; most business apps answer 18+.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/target-audience-content`

Clicks: **Policy and programs** → **App content** → **Target audience and content** → **Start** → **<age groups>** → **Next** → **<appeal to children: No>** → **Save**

### news

**News app declaration.** Asked of every app; answer No unless the app is a news publication.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/news-app`

Clicks: **Policy and programs** → **App content** → **News apps** → **Start** → **<Yes / No>** → **Save**

### dataSafety

**Data safety.** Required; the first version is filled in the Console, exported as CSV, and re-applied by `data-safety` on later releases.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/data-privacy-security`

Clicks: **Policy and programs** → **App content** → **Data safety** → **Start** → **<questionnaire>** → **Save** → **Submit** → **then: Export to CSV**

### government

**Government app declaration.** Asked of every app; answer No unless developed for or by a government.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/government-apps`

Clicks: **Policy and programs** → **App content** → **Government apps** → **Start** → **<Yes / No>** → **Save**

### financialFeatures

**Financial features declaration.** Apps touching payments, loans or banking must declare which features they offer; a POS app must answer this honestly.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/financial-features`

Clicks: **Policy and programs** → **App content** → **Financial features** → **Start** → **<features or 'My app doesn't provide any financial features'>** → **Save**

### health

**Health apps declaration.** Asked of every app; answer No unless the app handles health data.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/app-content/health`

Clicks: **Policy and programs** → **App content** → **Health** → **Start** → **<Yes / No>** → **Save**

### category

**App category and tags.** Store settings hold the category; the API only covers contact details on that page.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/store-settings`

Clicks: **Grow users** → **Store presence** → **Store settings** → **App category** → **<category>** → **Tags** → **Save**

### countries

**Countries / regions for production.** A production track with no countries serves nobody. Set once; the API can only read it.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/tracks/production`

Clicks: **Release** → **Production** → **Countries / regions** → **Add countries / regions** → **<select>** → **Add countries / regions**

### pricing

**Pricing (free / paid).** Free is permanent: a free app can never become paid. Set at creation or under Monetize.

URL: `https://play.google.com/console/u/0/developers/<dev>/app/<app>/monetization-setup`

Clicks: **Monetize** → **Products** → **App pricing** → **<Free / Paid>** → **Save**

<!-- generated:end -->

## How to run a form with a browser agent

1. Open the section's URL. If the Console shows the app list instead, the ids are wrong — read them from the URL after clicking into the app.
2. Click through the listed sequence. Radio buttons and checkboxes: match the label text; the Console renames labels occasionally, so prefer the meaning in the step's _why_ over the exact string.
3. Fill each `<placeholder>` from the named config key. `<Yes / No>` means the boolean in the config, rendered as the matching radio.
4. **Save** the section. Most declarations show a green tick on _App content_ when complete; the content-rating questionnaire shows the resulting ratings.
5. Tell the user what was answered, then write the key into `config.console.done`.

## Notes per step

### app

Default language must match `config.defaultLanguage` (e.g. _Turkish – tr-TR_). _App name_ is `listing.title`. _Free or paid_ is `console.pricing` — free is permanent. Tick the declarations the Console requires (Developer Program Policies, US export laws).

### serviceAccount

The email to invite is the `client_email` from the service-account JSON (`doctor` prints it). App-level permissions: **Release to testing tracks**, **Release to production, exclude devices, and use Play App Signing**, **Manage store presence**, **View app information**; optionally **Reply to reviews**. Grants can take up to 24 hours to reach the API.

### firstBundle

Upload the signed `.aab` (`config.bundle.path`, or the CI artefact). When asked, **Use Google-generated key** for Play App Signing. Release name: the app's `versionName`. Save; _Review release_; _Start rollout to Internal testing_. After this the API can upload every later bundle.

### privacyPolicy

`console.privacyPolicyUrl`. Must be a public URL that loads without login; Google's crawler checks it.

### appAccess

If `console.appAccess.restricted` is true: choose **All or some functionality is restricted**, _Add new instructions_, fill _Instruction name_ (e.g. "Reviewer account"), _Username_ = `console.appAccess.username`, _Password_ = `console.appAccess.password`, _Any other information_ = `console.appAccess.instructions`. If false: **All functionality is available without special access**.

### ads

`console.ads` → _Yes, my app contains ads_ / _No, my app does not contain ads_.

### contentRating

Start questionnaire → email address = `console.contentRating.email` → category (for a business/utility app: **Utility, Productivity, Communication, or Other**) → answer every question from `console.contentRating` (violence, sexuality, language, controlled substances, gambling, user interaction, user-generated content, personal information sharing, location sharing, purchases). Save → Next → Submit. Ratings (IARC) are generated automatically.

### targetAudience

Pick the age groups in `console.targetAudience` (a business app: **18 and over** only). On the next page, _Appeal to children_: **No** unless the config says otherwise. Save.

### news

`console.containsNews` → Yes / No. Save.

### dataSafety

The first time: answer the questionnaire (data collected, shared, security practices, deletion) → Save → Submit. Then **Export to CSV** (button at the top of the Data safety page) and store the file at `config.dataSafety.csvPath`; from now on `playstore-release data-safety` re-applies it. A POS/business app typically declares: name, email, phone, financial info (transaction history) — collected, not shared, encrypted in transit, deletable on request.

### government

`console.isGovernmentApp` → Yes / No. Save.

### financialFeatures

If `console.financialFeatures` is empty: **My app doesn't provide any financial features**. Otherwise tick each listed feature (e.g. _Payments and money transfers_ only if the app itself moves money; a merchant back-office that _shows_ transactions is not a payment instrument). Answer truthfully — Google verifies against the binary.

### health

`console.healthApp` → _My app does not have any health features_ unless the config says otherwise. Save.

### category

Grow users → Store presence → **Store settings** → _App category_: `console.category` (e.g. **Business**). _Tags_: `console.tags` if any. Contact details on the same page are written by the API (`details`) — leave them.

### countries

Release → Production → **Countries / regions** → _Add countries / regions_ → select all (`console.countries` = `"all"`) or the listed codes → _Add countries / regions_. Without this a production release serves nobody.

### pricing

Set at creation. To confirm: Monetize → Products → **App pricing** → `console.pricing`. Free cannot become paid later.
