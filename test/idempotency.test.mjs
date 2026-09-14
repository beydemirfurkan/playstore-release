// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContext } from "../src/core/context.mjs";
import { runOperation, runPipeline, PIPELINE } from "../src/index.mjs";
import { Status } from "../src/core/status.mjs";
import {
  createMockPlay,
  readyToPublishRoutes,
  testCredentials,
  png,
  jpeg,
  sha1,
  API,
  PACKAGE,
} from "./helpers/mock-play.mjs";

/** A project with valid Play graphics and a config pointing at them. */
function project({ phone = 2, config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "psr-idem-"));
  mkdirSync(join(root, "images", "phone"), { recursive: true });
  const files = {
    icon: png(512, 512, { tag: "icon", alpha: true }),
    featureGraphic: png(1024, 500, { tag: "feature" }),
    phoneScreenshots: Array.from({ length: phone }, (_, i) =>
      i % 2 ? jpeg(1080, 1920, { tag: `p${i}` }) : png(1080, 1920, { tag: `p${i}` }),
    ),
  };
  writeFileSync(join(root, "images", "icon.png"), files.icon);
  writeFileSync(join(root, "images", "feature-graphic.png"), files.featureGraphic);
  files.phoneScreenshots.forEach((b, i) =>
    writeFileSync(join(root, "images", "phone", `0${i + 1}.${i % 2 ? "jpg" : "png"}`), b),
  );
  writeFileSync(
    join(root, "playstore.config.json"),
    JSON.stringify({
      defaultLanguage: "tr-TR",
      listing: { title: "Test App", shortDescription: "Short", fullDescription: "Full text.", releaseNotes: "Fixes." },
      details: { contactEmail: "dev@example.com", contactWebsite: "https://example.com" },
      images: { dir: "./images" },
      release: { track: "internal", status: "completed" },
      ...config,
    }),
  );
  const hashes = {
    icon: [sha1(files.icon)],
    featureGraphic: [sha1(files.featureGraphic)],
    phoneScreenshots: files.phoneScreenshots.map(sha1),
  };
  return { root, hashes };
}

async function ctxFor(root, routes, opts = {}) {
  const mock = createMockPlay({ routes, strict: false });
  const ctx = await createContext({
    credentials: testCredentials(),
    config: join(root, "playstore.config.json"),
    fetchImpl: mock.fetchImpl,
    runtime: { env: {}, cwd: root },
    ...opts,
  });
  return { ctx, mock };
}

const rel = (c) => `${c.method} ${c.pathname.replace(/.*\/applications\/[^/]+/, "")}`;

test("a second publish with nothing changed sends only the edit lifecycle", async () => {
  const { root, hashes } = project();
  const routes = readyToPublishRoutes({
    images: hashes,
    tracks: [
      {
        track: "internal",
        releases: [{ status: "completed", versionCodes: ["7"], releaseNotes: [{ language: "tr-TR", text: "Fixes." }] }],
      },
      { track: "production", releases: [] },
    ],
  });
  const { ctx, mock } = await ctxFor(root, routes);
  const { results } = await runPipeline(PIPELINE, ctx);
  for (const r of results)
    assert.ok([Status.OK, Status.SKIPPED].includes(r.status), `${r.id}: ${r.status} ${r.message}`);
  assert.deepEqual(mock.writes(), [], "an unchanged run must be write-free");
  assert.equal(mock.commits().length, 0, "nothing to commit means no commit");
  assert.deepEqual(mock.mutations().map(rel), ["POST /edits", "DELETE /edits/edit-1"]);
});

