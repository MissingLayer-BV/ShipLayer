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
const xctestSource = (body: string): string => `import XCTest
final class PaywallUITests: XCTestCase {
  func testPaywallEvidence() {
${body.split("\n").map((line) => `    ${line}`).join("\n")}
  }
}
`;
const swiftTestingSource = (body: string): string => `import Testing
@Test func paywallEvidence() {
${body.split("\n").map((line) => `  ${line}`).join("\n")}
}
`;

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

test("generic AI permission actions load (a truthful declaration must be representable) but block at the check gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-generic-action-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  if (!manifest.aiDataSharing.enabled) throw new Error("fixture");
  manifest.aiDataSharing.consent.affirmativeAction = "Allow and scan";
  assert.doesNotThrow(() => validateManifest(manifest));
  // The rendered consent screen is updated to match the same (still generic) label so this
  // isolates the affirmativeAction-language gate from the separate evidence-rendering gate.
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")
Button("Allow and scan") {}
Button("Keep on device and enter manually") {}
Link("Privacy Policy", destination: privacyURL)
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-action-language" && item.severity === "block" && item.message.includes("Allow and scan")));
  assert.equal(report.canSubmit, false);
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

test("AI consent accepts design-system Button/Link wrappers rendering the declared action, decline, and privacy link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-wrapped-controls-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  // Real SwiftUI apps normally wrap their buttons in a design-system component instead of using
  // the literal SwiftUI Button/Link initializers directly; this is the normal case, not an edge
  // case (see BackYet's PrimaryActionButton).
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")
PrimaryActionButton(title: "Allow and send to AI", action: { send() })
SecondaryActionButton(title: "Keep on device and enter manually", action: { manual() })
PolicyLink(title: "Privacy Policy", destination: privacyURL)
`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"]) {
    assert.equal(report.results.some((item) => item.id === id && item.severity === "block"), false, id);
  }
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-evidence" && item.severity === "pass"));
});

test("a design-system wrapper's action/destination trailing closure cannot leak non-rendered text as a visible action, decline, or privacy link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-wrapped-hidden-copy-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  // The trailing closure after action:/destination: is real source text, but only a genuine
  // Text(...)/Label(...) call inside it is actually rendered copy -- a sibling non-UI statement
  // (log/track/etc.) sitting in the same closure must not count as visible.
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")
FancyButton(action: send) { log("Allow and send to AI") }
FancyButton(action: manual) { log("Keep on device and enter manually") }
PolicyLink(destination: privacyURL) { Text("Learn more"); track("Privacy Policy") }
`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
});

test("AI consent ignores strings hidden in action and destination closures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-hidden-control-copy-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("AI helper")
Button { let _ = Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}"); log("Allow and send to AI") } label: { Text("Continue") }
Button { log("Keep on device and enter manually") } label: { Text("Cancel") }
NavigationLink { Text("Privacy Policy") } label: { Text("Learn more") }
`);
  const report = await preflight(root, manifest);
  for (const id of ["ai-sharing.consent-recipients", "ai-sharing.consent-data", "ai-sharing.consent-purpose", "ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
  assert.equal(report.results.some((item) => item.id === "ai-sharing.consent-evidence" && item.severity === "pass"), false);
});

test("AI consent ignores release-excluded conditional compilation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-debug-consent-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `#if DEBUG
Text("Cloudflare OpenRouter Alibaba Cloud International ${DATA_SENT} ${PURPOSE}")
Button("Allow and send to AI") {}
Button("Keep on device and enter manually") {}
Link("Privacy Policy", destination: privacyURL)
#else
Text("AI helper")
#endif
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.consent-recipients" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "ai-sharing.consent-evidence" && item.severity === "pass"), false);
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

test("compound visibility assertions do not prove localized price visibility", async () => {
  const cases = [
    `XCTAssertTrue(app.staticTexts["paywall.price"].exists || fallbackVisible)`,
    `XCTAssertEqual(app.staticTexts["paywall.price"].exists || fallbackVisible, true)`
  ];
  for (const [index, assertion] of cases.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-price-compound-${index}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Tests/PaywallUITests.swift"), xctestSource(`${assertion}\nXCTAssertFalse(app.buttons["paywall.purchase"].isEnabled)`));
    const report = await preflight(root, manifest);
    assert.ok(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block"), assertion);
  }

  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-compound-expect-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), swiftTestingSource(`#expect(app.staticTexts["paywall.price"].exists || fallbackVisible)\n#expect(!app.buttons["paywall.purchase"].isEnabled)`));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block"));
});

