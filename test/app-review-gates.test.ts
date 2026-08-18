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

test("AI consent accepts standard SwiftUI trailing-closure labels", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-trailing-labels-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")
Button(action: allow) { Text("Allow and send to AI") }
Button(action: decline) { Text("Keep on device and enter manually") }
Link(destination: privacyURL) { Text("Privacy Policy") }
`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"]) {
    assert.equal(report.results.some((item) => item.id === id && item.severity === "block"), false, id);
  }
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-evidence" && item.severity === "pass"));
});

test("AI consent accepts no-parentheses SwiftUI label closures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-label-closures-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")
Button { send() } label: { Text("Allow and send to AI") }
Button { manual() } label: { Text("Keep on device and enter manually") }
NavigationLink { PrivacyView() } label: { Text("Privacy Policy") }
`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"]) {
    assert.equal(report.results.some((item) => item.id === id && item.severity === "block"), false, id);
  }
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-evidence" && item.severity === "pass"));
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

test("commented-out AI consent controls cannot satisfy production evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-comments-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `/* Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")\nButton("Allow and send to AI") {}\nButton("Keep on device and enter manually") {}\nLink("Privacy Policy", destination: privacyURL) */\nstruct AIConsent {}\n`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-recipients", "ai-sharing.consent-data", "ai-sharing.consent-purpose", "ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
});

test("unused AI disclosure constants do not count as visible consent copy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-unused-copy-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `let unusedDisclosure = "Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}"\nButton("Allow and send to AI") {}\nButton("Keep on device and enter manually") {}\nLink("Privacy Policy", destination: privacyURL)\n`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-recipients", "ai-sharing.consent-data", "ai-sharing.consent-purpose"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
  assert.equal(report.results.some((item) => item.id === "ai-sharing.consent-evidence" && item.severity === "pass"), false);
});

test("AI privacy-policy evidence rejects test, fixture, and generated release roles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-policy-role-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  if (!manifest.aiDataSharing.enabled) throw new Error("fixture");
  await mkdir(path.join(root, "fixtures"), { recursive: true });
  await writeFile(path.join(root, "fixtures/privacy.md"), await readFile(path.join(root, "Legal/privacy.md"), "utf8"));
  manifest.aiDataSharing.privacyPolicy.evidence = ["fixtures/privacy.md"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.policy-source-role" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "ai-sharing.policy-evidence" && item.severity === "pass"), false);
});

test("privacy disclosures hidden in HTML comments do not satisfy policy evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-policy-comments-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  if (!manifest.aiDataSharing.enabled) throw new Error("fixture");
  await writeFile(path.join(root, "Legal/privacy.html"), `<!-- Users select and upload ${DATA_SENT} to Cloudflare, OpenRouter, and Alibaba Cloud International to ${PURPOSE}. Uploaded data is deleted. Each processor provides the same or equal protection. --><main>Privacy</main>`);
  manifest.aiDataSharing.privacyPolicy.evidence = ["Legal/privacy.html"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.policy-recipients" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "ai-sharing.policy-evidence" && item.severity === "pass"), false);
});

test("unused policy constants in production code cannot satisfy public policy evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-policy-unused-code-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  if (!manifest.aiDataSharing.enabled) throw new Error("fixture");
  await writeFile(path.join(root, "Sources/privacy.tsx"), `const unused = "Users upload ${DATA_SENT} to Cloudflare, OpenRouter, and Alibaba Cloud International to ${PURPOSE}; it is deleted and receives equal protection"; export function Privacy() { return <main>Privacy</main>; }`);
  manifest.aiDataSharing.privacyPolicy.evidence = ["Sources/privacy.tsx"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.policy-source-role" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "ai-sharing.policy-evidence" && item.severity === "pass"), false);
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

test("comments and unrelated negative assertions cannot satisfy purchase evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-comments-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `/*\nText(product.displayPrice)\nlet product: Product?\nProgressView("Loading")\nButton("Buy") { Task { try await product.purchase() } }.disabled(product == nil)\n*/\nstruct EmptyPaywall {}\n`);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `// localized price visible before purchase\nXCTAssertFalse(app.staticTexts["paywall.price"].exists)\nXCTAssertFalse(app.staticTexts["ad"].exists)\n`);
  const report = await preflight(root, manifest);
  for (const id of ["purchase.localized-price-source", "purchase.unavailable-source", "purchase.presentation-tests", "purchase.unavailable-tests"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "pass"), false);
});