test("images: unchanged sha1s upload nothing; one stale sha1 costs one upload and one delete", async () => {
  const { root, hashes } = project();
  const same = await ctxFor(root, readyToPublishRoutes({ images: hashes }));
  const ok = await runOperation("images", same.ctx, { prune: true });
  assert.equal(ok.status, Status.OK, ok.message);
  assert.deepEqual(same.mock.writes(), []);

  const stale = { ...hashes, phoneScreenshots: [hashes.phoneScreenshots[0], "sha-stale"] };
  const changed = await ctxFor(root, readyToPublishRoutes({ images: stale }));
  const res = await runOperation("images", changed.ctx, { prune: true });
  assert.equal(res.status, Status.CHANGED, res.message);
  assert.equal(res.details.uploaded, 1);
  assert.equal(res.details.deleted, 1);
  const writes = changed.mock.writes().map(rel);
  assert.deepEqual(
    writes.filter((w) => w.startsWith("DELETE")),
    ["DELETE /edits/edit-1/listings/tr-TR/phoneScreenshots/phoneScreenshots-1"],
  );
  assert.equal(writes.filter((w) => w.startsWith("POST") && w.includes("phoneScreenshots")).length, 1);
  const upload = changed.mock.calls.find((c) => c.method === "POST" && c.pathname.includes("/upload/"));
  assert.equal(upload.contentType, "image/jpeg", "the raw bytes go up with their real content type");
  assert.ok(upload.path.includes("uploadType=media"));
});

test("images: a different order is reported, not silently rewritten — unless --reorder", async () => {
  const { root, hashes } = project();
  const reversed = { ...hashes, phoneScreenshots: [...hashes.phoneScreenshots].reverse() };
  const a = await ctxFor(root, readyToPublishRoutes({ images: reversed }));
  const res = await runOperation("images", a.ctx, { prune: true });
  assert.equal(res.status, Status.OK, "membership is identical, so nothing is uploaded");
  assert.ok(res.findings.some((f) => f.id.startsWith("images.order.differs")));
  assert.deepEqual(a.mock.writes(), []);

  const b = await ctxFor(root, readyToPublishRoutes({ images: reversed }));
  const re = await runOperation("images", b.ctx, { prune: true, reorder: true });
  assert.equal(re.status, Status.CHANGED);
  const writes = b.mock.writes().map(rel);
  assert.equal(writes[0], "DELETE /edits/edit-1/listings/tr-TR/phoneScreenshots", "deleteall first");
  assert.equal(writes.filter((w) => w.startsWith("POST")).length, 2, "then every file, in order");
});

test("images: a 1290×2796 screenshot is refused locally before any upload", async () => {
  const { root, hashes } = project();
  writeFileSync(join(root, "images", "phone", "03.png"), png(1290, 2796, { tag: "iphone" }));
  const { ctx, mock } = await ctxFor(root, readyToPublishRoutes({ images: hashes }));
  const res = await runOperation("images", ctx);
  assert.equal(res.status, Status.ERROR);
  assert.ok(
    res.findings.some((f) => f.id.startsWith("images.invalid.phoneScreenshots.03.png") && /2\.17:1/.test(f.title)),
    JSON.stringify(res.findings.map((f) => f.title)),
  );
  assert.deepEqual(mock.writes(), []);
});

test("listing: only the language whose text differs is written", async () => {
  const { root } = project({
    config: {
      defaultLanguage: "tr-TR",
      listing: { title: "Test App", shortDescription: "Short", fullDescription: "Full text." },
      locales: { "tr-TR": {}, "en-US": { title: "Test App EN", fullDescription: "Full text EN." } },
    },
  });
  const routes = readyToPublishRoutes();
  routes[`GET ${API}/applications/${PACKAGE}/edits/:edit/listings`] = {
    listings: [
      { language: "tr-TR", title: "Test App", shortDescription: "Short", fullDescription: "Full text." },
      { language: "en-US", title: "Old EN", shortDescription: "Short", fullDescription: "Full text EN." },
    ],
  };
  routes[`GET ${API}/applications/${PACKAGE}/edits/:edit/listings/:lang`] = ({ params }) =>
    params.lang === "en-US"
      ? { language: "en-US", title: "Old EN", shortDescription: "Short", fullDescription: "Full text EN." }
      : { language: "tr-TR", title: "Test App", shortDescription: "Short", fullDescription: "Full text." };
  const { ctx, mock } = await ctxFor(root, routes);
  const res = await runOperation("listing", ctx);
  assert.equal(res.status, Status.CHANGED);
  assert.deepEqual(res.details.changed, { "en-US": ["title"] });
  const puts = mock.writes().filter((w) => w.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.language, "en-US");
  assert.equal(puts[0].body.shortDescription, "Short", "the PUT carries the whole listing, not only the diff");
});

