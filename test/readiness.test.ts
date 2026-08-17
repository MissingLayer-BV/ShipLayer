import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateReleasePackage } from "../src/generator.js";
import { defaultManifest, validateManifest, writeManifest } from "../src/manifest.js";
import { preflight } from "../src/preflight.js";
import { analyzeRepository, findValue } from "../src/scanner.js";
import type { AnalysisReport, PreflightReport } from "../src/types.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

const emptyAnalysis = (repository: string): AnalysisReport => ({ schemaVersion: 1, repository, scannedAt: "x", project: { xcodeProjects: [], workspaces: [], projectYml: [] }, findings: [], contradictions: [], unresolvedQuestions: [], ignored: { directories: [], filesOverLimit: 0, filesScanned: 0, entriesVisited: 0, unreadable: [], symlinksIgnored: [], truncated: false } });
const emptyPreflight: PreflightReport = { repository: ".", results: [], summary: { pass: 0, warn: 0, block: 0 }, canPrepare: true, canApply: false, canSubmit: false };

test("scanner evidence cannot be silently omitted from a ready manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-evidence-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Info.plist"), "<key>NSCameraUsageDescription</key><string>Capture proof</string>"); await writeFile(path.join(root, "App.swift"), "import Firebase\nlet endpoint = \"https://api.openai.com/v1/models\"");
  let report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("source.permission.NSCameraUsageDescription") && item.severity === "block")); assert.ok(report.results.some((item) => item.id.startsWith("source.external.") && item.severity === "block"));
  manifest.permissions = [{ key: "NSCameraUsageDescription", purpose: "Capture proof", confirmation: "confirmed", evidence: ["Info.plist"] }];
  manifest.externalServiceDecisions = [{ finding: "thirdPartySdkCandidate:Firebase:Firebase", disposition: "not-an-external-processor", reason: "Fixture decision only.", evidence: ["App.swift"], confirmation: "confirmed" }, { finding: "endpoint:https://api.openai.com/v1/models", disposition: "not-an-external-processor", reason: "Fixture decision only.", evidence: ["App.swift"], confirmation: "confirmed" }];
  report = await preflight(root, manifest); assert.equal(report.summary.block, 0, report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; "));
  manifest.permissions[0].purpose = "Different purpose"; manifest.externalServiceDecisions[0].evidence = ["made-up.swift"];
  report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("purpose") && item.severity === "block")); assert.ok(report.results.some((item) => item.id.includes("external-decision") && item.severity === "block"));
});

test("family-specific dimensions, mandatory paid agreements, and remote references block readiness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-family-")); const manifest = readyManifest("paid-app"); await writeReadyAssets(root, manifest);
  manifest.screenshots.configurations[0].requiredDimensions = { width: 2064, height: 2752 }; await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), png(2064, 2752));
  let report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("accepted-dimensions") && item.severity === "block"));
  manifest.screenshots.configurations[0].requiredDimensions = { width: 1290, height: 2796 }; await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), png(1290, 2796)); manifest.confirmations.paidAgreements = "not-applicable";
  report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id === "confirmation.paidAgreements" && item.severity === "block"));
  manifest.confirmations.paidAgreements = "confirmed"; manifest.confirmations.ageRating = "not-applicable";
  report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id === "confirmation.ageRating" && item.severity === "block"));
  manifest.confirmations.ageRating = "confirmed"; manifest.sync = { mode: "dry-run" }; report = await preflight(root, manifest, true); assert.ok(report.results.some((item) => item.id === "asc.credentials" && item.severity === "block"));
});

test("nested managed output works without escaping the repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer nested ")); const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  const first = await generateReleasePackage(root, manifest, emptyAnalysis(root), emptyPreflight, "nested folder/output package");
  const second = await generateReleasePackage(root, manifest, emptyAnalysis(root), emptyPreflight, "nested folder/output package");
  assert.equal(first.directory, second.directory);
});

