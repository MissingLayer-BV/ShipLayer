import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeRepository } from "../src/scanner.js";
import { preflight } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { validateManifest } from "../src/manifest.js";
import { readManifest } from "../src/manifest.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

const STOREKIT_PAYWALL_SOURCE = "import StoreKit\nfinal class Paywall {\n  func buy(_ product: Product) async throws {\n    Text(product.displayPrice)\n    try await product.purchase()\n  }\n}\n";

test("monetization contradiction blocks a 'free' declaration that disagrees with StoreKit purchase evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-money-contradiction-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  const report = await preflight(root, manifest);
  const contradiction = report.results.find((item) => item.id === "monetization.source-contradiction");
  assert.ok(contradiction && contradiction.severity === "block");
  assert.ok(contradiction.message.includes("Sources/Paywall.swift"));
  assert.ok(report.results.some((item) => item.id === "purchase.presentation" && item.severity === "block"));
  assert.equal(report.canSubmit, false);
});

test("a genuinely free app with no StoreKit evidence still passes cleanly (no false block)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-money-clean-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "monetization.source-contradiction").length, 0);
  assert.ok(report.results.some((item) => item.id === "monetization" && item.severity === "pass"));
});

test("a confirmed sourceContradictionOverride downgrades the monetization contradiction to a warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-money-override-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  manifest.sourceContradictionOverrides = [{ finding: "monetization.source-contradiction", reason: "This paywall is unreachable demo scaffolding behind a disabled feature flag.", evidence: ["Sources/Paywall.swift"], confirmation: "confirmed" }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "monetization.source-contradiction" && item.severity === "block").length, 0);
  const warned = report.results.find((item) => item.id === "monetization.source-contradiction" && item.severity === "warn");
  assert.ok(warned && warned.message.includes("unreachable demo scaffolding"));
});

test("an unconfirmed override does not suppress the monetization contradiction block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-money-override-unconfirmed-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  manifest.sourceContradictionOverrides = [{ finding: "monetization.source-contradiction", reason: "pending legal review", evidence: ["Sources/Paywall.swift"], confirmation: "needs-human-confirmation" }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "monetization.source-contradiction" && item.severity === "block"));
});

test("sourceContradictionOverride cannot be expressed as an empty/default value", () => {
  const manifest = readyManifest();
  manifest.sourceContradictionOverrides = [{ finding: "monetization.source-contradiction", reason: "", evidence: [], confirmation: "confirmed" }];
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
});

test("AI data-sharing contradiction blocks when source calls a third-party AI/inference endpoint but aiDataSharing.enabled is false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-contradiction-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "worker/src"), { recursive: true });
  await writeFile(path.join(root, "worker/src/index.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')");
  const report = await preflight(root, manifest);
  const contradiction = report.results.find((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block");
  assert.ok(contradiction);
  assert.ok(contradiction.message.includes("openrouter.ai/api/v1/chat/completions"));
  assert.ok(contradiction.message.includes("worker/src/index.ts"));
  assert.equal(report.canSubmit, false);
});

test("a bare AI-provider privacy-policy link only warns, and never blocks, without an AI disclosure (no false block)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-weak-link-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://openrouter.ai/privacy')");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.possible-processor-link" && item.severity === "warn"));
});

test("an app with no AI signal at all still passes the AI-sharing declaration check cleanly (no false block)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-clean-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction").length, 0);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.possible-processor-link").length, 0);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "pass"));
});

test("a confirmed sourceContradictionOverride downgrades the AI contradiction to a warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-override-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')");
  manifest.sourceContradictionOverrides = [{ finding: "ai-sharing.source-contradiction:endpoint:https://openrouter.ai/api/v1/chat/completions", reason: "This call only fires in a developer-only debug menu never shipped to users.", evidence: ["worker.ts"], confirmation: "confirmed" }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "warn"));
});

test("generated review notes and StoreKit checklist name unresolved evidence instead of a false negative claim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-generator-honesty-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  await mkdir(path.join(root, "worker/src"), { recursive: true });
  await writeFile(path.join(root, "worker/src/index.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')");
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  manifest.screenshots.finalOutputDir = "release-honesty/screenshots/final";
  const generated = await generateReleasePackage(root, manifest, analysis, report, "release-honesty");
  const notes = await readFile(path.join(generated.directory, "review/app-review-notes.md"), "utf8");
  assert.equal(notes.includes("No In-App Purchases or subscriptions are offered."), false);
  assert.equal(notes.includes("No confirmed external processors are listed. Confirm this is accurate before submission."), false);
  assert.ok(notes.includes("UNVERIFIED"));
  assert.ok(notes.includes("Sources/Paywall.swift"));
  assert.ok(notes.includes("openrouter.ai"));
  const checklist = await readFile(path.join(generated.directory, "storekit/checklist.md"), "utf8");
  assert.ok(checklist.includes("UNVERIFIED"));
  assert.ok(checklist.includes("Sources/Paywall.swift"));
});

