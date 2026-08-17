import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, cp } from "node:fs/promises";
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
