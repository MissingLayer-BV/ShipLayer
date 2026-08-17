import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultManifest, validateManifest } from "../src/manifest.js";
import { generateReleasePackage } from "../src/generator.js";
import { safeRelativePath, walkRepository } from "../src/fs.js";
import { preflight as runPreflight } from "../src/preflight.js";
import type { AnalysisReport, PreflightReport } from "../src/types.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";
import { inspectImage } from "../src/image.js";

const analysis = (repository: string): AnalysisReport => ({ schemaVersion: 1, repository, scannedAt: "x", project: { xcodeProjects: [], workspaces: [], projectYml: [] }, findings: [], contradictions: [], unresolvedQuestions: [], ignored: { directories: [], filesOverLimit: 0, filesOverLimitPaths: [], filesScanned: 0, entriesVisited: 0, unreadable: [], symlinksIgnored: [], truncated: false } });
const preflight: PreflightReport = { repository: ".", results: [], summary: { pass: 0, warn: 0, block: 0 }, canPrepare: true, canApply: false, canSubmit: false };
test("safe relative paths reject traversal and absolute paths", () => { assert.throws(() => safeRelativePath("../escape", "test")); assert.throws(() => safeRelativePath("/tmp/escape", "test")); assert.equal(safeRelativePath("release folder/output", "test"), "release folder/output"); });
test("generator refuses outside and unmanaged output", async () => { const root = await mkdtemp(path.join(tmpdir(), "shiplayer spaces ")); const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" }); await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, "../escape")); await mkdir(path.join(root, "unmanaged")); await writeFile(path.join(root, "unmanaged", "keep.txt"), "keep"); await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, "unmanaged"), /refusing to overwrite/); });
test("generator rejects source-control output and init never follows a forced manifest symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-init-link-")); const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" }); await mkdir(path.join(root, ".git"));
  await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, ".git/shiplayer-malicious"), /reserved/);
  const outside = path.join(root, "outside.yml"); await writeFile(outside, "keep-this-target"); await symlink(outside, path.join(root, "shiplayer.yml"));
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--force", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 1); assert.match(run.stdout, /regular file/); assert.equal(await readFile(outside, "utf8"), "keep-this-target");
});
test("generator rejects an output that collides with declared source inputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-output-collision-")); const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" }); manifest.screenshots.marketingProjectPath = "design/editor";
  await assert.rejects(() => generateReleasePackage(root, manifest, analysis(root), preflight, "design"), /collides with a manifest source input/);
});
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
test("manifest rejects direct secret material while allowing ordinary support prose", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" }); manifest.review.notes = "password reset is available from Settings"; validateManifest(manifest);
  manifest.review.notes = "api_key=sk-this-is-a-real-looking-secret"; assert.throws(() => validateManifest(manifest), /credential material/);
  manifest.review.notes = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"; assert.throws(() => validateManifest(manifest), /credential material/);
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
test("image inspection rejects empty PNG streams and empty JPEG scans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-decode-"));
  const fakePng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), png(1320, 2868).subarray(8, 33), Buffer.from([0, 0, 0, 0, 73, 68, 65, 84, 53, 175, 6, 30]), png(1320, 2868).subarray(-12)]);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x0b, 0x34, 0x05, 0x28, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xff, 0xd9]);
  await writeFile(path.join(root, "empty.png"), fakePng); await writeFile(path.join(root, "empty.jpg"), fakeJpeg);
  assert.equal(await inspectImage(path.join(root, "empty.png")), undefined); assert.equal(await inspectImage(path.join(root, "empty.jpg")), undefined);
});