test("compound unavailable assertions do not prove purchase is disabled", async () => {
  const xctestCases = [
    `XCTAssertFalse(app.buttons["paywall.purchase"].isEnabled && networkIsDown)`,
    `XCTAssertTrue(!app.buttons["paywall.purchase"].isEnabled || networkIsDown)`
  ];
  for (const [index, assertion] of xctestCases.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-unavailable-compound-${index}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Tests/PaywallUITests.swift"), xctestSource(`XCTAssertTrue(app.staticTexts["paywall.price"].exists)\n${assertion}`));
    const report = await preflight(root, manifest);
    assert.ok(report.results.some((item) => item.id === "purchase.unavailable-tests" && item.severity === "block"), assertion);
  }

  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-unavailable-compound-expect-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), swiftTestingSource(`#expect(app.staticTexts["paywall.price"].exists)\n#expect(app.buttons["paywall.purchase"].isEnabled == false || networkIsDown)`));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.unavailable-tests" && item.severity === "block"));
});

test("direct visibility and unavailable assertions remain valid evidence", async () => {
  const xctestCases = [
    `XCTAssertTrue(app.staticTexts["paywall.price"].exists)\nXCTAssertFalse(app.buttons["paywall.purchase"].isEnabled)`,
    `XCTAssertEqual(app.staticTexts["paywall.price"].exists, true)\nXCTAssertTrue(!app.buttons["paywall.purchase"].isEnabled)`,
    `XCTAssertTrue(app.staticTexts["paywall.price"].waitForExistence(timeout: 5))\nXCTAssertEqual(app.buttons["paywall.purchase"].isEnabled, false)`
  ];
  for (const [index, body] of xctestCases.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-direct-assertions-${index}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Tests/PaywallUITests.swift"), xctestSource(body));
    const report = await preflight(root, manifest);
    assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block"), false, body);
    assert.equal(report.results.some((item) => item.id === "purchase.unavailable-tests" && item.severity === "block"), false, body);
  }

  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-direct-expect-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), swiftTestingSource(`#expect(app.staticTexts["paywall.price"].exists)\n#expect(app.buttons["paywall.purchase"].isEnabled == false)`));
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block"), false);
  assert.equal(report.results.some((item) => item.id === "purchase.unavailable-tests" && item.severity === "block"), false);
});

test("purchase evidence accepts a localized displayPrice value that reaches visible UI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-dataflow-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?\nif let product {\n  let localizedPrice = product.displayPrice\n  Text("Unlock for \\(localizedPrice)")\n  Button("Buy") { Task { try await product.purchase() } }\n} else {\n  ProgressView("Loading price")\n}\n`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"), false);
});

test("purchase evidence accepts a case-pattern-bound displayPrice that reaches visible UI, corroborated by a real .displayPrice read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-pattern-binding-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  // Mirrors BackYet's actual shape: the enum case is constructed elsewhere with a genuine
  // `product.displayPrice` member read (LifetimePaywallManager.swift), and the view only ever
  // sees the already-destructured local name (PaywallSheet.swift). Both are declared as source
  // evidence, matching how a real app would have to reference them.
  await writeFile(path.join(root, "Sources/Paywall.swift"), `enum ProductState { case loading; case available(displayName: String, displayPrice: String); case unavailable }
let state: ProductState
switch state {
case .loading:
  ProgressView("Loading price")
case .available(_, let displayPrice):
  Text("One-time purchase · \\(displayPrice)")
  Button("Unlock for \\(displayPrice)") { Task { try await product.purchase() } }
case .unavailable:
  Text("Price unavailable")
}
`);
  await writeFile(path.join(root, "Sources/PaywallManager.swift"), `func load(product: Product) -> ProductState {
  .available(displayName: product.displayName, displayPrice: product.displayPrice)
}
`);
  if (manifest.monetization.type !== "non-consumables") throw new Error("fixture");
  manifest.monetization.purchasePresentation.sourceEvidence = ["Sources/Paywall.swift", "Sources/PaywallManager.swift"];
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"), false);
});

