import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { preflight } from "../src/preflight.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

test("round-5 rejects reserved nested output and keeps a custom package deterministic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-round5-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeFile(path.join(root, "App.swift"), "import SwiftUI\n");
  const report = await preflight(root, manifest); const firstAnalysis = await analyzeRepository(root);
  await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "safe/.git/evil"), /reserved/);
  await generateReleasePackage(root, manifest, firstAnalysis, report, "safe output");
  const secondAnalysis = await analyzeRepository(root); const secondReport = await preflight(root, manifest);
  await generateReleasePackage(root, manifest, secondAnalysis, secondReport, "safe output");
  const packageReport = await readFile(path.join(root, "safe output/reports/analysis.json"), "utf8");
  assert.ok(!packageReport.includes("filesScanned")); assert.ok(!packageReport.includes("entriesVisited"));
  assert.match(await readFile(path.join(root, "safe output/legal/privacy-policy-draft.html"), "utf8"), /<\/main><\/body><\/html>$/);
  assert.match(await readFile(path.join(root, "safe output/legal/support-page-draft.html"), "utf8"), /<\/main><\/body><\/html>$/);
});

test("round-5 accepts an explicitly confirmed Icon Composer asset without a raster catalog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-icon-composer-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await rm(path.join(root, "Assets.xcassets"), { recursive: true, force: true }); await mkdir(path.join(root, "Assets"), { recursive: true }); await writeFile(path.join(root, "Assets/App.icon"), "Icon Composer fixture");
  manifest.app.productionIconAsset = "Assets/App.icon"; manifest.app.productionIconAssetConfirmation = "confirmed";
  const report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id.startsWith("assets.app-icon") && item.severity === "block").length, 0); assert.ok(report.results.some((item) => item.id === "assets.icon-composer" && item.severity === "pass"));
});

test("round-5 keeps harmless source links and oversized binary assets out of source scan blockers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-walker-round5-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await symlink(path.join(root, "README-target.md"), path.join(root, "README-LINK.md")); await writeFile(path.join(root, "README-target.md"), "readme");
  await writeFile(path.join(root, "large.bin"), Buffer.alloc(1_000_001));
  const report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id === "source.scan-coverage" && item.severity === "block").length, 0);
});
