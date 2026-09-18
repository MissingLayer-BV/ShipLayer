// Regression tests for the third-round independent review: round 2 swung from under-blocking
// into over-blocking with no escape hatch (init writing an unoverridable kind:"ai" for policy
// links/fixtures; the AI classifier over-matching real provider privacy-policy/model-card URLs;
// init crashing on single-label hosts; and the pbxproj endpoint scan missing quoted values).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeRepository } from "../src/scanner.js";
import { preflight } from "../src/preflight.js";
import { classifyAiEndpoint } from "../src/evidence.js";
import { readManifest } from "../src/manifest.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

// --- Critical 1: init must never write an unoverridable kind:"ai" for a policy link or fixture --

test("Critical 1: a bare AI-provider policy link produces only a warning through the documented init -> check flow, never a hard block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3c1-policy-"));
  await writeFile(path.join(root, "project.yml"), "name: PolicyLinkApp\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.policylink\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    ITSAppUsesNonExemptEncryption: false\n");
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/App.swift"), "import SwiftUI\nstruct PolicyView: View {\n  var body: some View {\n    Link(\"AI vendor policy\", destination: URL(string: \"https://openrouter.ai/privacy\")!)\n  }\n}\n");
  const initRun = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(initRun.status, 0, initRun.stderr);
  const manifest = await readManifest(root);
  // The proposal must not force AI-pipeline membership for a mere policy link.
  const proposal = manifest.externalProcessors.find((item) => item.name === "openrouter.ai");
  if (proposal) assert.equal(proposal.kind, "network");
  const checkRun = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "check", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  const report = JSON.parse(checkRun.stdout) as { results: Array<{ id: string; severity: string }> };
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.declaration" && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "pass"));
});

test("Critical 1: an endpoint that only exists under Examples/ never becomes an ai-sharing.declaration block via init", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3c1-fixture-"));
  await writeFile(path.join(root, "project.yml"), "name: ExamplesApp\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.examples\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    ITSAppUsesNonExemptEncryption: false\n");
  await mkdir(path.join(root, "Examples"), { recursive: true });
  await writeFile(path.join(root, "Examples/AIDemo.swift"), "let endpoint = \"https://api.openai.com/v1/chat/completions\"\n");
  const initRun = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(initRun.status, 0, initRun.stderr);
  const manifest = await readManifest(root);
  assert.equal(manifest.externalProcessors.length, 0);
  const checkRun = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "check", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  const report = JSON.parse(checkRun.stdout) as { results: Array<{ id: string; severity: string }> };
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "pass"));
});

test("Critical 1: a real AI-provider API endpoint still proposes kind:\"ai\" and still requires a disclosure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3c1-real-"));
  await writeFile(path.join(root, "project.yml"), "name: RealAIApp\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.realai\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    ITSAppUsesNonExemptEncryption: false\n");
  await mkdir(path.join(root, "worker"), { recursive: true });
  await writeFile(path.join(root, "worker/index.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')\n");
  const initRun = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(initRun.status, 0, initRun.stderr);
  const manifest = await readManifest(root);
  const proposal = manifest.externalProcessors.find((item) => item.name === "openrouter.ai");
  assert.ok(proposal);
  assert.equal(proposal?.kind, "ai");
  const checkRun = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "check", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  const report = JSON.parse(checkRun.stdout) as { results: Array<{ id: string; severity: string }> };
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "block"));
});

test("Critical 1: an unrecognized-host ambiguous-endpoint proposal is overridable end to end (H4's override gap is closed)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3c1-ambiguous-override-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://api.myteamchat.example.com/v1/messages')");
  // init would propose kind: "network" for this (path-shape, not provider) — confirm that
  // directly via preflight with a confirmed intersecting override; nothing should remain blocked
  // by an unrelated, unresolvable ai-sharing.declaration check.
  manifest.sourceContradictionOverrides = [{ finding: "ai-sharing.source-contradiction:endpoint:https://api.myteamchat.example.com/v1/messages", reason: "Our own team-chat backend, not an AI provider.", evidence: ["worker.ts"], confirmation: "confirmed" }];
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.severity === "block" && item.id.startsWith("ai-sharing")).length, 0);
});

