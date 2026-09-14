// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReport } from "../src/report/report.mjs";
import { getAppSnapshot } from "../src/report/snapshot.mjs";
import { createContext } from "../src/core/context.mjs";
import { runOperation } from "../src/index.mjs";
import { Severity } from "../src/core/findings.mjs";
import { Status } from "../src/core/status.mjs";
import { CONSOLE_STEPS } from "../src/core/console.mjs";
import {
  createMockPlay,
  readyToPublishRoutes,
  testCredentials,
  googleError,
  png,
  API,
  PACKAGE,
} from "./helpers/mock-play.mjs";

const CONFIG = {
  defaultLanguage: "tr-TR",
  listing: { title: "Test App", shortDescription: "Short", fullDescription: "Full text." },
  details: { contactEmail: "dev@example.com", contactWebsite: "https://example.com" },
  release: { track: "internal", status: "completed" },
};

/** A snapshot with everything in order; each test spoils one thing. */
function healthySnapshot(overrides = {}) {
  return {
    generatedAt: "2026-09-14T00:00:00.000Z",
    packageName: PACKAGE,
    access: { status: 200 },
    bundles: [{ versionCode: 7, sha1: "sha-bundle-7" }],
    tracks: [
      { track: "internal", releases: [{ status: "completed", versionCodes: ["7"] }] },
      { track: "production", releases: [] },
    ],
    listings: {
      "tr-TR": { language: "tr-TR", title: "Test App", shortDescription: "Short", fullDescription: "Full text." },
    },
    images: {
      "tr-TR": {
        icon: [{ id: "i", sha1: "a" }],
        featureGraphic: [{ id: "f", sha1: "b" }],
        phoneScreenshots: [
          { id: "p1", sha1: "c" },
          { id: "p2", sha1: "d" },
        ],
        sevenInchScreenshots: [],
        tenInchScreenshots: [],
      },
    },
    details: { defaultLanguage: "tr-TR", contactEmail: "dev@example.com", contactWebsite: "https://example.com" },
    testers: {},
    reviews: null,
    subscriptions: [],
    locale: "tr-TR",
    locales: ["tr-TR"],
    errors: [],
    ...overrides,
  };
}

const DECLARATIONS = CONSOLE_STEPS.filter((s) => s.group !== "bootstrap").map((s) => s.key);

test("with every declaration still open, the verdict is needs-human and each step is uiOnly with clicks", () => {
  const report = buildReport({ snapshot: healthySnapshot(), config: CONFIG });
  assert.equal(report.verdict, "needs-human");
  const human = report.findings.filter((f) => f.uiOnly);
  assert.deepEqual(human.map((f) => f.id).sort(), DECLARATIONS.map((k) => `console.${k}`).sort());
  for (const f of human) {
    assert.ok(f.fixClicks?.length, `${f.id} has clicks`);
    assert.ok(f.fix.includes("play.google.com/console"), `${f.id} names the console URL`);
  }
  assert.ok(report.nextActions.every((a) => a.kind === "human"));
});

test("console.done flips a declaration to INFO; a production release flips them all", () => {
  const partly = buildReport({
    snapshot: healthySnapshot(),
    config: { ...CONFIG, console: { done: ["ads", "news"] } },
  });
  assert.ok(partly.findings.some((f) => f.id === "console.ads.done" && f.severity === Severity.INFO));
  assert.ok(!partly.findings.some((f) => f.id === "console.ads"));
  assert.ok(partly.findings.some((f) => f.id === "console.contentRating" && f.severity === Severity.BLOCKER));

  const live = buildReport({
    snapshot: healthySnapshot({
      tracks: [
        { track: "internal", releases: [{ status: "completed", versionCodes: ["7"] }] },
        { track: "production", releases: [{ status: "completed", versionCodes: ["7"] }] },
      ],
    }),
    config: CONFIG,
  });
  assert.equal(live.summary.blockers, 0);
  assert.equal(live.verdict, "live");
});

test("everything done and nothing on production → ready; staged → rolling-out; halted → halted", () => {
  const done = { ...CONFIG, console: { done: DECLARATIONS } };
  assert.equal(buildReport({ snapshot: healthySnapshot(), config: done }).verdict, "ready");

  const rolling = healthySnapshot({
    tracks: [
      { track: "internal", releases: [{ status: "completed", versionCodes: ["7"] }] },
      { track: "production", releases: [{ status: "inProgress", userFraction: 0.2, versionCodes: ["7"] }] },
    ],
  });
  const r = buildReport({ snapshot: rolling, config: done });
  assert.equal(r.verdict, "rolling-out");
  assert.ok(r.nextActions.some((a) => a.kind === "wait"));

  const halted = healthySnapshot({
    tracks: [
      { track: "internal", releases: [{ status: "completed", versionCodes: ["7"] }] },
      { track: "production", releases: [{ status: "halted", userFraction: 0.2, versionCodes: ["7"] }] },
    ],
  });
  assert.equal(buildReport({ snapshot: halted, config: done }).verdict, "halted");
});

