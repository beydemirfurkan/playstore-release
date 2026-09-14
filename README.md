# playstore-release

Ship an Android app to Google Play end-to-end over the [Google Play Developer API](https://developers.google.com/android-publisher) — an opinionated, idempotent publishing pipeline with a readiness report, for humans and AI agents. The Android sibling of [appstore-release](https://github.com/beydemirfurkan/appstore-release).

No dependencies. Clone it and run it.

```bash
git clone https://github.com/beydemirfurkan/playstore-release ~/playstore-release
export PLAY_SERVICE_ACCOUNT_JSON=/abs/service-account.json PLAY_PACKAGE_NAME=com.example.app
node ~/playstore-release/src/cli.mjs doctor
node ~/playstore-release/src/cli.mjs check
```

## What it does

| command                        | what                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`                       | credentials present and accepted; can this account open an edit for this app                                                                  |
| `check`                        | the readiness report: a verdict (`ready` · `blocked` · `needs-human` · `rolling-out` · `halted` · `live`) and an ordered list of next actions |
| `publish`                      | bundle → contact details → listing → graphics → track release → testers, **in one edit, committed once**; idempotent                          |
| `promote`                      | internal → production, full or staged; `--halt` / `--resume` / `--complete`                                                                   |
| `data-safety`                  | apply the Data safety CSV exported from the Console                                                                                           |
| `reviews` / `review-reply`     | read and answer user reviews                                                                                                                  |
| `subscriptions`                | create / update / activate subscription products                                                                                              |
| `init` / `validate` / `schema` | author a config without credentials                                                                                                           |
| `mcp`                          | the same surface as 10 MCP tools + 7 resources over stdio                                                                                     |

What Google keeps Console-only — creating the app, the first bundle upload, content rating, app access, ads / news / government / financial / health declarations, privacy policy, category, countries, pricing — is reported by `check` with the exact URL and clicks, and spelled out in [references/console.md](skills/playstore-release/references/console.md) so a browser agent can fill the forms for you.

## Design

- **Everything is an edit.** Reads and writes go through one `EditManager`; a pipeline holds it and commits once; any error discards it. `--dry-run` opens and discards an edit to read state and never validates or commits.
- **Idempotent, provably.** A second `publish` with nothing changed sends only `edits.insert` + `edits.delete` — there is a test asserting exactly that.
- **Findings, not logs.** Every problem is a `Finding` with an owner (`cli` · `ui` · `external`), a fix, and — for Console-only steps — the clicks. The CLI text, `--json` and the MCP tools render the same objects.
- **Local validation first.** Screenshot aspect ratio (long side ≤ 2× short), feature graphic size and alpha, listing lengths, rollout fractions: all checked before a byte is sent.

## Layout

```
src/cli.mjs            dispatcher            src/ops/          one file per operation (see _contract.md)
src/index.mjs          library API           src/report/       snapshot → checks → verdict → renderings
src/core/              config, findings, console steps
src/play/              auth (RS256 → OAuth), client, edits, uploads, image headers, error hints
src/mcp/               zero-dep JSON-RPC MCP server
skills/playstore-release/   the Claude Code skill: SKILL.md + references/
```

## As a Claude Code skill

```bash
node scripts/install-skill.mjs      # symlinks ~/.claude/skills/playstore-release → skills/playstore-release
```

Or as a plugin: the repo carries `.claude-plugin/` and `.mcp.json`.

## Development

```bash
npm install          # dev tooling only (prettier, tsc, ajv)
npm run verify       # typecheck · format · schema · manifests · distribution · tests
```

MIT.
