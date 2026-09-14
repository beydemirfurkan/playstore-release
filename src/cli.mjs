#!/usr/bin/env node
// Single entrypoint / dispatcher.
//
//   playstore-release status              read-only overview
//   playstore-release check               readiness report (what's missing + Console-only steps)
//   playstore-release publish             the whole pipeline in one edit, then check
//   playstore-release <operation>         run one operation (listing, images, release, ...)
//   playstore-release promote --yes       move the newest bundle to production
//
// Credentials come from PLAY_SERVICE_ACCOUNT_JSON and PLAY_PACKAGE_NAME, or
// from the matching flags.

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createContext } from "./core/context.mjs";
import { Status, Exit } from "./core/status.mjs";
import { Severity } from "./core/findings.mjs";
import { runOperation, runPipeline } from "./index.mjs";
import { OPERATIONS, PIPELINE, getOperation, operationIds } from "./ops/registry.mjs";
import { parseArgs, splitFlags, GLOBAL_FLAGS, UsageError } from "./cli/args.mjs";
import { createTextSink, renderFindings } from "./cli/render.mjs";
import { schemaCommand, initCommand, validateCommand } from "./cli/local.mjs";
import { doctorCommand } from "./cli/doctor.mjs";
import { buildTools } from "./mcp/tools.mjs";
import { RESOURCES } from "./mcp/resources.mjs";

const version = createRequire(import.meta.url)("../package.json").version;

// Counted rather than written down, so the help text cannot drift from reality.
const MCP_TOOL_COUNT = buildTools({ env: {} }).length;

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Run the CLI. Returns an exit code rather than calling process.exit, so the
 * dispatcher is importable from tests and reusable from other entrypoints.
 *
 * @param {string[]} [argv]
 * @param {{ stdout?: any, stderr?: any, env?: any, cwd?: string, fetchImpl?: typeof fetch }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();

  // Parse twice: once to learn the command, once with that operation's own flags
  // in the spec, so `--file x.aab` is accepted for upload-bundle and rejected elsewhere.
  let parsed;
  try {
    const first = parseArgs(argv, {}, { lenient: true });
    const op = first.command ? getOperation(first.command) : null;
    parsed = parseArgs(argv, op?.meta.args ?? {});
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`${e.message}\n\n`);
      writeHelp(stderr);
      return Exit.USAGE;
    }
    throw e;
  }

  const { command, flags } = parsed;
  if (flags.version) {
    stdout.write(`${version}\n`);
    return Exit.OK;
  }
  if (flags.help || command === "help" || command === null) {
    writeHelp(stdout);
    return Exit.OK;
  }

  // Local commands run before any context is built — they exist precisely for
  // the case where there are no credentials yet.
  if (command === "schema") return schemaCommand(stdout);
  if (command === "init") return initCommand({ stdout, stderr, cwd, target: parsed.positionals[0] });
  if (command === "validate") return validateCommand({ stdout, stderr, cwd, env, explicit: flags.config });
  if (command === "doctor") {
    return doctorCommand({
      stdout,
      stderr,
      env,
      cwd,
      config: flags.config,
      packageName: flags.package,
      serviceAccount: flags["service-account"],
      fetchImpl: io.fetchImpl,
    });
  }
  if (command === "mcp") {
    // Hand the process to the MCP server; it owns stdio from here.
    const { main: mcpMain } = await import("./mcp/server.mjs");
    await mcpMain();
    return Exit.OK;
  }

  const isPipeline = command === "publish";
  const op = isPipeline ? null : getOperation(command);
  if (!isPipeline && !op) {
    stderr.write(`Unknown command: ${command}\n\n`);
    writeHelp(stderr);
    return Exit.USAGE;
  }

  const opFlags = op?.meta.args ?? {};
  const { globals, opArgs } = splitFlags(flags, opFlags);

  // Under --json, stdout carries exactly one JSON document and nothing else;
  // every human-readable byte goes to stderr. That is what makes `| jq` work.
  const humanStream = globals.json ? stderr : stdout;
  const sink = createTextSink(humanStream, { verbose: globals.verbose, quiet: globals.quiet });

  let ctx;
  try {
    ctx = await createContext({
      credentials: { serviceAccount: globals.serviceAccount, packageName: globals.package },
      config: globals.config,
      projectRoot: globals.projectRoot,
      dryRun: globals.dryRun,
      onEvent: sink,
      fetchImpl: io.fetchImpl,
      runtime: { env, cwd },
    });
  } catch (e) {
    stderr.write(`✗ ${messageOf(e)}\n`);
    return Exit.CONFIG;
  }
  ctx.keepEdit = Boolean(globals.keepEdit);

  // Credentials are reported as findings, not thrown, so we can print everything
  // that is missing at once instead of one environment variable per run.
  if (ctx.findings.some((f) => f.severity === Severity.BLOCKER)) {
    renderFindings(stderr, ctx.findings);
    if (globals.json) writeJson(stdout, { ok: false, results: [], findings: ctx.findings, changes: [] });
    return globals.exitZero ? Exit.OK : Exit.CONFIG;
  }
  if (!ctx.packageName) {
    stderr.write("✗ No package name. Set PLAY_PACKAGE_NAME, pass --package, or put packageName in the config.\n");
    return globals.exitZero ? Exit.OK : Exit.CONFIG;
  }

  // Destructive and irreversible operations need an explicit yes — a human typed
  // `promote`, but production is not something to reach by muscle memory.
  if (op && (op.meta.irreversible || op.meta.destructive) && !globals.yes && !globals.dryRun) {
    const why = op.meta.irreversible ? "cannot be undone" : "can delete data on Play";
    stderr.write(`✗ ${command} ${why}. Re-run with --yes to confirm, or --dry-run to see what it would do.\n`);
    return Exit.CONFIRM;
  }

  if (globals.dryRun)
    ctx.log.info("dry run — an edit is opened to read state, but nothing is committed to Google Play");

  try {
    if (isPipeline) {
      ctx.log.section("Google Play — publishing pipeline");
      await runPipeline(PIPELINE, ctx);
      await runOperation("check", ctx, {});
    } else {
      await runOperation(command, ctx, opArgs);
    }
  } finally {
    // An interrupted run must never leave an edit open.
    if (!ctx.keepEdit) await ctx.edit.discard().catch(() => {});
  }

  const results = ctx.log.results();
  const findings = [...ctx.findings, ...results.flatMap((r) => r.findings ?? [])];

  const manual = results.filter((r) => r.status === Status.MANUAL);
  if (manual.length && !isPipeline && command !== "check") {
    ctx.log.section("Manual steps required (Google has no API for these)");
    manual.forEach((m, i) => ctx.log.info(`${i + 1}. ${m.title} — ${m.message}`));
  }
  renderFindings(humanStream, findings);

  const code = exitCodeFor(results, findings);
  if (globals.json) {
    writeJson(stdout, {
      ok: code === Exit.OK,
      dryRun: Boolean(globals.dryRun),
      results,
      findings,
      changes: ctx.log.changes(),
    });
  }
  return globals.exitZero ? Exit.OK : code;
}

