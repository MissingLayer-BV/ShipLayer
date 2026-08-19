// Regression tests for the second-round independent review of the evidence-backed readiness
// gates (see PR history): override-evidence intersection (C1), the paid-app bypass (C2), the
// inverted AI classifier (C3), the ambiguous proxied-endpoint case (H4), StoreKit corroboration
// (H3), fixture/sample path exclusion (H5), and the smaller MEDIUM-severity gaps (M1/M2/M6/M7/M8).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeRepository } from "../src/scanner.js";
import { preflight } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { validateManifest } from "../src/manifest.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

const STOREKIT_PAYWALL_SOURCE = "import StoreKit\nfinal class Paywall {\n  func buy(_ product: Product) async throws {\n    Text(product.displayPrice)\n    try await product.purchase()\n  }\n}\n";

// --- C1: override evidence must intersect the flagged finding's own source paths -------------

test("C1: an override citing evidence unrelated to the flagged finding does not suppress the monetization block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c1-money-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  await writeFile(path.join(root, "NOTES.md"), "unrelated notes");
  manifest.sourceContradictionOverrides = [{ finding: "monetization.source-contradiction", reason: "n/a", evidence: ["NOTES.md"], confirmation: "confirmed" }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "monetization.source-contradiction" && item.severity === "block"));
  assert.equal(report.results.filter((item) => item.id === "monetization.source-contradiction" && item.severity === "warn").length, 0);
  // "Free app with no declared IAP" must not appear as a pass while the block stands.
  assert.equal(report.results.some((item) => item.id === "monetization" && item.severity === "pass"), false);
});

test("C1: an override citing evidence unrelated to the flagged finding does not suppress the AI block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c1-ai-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')");
  await writeFile(path.join(root, "NOTES.md"), "unrelated notes");
  manifest.sourceContradictionOverrides = [{ finding: "ai-sharing.source-contradiction:endpoint:https://openrouter.ai/api/v1/chat/completions", reason: "n/a", evidence: ["NOTES.md"], confirmation: "confirmed" }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block"));
});

test("C1: an override citing a non-existent evidence path does not suppress the block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c1-missing-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  manifest.sourceContradictionOverrides = [{ finding: "monetization.source-contradiction", reason: "does not exist", evidence: ["Sources/DoesNotExist.swift"], confirmation: "confirmed" }];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "monetization.source-contradiction" && item.severity === "block"));
});

// --- C2: the StoreKit cross-check must run for every monetization type without IAP capability --

test("C2: declaring paid-app instead of free does not bypass the StoreKit contradiction check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c2-paid-app-"));
  const manifest = readyManifest("paid-app");
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  const report = await preflight(root, manifest);
  const contradiction = report.results.find((item) => item.id === "monetization.source-contradiction");
  assert.ok(contradiction && contradiction.severity === "block");
  assert.equal(report.results.some((item) => item.id === "monetization" && item.severity === "pass"), false);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation" && item.severity === "block"));
});

test("C2: a genuinely paid app with no StoreKit evidence still passes cleanly (no false block)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c2-paid-app-clean-"));
  const manifest = readyManifest("paid-app");
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "monetization.source-contradiction").length, 0);
  assert.ok(report.results.some((item) => item.id === "monetization" && item.severity === "pass"));
});

// --- C3: a known AI-provider host is strong evidence by default -------------------------------

test("C3: a known AI-provider host with an unlisted API path (not just /chat/completions) still blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c3-responses-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://api.openai.com/v1/responses')");
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block" && item.message.includes("api.openai.com/v1/responses")));
});

test("C3: known-provider image/audio generation endpoints still block", async () => {
  for (const endpoint of ["https://api.openai.com/v1/images/generations", "https://api.openai.com/v1/audio/transcriptions", "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent"]) {
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c3-multi-"));
    const manifest = readyManifest();
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "worker.ts"), `fetch('${endpoint}')`);
    const report = await preflight(root, manifest);
    assert.ok(report.results.some((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block"), `expected a block for ${endpoint}`);
  }
});

test("C3: a known AI-provider host with a docs/pricing/marketing path still only warns (no false block)", async () => {
  for (const endpoint of ["https://openrouter.ai/privacy", "https://openai.com/pricing", "https://anthropic.com/", "https://docs.anthropic.com/"]) {
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c3-policy-"));
    const manifest = readyManifest();
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "worker.ts"), `fetch('${endpoint}')`);
    const report = await preflight(root, manifest);
    assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block").length, 0, `unexpected block for ${endpoint}`);
  }
});

// --- H4: an AI-shaped path on an unrecognized host blocks under a distinct id -----------------

