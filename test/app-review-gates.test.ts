import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateManifest } from "../src/manifest.js";
import { preflight } from "../src/preflight.js";
import type { ShipLayerManifest } from "../src/types.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

const DATA_SENT = "metadata-free receipt images";
const PURPOSE = "extract editable receipt suggestions";

function addCompleteAISharing(manifest: ShipLayerManifest): void {
  const processor = (name: string, kind: "ai" | "network") => ({
    name,
    kind,
    aiPipelineRecipient: true,
    purpose: "App Functionality" as const,
    dataCategories: ["Photos or Videos"],
    privacyPolicyUrl: `https://example.com/${encodeURIComponent(name)}`,
    protectionConfirmation: "confirmed" as const,
    confirmation: "confirmed" as const
  });
  manifest.dataProcessing = [{ category: "Photos or Videos", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" }];
  manifest.externalProcessors = [processor("Cloudflare", "network"), processor("OpenRouter", "ai"), processor("Alibaba Cloud International", "ai")];
  manifest.aiDataSharing = {
    enabled: true,
    dataSent: [DATA_SENT],
    purpose: PURPOSE,
    processorNames: ["Cloudflare", "OpenRouter", "Alibaba Cloud International"],
    consent: {
      shownBeforeTransmission: true,
      affirmativeAction: "Allow and send to AI",
      declinePath: "Keep on device and enter manually",
      privacyPolicyLinkVisible: true,
      evidence: ["Sources/AIConsent.swift"],
      confirmation: "confirmed"
    },
    privacyPolicy: {
      identifiesDataAndCollectionMethod: true,
      identifiesAllUses: true,
      namesAllProcessors: true,
      explainsRetentionAndDeletion: true,
      confirmsEqualProtection: true,
      evidence: ["Legal/privacy.md"],
      confirmation: "confirmed"
    }
  };
}

async function writeAISharingEvidence(root: string, consent = `Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}`): Promise<void> {
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await mkdir(path.join(root, "Legal"), { recursive: true });
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text(\"${consent}\")\nButton(\"Allow and send to AI\") {}\nButton(\"Keep on device and enter manually\") {}\nLink(\"Privacy Policy\", destination: privacyURL)\n`);
  await writeFile(path.join(root, "Legal/privacy.md"), `Users select and upload ${DATA_SENT} to Cloudflare, OpenRouter, and Alibaba Cloud International to ${PURPOSE}. This is the only use. Uploaded data is deleted after processing; limited security logs may be retained. Each processor must protect the data to the same or an equal standard.\n`);
}

test("AI processors cannot be treated as no sharing because routing is ZDR or no-training", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-disabled-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  manifest.aiDataSharing = { enabled: false };
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "block" && item.message.includes("AI-pipeline recipients")));
  assert.equal(report.canSubmit, false);
});

test("AI readiness requires exact data, purpose, recipients, consent, and matching policy evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-ready-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  validateManifest(manifest);
  let report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("ai-sharing.") && item.severity === "block").length, 0);

  await writeAISharingEvidence(root, `Cloudflare OpenRouter ${DATA_SENT} ${PURPOSE}`);
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-recipients" && item.severity === "block"));
});

test("generic AI permission actions are rejected by manifest validation", () => {
  const manifest = readyManifest();
  addCompleteAISharing(manifest);
  if (!manifest.aiDataSharing.enabled) throw new Error("fixture");
  manifest.aiDataSharing.consent.affirmativeAction = "Allow and scan";
  assert.throws(() => validateManifest(manifest), /affirmativeAction/);
});