test("release: a staged rollout keeps the still-serving completed release; a full release supersedes it", async () => {
  const { root } = project({ config: { release: { track: "production", status: "inProgress", userFraction: 0.1 } } });
  const routes = readyToPublishRoutes({
    bundles: [
      { versionCode: 7, sha1: "a" },
      { versionCode: 8, sha1: "b" },
    ],
    tracks: [
      { track: "internal", releases: [{ status: "completed", versionCodes: ["8"] }] },
      { track: "production", releases: [{ status: "completed", versionCodes: ["7"], name: "1.0.0" }] },
    ],
  });
  const staged = await ctxFor(root, routes);
  const res = await runOperation("release", staged.ctx);
  assert.equal(res.status, Status.CHANGED, res.message);
  const put = staged.mock.writes().find((w) => w.method === "PUT");
  assert.deepEqual(
    put.body.releases.map((r) => [r.status, r.versionCodes[0], r.userFraction ?? null]),
    [
      ["inProgress", "8", 0.1],
      ["completed", "7", null],
    ],
  );

  const full = await ctxFor(root, routes);
  const done = await runOperation("release", full.ctx, { status: "completed" });
  assert.equal(done.status, Status.CHANGED);
  const put2 = full.mock.writes().find((w) => w.method === "PUT");
  assert.deepEqual(
    put2.body.releases.map((r) => [r.status, r.versionCodes[0]]),
    [["completed", "8"]],
  );
});

test("upload-bundle: the same bytes already on Play are not re-uploaded, and the versionCode is noted for release", async () => {
  const { root } = project();
  const aab = Buffer.from("PK fake bundle bytes");
  writeFileSync(join(root, "app.aab"), aab);
  const routes = readyToPublishRoutes({
    bundles: [{ versionCode: 7, sha1: sha1(aab) }],
    tracks: [{ track: "internal", releases: [] }],
  });
  const { ctx, mock } = await ctxFor(root, routes);
  ctx.edit.hold();
  const up = await runOperation("upload-bundle", ctx, { file: "./app.aab" });
  assert.equal(up.status, Status.OK, up.message);
  assert.equal(ctx.edit.notes.versionCode, 7);
  const released = await runOperation("release", ctx);
  assert.equal(released.status, Status.CHANGED);
  assert.equal(mock.writes().find((w) => w.method === "PUT").body.releases[0].versionCodes[0], "7");
  ctx.edit.unhold();

  const fresh = await ctxFor(
    root,
    readyToPublishRoutes({ bundles: [], tracks: [{ track: "internal", releases: [] }] }),
  );
  const upload = await runOperation("upload-bundle", fresh.ctx, { file: "./app.aab" });
  assert.equal(upload.status, Status.CHANGED);
  assert.equal(upload.details.versionCode, 8);
  const call = fresh.mock.calls.find((c) => c.pathname.includes("/upload/"));
  assert.equal(call.contentType, "application/octet-stream");
  assert.equal(call.raw.length, aab.length);
});

test("testers and details are written only when they differ", async () => {
  const { root } = project({ config: { testers: { alpha: ["qa@googlegroups.com"] } } });
  const routes = readyToPublishRoutes();
  routes[`GET ${API}/applications/${PACKAGE}/edits/:edit/testers/:track`] = { googleGroups: ["qa@googlegroups.com"] };
  const { ctx, mock } = await ctxFor(root, routes);
  assert.equal((await runOperation("testers", ctx)).status, Status.OK);
  assert.equal((await runOperation("details", ctx)).status, Status.OK);
  assert.deepEqual(mock.writes(), []);
});