// --- Critical 2: the classifier must not hard-block real provider privacy-policy/model-card URLs --

test("Critical 2: known-provider privacy-policy, legal, and model-card URLs classify as policy (warn), not provider (block)", () => {
  const urls = [
    "https://openai.com/policies/privacy-policy",
    "https://www.anthropic.com/legal/privacy",
    "https://x.ai/legal/terms-of-service",
    "https://huggingface.co/meta-llama/Llama-3-8B",
    "https://openai.com/index/hello-gpt-4o",
  ];
  for (const url of urls) assert.equal(classifyAiEndpoint(url), "policy", `expected policy for ${url}`);
});

test("Critical 2: real provider API paths (beyond /chat/completions) still classify as provider (block)", () => {
  const urls = [
    "https://api.openai.com/v1/responses",
    "https://api.openai.com/v1/images/generations",
    "https://api.openai.com/v1/audio/transcriptions",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
    "https://openrouter.ai/api/v1/chat/completions",
  ];
  for (const url of urls) assert.equal(classifyAiEndpoint(url), "provider", `expected provider for ${url}`);
});

test("Critical 2: openrouter.ai/privacy remains policy-only (round-1 baseline preserved)", () => {
  assert.equal(classifyAiEndpoint("https://openrouter.ai/privacy"), "policy");
});

test("Critical 2: an app whose only network strings are real provider privacy-policy links passes cleanly end to end", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3c2-e2e-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://openai.com/policies/privacy-policy'); fetch('https://www.anthropic.com/legal/privacy')");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block").length, 0);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction-ambiguous-endpoint" && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.possible-processor-link" && item.severity === "warn"));
});

test("Critical 2: an unrecognized-host AI-shaped path (proxy case) still blocks", () => {
  assert.equal(classifyAiEndpoint("https://api.myteamchat.example.com/v1/messages"), "path-shape");
});

// --- High 3: init must never crash on a single-label host --------------------------------------

test("High 3: init does not crash and writes a valid manifest for a single-label (localhost) endpoint host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3h3-localhost-"));
  await writeFile(path.join(root, "project.yml"), "name: LocalhostApp\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.localhost\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    ITSAppUsesNonExemptEncryption: false\n");
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/App.swift"), "#if DEBUG\nlet debugEndpoint = \"http://localhost:8080/health\"\n#endif\n");
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const manifest = await readManifest(root);
  const proposal = manifest.externalProcessors.find((item) => item.name === "localhost");
  assert.ok(proposal);
  assert.equal(proposal?.privacyPolicyUrl, "https://unconfirmed.invalid/localhost");
});

// --- Medium 4: the pbxproj/xcconfig endpoint scan must accept quoted build-setting values --------

test("Medium 4: a quoted https URL assigned to an arbitrary pbxproj build setting is detected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3m4-quoted-"));
  await mkdir(path.join(root, "App.xcodeproj"), { recursive: true });
  await writeFile(path.join(root, "App.xcodeproj/project.pbxproj"), 'BARE_API_URL = https://bare.example.com/v1/inference;\nQUOTED_API_URL = "https://quoted.example.com/v1/chat/completions";\n');
  const analysis = await analyzeRepository(root);
  const endpointKeys = analysis.findings.filter((finding) => finding.key.startsWith("endpoint:")).map((finding) => finding.key);
  assert.ok(endpointKeys.includes("endpoint:https://bare.example.com/v1/inference"));
  assert.ok(endpointKeys.includes("endpoint:https://quoted.example.com/v1/chat/completions"));
});

test("Medium 4: a quoted https URL in an xcconfig setting is detected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r3m4-xcconfig-"));
  await writeFile(path.join(root, "Secrets.xcconfig"), 'API_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"\n');
  const analysis = await analyzeRepository(root);
  assert.ok(analysis.findings.some((finding) => finding.key === "endpoint:https://openrouter.ai/api/v1/chat/completions"));
});

