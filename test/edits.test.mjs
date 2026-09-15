// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContext } from "../src/core/context.mjs";
import { runOperation, runPipeline } from "../src/index.mjs";
import { Status } from "../src/core/status.mjs";
import { createMockPlay, readyToPublishRoutes, testCredentials, googleError } from "./helpers/mock-play.mjs";

const CONFIG = {
  defaultLanguage: "tr-TR",
  listing: { title: "Test App", shortDescription: "Short", fullDescription: "Full text." },
  details: { contactEmail: "dev@example.com", contactWebsite: "https://example.com" },
  release: { track: "internal", status: "completed" },
};

function project(config = CONFIG) {
  const root = mkdtempSync(join(tmpdir(), "psr-edit-"));
  writeFileSync(join(root, "playstore.config.json"), JSON.stringify(config));
  return root;
}

async function ctxFor(routes, { config = CONFIG, dryRun = false, strict = false } = {}) {
  const mock = createMockPlay({ routes, strict });
  const root = project(config);
  const ctx = await createContext({
    credentials: testCredentials(),
    config: join(root, "playstore.config.json"),
    fetchImpl: mock.fetchImpl,
    dryRun,
    runtime: { env: {}, cwd: root },
  });
  return { ctx, mock, root };
}

const editPaths = (mock) =>
  mock.calls
    .filter((c) => /\/edits/.test(c.pathname))
    .map((c) => `${c.method} ${c.pathname.replace(/.*\/applications\/[^/]+/, "")}`);

test("a read-only operation opens an edit lazily and discards it, never commits", async () => {
  const { ctx, mock } = await ctxFor(readyToPublishRoutes());
  const res = await runOperation("status", ctx);
  assert.equal(res.status, Status.OK, res.message);
  assert.deepEqual(editPaths(mock)[0], "POST /edits");
  assert.equal(mock.commits().length, 0);
  assert.ok(editPaths(mock).includes("DELETE /edits/edit-1"), "the edit must be discarded");
  assert.equal(ctx.edit.id, null);
});

test("a standalone mutating operation validates and commits its own edit", async () => {
  const { ctx, mock } = await ctxFor(
    readyToPublishRoutes({
      listing: { language: "tr-TR", title: "Old", shortDescription: "Short", fullDescription: "Full text." },
    }),
  );
  const res = await runOperation("listing", ctx);
  assert.equal(res.status, Status.CHANGED, res.message);
  assert.equal(res.details.edit.outcome, "committed");
  const paths = editPaths(mock);
  assert.ok(paths.includes("PUT /edits/edit-1/listings/tr-TR"));
  assert.ok(
    paths.indexOf("POST /edits/edit-1:validate") < paths.indexOf("POST /edits/edit-1:commit"),
    "validate before commit",
  );
  assert.equal(mock.commits().length, 1);
});

test("an unchanged standalone operation discards rather than commits", async () => {
  const { ctx, mock } = await ctxFor(readyToPublishRoutes());
  const res = await runOperation("listing", ctx);
  assert.equal(res.status, Status.OK);
  assert.equal(res.details.edit.outcome, "discarded");
  assert.equal(mock.commits().length, 0);
});

test("the pipeline shares ONE edit and commits once at the end", async () => {
  const { ctx, mock } = await ctxFor(
    readyToPublishRoutes({
      listing: { language: "tr-TR", title: "Old", shortDescription: "Short", fullDescription: "Full text." },
      details: { defaultLanguage: "tr-TR", contactEmail: "old@example.com" },
    }),
    { config: { ...CONFIG, images: undefined } },
  );
  const { results } = await runPipeline(["details", "listing", "release"], ctx);
  const inserts = mock.calls.filter((c) => c.method === "POST" && /\/edits$/.test(c.pathname));
  assert.equal(inserts.length, 1, "one edit for the whole pipeline");
  assert.equal(mock.commits().length, 1);
  const edit = results.find((r) => r.id === "edit");
  assert.equal(edit.status, Status.CHANGED);
  assert.match(edit.message, /committed edit edit-1/);
  assert.equal(results.find((r) => r.id === "details").status, Status.CHANGED);
  assert.equal(results.find((r) => r.id === "listing").status, Status.CHANGED);
  assert.equal(
    results.find((r) => r.id === "release").status,
    Status.OK,
    "versionCode 7 is already completed on internal",
  );
});

test("an ERROR in the pipeline discards the edit and nothing is committed", async () => {
  const routes = readyToPublishRoutes({ details: { defaultLanguage: "tr-TR", contactEmail: "old@example.com" } });
  routes[
    `PUT ${"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.test"}/edits/:edit/listings/:lang`
  ] = googleError(400, "Short description is too long", "INVALID_ARGUMENT", "badRequest");
  const { ctx, mock } = await ctxFor(routes, {
    config: { ...CONFIG, listing: { ...CONFIG.listing, title: "Changed" } },
  });
  const { results } = await runPipeline(["details", "listing"], ctx);
  assert.equal(results.find((r) => r.id === "details").status, Status.CHANGED, "details ran and staged its change");
  assert.equal(results.find((r) => r.id === "listing").status, Status.ERROR);
  assert.equal(results.find((r) => r.id === "edit").status, Status.ERROR);
  assert.equal(mock.commits().length, 0, "a failed pipeline must not commit");
  assert.ok(editPaths(mock).includes("DELETE /edits/edit-1"));
});

