#!/usr/bin/env node
// Make this checkout available to Claude Code as a skill, without copying:
// a symlink from ~/.claude/skills/playstore-release to skills/playstore-release.
// The SKILL.md finds the CLI through PLAYSTORE_RELEASE_HOME or by resolving
// its own real path, so the checkout can live anywhere.
import { existsSync, lstatSync, readlinkSync, symlinkSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(ROOT, "skills", "playstore-release");
const skillsDir = process.env.CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
const link = join(skillsDir, "playstore-release");
const force = process.argv.includes("--force");

mkdirSync(skillsDir, { recursive: true });
if (existsSync(link) || isLink(link)) {
  if (isLink(link) && resolve(dirname(link), readlinkSync(link)) === target) {
    console.log(`✓ already installed: ${link} → ${target}`);
    process.exit(0);
  }
  if (!force) {
    console.error(`✗ ${link} exists and is not this checkout. Re-run with --force to replace it.`);
    process.exit(1);
  }
  unlinkSync(link);
}
symlinkSync(target, link, "dir");
console.log(`✓ installed: ${link} → ${target}`);
console.log(
  `\nNext, in the shell you run Claude Code from:\n  export PLAY_SERVICE_ACCOUNT_JSON=/abs/path/service-account.json\n  export PLAY_PACKAGE_NAME=com.example.app\n  export PLAYSTORE_RELEASE_HOME=${ROOT}   # optional; the skill resolves it anyway`,
);

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