// --- Round 4: Finding A — "api-docs"/doc-ish api- subdomains must not classify as API-only ------

test("Round 4 Finding A: api-docs.<provider> (documentation convention) classifies as policy, not provider", () => {
  assert.equal(classifyAiEndpoint("https://api-docs.deepseek.com/guides/reasoning_model"), "policy");
});

test("Round 4 Finding A: a real api. subdomain still classifies provider (no regression)", () => {
  assert.equal(classifyAiEndpoint("https://api.openai.com/v1/responses"), "provider");
  assert.equal(classifyAiEndpoint("https://api.deepseek.com/v1/chat/completions"), "provider");
});

test("Round 4 Finding A: an app whose only network string is an api-docs.<provider> link passes cleanly end to end", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r4a-apidocs-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://api-docs.deepseek.com/guides/reasoning_model')");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.severity === "block" && item.id.startsWith("ai-sharing")).length, 0);
});

// --- Round 4: Finding B — Examples/ must be rejected as production AI-consent evidence -----------

test("Round 4 Finding B: Examples/ConsentView.swift is rejected as production AI-consent evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r4b-examples-consent-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [{ name: "OpenRouter", kind: "ai", aiPipelineRecipient: true, purpose: "App Functionality", dataCategories: ["Photos or Videos"], privacyPolicyUrl: "https://example.com/openrouter", protectionConfirmation: "confirmed", confirmation: "confirmed" }];
  manifest.dataProcessing = [{ category: "Photos or Videos", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" }];
  manifest.aiDataSharing = {
    enabled: true,
    dataSent: ["photos"],
    purpose: "extract data",
    processorNames: ["OpenRouter"],
    consent: { shownBeforeTransmission: true, affirmativeAction: "Allow and send to AI", declinePath: "Keep on device", privacyPolicyLinkVisible: true, evidence: ["Examples/ConsentView.swift"], confirmation: "confirmed" },
    privacyPolicy: { identifiesDataAndCollectionMethod: true, identifiesAllUses: true, namesAllProcessors: true, explainsRetentionAndDeletion: true, confirmsEqualProtection: true, evidence: ["Legal/privacy.md"], confirmation: "confirmed" },
  };
  await mkdir(path.join(root, "Examples"), { recursive: true });
  await writeFile(path.join(root, "Examples/ConsentView.swift"), "Text(\"photos OpenRouter extract data\")\nButton(\"Allow and send to AI\") {}\nButton(\"Keep on device\") {}\nLink(\"Privacy Policy\", destination: privacyURL)\n");
  await mkdir(path.join(root, "Legal"), { recursive: true });
  await writeFile(path.join(root, "Legal/privacy.md"), "Users select and upload photos to OpenRouter to extract data. This is the only use. Uploaded data is deleted after processing. Each processor must protect the data to the same or an equal standard.");
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-source-role" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "ai-sharing.consent-evidence" && item.severity === "pass"), false);
});

test("Round 4 Finding B: evidence.ts and preflight.ts agree on Examples/ exclusion for endpoint findings too", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-r4b-examples-endpoint-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Examples"), { recursive: true });
  await writeFile(path.join(root, "Examples/Demo.swift"), "import StoreKit\nfinal class Demo { func buy(_ p: Product) async throws { try await p.purchase() } }\n");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "monetization.source-contradiction").length, 0);
});

// --- Round 4: Finding C — a trailing-dot host must not evade classification ----------------------

test("Round 4 Finding C: a trailing-dot host classifies identically to the same host without the dot", () => {
  assert.equal(classifyAiEndpoint("https://api.openai.com./v1/responses"), "provider");
  assert.equal(classifyAiEndpoint("https://api.openai.com./v1/responses"), classifyAiEndpoint("https://api.openai.com/v1/responses"));
});
