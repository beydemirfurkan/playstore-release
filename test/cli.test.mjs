// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { main } from "../src/cli.mjs";
import { Exit } from "../src/core/status.mjs";
import { createMockPlay, readyToPublishRoutes, testServiceAccount, PACKAGE } from "./helpers/mock-play.mjs";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.mjs");

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    get outText() {
      return out.join("");
    },
    get errText() {
      return err.join("");
    },
  };
}

const noCredentials = { env: {}, cwd: "/nonexistent-so-no-config-is-found" };

test("--version prints just the version", async () => {
  const io = capture();
  assert.equal(await main(["--version"], { ...io, ...noCredentials }), Exit.OK);
  assert.match(io.outText.trim(), /^\d+\.\d+\.\d+$/);
});

test("--help goes to stdout and exits 0; an unknown command goes to stderr and exits 2", async () => {
  const help = capture();
  assert.equal(await main(["--help"], { ...help, ...noCredentials }), Exit.OK);
  assert.match(help.outText, /Usage: playstore-release/);
  assert.equal(help.errText, "");

  const bad = capture();
  assert.equal(await main(["nope"], { ...bad, ...noCredentials }), Exit.USAGE);
  assert.match(bad.errText, /Unknown command: nope/);
  assert.equal(bad.outText, "");
});

test("an unknown flag is a usage error, not a crash", async () => {
  const io = capture();
  assert.equal(await main(["status", "--nope"], { ...io, ...noCredentials }), Exit.USAGE);
  assert.match(io.errText, /Unknown flag: --nope/);
});

test("missing credentials exit 3 and name the variable", async () => {
  const io = capture();
  assert.equal(await main(["status"], { ...io, ...noCredentials }), Exit.CONFIG);
  assert.match(io.errText, /PLAY_SERVICE_ACCOUNT_JSON/);
});

test("--json puts exactly one JSON document on stdout and nothing else", async () => {
  const io = capture();
  await main(["status", "--json"], { ...io, ...noCredentials });
  const parsed = JSON.parse(io.outText);
  assert.equal(parsed.ok, false);
  assert.ok(Array.isArray(parsed.findings));
  assert.equal(io.outText.trimEnd().split("\n}").length, 2, "stdout held more than one document");
  assert.match(io.errText, /PLAY_SERVICE_ACCOUNT_JSON/, "human output belongs on stderr");
});

test("--exit-zero suppresses the failure code but not the diagnosis", async () => {
  const io = capture();
  assert.equal(await main(["status", "--json", "--exit-zero"], { ...io, ...noCredentials }), Exit.OK);
  assert.equal(JSON.parse(io.outText).ok, false);
});

test("irreversible operations refuse without --yes (exit 7) but run under --dry-run", async () => {
  const mock = createMockPlay({ routes: readyToPublishRoutes(), strict: false });
  const env = { PLAY_SERVICE_ACCOUNT_JSON: testServiceAccount(), PLAY_PACKAGE_NAME: PACKAGE };
  const refused = capture();
  assert.equal(
    await main(["promote"], { ...refused, env, cwd: "/nonexistent", fetchImpl: mock.fetchImpl }),
    Exit.CONFIRM,
  );
  assert.match(refused.errText, /--yes/);
  assert.equal(mock.calls.length, 0, "nothing is called before the confirmation gate");

  const dry = capture();
  const code = await main(["promote", "--dry-run", "--force", "--json"], {
    ...dry,
    env,
    cwd: "/nonexistent",
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(code, Exit.OK, dry.errText);
  const doc = JSON.parse(dry.outText);
  assert.equal(doc.dryRun, true);
  assert.equal(doc.results[0].status, "planned");
  assert.equal(mock.commits().length, 0);
});

test("init writes the template, refuses to overwrite, and validate accepts what it wrote", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "psr-cli-"));
  const first = capture();
  assert.equal(await main(["init"], { ...first, env: {}, cwd }), Exit.OK);
  assert.match(first.outText, /Wrote playstore\.config\.json/);
  const written = JSON.parse(readFileSync(join(cwd, "playstore.config.json"), "utf8"));
  assert.ok(written.$schema);

  const second = capture();
  assert.equal(await main(["init"], { ...second, env: {}, cwd }), Exit.USAGE);
  assert.match(second.errText, /already exists/);

  const valid = capture();
  assert.equal(await main(["validate"], { ...valid, env: {}, cwd }), Exit.OK, valid.errText);
});

test("validate reports schema and semantic problems with exit 3", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "psr-cli-"));
  writeFileSync(
    join(cwd, "playstore.config.json"),
    JSON.stringify({
      defaultLanguage: "tr-TR",
      listing: { title: "x".repeat(31), shortDescription: "s", fullDescription: "f", keyword: "typo" },
      release: { track: "internal", status: "completed", userFraction: 0.5 },
    }),
  );
  const io = capture();
  assert.equal(await main(["validate"], { ...io, env: {}, cwd }), Exit.CONFIG);
  assert.match(io.errText, /title.*30/);
  assert.match(io.errText, /userFraction/);
  assert.match(io.errText, /keyword/);
});

test("the file runs as a program from the shell", async () => {
  const { stdout } = await run(process.execPath, [CLI, "--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});
