import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultManifest, validateManifest } from "../src/manifest.js";
import { generateReleasePackage } from "../src/generator.js";
import { safeRelativePath, walkRepository } from "../src/fs.js";
import { preflight as runPreflight } from "../src/preflight.js";
import type { AnalysisReport, PreflightReport } from "../src/types.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

const analysis = (repository: string): AnalysisReport => ({ schemaVersion: 1, repository, scannedAt: "x", project: { xcodeProjects: [], workspaces: [], projectYml: [] }, findings: [], contradictions: [], unresolvedQuestions: [], ignored: { directories: [], filesOverLimit: 0, filesScanned: 0, unreadable: [], symlinksIgnored: [], truncated: false } });
const preflight: PreflightReport = { repository: ".", results: [], summary: { pass: 0, warn: 0, block: 0 }, canPrepare: true, canApply: false, canSubmit: false };
test("safe relative paths reject traversal and absolute paths", () => { assert.throws(() => safeRelativePath("../escape", "test")); assert.throws(() => safeRelativePath("/tmp/escape", "test")); assert.equal(safeRelativePath("release folder/output", "test"), "release folder/output"); });
test("generator refuses outside and unmanaged output", async () => { const root = await mkdtemp(path.join(tmpdir(), "shiplayer spaces ")); const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" }); await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, "../escape")); await mkdir(path.join(root, "unmanaged")); await writeFile(path.join(root, "unmanaged", "keep.txt"), "keep"); await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, "unmanaged"), /refusing to overwrite/); });
test("managed regeneration removes only marked package contents and rejects symlink output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer managed "));
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  await generateReleasePackage(root, manifest, analysis(root), preflight, "safe-output");
  await writeFile(path.join(root, "safe-output/stale.txt"), "stale");
  await generateReleasePackage(root, manifest, analysis(root), preflight, "safe-output");
  await assert.rejects(() => access(path.join(root, "safe-output/stale.txt")));
  await symlink(path.join(root, "safe-output"), path.join(root, "linked-output"));
  await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, "linked-output"), /symlink/);
});
test("failed staging preserves the previous managed package atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer atomic "));
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  await generateReleasePackage(root, manifest, analysis(root), preflight, "safe-output");
  const before = await readFile(path.join(root, "safe-output/manifest.normalized.yml"), "utf8");
  await rm(path.join(root, ".shiplayer-staging"), { recursive: true, force: true });
  await symlink(path.join(root, "safe-output"), path.join(root, ".shiplayer-staging"));
  await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, "safe-output"), /staging directory.*symlink/);
  assert.equal(await readFile(path.join(root, "safe-output/manifest.normalized.yml"), "utf8"), before);
});
test("schema rejects traversal locale and malformed manifests without runtime crashes", () => { const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" }); manifest.metadata.localizations = { "../../escape": {} }; assert.throws(() => validateManifest(manifest), /Invalid shiplayer/); assert.throws(() => validateManifest({ schemaVersion: 1 }), /Invalid shiplayer/); });
test("manifest rejects unsafe raw, marketing, and IAP asset paths before generation", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  manifest.screenshots.rawOutputDir = "../screenshots";
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
  manifest.screenshots.rawOutputDir = "screenshots";
  manifest.screenshots.marketingProjectPath = "/tmp/marketing";
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
});
test("walker is deterministic and ignores symlinks", async () => { const root = await mkdtemp(path.join(tmpdir(), "shiplayer-walk-")); await writeFile(path.join(root, "z.swift"), "z"); await writeFile(path.join(root, "a.swift"), "a"); await symlink(path.join(root, "a.swift"), path.join(root, "linked.swift")); const first = await walkRepository(root); const second = await walkRepository(root); assert.deepEqual(first.files, second.files); assert.equal(first.symlinksIgnored.length, 1); });
test("preflight turns tiny or unreadable image input into blockers instead of crashing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-image-"));
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app", version: "1", build: "1" });
  manifest.app.primaryCategory = "Productivity";
  manifest.contacts = { supportUrl: "https://example.com/support", privacyUrl: "https://example.com/privacy", copyright: "2026 Example" };
  manifest.review = { contact: { firstName: "A", lastName: "B", email: "a@example.com", phone: "+12025550123" }, recordingScenarios: [{ id: "home", title: "Home", steps: ["Launch"] }] };
  manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"] }];
  manifest.screenshots.configurations = [{ device: "iPhone 16 Pro Max", family: "iphone", locale: "en-US", requiredDimensions: { width: 1320, height: 2868 } }];
  manifest.build.exportCompliance = "exempt";
  manifest.confirmations = { privacy: "confirmed", legal: "confirmed", trader: "confirmed", paidAgreements: "confirmed", ageRating: "confirmed", contentRights: "confirmed" };
  manifest.metadata.localizations["en-US"] = { name: "Example", description: "Description", keywords: ["example"] };
  await mkdir(path.join(root, "release/raw-screenshots/iphone/en-US"), { recursive: true });
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/tiny.png"), "not a png");
  const report = await runPreflight(root, manifest);
  assert.ok(report.results.some((item) => item.id.includes("tiny.png") && item.severity === "block"));
});
test("preflight rejects structural image fakes, alpha icons, and accepts valid landscape screenshots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-real-image-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  let report = await runPreflight(root, manifest); assert.equal(report.summary.block, 0);
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(18)]));
  report = await runPreflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("home.png") && item.severity === "block"));
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), png(2868, 1320)); report = await runPreflight(root, manifest); assert.equal(report.summary.block, 0);
  await writeFile(path.join(root, "Assets.xcassets/AppIcon.appiconset/icon.png"), png(1024, 1024, true)); report = await runPreflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("app-icon") && item.severity === "block"));
});
test("purchase review assets must be full valid App Store screenshots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-review-image-")); const manifest = readyManifest("non-consumables"); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "review/unlock.png"), png(1, 1));
  const report = await runPreflight(root, manifest);
  assert.ok(report.results.some((item) => item.id.includes("purchase.com.example.unlock.asset-dimensions") && item.severity === "block"));
});
