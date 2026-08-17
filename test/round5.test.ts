import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { preflight } from "../src/preflight.js";
import { writeManifest } from "../src/manifest.js";
import { readManifest } from "../src/manifest.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

test("round-5 rejects reserved nested output and keeps a custom package deterministic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-round5-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeFile(path.join(root, "App.swift"), "import SwiftUI\n");
  const report = await preflight(root, manifest); const firstAnalysis = await analyzeRepository(root);
  await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "safe/.git/evil"), /reserved/); await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "safe/.GIT/evil"), /reserved/); await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "Shiplayer-Release"), /reserved/);
  await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "RELEASE"), /reserved|collides/);
  await generateReleasePackage(root, manifest, firstAnalysis, report, "safe output");
  const secondAnalysis = await analyzeRepository(root); const secondReport = await preflight(root, manifest);
  await generateReleasePackage(root, manifest, secondAnalysis, secondReport, "safe output");
  const packageReport = await readFile(path.join(root, "safe output/reports/analysis.json"), "utf8");
  assert.ok(!packageReport.includes("filesScanned")); assert.ok(!packageReport.includes("entriesVisited"));
  assert.match(await readFile(path.join(root, "safe output/legal/privacy-policy-draft.html"), "utf8"), /<\/main><\/body><\/html>$/);
  assert.match(await readFile(path.join(root, "safe output/legal/support-page-draft.html"), "utf8"), /<\/main><\/body><\/html>$/);
});

test("round-6 default CLI prepare allows canonical output but rejects case-aliased source control", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-default-output-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "prepare", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.ok(run.stdout.includes("shiplayer-release")); assert.ok(await readFile(path.join(root, "shiplayer-release/.shiplayer-managed"), "utf8"));
});

test("round-5 accepts an explicitly confirmed Icon Composer asset without a raster catalog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-icon-composer-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await rm(path.join(root, "Assets.xcassets"), { recursive: true, force: true }); await mkdir(path.join(root, "Assets/App.icon/artwork"), { recursive: true }); await writeFile(path.join(root, "Assets/App.icon/icon.json"), "{\"version\":1}"); await writeFile(path.join(root, "Assets/App.icon/artwork/icon.png"), "Icon Composer fixture");
  manifest.app.productionIconAsset = "Assets/App.icon"; manifest.app.productionIconAssetConfirmation = "confirmed";
  const report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id.startsWith("assets.app-icon") && item.severity === "block").length, 0); assert.ok(report.results.some((item) => item.id === "assets.icon-composer" && item.severity === "pass"));
});

test("round-5 keeps harmless source links and oversized binary assets out of source scan blockers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-walker-round5-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await symlink(path.join(root, "README-target.md"), path.join(root, "README-LINK.md")); await writeFile(path.join(root, "README-target.md"), "readme");
  await writeFile(path.join(root, "large.bin"), Buffer.alloc(1_000_001));
  const report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id === "source.scan-coverage" && item.severity === "block").length, 0);
});

test("round-6 accepts valid landscape iPhone and iPad App Review screenshots", async () => {
  const phoneRoot = await mkdtemp(path.join(tmpdir(), "shiplayer-landscape-phone-")); const phone = readyManifest("non-consumables"); await writeReadyAssets(phoneRoot, phone); await writeFile(path.join(phoneRoot, "review/unlock.png"), png(2868, 1320));
  let report = await preflight(phoneRoot, phone); assert.ok(report.results.some((item) => item.id === "purchase.com.example.unlock.asset" && item.severity === "pass"));
  const padRoot = await mkdtemp(path.join(tmpdir(), "shiplayer-landscape-pad-")); const pad = readyManifest("non-consumables"); pad.app.deviceFamilies = ["ipad"]; pad.screenshots.configurations = [{ device: "iPad", family: "ipad", locale: "en-US", requiredDimensions: { width: 2064, height: 2752 } }]; await writeReadyAssets(padRoot, pad); await mkdir(path.join(padRoot, "release/raw-screenshots/ipad/en-US"), { recursive: true }); await writeFile(path.join(padRoot, "release/raw-screenshots/ipad/en-US/home.png"), png(2064, 2752)); await writeFile(path.join(padRoot, "review/unlock.png"), png(2752, 2064));
  report = await preflight(padRoot, pad); assert.ok(report.results.some((item) => item.id === "purchase.com.example.unlock.asset" && item.severity === "pass"));
});

