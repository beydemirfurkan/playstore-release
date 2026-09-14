// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readImage, imageProblems } from "../src/play/imagemeta.mjs";
import { resolveCredentials } from "../src/core/credentials.mjs";
import { validateConfig } from "../src/core/requirements.mjs";
import { resolveLocales } from "../src/core/locales.mjs";
import { withHints } from "../src/play/hints.mjs";
import { PlayApiError } from "../src/play/client.mjs";
import { png, jpeg, testServiceAccount } from "./helpers/mock-play.mjs";

test("readImage reads PNG and JPEG headers including alpha", () => {
  const dir = mkdtempSync(join(tmpdir(), "psr-img-"));
  writeFileSync(join(dir, "a.png"), png(1080, 1920, { alpha: true }));
  writeFileSync(join(dir, "b.jpg"), jpeg(1920, 1080));
  writeFileSync(join(dir, "c.txt"), "not an image");
  assert.deepEqual(pick(readImage(join(dir, "a.png"))), { format: "png", width: 1080, height: 1920, hasAlpha: true });
  assert.deepEqual(pick(readImage(join(dir, "b.jpg"))), { format: "jpeg", width: 1920, height: 1080, hasAlpha: false });
  assert.equal(readImage(join(dir, "c.txt")), null);
});
const pick = (i) => i && { format: i.format, width: i.width, height: i.height, hasAlpha: i.hasAlpha };

test("imageProblems encodes Play's rules", () => {
  const ok = (t, w, h, alpha = false, format = "png") =>
    imageProblems(t, { format, width: w, height: h, hasAlpha: alpha, size: 1000 });
  assert.deepEqual(ok("icon", 512, 512, true), []);
  assert.match(ok("icon", 1024, 1024)[0], /512×512/);
  assert.match(ok("icon", 512, 512, false, "jpeg")[0], /JPEG/);
  assert.deepEqual(ok("featureGraphic", 1024, 500), []);
  assert.match(ok("featureGraphic", 1024, 500, true)[0], /alpha/);
  assert.deepEqual(ok("phoneScreenshots", 1080, 1920), []);
  assert.deepEqual(ok("phoneScreenshots", 1080, 2160), [], "exactly 2:1 is allowed");
  assert.match(ok("phoneScreenshots", 1290, 2796)[0], /2\.17:1/);
  assert.match(ok("phoneScreenshots", 300, 600)[0], /320–3840/);
  assert.match(ok("phoneScreenshots", 4000, 2000)[0], /320–3840/);
  assert.match(imageProblems("phoneScreenshots", null)[0], /readable/);
});

test("credentials: inline JSON, base64 and a path all resolve; shape problems are findings", () => {
  const json = testServiceAccount();
  const inline = resolveCredentials({ serviceAccount: json, packageName: "com.example.app" }, { env: {} });
  assert.equal(inline.credentials.clientEmail, "release@test-project.iam.gserviceaccount.com");
  assert.equal(Object.keys(inline.credentials).includes("privateKey"), false, "the key must not enumerate");
  assert.ok(inline.credentials.privateKey.includes("BEGIN PRIVATE KEY"));

  const b64 = resolveCredentials({ serviceAccount: Buffer.from(json).toString("base64") }, { env: {} });
  assert.equal(b64.credentials.clientEmail, inline.credentials.clientEmail);

  const dir = mkdtempSync(join(tmpdir(), "psr-cred-"));
  writeFileSync(join(dir, "sa.json"), json);
  const fromEnv = resolveCredentials(
    {},
    { env: { PLAY_SERVICE_ACCOUNT_JSON: join(dir, "sa.json"), PLAY_PACKAGE_NAME: "com.example.app" } },
  );
  assert.equal(fromEnv.credentials.packageName, "com.example.app");

  const wrongType = resolveCredentials({ serviceAccount: JSON.stringify({ type: "authorized_user" }) }, { env: {} });
  assert.equal(wrongType.credentials, null);
  assert.ok(wrongType.findings.some((f) => f.id === "account.credentials.type"));

  const badPkg = resolveCredentials({ serviceAccount: json, packageName: "mutlupos" }, { env: {} });
  assert.ok(badPkg.findings.some((f) => f.id === "account.credentials.packageName.malformed"));

  const none = resolveCredentials({}, { env: {} });
  assert.ok(none.findings.some((f) => f.id === "account.credentials.serviceAccount"));
});

test("validateConfig: limits, rollout semantics and per-language requirements", () => {
  const base = { defaultLanguage: "tr-TR", listing: { title: "T", shortDescription: "S", fullDescription: "F" } };
  assert.equal(validateConfig(base).valid, true);

  const long = validateConfig({ ...base, listing: { ...base.listing, releaseNotes: "x".repeat(501) } });
  assert.ok(long.findings.some((f) => f.id === "config.listing.releaseNotes.too-long"));

  const staged = validateConfig({ ...base, release: { track: "production", status: "inProgress" } });
  assert.ok(staged.findings.some((f) => f.id === "config.release.userFraction.missing"));

  const multi = validateConfig({ ...base, locales: { "tr-TR": {}, "en-US": { title: "EN" } } }, { needs: ["listing"] });
  assert.equal(multi.valid, true, "en-US inherits short/full from listing");
  const half = validateConfig(
    {
      defaultLanguage: "tr-TR",
      locales: { "tr-TR": { title: "T", shortDescription: "S", fullDescription: "F" }, "en-US": { title: "EN" } },
    },
    { needs: ["listing"] },
  );
  assert.ok(half.findings.some((f) => f.id === "config.locales.en-US.shortDescription.missing"));
});

test("resolveLocales puts the default language first and inherits the shared listing", () => {
  const entries = resolveLocales({
    defaultLanguage: "tr-TR",
    listing: { video: "https://v" },
    locales: { "en-US": { title: "EN" }, "tr-TR": { title: "TR" } },
  });
  assert.deepEqual(
    entries.map((e) => e.locale),
    ["tr-TR", "en-US"],
  );
  assert.equal(entries[1].listing.video, "https://v");
});

test("hints: Google's messages become findings with owners", () => {
  const first = withHints(
    new PlayApiError(400, "POST", "/edits/x/bundles", {
      message: "APK/AAB has not been uploaded via console for this app",
    }),
  );
  assert.equal(first.hints[0].id, "bundle.first.console");
  assert.equal(first.hints[0].uiOnly, true);
  const feature = withHints(
    new PlayApiError(400, "POST", "/edits/x:commit", { message: "Feature graphic is required" }),
  );
  assert.equal(feature.hints[0].fixCommand, "playstore-release images");
  const generic403 = withHints(new PlayApiError(403, "POST", "/edits", { message: "Forbidden" }));
  assert.equal(generic403.hints[0].id, "account.permissions");
  const code = withHints(
    new PlayApiError(400, "POST", "/edits/x/bundles", {
      message: "Version code 7 has already been used. Try another version code.",
    }),
  );
  assert.match(code.hints[0].title, /versionCode 7/);
});