test("H4: an AI-shaped path on a host ShipLayer does not recognize blocks under a distinct ambiguous-endpoint id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-h4-ambiguous-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://api.myteamchat.example.com/v1/messages')");
  const report = await preflight(root, manifest);
  const ambiguous = report.results.find((item) => item.id === "ai-sharing.source-contradiction-ambiguous-endpoint");
  assert.ok(ambiguous && ambiguous.severity === "block");
  assert.ok(ambiguous.message.includes("does not recognize"));
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block").length, 0);
});

test("H4: the ambiguous-endpoint blocker is independently overridable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-h4-override-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "fetch('https://api.myteamchat.example.com/v1/messages')");
  manifest.sourceContradictionOverrides = [{ finding: "ai-sharing.source-contradiction:endpoint:https://api.myteamchat.example.com/v1/messages", reason: "This is our own team-chat backend, not an AI provider.", evidence: ["worker.ts"], confirmation: "confirmed" }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction-ambiguous-endpoint" && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.source-contradiction-ambiguous-endpoint" && item.severity === "warn"));
});

// --- H3: a bare .purchase( call needs corroboration before it counts as StoreKit evidence ------

test("H3: a bare .purchase( call with no StoreKit import/displayPrice nearby does not block a free app", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-h3-bare-purchase-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Cart.swift"), "final class Cart {\n  func purchase(item: Item) { /* not StoreKit */ }\n}\n");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "monetization.source-contradiction").length, 0);
  assert.ok(report.results.some((item) => item.id === "monetization" && item.severity === "pass"));
});

test("H3: a corroborated .purchase( call (StoreKit import present) still blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-h3-corroborated-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), "import StoreKit\nfinal class Paywall {\n  func buy(_ product: Product) async throws { try await product.purchase() }\n}\n");
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "monetization.source-contradiction" && item.severity === "block"));
});

// --- M8: a legacy StoreKit-1 payment queue is strong evidence on its own ----------------------

test("M8: SKPaymentQueue usage alone (no .purchase(/.displayPrice) still contradicts a free declaration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m8-skpaymentqueue-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/LegacyStore.swift"), "import StoreKit\nfinal class LegacyStore: NSObject, SKPaymentTransactionObserver {\n  func start() { SKPaymentQueue.default().add(self) }\n  func paymentQueue(_ queue: SKPaymentQueue, updatedTransactions transactions: [SKPaymentTransaction]) {}\n}\n");
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "monetization.source-contradiction" && item.severity === "block"));
});

// --- H5: fixture/sample/example evidence is not production evidence ---------------------------

test("H5: StoreKit purchase evidence that only exists under fixtures/ does not block a free app", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-h5-fixtures-money-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "fixtures"), { recursive: true });
  await writeFile(path.join(root, "fixtures/DemoPaywall.swift"), STOREKIT_PAYWALL_SOURCE);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "monetization.source-contradiction").length, 0);
});

test("H5: an AI endpoint that only exists under Examples/ does not block an undeclared AI app", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-h5-examples-ai-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Examples"), { recursive: true });
  await writeFile(path.join(root, "Examples/Demo.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "pass"));
});

// --- M1: kind:"ai" alone forces the AI-pipeline role, even if aiPipelineRecipient is false ------

test("M1: an externalProcessor with kind:'ai' but aiPipelineRecipient:false still requires an AI disclosure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m1-kind-ai-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [{ name: "openrouter.ai", kind: "ai", aiPipelineRecipient: false, purpose: "Other Purposes", dataCategories: ["Other Data"], privacyPolicyUrl: "https://openrouter.ai/", protectionConfirmation: "confirmed", confirmation: "confirmed" }];
  manifest.dataProcessing = [{ category: "Other Data", purpose: ["Other Purposes"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "block" && item.message.includes("openrouter.ai")));
});

// --- M2: detected CODE_SIGN_STYLE is cross-checked against build.signing -----------------------

test("M2: a manifest signing mode that disagrees with detected CODE_SIGN_STYLE blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m2-signing-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "project.yml"), `name: Example\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: ${manifest.app.bundleId}\n    MARKETING_VERSION: ${manifest.app.version}\n    CURRENT_PROJECT_VERSION: ${manifest.app.build}\n    IPHONEOS_DEPLOYMENT_TARGET: ${manifest.app.deploymentTarget || "17.0"}\n    TARGETED_DEVICE_FAMILY: ${manifest.app.deviceFamilies.map((family) => family === "iphone" ? "1" : "2").join(",")}\n    ITSAppUsesNonExemptEncryption: false\n    CODE_SIGN_STYLE: Automatic\n`);
  manifest.build.signing = "manual";
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "consistency.signing" && item.severity === "block"));
});