test("a case-pattern-bound displayPrice with no real .displayPrice member read anywhere in evidence still blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-pattern-binding-unproven-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  // The associated-value LABEL is named displayPrice, but it is never actually read from
  // StoreKit anywhere in the declared evidence -- an enum can carry a hard-coded fixture under
  // that label just as easily as a real price. The bound name alone must not be enough.
  await writeFile(path.join(root, "Sources/Paywall.swift"), `enum PriceCache { case ready(id: String, displayPrice: String); case empty }
let state: PriceCache = .ready(id: "lifetime", displayPrice: "$0.99")
switch state {
case .ready(_, let displayPrice):
  Text("One-time purchase · \\(displayPrice)")
  Button("Unlock for \\(displayPrice)") { Task { try await product.purchase() } }
case .empty:
  Text("Price unavailable")
}
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"));
});

test("purchase evidence accepts a design-system Button wrapper rendering displayPrice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-wrapped-button-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?
if let product {
  PrimaryActionButton(
    title: "Unlock for \\(product.displayPrice)",
    isEnabled: true,
    action: { Task { try await product.purchase() } }
  )
} else {
  ProgressView("Loading price")
}
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"), false);
  assert.equal(report.results.some((item) => item.id === "purchase.call-source" && item.severity === "block"), false);
});

test("purchase presentation tests block when the only price assertion equals a hard-coded in-app fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-fixture-test-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  // Production source genuinely renders StoreKit's displayPrice, but also carries a
  // test-flag-gated hard-coded literal fixture value — mirroring BackYet's
  // LifetimePaywallManager, which substitutes a raw "$9.99" string for
  // --ui-testing-purchase- launch arguments instead of ever calling StoreKit.
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?
let displayPrice = testArguments.contains(where: { $0.hasPrefix("--ui-testing-purchase-") }) ? "$9.99" : product?.displayPrice
if let product {
  Text("One-time purchase · \\(product.displayPrice)").accessibilityIdentifier("paywall.price")
  Button("Buy") { Task { try await product.purchase() } }.accessibilityIdentifier("paywall.purchase")
} else {
  ProgressView("Loading price")
  Button("Price unavailable") {}.disabled(true).accessibilityIdentifier("paywall.purchase")
}
`);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `import XCTest
final class PaywallUITests: XCTestCase {
  func testPaywallEvidence() {
    let price = app.staticTexts["paywall.price"]
    XCTAssertTrue(price.exists)
    XCTAssertEqual(price.label, "One-time purchase · $9.99")
  }
}
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block" && item.message.includes("$9.99")));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "pass"), false);
});

test("an unrelated equality assertion elsewhere in the same test evidence does not block a correct paywall", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-price-unrelated-assertion-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  // The real price genuinely comes from StoreKit; a completely separate marketing element (a
  // strikethrough "was" price) happens to be a hard-coded literal that also appears in source.
  // testEvidence routinely references a whole *UITests.swift file (BackYet's own manifest does
  // exactly this), so an unrelated equality assertion in the same file is the normal case, not
  // an edge case, and must not veto an honest, separate price-visibility assertion.
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?
if let product {
  Text(product.displayPrice).accessibilityIdentifier("paywall.price")
  Text("$19.99").strikethrough().accessibilityIdentifier("paywall.discountBadge")
  Button("Buy") { Task { try await product.purchase() } }.accessibilityIdentifier("paywall.purchase")
} else {
  ProgressView("Loading price")
  Button("Price unavailable") {}.disabled(true).accessibilityIdentifier("paywall.purchase")
}
`);
  await writeFile(path.join(root, "Tests/PaywallUITests.swift"), `import XCTest
final class PaywallUITests: XCTestCase {
  func testPriceIsVisible() {
    XCTAssertTrue(app.staticTexts["paywall.price"].waitForExistence(timeout: 5))
  }
  func testDiscountBadgeShowsOriginalPrice() {
    XCTAssertEqual(app.staticTexts["paywall.discountBadge"].label, "$19.99")
  }
}
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-tests" && item.severity === "block"), false);
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
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let unused = AnyView(
  VStack {
    ProductView(id: "com.example.unlock")
  }
)
let wrapped: AnyView = {
  ProductView(id: "com.example.unlock")
}()
struct EmptyPaywall: View { var body: some View { Text("Empty") } }
`);
  const report = await preflight(root, manifest);
  for (const id of ["purchase.localized-price-source", "purchase.call-source", "purchase.unavailable-source"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("multiline StoreKit merchandising inside a rendered body remains valid", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-multiline-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `struct Paywall: View {
  var body: some View {
    VStack {
      ProductView(
        id: "com.example.unlock"
      )
    }
  }
}
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
});

test("release-excluded merchandising evidence cannot satisfy purchase source gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-debug-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `#if DEBUG
ProductView(id: "com.example.unlock")
#endif
struct EmptyPaywall: View { var body: some View { Text("Empty") } }
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("nested conditional compilation keeps the production else branch eligible", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-production-else-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `#if DEBUG
  #if false
  ProductView(id: "debug-false")
  #else
  ProductView(id: "debug")
  #endif
#elseif targetEnvironment(simulator)
ProductView(id: "simulator")
#else
struct Paywall: View {
  var body: some View {
    ProductView(id: "com.example.unlock")
  }
}
#endif
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
});

test("merchandising compiled only for another Apple platform cannot satisfy iOS source gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-macos-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `#if os(macOS)
ProductView(id: "com.example.unlock")
#endif
struct EmptyPaywall: View { var body: some View { Text("Empty") } }
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("nested platform elseif compilation selects only the iOS release branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ios-elseif-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `#if os(macOS)
ProductView(id: "mac.unlock")
#elseif os(tvOS)
ProductView(id: "tv.unlock")
#elseif os(iOS)
  #if DEBUG
  ProductView(id: "debug.unlock")
  #else
  struct Paywall: View {
    var body: some View { ProductView(id: "com.example.unlock") }
  }
  #endif
#elseif os(visionOS)
ProductView(id: "vision.unlock")
#else
ProductView(id: "unknown.unlock")
#endif
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
});

test("an unknown conditional branch cannot independently establish iOS release evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-unknown-condition-product-view-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `#if canImport(UnverifiedPaywall)
ProductView(id: "com.example.unlock")
#endif
struct EmptyPaywall: View { var body: some View { Text("Empty") } }
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("known iOS OR and negated other-platform conditions remain eligible", async () => {
  const conditions = ["os(iOS) || os(visionOS)", "!os(macOS)"];
  for (const [index, condition] of conditions.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-known-ios-condition-${index}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Sources/Paywall.swift"), `#if ${condition}
struct Paywall: View { var body: some View { ProductView(id: "com.example.unlock") } }
#endif
`);
    const report = await preflight(root, manifest);
    assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0, condition);
  }
});

test("known Apple commerce and UI framework guards remain eligible on iOS", async () => {
  const conditions = ["canImport(StoreKit)", "os(iOS) && canImport(StoreKit)", "canImport(SwiftUI) && os(iOS)"];
  for (const [index, condition] of conditions.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-known-framework-condition-${index}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Sources/Paywall.swift"), `#if ${condition}
struct Paywall: View { var body: some View { ProductView(id: "com.example.unlock") } }
#endif
`);
    const report = await preflight(root, manifest);
    assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0, condition);
  }
});

test("nested known Apple framework guards preserve iOS release evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-nested-framework-condition-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `#if canImport(SwiftUI)
  #if canImport(StoreKit)
    #if os(iOS)
    struct Paywall: View { var body: some View { ProductView(id: "com.example.unlock") } }
    #endif
  #endif
#endif
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
});

test("inverse known Apple framework guards select the iOS release else branch", async () => {
  for (const framework of ["StoreKit", "SwiftUI"]) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-inverse-known-framework-${framework}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Sources/Paywall.swift"), `#if !canImport(${framework})
Text("Unavailable")
#else
struct Paywall: View { var body: some View { ProductView(id: "com.example.unlock") } }
#endif
`);
    const report = await preflight(root, manifest);
    assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0, framework);
  }
});

test("an inverse custom framework guard cannot make its else branch release evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-inverse-custom-framework-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `#if !canImport(CustomPaywall)
Text("Fallback")
#else
ProductView(id: "com.example.unlock")
#endif
struct EmptyPaywall: View { var body: some View { Text("Empty") } }
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.localized-price-source" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("coexisting optional product and fallback do not prove purchase is withheld", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-unsafe-force-purchase-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?
Button("Buy") { Task { try await product!.purchase() } }
if let product { Text(product.displayPrice) }
ProgressView("Loading")
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.unavailable-source" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("purchase source accepts guarded or safely disabled actions", async () => {
  const predicates = ["isLoading", "product == nil", "!isAvailable", "!canPurchase", "!priceLoaded", "!productLoaded"];
  for (const [index, predicate] of predicates.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-safe-disabled-${index}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?
Text(product?.displayPrice ?? "")
Button("Buy") { Task { try await product!.purchase() } }
  .disabled(${predicate})
`);
    const report = await preflight(root, manifest);
    assert.equal(report.results.some((item) => item.id === "purchase.unavailable-source" && item.severity === "block"), false, predicate);
  }
});

test("purchase source rejects inverted or compound disabled predicates", async () => {
  const predicates = ["!loading", "isAvailable", "canPurchase", "productLoaded", "isLoading && networkIsDown"];
  for (const [index, predicate] of predicates.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-unsafe-disabled-${index}-`));
    const manifest = readyManifest("non-consumables");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Sources/Paywall.swift"), `let product: Product?
Text(product?.displayPrice ?? "")
Button("Buy") { Task { try await product!.purchase() } }
  .disabled(${predicate})
`);
    const report = await preflight(root, manifest);
    assert.ok(report.results.some((item) => item.id === "purchase.unavailable-source" && item.severity === "block"), predicate);
    assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false, predicate);
  }
});

test("custom ProductViewStyle cannot inherit StoreKit-owned presentation evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-custom-product-style-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `ProductView(id: "com.example.unlock")
  .productViewStyle(PriceHidingStyle())
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.custom-product-view-style" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("built-in ProductViewStyle remains StoreKit-owned presentation evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-built-in-product-style-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `ProductView(id: "com.example.unlock")
  .productViewStyle(.compact)
`);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0);
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

test("custom SubscriptionStoreControlStyle cannot inherit automatic disclosure evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-custom-subscription-control-style-"));
  const manifest = readyManifest("subscriptions");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `SubscriptionStoreView(groupID: "example-pro")
  .subscriptionStoreControlStyle(PriceHidingStyle())
`);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.custom-subscription-control-style" && item.severity === "block"));
  for (const id of ["purchase.localized-price-source", "purchase.subscription-period-source", "purchase.offer-terms-source", "purchase.legal-links-source"]) {
    assert.ok(report.results.some((item) => item.id === id && item.severity === "block"), id);
  }
  assert.equal(report.results.some((item) => item.id === "purchase.presentation-source" && item.severity === "pass"), false);
});