test("a clean free/no-processor app still gets the ordinary confident text (no spurious UNVERIFIED)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-generator-clean-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  manifest.screenshots.finalOutputDir = "release-clean/screenshots/final";
  const generated = await generateReleasePackage(root, manifest, analysis, report, "release-clean");
  const notes = await readFile(path.join(generated.directory, "review/app-review-notes.md"), "utf8");
  assert.ok(notes.includes("No In-App Purchases or subscriptions are offered."));
  assert.ok(notes.includes("No confirmed external processors are listed. Confirm this is accurate before submission."));
  assert.equal(notes.includes("UNVERIFIED"), false);
});

test("test-only source exclusions stay in the analysis report but are not surfaced as a preflight warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-test-noise-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "ExampleTests"), { recursive: true });
  await writeFile(path.join(root, "ExampleTests/Fixture.swift"), "// test fixture");
  const analysis = await analyzeRepository(root);
  assert.ok(analysis.unresolvedQuestions.some((question) => question.startsWith("Excluded conventional test-only source")));
  const report = await preflight(root, manifest, false, analysis);
  assert.equal(report.results.filter((item) => item.severity === "warn" && item.message.includes("Excluded conventional test-only source")).length, 0);
});

test("remaining-human-actions.md lists each scanner question once, not twice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-dedup-actions-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  manifest.screenshots.finalOutputDir = "release-dedup/screenshots/final";
  const generated = await generateReleasePackage(root, manifest, analysis, report, "release-dedup");
  const actions = await readFile(path.join(generated.directory, "remaining-human-actions.md"), "utf8");
  const occurrences = actions.split("Confirm App Privacy questionnaire answers and all third-party processor data handling").length - 1;
  assert.equal(occurrences, 1);
});

test("init carries detected endpoints, StoreKit evidence, and signing configuration forward as proposals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-init-carryforward-"));
  await writeFile(path.join(root, "project.yml"), "name: Example\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.app\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    CODE_SIGN_STYLE: Manual\n");
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://api.example.test/v1/receipts')");
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const manifest = await readManifest(root);

  // Signing: carried forward as a detected fact, not a fabricated confirmation.
  assert.equal(manifest.build.signing, "manual");

  // External endpoints: proposals only, never a confirmed disposition.
  const proposal = manifest.externalProcessors.find((item) => item.name === "api.example.test");
  assert.ok(proposal);
  assert.equal(proposal?.confirmation, "needs-human-confirmation");
  assert.equal(proposal?.protectionConfirmation, "needs-human-confirmation");
  assert.deepEqual(proposal?.notCollectionAttestation, {
    dataNotRetainedBeyondRealTimeService: "needs-human-confirmation",
    basis: "needs-human-confirmation",
    evidence: { kind: "processor-privacy-policy" },
    confirmation: "needs-human-confirmation"
  });
  assert.ok(proposal?.evidence?.includes("worker.ts"));

  // Monetization stays "free" (the schema cannot represent "maybe has IAP"), but the contradiction
  // is called out loudly as an unresolved question so a human cannot miss it.
  assert.equal(manifest.monetization.type, "free");
  const output = JSON.parse(run.stdout) as { unresolvedQuestions: string[] };
  assert.ok(output.unresolvedQuestions.some((question) => question.includes("StoreKit purchase evidence") && question.includes("Sources/Paywall.swift")));
  assert.ok(output.unresolvedQuestions.some((question) => question.includes("notCollectionAttestation.basis") && question.includes("data is not retained beyond servicing the request in real time")));

  // And critically: `check` immediately blocks on this contradiction rather than passing quietly.
  const checkRun = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "check", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(checkRun.status, 2);
  const checkReport = JSON.parse(checkRun.stdout) as { results: Array<{ id: string; severity: string }> };
  assert.ok(checkReport.results.some((item) => item.id === "monetization.source-contradiction" && item.severity === "block"));
});

test("init on a genuinely free/no-processor app produces a manifest with no proposals to confirm", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-init-clean-"));
  await writeFile(path.join(root, "project.yml"), "name: Example\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.app\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n");
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const manifest = await readManifest(root);
  assert.equal(manifest.externalProcessors.length, 0);
  assert.equal(manifest.monetization.type, "free");
});