test("dry run opens and discards the edit, stages nothing, never validates or commits", async () => {
  const { ctx, mock } = await ctxFor(
    readyToPublishRoutes({
      listing: { language: "tr-TR", title: "Old", shortDescription: "Short", fullDescription: "Full text." },
    }),
    { dryRun: true },
  );
  const { results } = await runPipeline(["details", "listing", "release"], ctx);
  assert.equal(results.find((r) => r.id === "listing").status, Status.PLANNED);
  assert.equal(results.find((r) => r.id === "edit").status, Status.PLANNED);
  assert.equal(mock.commits().length, 0);
  assert.equal(mock.calls.filter((c) => /:validate$/.test(c.pathname)).length, 0);
  assert.deepEqual(mock.writes(), [], "no write reaches the mock under dry run");
  assert.ok(editPaths(mock).includes("POST /edits"), "reads still need an edit");
  assert.ok(editPaths(mock).includes("DELETE /edits/edit-1"));
  const planned = ctx.log.changes().filter((c) => !c.applied);
  assert.ok(planned.some((c) => c.resource === "listings" && c.action === "update"));
});

test("--keep-edit leaves the edit open and reports its id", async () => {
  const { ctx, mock } = await ctxFor(
    readyToPublishRoutes({
      listing: { language: "tr-TR", title: "Old", shortDescription: "Short", fullDescription: "Full text." },
    }),
  );
  ctx.keepEdit = true;
  const res = await runOperation("listing", ctx);
  assert.equal(res.details.edit.outcome, "kept");
  assert.equal(ctx.edit.id, "edit-1");
  assert.equal(mock.commits().length, 0);
  assert.ok(!editPaths(mock).includes("DELETE /edits/edit-1"));
});

test("an operation that throws a Play error gets hints and its edit discarded", async () => {
  const routes = readyToPublishRoutes();
  routes[`POST ${"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.test"}/edits`] =
    googleError(403, "The caller does not have permission", "PERMISSION_DENIED", "forbidden");
  const { ctx } = await ctxFor(routes);
  const res = await runOperation("listing", ctx);
  assert.equal(res.status, Status.ERROR);
  assert.ok(
    res.findings.some((f) => f.id === "account.permissions" && f.uiOnly),
    "403 → invite-the-service-account hint",
  );
});

test("operations with edit: false never open an edit", async () => {
  const root = project({ ...CONFIG, dataSafety: { csvPath: "./data-safety.csv" } });
  writeFileSync(join(root, "data-safety.csv"), "a,b\n1,2\n");
  const mock = createMockPlay({
    routes: {
      [`POST https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.test/dataSafety`]: {},
    },
    strict: true,
  });
  const ctx = await createContext({
    credentials: testCredentials(),
    config: join(root, "playstore.config.json"),
    fetchImpl: mock.fetchImpl,
    runtime: { env: {}, cwd: root },
  });
  const res = await runOperation("data-safety", ctx);
  assert.equal(res.status, Status.CHANGED, res.message);
  assert.equal(mock.calls.filter((c) => /\/edits/.test(c.pathname)).length, 0);
  // Second run: same CSV → nothing sent.
  mock.reset();
  const again = await runOperation("data-safety", ctx);
  assert.equal(again.status, Status.OK);
  assert.equal(mock.mutations().length, 0);
});

test("before any bundle exists, publish still commits the listing and release is SKIPPED", async () => {
  const { ctx, mock } = await ctxFor(
    readyToPublishRoutes({
      bundles: [],
      tracks: [{ track: "internal", releases: [] }],
      listing: { language: "tr-TR", title: "Test App" },
      details: { defaultLanguage: "tr-TR" },
    }),
  );
  const { results } = await runPipeline(["details", "listing", "release"], ctx);
  assert.equal(results.find((r) => r.id === "release").status, Status.SKIPPED);
  assert.equal(results.find((r) => r.id === "listing").status, Status.CHANGED);
  assert.equal(results.find((r) => r.id === "edit").status, Status.CHANGED, "the listing still reaches Play");
  assert.equal(mock.commits().length, 1);
});

test("a 403 on commit for an app with no bundle is explained as the first-bundle rule, not a permission problem", async () => {
  const routes = readyToPublishRoutes({
    bundles: [],
    tracks: [{ track: "internal", releases: [] }],
    details: { defaultLanguage: "tr-TR" },
  });
  routes[
    `POST ${"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.test"}/edits/:edit:validate`
  ] = googleError(403, "The caller does not have permission", "PERMISSION_DENIED");
  const { ctx, mock } = await ctxFor(routes);
  const { results } = await runPipeline(["details"], ctx);
  const edit = results.find((r) => r.id === "edit");
  assert.equal(edit.status, Status.ERROR);
  assert.equal(edit.findings[0].id, "bundle.first.console");
  assert.equal(edit.findings[0].uiOnly, true);
  assert.equal(mock.commits().length, 0);
  assert.equal(ctx.edit.id, null, "the edit is discarded after the diagnosis");
});
