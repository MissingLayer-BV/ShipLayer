import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, readlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// These tests exercise scripts/install.sh's skill-symlink logic in isolation
// (--skip-build --skip-cli-link) against a throwaway $HOME, never the real
// developer machine. They never invoke `npm link`/`npm run build`, which
// would touch state outside this repository.

const REPO_ROOT = path.resolve(".");
const SCRIPT = path.join(REPO_ROOT, "scripts/install.sh");
const SKILL_SRC = path.join(REPO_ROOT, "skills/ship-app-store");

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "shiplayer-install-home-"));
}

function run(home: string, args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

test("install script links the skill into both directories and reports what it touched", async () => {
  const home = await tempHome();
  const result = run(home, ["install", "--skip-build", "--skip-cli-link"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const claudeTarget = path.join(home, ".claude/skills/ship-app-store");
  const codexTarget = path.join(home, ".codex/skills/ship-app-store");
  assert.equal(await readlink(claudeTarget), SKILL_SRC);
  assert.equal(await readlink(codexTarget), SKILL_SRC);
  assert.match(result.stdout, /Paths touched:/);
  assert.match(result.stdout, new RegExp(claudeTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("install script is idempotent: a second run is a clean no-op", async () => {
  const home = await tempHome();
  const first = run(home, ["install", "--skip-build", "--skip-cli-link"]);
  assert.equal(first.status, 0, first.stderr);
  const second = run(home, ["install", "--skip-build", "--skip-cli-link"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already linked/);
  assert.match(second.stdout, /no-op/);

  const claudeTarget = path.join(home, ".claude/skills/ship-app-store");
  assert.equal(await readlink(claudeTarget), SKILL_SRC);
});

test("install script refuses to clobber a real directory that isn't its own symlink", async () => {
  const home = await tempHome();
  const claudeSkills = path.join(home, ".claude/skills");
  await mkdir(path.join(claudeSkills, "ship-app-store"), { recursive: true });
  await writeFile(path.join(claudeSkills, "ship-app-store", "marker.txt"), "owner content, do not touch");

  const result = run(home, ["install", "--skip-build", "--skip-cli-link"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /REFUSING/);

  const marker = await readFile(path.join(claudeSkills, "ship-app-store", "marker.txt"), "utf8");
  assert.equal(marker, "owner content, do not touch");
});

test("install script refuses to clobber a symlink that points somewhere else", async () => {
  const home = await tempHome();
  const codexSkills = path.join(home, ".codex/skills");
  await mkdir(codexSkills, { recursive: true });
  const foreignTarget = path.join(home, "elsewhere");
  await mkdir(foreignTarget, { recursive: true });
  await symlink(foreignTarget, path.join(codexSkills, "ship-app-store"));

  const result = run(home, ["install", "--skip-build", "--skip-cli-link"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /REFUSING/);
  assert.equal(await readlink(path.join(codexSkills, "ship-app-store")), foreignTarget);
});

test("install script never writes outside the two skill directories it owns", async () => {
  const home = await tempHome();
  const result = run(home, ["install", "--skip-build", "--skip-cli-link"]);
  assert.equal(result.status, 0, result.stderr);
  for (const line of result.stdout.split("\n")) {
    if (!line.trim().startsWith("- ")) continue;
    const touchedPath = line.trim().slice(2).split(" ")[0];
    assert.ok(
      touchedPath.startsWith(path.join(home, ".claude/skills")) || touchedPath.startsWith(path.join(home, ".codex/skills")),
      `unexpected touched path outside owned directories: ${touchedPath}`
    );
  }
});

test("uninstall removes only the symlink it owns and leaves a foreign one alone", async () => {
  const home = await tempHome();
  const install = run(home, ["install", "--skip-build", "--skip-cli-link"]);
  assert.equal(install.status, 0, install.stderr);

  // Replace the codex link with a foreign symlink after install, simulating
  // something else having taken over that path.
  const codexTarget = path.join(home, ".codex/skills/ship-app-store");
  await rm(codexTarget);
  const foreignTarget = path.join(home, "elsewhere-2");
  await mkdir(foreignTarget, { recursive: true });
  await symlink(foreignTarget, codexTarget);

  const uninstall = run(home, ["uninstall", "--skip-cli-unlink"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);

  const claudeTarget = path.join(home, ".claude/skills/ship-app-store");
  await assert.rejects(readlink(claudeTarget));
  assert.equal(await readlink(codexTarget), foreignTarget);
});

test("install script status reports installed/not-installed accurately", async () => {
  const home = await tempHome();
  const before = run(home, ["status"]);
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /not installed/);

  run(home, ["install", "--skip-build", "--skip-cli-link"]);
  const after = run(home, ["status"]);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /\(ours\)/);
});
