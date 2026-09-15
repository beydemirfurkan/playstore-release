# Gotchas

Every failure mode hit in practice, with the exact text Google sends and what to do. `check` and the error hints point here.

## Access

**The very first bundle must be uploaded in the Console.** Seen in practice (2026-09): on an app created minutes earlier with every permission granted, reads and writes into an edit succeed, and then `edits:validate` / `edits:commit` answer **`403 The caller does not have permission`** — the exact text of a missing grant. It is not a grant problem: Google's rule is that an app becomes API-committable only after one bundle has gone through the Console. `publish` recognises the combination (403 on commit + zero bundles) and reports `bundle.first.console` instead of sending you back to Users and permissions. Upload the .aab once to Internal testing by hand — references/console.md#firstbundle — and never again. Older reports also mention a `400 … has not been uploaded via console` wording on `bundles.upload`.

**403 for up to 24 hours after inviting the service account.** `The caller does not have permission` / `insufficient permissions`. The invitation is accepted instantly; the grant propagates slowly. Re-run `doctor` later. If it persists a day later, the account was invited without app-level permissions — Users and permissions → the account → App permissions.

**403 "API has not been used in project … or it is disabled".** The service account's own Cloud project must have the _Google Play Android Developer API_ enabled: `gcloud services enable androidpublisher.googleapis.com --project <project>`.

**404 `applicationNotFound` / `Package not found`.** Either the package name is wrong (check `applicationId` in `android/app/build.gradle` — a Capacitor `appId` is the same thing), the app was never created in the Console, or the first bundle is missing. The API cannot tell these apart.

**400 `invalid_grant` on the token.** The JSON's `private_key` and `client_email` do not belong together (a key from another account), or the machine clock is off by more than a few minutes.

## Edits

**One open edit at a time is the practical limit.** Inserting a second edit while one is open is allowed, but committing the old one then fails with `400 The edit has been deleted/expired`. This tool discards its edit on every exit path (`finally`), including Ctrl-C between requests. If something else left one open, it expires on its own; there is no list call.

**Reads need an edit.** Listings, images, tracks, details and testers are readable only through `edits/{id}/…`. That is why `status`, `check` and even `--dry-run` insert (and discard) an edit.

**`edits.validate` runs before every commit.** Its 400 is the whole reason: it names what a commit would reject — a missing feature graphic, a listing over its limit, a versionCode already used — before anything is sent.

**`changesNotSentForReview=true` only works for an app that has already been reviewed once**, and only for changes Google considers minor. On a first release, or after a policy-relevant change, the commit is rejected with `400 … changes cannot be sent for review` or is simply queued for review anyway. Leave it off unless a later small update needs to skip the queue.

## Bundles

**`Version code N has already been used.`** Every upload needs a `versionCode` above anything Play has ever seen for the app — including bundles on deleted releases. CI should derive the next code from Play (Codemagic: `google-play get-latest-build-number`) rather than count on its own.

**`versionName` is cosmetic; `versionCode` is identity.** Play shows `versionName` in the Console; nothing depends on it.

**Play App Signing.** Your keystore signs the _upload_; Google re-signs with the app signing key it holds. Losing the upload key is recoverable (Console → Setup → App signing → request upload key reset, ~2 days). Losing the app signing key is not your problem — Google has it.

**An unsigned or debug-signed .aab is rejected at upload.** `jarsigner -verify app-release.aab` must say `jar verified`.

## Listing

Limits enforced at validation, not documented in one place: title 30, short description 80, full description 4000, release notes 500 per language, subscription title 55, subscription description 80, benefit 40. Emoji are accepted everywhere. A language with a listing but no graphics is fine for a secondary language; the default language needs everything.

**`PUT listings/{lang}` replaces the whole listing.** A PATCH on a language with no listing 404s; this tool always PUTs the merged object.

## Images

See references/assets.md for the rules. In one line each:

- Screenshot long side more than 2× the short side → `400`. 1290×2796 (iPhone) fails; 1080×1920 passes.
- Feature graphic missing → commit `400 … feature graphic`.
- Alpha in a feature graphic or screenshot → `400`. Alpha in the icon is fine.
- Fewer than 2 phone screenshots → commit `400`.
- There is no reorder endpoint; order = upload order.
- Images belong to a listing: uploading for a language without one → `404`.

## Tracks and rollouts

**A track's `releases` array is replaced wholesale on PUT.** Send the release you want _and_ whatever else should keep serving. A staged (`inProgress`) release must be accompanied by the previous `completed` release, or users outside the fraction get nothing. A `completed` release supersedes everything else on the track. `release` and `promote` do this for you.

**`userFraction` is only valid with `inProgress`**, strictly between 0 and 1. A "100% staged" release is `completed`.

**`completed` on production cannot be recalled.** You can `halt` an `inProgress` rollout, or ship a higher versionCode; you cannot un-release. This is why `promote` requires `--yes` and a `ready` verdict.

**Review state is invisible to the API.** After the first production release the Console shows "In review" for hours to days; `tracks.get` shows the release with the status you set. Ask the user to look at the Console, or wait for the app to appear in the store.

**Countries are Console-only.** A production release with no countries selected commits fine and serves nobody. `edits.countryavailability` is read-only.

## Data safety

`applications.dataSafety` accepts the CSV exported from the Console's Data safety page (App content → Data safety → Export). Fill the questionnaire by hand once, export, commit the CSV to the project, and `data-safety` re-applies it — idempotent through a local hash. The Console still shows the section as needing review until the next release is reviewed.

## Reviews

`reviews.list` needs the _Reply to reviews_ permission even for reading; without it `status` simply omits the section. Replies are public, permanent, at most 350 characters.

## Personal developer accounts

Accounts created after 13 November 2023 as _personal_ (not organisation) must run a closed test with 12 testers opted in for 14 consecutive days and then "Apply for production access" in the Console before a production track exists. Organisation accounts are exempt. The API cannot see which kind of account it is; if `promote` reports `Track not found` for production, this is why.