/**
 * Exit 4 means "there is still something this tool can do about it"; exit 5 means
 * "there is not". That distinction is the whole reason for the code table.
 */
function exitCodeFor(results, findings) {
  if (results.some((r) => r.status === Status.ERROR)) return Exit.BLOCKED;
  const blocking = findings.filter((f) => f.severity === Severity.BLOCKER);
  if (blocking.some((f) => !f.uiOnly)) return Exit.BLOCKED;
  if (blocking.length || results.some((r) => r.status === Status.MANUAL)) return Exit.NEEDS_HUMAN;
  return Exit.OK;
}

function writeJson(stream, payload) {
  stream.write(JSON.stringify(payload, null, 2) + "\n");
}

function writeHelp(stream) {
  const ops = operationIds()
    .map((id) => `  ${id.padEnd(16)} ${OPERATIONS[id].meta.title}`)
    .join("\n");
  const flags = Object.entries(GLOBAL_FLAGS)
    .map(([name, def]) => {
      const label = def.alias ? `-${def.alias}, --${name}` : `--${name}`;
      return `  ${label.padEnd(20)} ${def.description}`;
    })
    .join("\n");

  stream.write(
    `playstore-release ${version}\n` +
      `Ship an Android app to Google Play, end to end, over the Google Play Developer API.\n\n` +
      `Usage: playstore-release <command> [options]\n\n` +
      `Commands\n` +
      `  init             scaffold playstore.config.json (no credentials needed)\n` +
      `  schema           print the config JSON Schema\n` +
      `  validate         check the config offline\n` +
      `  doctor           verify credentials and config; opens and discards one edit\n` +
      `  mcp              run the MCP server on stdio (${MCP_TOOL_COUNT} tools, ${RESOURCES.length} resources)\n` +
      `  publish          the ${PIPELINE.length}-step pipeline in one edit, then a readiness check\n` +
      `${ops}\n\n` +
      `Options\n${flags}\n\n` +
      `Exit codes\n` +
      `  0 ok · 2 usage · 3 config/credentials · 4 blocked (fixable) · 5 needs a human in the Play Console · 6 API · 7 needs --yes\n`,
  );
}

// Only run when invoked as a program, so tests and the MCP server can import main().
// argv[1] may be a symlink (npm bin, ~/.claude/skills), import.meta.url is the real
// file — resolve before comparing.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(`\n✗ ${messageOf(e)}`);
    process.exitCode = Exit.INTERNAL;
  }
}