test("unsupported apply and submit execution return exit code 3", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-unsupported-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const command = "./node_modules/.bin/tsx";
  const apply = spawnSync(command, ["src/index.ts", "apply", root, "--apply", "--yes-i-understand", "--json"], { encoding: "utf8" }); assert.equal(apply.status, 3); assert.equal(JSON.parse(apply.stdout).unsupported, true);
  const submit = spawnSync(command, ["src/index.ts", "submit", root, "--submit", "--yes-submit", "--json"], { encoding: "utf8" }); assert.equal(submit.status, 3); assert.equal(JSON.parse(submit.stdout).unsupported, true);
});

test("extensions become manual secondary evidence rather than a production contradiction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-widget-")); await mkdir(path.join(root, "App.xcodeproj")); await writeFile(path.join(root, "App.xcodeproj/project.pbxproj"), "PRODUCT_BUNDLE_IDENTIFIER = com.example.app;\nPRODUCT_BUNDLE_IDENTIFIER = com.example.app.widget;");
  const report = await analyzeRepository(root); assert.equal(findValue(report, "bundleId"), "com.example.app"); assert.equal(report.contradictions.length, 0); assert.ok(report.findings.some((item) => item.key === "secondaryBundleId"));
});

test("product limits, product-ID characters, and offer matrix are enforced", () => {
  const manifest = readyManifest("subscriptions"); const product = manifest.monetization.type === "subscriptions" ? manifest.monetization.products[0] : undefined; assert.ok(product);
  product.productId = "pro_unlock_2026"; product.introductoryOffer = { type: "pay-up-front", duration: "P3D", pricePointReference: "P1" }; assert.throws(() => validateManifest(manifest), /pay-up-front/);
  product.introductoryOffer = { type: "pay-as-you-go", duration: "P1M", pricePointReference: "P1", numberOfPeriods: 13 }; assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
  product.introductoryOffer = { type: "pay-as-you-go", duration: "P1M", pricePointReference: "P1", numberOfPeriods: 12 }; validateManifest(manifest);
  product.localizations["en-US"].displayName = "x".repeat(31); assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
  product.localizations["en-US"].displayName = "Example Pro"; product.referenceName = "x".repeat(65); assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
  product.referenceName = "Example Pro Monthly"; product.localizations["en-US"].description = "x".repeat(46); assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
  product.localizations["en-US"].description = "Monthly access."; product.reviewNotes = "x".repeat(4001); assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
  product.reviewNotes = "Tap Upgrade."; (manifest.monetization as unknown as { group: { localizations: Record<string, unknown> } }).group.localizations.invalid = { displayName: "Invalid locale" }; assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
});

test("review assets accept supported iPhone capture sizes but never cross family", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-review-family-")); const manifest = readyManifest("non-consumables"); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "review/unlock.png"), png(1179, 2556)); let report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.includes("purchase.com.example.unlock") && item.severity === "block").length, 0);
  await writeFile(path.join(root, "review/unlock.png"), png(2064, 2752)); report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id.includes("purchase.com.example.unlock.asset-dimensions") && item.severity === "block"));
});

test("privacy/legal, App Store record, and scanner omissions cannot silently green-light submit readiness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-submit-gates-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  manifest.confirmations.privacy = "not-applicable"; manifest.confirmations.legal = "not-applicable"; manifest.app.appStoreAppId = undefined;
  await writeFile(path.join(root, "oversized.swift"), "x".repeat(1_000_001));
  const report = await preflight(root, manifest);
  assert.equal(report.canSubmit, false); assert.ok(report.results.some((item) => item.id === "confirmation.privacy" && item.severity === "block")); assert.ok(report.results.some((item) => item.id === "app.store-id" && item.severity === "block")); assert.ok(report.results.some((item) => item.id === "source.scan-coverage" && item.severity === "block"));
});

test("assembled App Review notes remain within Apple's pasteable limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-review-notes-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  manifest.review.recordingScenarios = Array.from({ length: 20 }, (_, index) => ({ id: `scenario-${index}`, title: "Review flow", steps: Array.from({ length: 20 }, () => "x".repeat(400)) }));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "review.notes.length" && item.severity === "block"));
});