test("built-in SubscriptionStoreControlStyle remains automatic disclosure evidence", async () => {
  const styles = ["automatic", "buttons", "picker", "prominentPicker", "compactPicker", "pagedPicker", "pagedProminentPicker"];
  for (const style of styles) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-built-in-subscription-control-${style}-`));
    const manifest = readyManifest("subscriptions");
    await writeReadyAssets(root, manifest);
    await writeFile(path.join(root, "Sources/Paywall.swift"), `SubscriptionStoreView(groupID: "example-pro")
  .subscriptionStoreControlStyle(.${style})
`);
    const report = await preflight(root, manifest);
    assert.equal(report.results.filter((item) => item.id.startsWith("purchase.") && item.severity === "block").length, 0, style);
  }
});

test("built-in SubscriptionStoreControlStyle accepts the placement overload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-built-in-subscription-control-placement-"));
  const manifest = readyManifest("subscriptions");
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Sources/Paywall.swift"), `SubscriptionStoreView(groupID: "example-pro")
  .subscriptionStoreControlStyle(.buttons, placement: .automatic)
`);
  const report = await preflight(root, manifest);
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

test("an AI consent override never clears the consent-flow blockers (LinkVoice rejection, 2026-09-23)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-consent-override-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  // No dedicated consent screen: the cited source only renders a sign-in agreement line.
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text("By continuing you agree to the Terms of Use and Privacy Policy.")\n`);
  const consentIds = ["ai-sharing.consent-recipients", "ai-sharing.consent-data", "ai-sharing.consent-purpose", "ai-sharing.consent-action", "ai-sharing.consent-decline", "ai-sharing.consent-privacy-link"];

  const blocked = await preflight(root, manifest);
  for (const id of consentIds) assert.ok(blocked.results.some((item) => item.id === id && item.severity === "block"), id);

  const override = { finding: "ai-sharing.consent", reason: "Consent is given by accepting the Privacy Policy at sign-in.", evidence: ["Sources/AIConsent.swift"], confirmation: "needs-human-confirmation" as const };
  manifest.sourceContradictionOverrides = [override];
  const unconfirmed = await preflight(root, manifest);
  assert.ok(unconfirmed.results.some((item) => item.id === "ai-sharing.consent-decline" && item.severity === "block"), "an unconfirmed override changes nothing");

  manifest.sourceContradictionOverrides = [{ ...override, confirmation: "confirmed" }];
  const overridden = await preflight(root, manifest);
  // App Review rejected exactly this shape: a sign-in agreement line is not in-app consent.
  for (const id of consentIds) assert.equal(overridden.results.find((item) => item.id === id)?.severity, "block", id);
  const declared = overridden.results.find((item) => item.id === "ai-sharing.consent-override");
  assert.equal(declared?.severity, "block");
  assert.match(declared?.message ?? "", /Consent is given by accepting the Privacy Policy at sign-in\./);
  assert.equal(overridden.results.some((item) => /Human-overridden/.test(item.message)), false);

  manifest.sourceContradictionOverrides = [{ ...override, confirmation: "confirmed", evidence: ["README.md"] }];
  await writeFile(path.join(root, "README.md"), "unrelated\n");
  const wrongEvidence = await preflight(root, manifest);
  assert.ok(wrongEvidence.results.some((item) => item.id === "ai-sharing.consent-decline" && item.severity === "block"), "evidence must cite the consent source");

  manifest.sourceContradictionOverrides = [{ ...override, confirmation: "confirmed" }];
  manifest.aiDataSharing = { ...manifest.aiDataSharing, privacyPolicy: { ...(manifest.aiDataSharing as any).privacyPolicy, confirmsEqualProtection: false } } as typeof manifest.aiDataSharing;
  const policyGap = await preflight(root, manifest);
  assert.ok(policyGap.results.some((item) => item.id === "ai-sharing.privacy-policy" && item.severity === "block"), "policy checks are not overridable");
});