test("AI consent evidence must render the declared action, decline path, and Privacy Policy link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-controls-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")\n`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
});

test("AI policy evidence must cover purpose, collection method, and retention or deletion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-policy-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Legal/privacy.md"), `Cloudflare, OpenRouter, and Alibaba Cloud International receive ${DATA_SENT}. Each provides equal protection.\n`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.policy-purpose", "ai-sharing.policy-collection-method", "ai-sharing.policy-retention"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
});

test("every AI-pipeline intermediary must appear in the AI recipient list without pulling in unrelated processors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-pipeline-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  manifest.externalProcessors.push({
    name: "Unrelated Analytics",
    kind: "analytics",
    aiPipelineRecipient: false,
    purpose: "Analytics",
    dataCategories: ["Product Interaction"],
    privacyPolicyUrl: "https://example.com/analytics",
    protectionConfirmation: "confirmed",
    confirmation: "confirmed"
  });
  manifest.dataProcessing.push({ category: "Product Interaction", purpose: ["Analytics"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" });
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.processors" && item.severity === "pass"));

  const cloudflare = manifest.externalProcessors.find((item) => item.name === "Cloudflare");
  if (!cloudflare || !manifest.aiDataSharing.enabled) throw new Error("fixture");
  manifest.aiDataSharing.processorNames = manifest.aiDataSharing.processorNames.filter((name) => name !== "Cloudflare");
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.processors" && item.severity === "block"));
});

test("AI consent production evidence cannot be satisfied by a test-only fake", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-role-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  if (!manifest.aiDataSharing.enabled) throw new Error("fixture");
  await mkdir(path.join(root, "Tests"), { recursive: true });
  await writeFile(path.join(root, "Tests/FakeConsent.swift"), await readFile(path.join(root, "Sources/AIConsent.swift"), "utf8"));
  manifest.aiDataSharing.consent.evidence = ["Tests/FakeConsent.swift"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-source-role" && item.severity === "block"));
});

test("all in-app purchases require a localized StoreKit price presentation contract", () => {
  const manifest = readyManifest("non-consumables") as unknown as { monetization: Record<string, unknown> };
  delete manifest.monetization.purchasePresentation;
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
});

test("purchase readiness blocks hidden or hard-coded prices and passes StoreKit displayPrice evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-gate-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  let report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);

  if (manifest.monetization.type !== "non-consumables") throw new Error("fixture");
  manifest.monetization.purchasePresentation.localizedPriceVisibleBeforePurchase = false;
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation" && item.severity === "block"));

  manifest.monetization.purchasePresentation.localizedPriceVisibleBeforePurchase = true;
  await writeFile(path.join(root, "Sources/Paywall.swift"), "Text(\"$9.99\")\nButton(\"Buy\") { Task { try await product.purchase() } }\n");
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"));
});

test("purchase evidence must render displayPrice and prove purchase unavailable before Product loads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-render-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `Text("Unlock")\nlet ignored = product.displayPrice\nButton("Buy") { Task { try await product.purchase() } }\n`);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `XCTAssertTrue(app.staticTexts["paywall.price"].exists)\n`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"));
  assert.ok(report.results.some((item) => item.id === "purchase.unavailable-source" && item.severity === "block"));
  assert.ok(report.results.some((item) => item.id === "purchase.unavailable-tests" && item.severity === "block"));
});

test("purchase evidence accepts a localized displayPrice value that reaches visible UI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-dataflow-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?\nif let product {\n  let localizedPrice = product.displayPrice\n  Text("Unlock for \\(localizedPrice)")\n  Button("Buy") { Task { try await product.purchase() } }\n} else {\n  ProgressView("Loading price")\n}\n`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"), false);
});

test("subscription evidence must render and test period, offer terms, Terms, and Privacy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-subscription-disclosures-"));
  const manifest = readyManifest("subscriptions");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?\nif let product { Text(product.displayPrice); Button("Buy") { Task { try await product.purchase() } } } else { ProgressView("Loading") }\n`);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `XCTAssertTrue(app.staticTexts["paywall.price"].exists)\nXCTAssertFalse(app.buttons["paywall.purchase"].isEnabled)\n`);
  const report = await preflight(root, manifest);
  for (const id of ["purchase.subscription-period-source", "purchase.offer-terms-source", "purchase.legal-links-source", "purchase.subscription-period-tests", "purchase.offer-terms-tests", "purchase.legal-links-tests"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
});

test("purchase evidence roles reject test-only source and non-test test evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-roles-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  if (manifest.monetization.type !== "non-consumables") throw new Error("fixture");
  manifest.monetization.purchasePresentation.sourceEvidence = ["Tests/PaywallUITests.swift"];
  manifest.monetization.purchasePresentation.testEvidence = ["Sources/Paywall.swift"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-source-role" && item.severity === "block"));
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-test-role" && item.severity === "block"));
});

test("StoreKit merchandising views may own purchase without an explicit purchase call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `ProductView(id: "com.example.unlock")\n`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.call-source" && item.severity === "block"), false);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
});
