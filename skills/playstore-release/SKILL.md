---
name: playstore-release
description: Ship an Android app to Google Play end-to-end via the Google Play Developer API — bundle upload, store listing, graphics, contact details, track releases, staged rollouts, promotion to production, data safety, reviews — plus an exact-click checklist (executable by a browser agent) for the handful of steps Google keeps Console-only. Use when the user says "publish/release my app on Google Play", "put it on the Play Store", "fill out the Play Console", "upload the AAB", "promote to production", "roll out to 10%", "reply to reviews", or "automate Google Play". Works for any app given a service-account JSON, a package name, and a config file.
---

# Play Store Release

Drive an entire Google Play publication from the Google Play Developer API. The user provides credentials and a config **once**; you do everything automatable and hand over only what Google genuinely does not expose — and even those come with exact clicks.

## Operating principle

1. **Let `check` decide what to do.** It returns a verdict and an ordered list of next actions, each labelled as something the tool can fix or something only a human in the Play Console can. Do not plan the sequence yourself — read it.
2. **Config-driven, not prompt-driven.** All app content lives in the config. Run commands; do not interview the user about things the config already answers.
3. **Google keeps more Console-only than Apple does.** Creating the app, the _first_ bundle upload, content rating, app access, ads/news/government/financial/health declarations, privacy policy URL, category, pricing and countries have no API. `check` lists each as a `[you]` finding with a URL and clicks, and `references/console.md` spells every form out so you can drive it with a browser tool while the user is signed in. When a step is done, add its key to `config.console.done`.
4. **Everything is idempotent and transactional.** `publish` runs six steps inside one edit and commits once; a second run with nothing changed sends only the edit lifecycle. An error anywhere discards the edit — nothing half-done reaches Play.
5. **Production is a separate, confirmed step.** `publish` releases to the configured track (internal by default). `promote --to production --yes` is the irreversible one; it refuses unless `check` says ready.
6. **Ask about content, not about schema.** Languages, staged rollout share, tester groups, subscription prices are config decisions — ask the user in their terms and write the config yourself; `playstore-release schema` has the exact shape.

## Setup — see references/setup.md

A Google Cloud service account with a JSON key, invited to the app in Play Console → Users and permissions with **Release to testing tracks**, **Release to production** and **Manage store presence**. The app must already exist in the Console with **one bundle uploaded by hand** (Google's rule, not ours).

```bash
export PLAY_SERVICE_ACCOUNT_JSON=/abs/service-account.json   # or the JSON / its base64 inline
export PLAY_PACKAGE_NAME=com.example.app                      # or packageName in the config
```

**How to invoke it.** This package has no install step and no dependencies — run the file directly:

```bash
PSR="${CLAUDE_PLUGIN_ROOT:-${PLAYSTORE_RELEASE_HOME:-$HOME/playstore-release}}"
node "$PSR/src/cli.mjs" <command>
```

If that path does not exist, resolve it from this skill's own location: `PSR="$(cd "$(dirname "$(readlink -f ~/.claude/skills/playstore-release/SKILL.md)")/../.." && pwd)"`. Below it is written as `playstore-release <command>`; that is the same thing. Run it from the user's project directory — relative paths in the config resolve against the config file, so never `cd` anywhere first.

If there is no config yet: `playstore-release init` writes one with a `$schema`, then fill it in from what the user tells you. `playstore-release validate` checks it without credentials or a network. For several languages add a `locales` block keyed by Play language codes (`tr-TR`, `en-US`); `listing` is the default for all of them.

## Runbook

### 1. Orient

```bash
playstore-release doctor     # credentials, config, and whether Play lets this account open an edit
playstore-release check      # the verdict and the ordered plan
```

`check --json` gives the same as data: `verdict` is one of `ready`, `blocked`, `needs-human`, `rolling-out`, `halted`, `live`; `nextActions` is the plan. A 404 from doctor means the app does not exist on Play or has no bundle yet; a 403 means the service account is not invited (grants take up to 24 h).

### 2. Bootstrap, once per app (Console-only)

`check` reports these as `console.app`, `console.serviceAccount`, `console.firstBundle`. Follow references/console.md — create the app, invite the service account, upload the first `.aab` to Internal testing by hand. Build the bundle with the project's own pipeline (Gradle `bundleRelease` locally, or CI); this tool does not build.

### 3. Declarations (Console-only, once — then only when policy changes)

`check` lists every open one: privacy policy, app access, ads, content rating, target audience, news, data safety, government, financial features, health, category, countries, pricing. Each finding carries the URL and the clicks; `config.console` carries the answers. With the user signed in to the Play Console, drive the forms with the browser tool, then add each key to `config.console.done`. Data safety is filled once by hand, exported as CSV into the project, and re-applied by `playstore-release data-safety` from then on.

### 4. Publish to the testing track

```bash
playstore-release publish --dry-run    # every change it would put into the edit, nothing committed
playstore-release publish              # bundle → details → listing → images → release → testers, one commit
```

Graphics must exist at `config.images.dir` — see references/assets.md. **1290×2796 iPhone screenshots are rejected by Play** (long side may be at most 2× the short side); re-render at 1080×1920. A 1024×500 feature graphic is required.

### 5. Promote to production

```bash
playstore-release check
playstore-release promote --to production --yes                     # full release
playstore-release promote --to production --user-fraction 0.1 --yes # staged
playstore-release promote --complete --yes                          # widen to everyone
playstore-release promote --halt --yes                              # stop serving new users
```

`promote` computes the readiness report first and refuses unless the verdict is `ready` (or `live`/`rolling-out` for a follow-up). `--force` exists; tell the user Google will bounce a release that is missing a declaration. The first production release goes through Google's review (typically a day, up to a week); the API does not expose review state — `status` shows the release as you set it.

### Later releases

CI builds and uploads the next bundle to internal (or `upload-bundle --file`), then `publish` and `promote` again. Nothing in the Console needs touching unless a policy form changed.

### Reviews

`playstore-release reviews --unreplied`, then `review-reply --review <id> --text "…" --yes`.

## When something returns a 400/403/404

Read references/gotchas.md before guessing. It documents the exact strings: the first-bundle rule, the 24-hour permission lag, the feature-graphic 400, the screenshot aspect rule, one open edit per app, versionCode reuse, what `changesNotSentForReview` does and does not do.

## Extending

Operations live in `src/ops/`, one file each, with a uniform `{ meta, run(ctx, args) }` contract — see `src/ops/_contract.md`. Add a file, register it in `src/ops/registry.mjs`, and both the CLI and the MCP server pick it up. Console-only steps live in `src/core/console.mjs`; `node scripts/render-console.mjs` regenerates the table in references/console.md.

## References

- `references/setup.md` — service account, API enablement, Play Console permissions, secrets hygiene.
- `references/console.md` — every Console-only form: URL, clicks, which config field answers what. Written for a browser agent.
- `references/assets.md` — exact rules for the icon, feature graphic and screenshots, and how to render them.
- `references/gotchas.md` — every pitfall hit in practice. Read before the first run.
- `references/config-template.json` — the config, validated against a published JSON Schema.