test("generated review notes use sign-in instructions and the owner's consent reason instead of claiming a consent screen", async () => {
  const { appReviewNotes } = await import("../src/generator.js");
  const { analyzeRepository } = await import("../src/scanner.js");
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-review-notes-override-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  await writeAISharingEvidence(root);
  const analysis = await analyzeRepository(root);

  const standard = await appReviewNotes(root, manifest, analysis);
  assert.match(standard, /No account, registration, or login is required\./);
  assert.match(standard, /Before transmission the app states that it sends/);

  manifest.review.demoAccount = { required: false, setupInstructions: "Sign in with any Apple ID; no demo account is needed." };
  manifest.sourceContradictionOverrides = [{ finding: "ai-sharing.consent", reason: "Consent is given by accepting the Privacy Policy at sign-in.", evidence: [...(manifest.aiDataSharing as any).consent.evidence], confirmation: "confirmed" }];
  const owner = await appReviewNotes(root, manifest, analysis);
  assert.match(owner, /No demo account is supplied\. Sign in with any Apple ID; no demo account is needed\./);
  assert.doesNotMatch(owner, /No account, registration, or login is required/);
  assert.match(owner, /Consent is given by accepting the Privacy Policy at sign-in\./);
  assert.doesNotMatch(owner, /Before transmission the app states/);
});
