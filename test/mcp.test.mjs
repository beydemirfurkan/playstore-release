// @ts-nocheck — tests assert at runtime; a possibly-undefined lookup here fails the test loudly anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createServer } from "../src/mcp/server.mjs";
import { buildTools } from "../src/mcp/tools.mjs";
import { RESOURCES } from "../src/mcp/resources.mjs";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/protocol.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../src/mcp/server.mjs");

/** Call the handlers directly — fast, and where most of the behaviour lives. */
function connect(env = {}) {
  const handlers = createServer({ env });
  return {
    handlers,
    request: async (method, params = {}) => handlers[method](params),
    tools: async () => (await handlers["tools/list"]()).tools,
    call: async (name, args = {}) => handlers["tools/call"]({ name, arguments: args }),
    read: async (uri) => handlers["resources/read"]({ uri }),
  };
}

function tool(tools, name) {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `no tool named ${name}`);
  return found;
}

const MUTATING = [
  "play_apply_publish",
  "play_upload_images",
  "play_promote",
  "play_reply_review",
  "play_configure_subscriptions",
];

test("the tool surface is exactly this, and grows only on purpose", async () => {
  const tools = await connect().tools();
  assert.equal(tools.length, 10, tools.map((t) => t.name).join(", "));
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "play_app_overview",
    "play_apply_publish",
    "play_configure_subscriptions",
    "play_plan_publish",
    "play_promote",
    "play_readiness_report",
    "play_reply_review",
    "play_reviews",
    "play_upload_images",
    "play_validate_config",
  ]);
});

test("every tool ships a usable JSON Schema and honest annotations", async () => {
  const tools = await connect().tools();
  for (const t of tools) {
    assert.ok(t.annotations, `${t.name} has no annotations`);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    assert.ok(t.description.length > 40, `${t.name} needs a description a model can choose on`);
    assert.equal(t.inputSchema.type, "object");
    for (const [key, spec] of Object.entries(t.inputSchema.properties)) {
      assert.ok(spec.description, `${t.name}.${key} has no description`);
      assert.ok(spec.type, `${t.name}.${key} has no type`);
    }
  }
  const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
  assert.deepEqual(readOnly.sort(), [
    "play_app_overview",
    "play_plan_publish",
    "play_readiness_report",
    "play_reviews",
    "play_validate_config",
  ]);
  for (const name of MUTATING) assert.equal(tool(tools, name).annotations.readOnlyHint, false, name);
});

test("every mutating tool requires confirm: true and refuses without it", async () => {
  const mcp = connect();
  const tools = await mcp.tools();
  for (const name of MUTATING) {
    const t = tool(tools, name);
    assert.ok(t.inputSchema.required?.includes("confirm"), `${name} does not require confirm`);
    assert.equal(t.inputSchema.properties.confirm.const, true);
    const missing = await mcp.call(name, name === "play_reply_review" ? { review: "r", text: "t" } : {});
    assert.equal(missing.isError, true, `${name} ran without confirmation`);
    const refused = await mcp.call(name, { confirm: false, review: "r", text: "t" });
    assert.equal(refused.isError, true, `${name} accepted confirm: false`);
  }
});

test("no tool accepts a credential as an argument", async () => {
  const tools = await connect().tools();
  for (const t of tools) {
    for (const key of Object.keys(t.inputSchema.properties ?? {})) {
      assert.ok(!/serviceaccount|privatekey|secret|password|json/i.test(key), `${t.name} accepts "${key}"`);
    }
  }
});

test("the server works without credentials and each tool explains the gap", async () => {
  const res = await connect({}).call("play_readiness_report");
  assert.notEqual(res.isError, true, "a missing key is not a malfunction");
  assert.match(res.content[0].text, /PLAY_SERVICE_ACCOUNT_JSON/);
  assert.equal(res.structuredContent.configured, false);
});

test("play_validate_config needs neither credentials nor a network", async () => {
  const res = await connect({}).call("play_validate_config", {
    config: { defaultLanguage: "tr-TR", listing: { title: "x".repeat(40) } },
  });
  assert.equal(res.structuredContent.valid, false);
  assert.match(res.content[0].text, /title/);
});

test("image pruning is opt-in for a model, unlike the CLI", async () => {
  const shots = tool(buildTools({ env: {} }), "play_upload_images");
  assert.equal(shots.inputSchema.properties.prune.default, false);
});

test("the resources are listed and readable", async () => {
  const mcp = connect();
  const { resources } = await mcp.request("resources/list");
  assert.equal(resources.length, RESOURCES.length);
  assert.equal(resources.length, 7);
  const gotchas = await mcp.read("playstore-release://gotchas");
  assert.match(gotchas.contents[0].text, /Gotchas/);
  const console_ = await mcp.read("playstore-release://console");
  assert.match(console_.contents[0].text, /firstBundle/);
  const schema = await mcp.read("playstore-release://config-schema");
  assert.equal(JSON.parse(schema.contents[0].text).title, "playstore-release config");
});

test("initialize echoes a version we speak, and names ours when we do not", async () => {
  const mcp = connect();
  const negotiated = await mcp.request("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(negotiated.protocolVersion, "2025-06-18");
  assert.equal(negotiated.serverInfo.name, "playstore-release");
  assert.ok(negotiated.instructions.includes("play_readiness_report"));
  const fallback = await mcp.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(fallback.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(LATEST_PROTOCOL_VERSION));
});

async function overStdio(messages, { env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, ...env },
  });
  const received = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) received.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  child.stdin.end();
  await new Promise((resolve) => child.on("close", () => resolve(undefined)));
  return received;
}

test("a spawned server speaks the protocol over stdio", async () => {
  const got = await overStdio([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.deepEqual(
    got.map((m) => m.id),
    [1, 2],
  );
  assert.equal(got[1].result.tools.length, 10);
});
