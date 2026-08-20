import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { analyzeRepository } from "../src/scanner.js";
import { generateReleasePackage } from "../src/generator.js";
import { preflight } from "../src/preflight.js";
import { validateManifest } from "../src/manifest.js";
import type { ShipLayerManifest } from "../src/types.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

test("preflight and generated release package are deterministic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-test-"));
  await cp(path.resolve("fixtures/SwiftSubscriptionApp"), root, { recursive: true });
  const manifest = parse(await readFile(path.resolve("fixtures/subscription-shiplayer.yml"), "utf8")) as ShipLayerManifest;
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.ok(report.summary.block > 0, "fixture intentionally lacks final submission assets");
  manifest.screenshots.finalOutputDir = "release-one/screenshots/final";
  const generated = await generateReleasePackage(root, manifest, await analyzeRepository(root), report, "release-one");
  const first = await readFile(path.join(generated.directory, "review/app-review-notes.md"), "utf8");
  const firstAnalysis = await readFile(path.join(generated.directory, "reports/analysis.json"), "utf8");
  manifest.screenshots.finalOutputDir = "release-two/screenshots/final";
  await generateReleasePackage(root, manifest, await analyzeRepository(root), report, "release-two");
  const second = await readFile(path.join(root, "release-two/review/app-review-notes.md"), "utf8");
  const secondAnalysis = await readFile(path.join(root, "release-two/reports/analysis.json"), "utf8");
  assert.equal(first, second);
  assert.equal(firstAnalysis, secondAnalysis);
  assert.ok(generated.files.includes("privacy/questionnaire-draft.md"));
  assert.ok(first.toLowerCase().includes("subscription"));
  assert.ok((await readFile(path.join(generated.directory, "legal/terms-of-use-draft.md"), "utf8")).includes("Standard Licensed"));
  assert.ok((await readFile(path.join(generated.directory, "remaining-human-actions.md"), "utf8")).includes("Scanner question:"));
});

test("complete free, paid, lifetime, and subscription fixtures pass preflight", async () => {
  for (const type of ["free", "paid-app", "non-consumables", "subscriptions"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-ready-${type}-`)); const manifest = readyManifest(type); await writeReadyAssets(root, manifest);
    const report = await preflight(root, manifest);
    assert.equal(report.summary.block, 0, `${type}: ${report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; ")}`);
  }
});