test("round-6 blocks unparsed privacy manifests and encryption/copyright contradictions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-privacy-round6-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "PrivacyInfo.xcprivacy"), "<dict><key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeMystery</string></dict>"); await writeFile(path.join(root, "Info.plist"), "<key>ITSAppUsesNonExemptEncryption</key><true/>"); manifest.contacts.copyright = "x";
  const report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id === "privacy.manifest.unparsed" && item.severity === "block")); assert.ok(report.results.some((item) => item.id === "consistency.encryption" && item.severity === "block")); assert.ok(report.results.some((item) => item.id === "contacts.copyright.format" && item.severity === "block"));
});

test("round-6 accepts an Xcode universal iOS icon slot and scans Worker endpoints but ignores generated web output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-worker-round6-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Assets.xcassets/AppIcon.appiconset/Contents.json"), JSON.stringify({ images: [{ filename: "icon.png", idiom: "universal", platform: "ios", size: "1024x1024" }] })); await mkdir(path.join(root, "worker"), { recursive: true }); await writeFile(path.join(root, "worker/index.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')"); await mkdir(path.join(root, "design/.next/cache"), { recursive: true }); await writeFile(path.join(root, "design/.next/cache/chunk.js"), "fetch('https://ignore.example')");
  const report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("openrouter.ai") && item.severity === "block")); assert.equal(report.results.filter((item) => item.id.includes("ignore.example")).length, 0); assert.equal(report.results.filter((item) => item.id.startsWith("assets.app-icon") && item.severity === "block").length, 0);
});

test("round-7 treats first-party runtime JS/TS as coverage but ignores generated screenshot/editor tooling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-scope-round7-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), Buffer.alloc(1_000_001)); await symlink(path.join(root, "worker.ts"), path.join(root, "linked-worker.ts"));
  let report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id === "source.scan-coverage" && item.severity === "block"));
  await rm(path.join(root, "worker.ts")); await rm(path.join(root, "linked-worker.ts")); await mkdir(path.join(root, "worker/src"), { recursive: true }); await writeFile(path.join(root, "worker/src/index.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')"); await writeFile(path.join(root, "worker/src/pages.ts"), "const copy = 'StoreKit Photos Sentry';"); await mkdir(path.join(root, "worker/.wrangler-dry-run"), { recursive: true }); await writeFile(path.join(root, "worker/.wrangler-dry-run/index.js"), "fetch('https://generated.example')"); await mkdir(path.join(root, "design/app-store-screenshots"), { recursive: true }); await writeFile(path.join(root, "design/app-store-screenshots/next-env.d.ts"), "type X = 'https://nextjs.org/docs'");
  const analysis = await analyzeRepository(root); const endpointValues = analysis.findings.filter((item) => item.key.startsWith("endpoint:")).flatMap((item) => Array.isArray(item.value) ? item.value : [item.value]); assert.ok(endpointValues.some((value) => String(value).includes("openrouter.ai"))); assert.ok(!endpointValues.some((value) => String(value).includes("generated.example") || String(value).includes("nextjs.org"))); assert.equal(analysis.findings.filter((item) => item.key === "framework:StoreKit" || item.key === "thirdPartySdkCandidate:Sentry").length, 0);
});

test("round-7 requires a separate evidence-backed disposition for every endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-endpoints-round7-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeFile(path.join(root, "worker.ts"), "fetch('https://api.example.test/one'); fetch('https://links.example.test/privacy')");
  manifest.externalServiceDecisions = [{ finding: "endpoint:https://api.example.test/one", disposition: "not-an-external-processor", reason: "Public fixture endpoint.", evidence: ["worker.ts"], confirmation: "confirmed" }];
  let report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("links.example.test") && item.severity === "block"));
  manifest.externalServiceDecisions.push({ finding: "endpoint:https://links.example.test/privacy", disposition: "not-an-external-processor", reason: "Public privacy link.", evidence: ["worker.ts"], confirmation: "confirmed" }); report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id.startsWith("source.external.") && item.severity === "block").length, 0);
});

test("round-7 init maps TARGETED_DEVICE_FAMILY tokens without inventing iPhone support", async () => {
  for (const [value, expected] of [["1", ["iphone"]], ["2", ["ipad"]], ["1,2", ["iphone", "ipad"]]] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-init-family-")); await writeFile(path.join(root, "project.yml"), `name: Family\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.family\n    TARGETED_DEVICE_FAMILY: ${value}\n`);
    const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); const manifest = await readManifest(root); assert.deepEqual(manifest.app.deviceFamilies, expected); assert.deepEqual(manifest.screenshots.configurations.map((item) => item.family), expected);
  }
});

test("round-7 detects runtime sidecar extensions and insecure HTTP endpoints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-runtime-round7-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeFile(path.join(root, "sidecar.mts"), "fetch('HTTP://api.example.test/v1')"); const report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("insecure-endpoint") && item.severity === "block"));
});