test("a missing feature graphic blocks with a fixCommand; an unassigned bundle points at release", () => {
  const snap = healthySnapshot();
  snap.images["tr-TR"].featureGraphic = [];
  const report = buildReport({ snapshot: snap, config: { ...CONFIG, console: { done: DECLARATIONS } } });
  assert.equal(report.verdict, "blocked");
  const f = report.findings.find((x) => x.id === "images.featureGraphic.missing");
  assert.equal(f.fixCommand, "playstore-release images");
  assert.equal(report.nextActions[0].command, "playstore-release images");

  const unassigned = healthySnapshot({ bundles: [{ versionCode: 9, sha1: "z" }] });
  const r2 = buildReport({ snapshot: unassigned, config: { ...CONFIG, console: { done: DECLARATIONS } } });
  assert.ok(r2.findings.some((x) => x.id === "bundle.unassigned" && x.fixCommand === "playstore-release release"));
  assert.ok(r2.findings.some((x) => x.id === "track.release.missing"));
});

test("a 1290×2796 local screenshot is reported with the aspect rule; 1080×1920 passes", () => {
  const root = mkdtempSync(join(tmpdir(), "psr-report-"));
  mkdirSync(join(root, "images", "phone"), { recursive: true });
  writeFileSync(join(root, "images", "icon.png"), png(512, 512, { alpha: true }));
  writeFileSync(join(root, "images", "feature-graphic.png"), png(1024, 500));
  writeFileSync(join(root, "images", "phone", "01.png"), png(1290, 2796, { tag: "a" }));
  writeFileSync(join(root, "images", "phone", "02.png"), png(1080, 1920, { tag: "b" }));
  const config = { ...CONFIG, images: { dir: "./images" }, console: { done: DECLARATIONS } };
  const report = buildReport({ snapshot: healthySnapshot(), config, resolvePath: (p) => join(root, p) });
  const bad = report.findings.find((f) => f.id.startsWith("images.invalid.phoneScreenshots.01.png"));
  assert.ok(bad, "01.png must be flagged");
  assert.match(bad.title, /2\.17:1/);
  assert.ok(!report.findings.some((f) => f.id.startsWith("images.invalid.phoneScreenshots.02.png")));
  // feature graphic with alpha is refused too
  writeFileSync(join(root, "images", "feature-graphic.png"), png(1024, 500, { alpha: true }));
  const again = buildReport({ snapshot: healthySnapshot(), config, resolvePath: (p) => join(root, p) });
  assert.ok(again.findings.some((f) => f.id.startsWith("images.invalid.featureGraphic") && /alpha/.test(f.title)));
});

test("404 on the edit → app + first bundle are the only findings; 403 → invite the service account", async () => {
  const notFound = createMockPlay({
    routes: {
      [`POST ${API}/applications/${PACKAGE}/edits`]: googleError(
        404,
        "Package not found: com.example.test.",
        "NOT_FOUND",
        "applicationNotFound",
      ),
    },
    strict: false,
  });
  const ctx404 = await createContext({
    credentials: testCredentials(),
    config: CONFIG,
    fetchImpl: notFound.fetchImpl,
    runtime: { env: {} },
  });
  const s404 = await getAppSnapshot(ctx404);
  assert.equal(s404.access.status, 404);
  const r404 = buildReport({ snapshot: s404, config: CONFIG });
  assert.deepEqual(r404.findings.map((f) => f.id).sort(), ["console.app", "console.firstBundle"]);
  assert.equal(r404.verdict, "needs-human");

  const forbidden = createMockPlay({
    routes: {
      [`POST ${API}/applications/${PACKAGE}/edits`]: googleError(
        403,
        "The caller does not have permission",
        "PERMISSION_DENIED",
        "forbidden",
      ),
    },
    strict: false,
  });
  const ctx403 = await createContext({
    credentials: testCredentials(),
    config: CONFIG,
    fetchImpl: forbidden.fetchImpl,
    runtime: { env: {} },
  });
  const r403 = buildReport({ snapshot: await getAppSnapshot(ctx403), config: CONFIG });
  assert.deepEqual(
    r403.findings.map((f) => f.id),
    ["console.serviceAccount"],
  );
});

test("check against the mock returns the report as details and MANUAL until settled", async () => {
  const mock = createMockPlay({ routes: readyToPublishRoutes(), strict: false });
  const ctx = await createContext({
    credentials: testCredentials(),
    config: CONFIG,
    fetchImpl: mock.fetchImpl,
    runtime: { env: {} },
  });
  const res = await runOperation("check", ctx);
  assert.equal(res.status, Status.MANUAL);
  assert.equal(res.details.verdict, "needs-human");
  assert.equal(res.details.release.newestVersionCode, 7);
  assert.equal(mock.commits().length, 0);
});
