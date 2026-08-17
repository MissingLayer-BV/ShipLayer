import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("CLI init is safe and analyze JSON is stable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-cli-")); await cp(path.resolve("fixtures/SwiftSubscriptionApp"), root, { recursive: true });
  const command = ["./node_modules/.bin/tsx", "src/index.ts"];
  const init = spawnSync(command[0], [...command.slice(1), "init", root, "--json"], { encoding: "utf8" }); assert.equal(init.status, 0, init.stderr); assert.match(init.stdout, /shiplayer\.yml/);
  const again = spawnSync(command[0], [...command.slice(1), "init", root], { encoding: "utf8" }); assert.equal(again.status, 1); assert.match(again.stderr, /Refusing to overwrite/);
  const scan = spawnSync(command[0], [...command.slice(1), "analyze", root, "--json"], { encoding: "utf8" }); assert.equal(scan.status, 0, scan.stderr); assert.equal(JSON.parse(scan.stdout).schemaVersion, 1);
});
test("CLI init creates an editable draft for a plain Xcode project without XcodeGen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer plain xcode ")); await mkdir(path.join(root, "Plain.xcodeproj")); await writeFile(path.join(root, "Plain.xcodeproj/project.pbxproj"), "PRODUCT_BUNDLE_IDENTIFIER = com.example.plain;\nMARKETING_VERSION = 1.0;\nCURRENT_PROJECT_VERSION = 1;");
  const init = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root], { encoding: "utf8" }); assert.equal(init.status, 0, init.stderr); const manifest = await readFile(path.join(root, "shiplayer.yml"), "utf8"); assert.match(manifest, /bundleId: com\.example\.plain/);
});

test("CLI uses stable JSON errors, force is explicit, and blockers use exit code 2", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer cli guards "));
  await writeFile(path.join(root, "shiplayer.yml"), "not: a-valid-manifest");
  const command = "./node_modules/.bin/tsx";
  const invalid = spawnSync(command, ["src/index.ts", "analyze", root, "--wrong", "--json"], { encoding: "utf8" });
  assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).exitCode, 1);
  const force = spawnSync(command, ["src/index.ts", "init", root, "--force"], { encoding: "utf8" });
  assert.equal(force.status, 0, force.stderr);
  const blocked = spawnSync(command, ["src/index.ts", "check", root, "--json"], { encoding: "utf8" });
  assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).summary.block > 0, true);
});