test("negated positive assertions do not prove localized price visibility", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-negated-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `import XCTest
final class PaywallUITests: XCTestCase {
  func testPriceIsAbsent() {
    XCTAssertTrue((!app.staticTexts["paywall.price"].exists))
    XCTAssertNotNil(app.staticTexts["paywall.price"].exists)
    XCTAssertFalse(app.buttons["paywall.purchase"].isEnabled)
  }
}
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "pass"), false);
});

test("reversed false comparisons do not prove localized price visibility", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-reversed-false-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `import Testing
@Test func priceIsAbsent() {
  #expect(false == app.staticTexts["paywall.price"].exists)
  #expect(!app.buttons["paywall.purchase"].isEnabled)
}
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "pass"), false);
});

test("top-level assertions are not credible purchase test evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-top-level-tests-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `XCTAssertTrue(app.staticTexts["paywall.price"].exists)\nXCTAssertFalse(app.buttons["paywall.purchase"].isEnabled)\n`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-test-container" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "pass"), false);
});

test("double-negative unavailable assertions do not prove purchase is disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-double-negative-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `import XCTest
final class PaywallUITests: XCTestCase {
  func testPaywall() {
    XCTAssertTrue(app.staticTexts["paywall.price"].exists)
    XCTAssertFalse(app.buttons["paywall.purchase"].isEnabled == false)
    XCTAssertEqual(app.buttons["paywall.purchase"].isEnabled == false, false)
  }
}
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.unavailable-tests" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "pass"), false);
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

test("root-level conventional Swift test basenames are test-only evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-root-tests-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  if (manifest.monetization.type !== "non-consumables") throw new Error("fixture");
  await writeFile(path.join(root, "PaywallTests.swift"), await readFile(path.join(root, "Sources/Paywall.swift"), "utf8"));
  await writeFile(path.join(root, "PaywallUITests.swift"), await readFile(path.join(root, "Tests/PaywallUITests.swift"), "utf8"));
  manifest.monetization.purchasePresentation.sourceEvidence = ["PaywallTests.swift"];
  manifest.monetization.purchasePresentation.testEvidence = ["PaywallUITests.swift"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-source-role" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-test-role" && item.severity === "block"), false);
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

test("unused StoreKit merchandising view assignments do not satisfy source evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-unused-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let unused = [ProductView(id: "com.example.unlock")]
let wrapped = AnyView(ProductView(id: "com.example.unlock"))
struct EmptyPaywall: View { var body: some View { Text("Empty") } }
`);
  const report = await preflight(root, manifest);
  for (const id of ["purchase.localized-price-source", "purchase.call-source", "purchase.unavailable-source"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("rendered StoreView may own non-consumable merchandising", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-store-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `struct Paywall: View { var body: some View { StoreView(ids: ["com.example.unlock"]) } }\n`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
});

test("SubscriptionStoreView may own subscription merchandising and automatic source disclosures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-subscription-store-view-"));
  const manifest = readyManifest("subscriptions");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `SubscriptionStoreView(groupID: "example-pro")\n`);
  const report = await preflight(root, manifest);
  for (const id of ["purchase.localized-price-source", "purchase.call-source", "purchase.unavailable-source", "purchase.subscription-period-source", "purchase.offer-terms-source", "purchase.legal-links-source"]) {
    assert.equal(report.results.some((item) => item.id === id && item.severity === "block"), false, id);
  }
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
});

test("custom subscription source accepts trailing-closure Terms and Privacy links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-subscription-trailing-links-"));
  const manifest = readyManifest("subscriptions");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?
if let product {
  Text(product.displayPrice)
  Text("Billed monthly")
  Text("3-day free trial, then renews monthly")
  Link(destination: termsURL) { Text("Terms of Use") }
  Link(destination: privacyURL) { Text("Privacy Policy") }
  Button("Subscribe") { Task { try await product.purchase() } }
} else {
  ProgressView("Loading price")
}
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.legal-links-source" && item.severity === "block"), false);
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), true);
});