test("M2: a manifest signing mode that matches detected CODE_SIGN_STYLE passes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m2-signing-match-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "project.yml"), `name: Example\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: ${manifest.app.bundleId}\n    MARKETING_VERSION: ${manifest.app.version}\n    CURRENT_PROJECT_VERSION: ${manifest.app.build}\n    IPHONEOS_DEPLOYMENT_TARGET: ${manifest.app.deploymentTarget || "17.0"}\n    TARGETED_DEVICE_FAMILY: ${manifest.app.deviceFamilies.map((family) => family === "iphone" ? "1" : "2").join(",")}\n    ITSAppUsesNonExemptEncryption: false\n    CODE_SIGN_STYLE: Manual\n`);
  manifest.build.signing = "manual";
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "consistency.signing" && item.severity === "pass"));
});

// --- M6: an undeclared/self-reported "no login required" is a warning, not a silent pass -------

test("M6: 'no login required' is recorded as an unverifiable warning, not a green pass", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m6-demo-account-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  const result = report.results.find((item) => item.id === "review.demo-account");
  assert.ok(result && result.severity === "warn");
});

// --- M7: the "free" monetization declaration itself requires explicit human confirmation -------

test("M7: an unconfirmed free monetization declaration blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m7-free-unconfirmed-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.monetization = { type: "free", confirmation: "needs-human-confirmation" };
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "monetization" && item.severity === "block"));
});

test("sourceContradictionOverride schema round-trips through generateReleasePackage's evidence matrix (M4)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m4-matrix-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  manifest.sourceContradictionOverrides = [{ finding: "monetization.source-contradiction", reason: "Dead code behind a disabled flag.", evidence: ["Sources/Paywall.swift"], confirmation: "confirmed" }];
  validateManifest(manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "release-m4");
  const matrix = JSON.parse(await readFile(path.join(generated.directory, "privacy/evidence-matrix.json"), "utf8")) as { sourceContradictionOverrides: unknown[] };
  assert.equal(matrix.sourceContradictionOverrides.length, 1);
});

// --- M5: the App Review recording script gates on evidence, not only on declaration ------------

test("M5: the recording script requires the StoreKit price step when evidence exists even though monetization is declared free", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-m5-recording-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Paywall.swift"), STOREKIT_PAYWALL_SOURCE);
  manifest.sourceContradictionOverrides = [{ finding: "monetization.source-contradiction", reason: "Dead code behind a disabled flag.", evidence: ["Sources/Paywall.swift"], confirmation: "confirmed" }];
  validateManifest(manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "release-m5");
  const script = await readFile(path.join(generated.directory, "review/physical-device-recording-script.md"), "utf8");
  assert.ok(script.includes("Show StoreKit's localized price"));
});

// --- C4 (partial): a literal URL declared in Info.plist/xcconfig/project.yml becomes an endpoint finding ---

test("C4 (partial): a literal AI endpoint declared as an xcconfig build setting is detected as an endpoint finding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c4-xcconfig-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Secrets.xcconfig"), "API_BASE_URL = https://openrouter.ai/api/v1/chat/completions\n");
  const analysis = await analyzeRepository(root);
  assert.ok(analysis.findings.some((finding) => finding.key === "endpoint:https://openrouter.ai/api/v1/chat/completions"));
  const report = await preflight(root, manifest, false, analysis);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.source-contradiction" && item.severity === "block"));
});

test("C4 (partial): a literal endpoint declared in Info.plist under an arbitrary key is detected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c4-plist-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Info.plist"), "<key>MyBackendBaseURL</key>\n<string>https://api.example.test/v1</string>\n");
  const analysis = await analyzeRepository(root);
  assert.ok(analysis.findings.some((finding) => finding.key === "endpoint:https://api.example.test/v1"));
});

test("C4 limitation: an env-var-injected base URL with no literal value anywhere in the repo is not detected (documented gap)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-c4-envvar-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "project.yml"), `name: Example\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: ${manifest.app.bundleId}\n    MARKETING_VERSION: ${manifest.app.version}\n    CURRENT_PROJECT_VERSION: ${manifest.app.build}\n    IPHONEOS_DEPLOYMENT_TARGET: ${manifest.app.deploymentTarget || "17.0"}\n    TARGETED_DEVICE_FAMILY: ${manifest.app.deviceFamilies.map((family) => family === "iphone" ? "1" : "2").join(",")}\n    ITSAppUsesNonExemptEncryption: false\n    API_BASE_URL: ""\n`);
  await writeFile(path.join(root, "Info.plist"), "<key>MyBackendBaseURL</key>\n<string>$(API_BASE_URL)</string>\n");
  const analysis = await analyzeRepository(root);
  // Documents a real, unresolved gap: a value injected only via CI secrets/environment variables,
  // never present as a literal anywhere in the repository, cannot be found by static scanning.
  assert.equal(analysis.findings.some((finding) => finding.key.startsWith("endpoint:")), false);
});
