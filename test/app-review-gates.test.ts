import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
  await writeFile(path.join(root, "Sources/AIConsent.swift"), `Text(\"${consent}\")\nButton(\"Allow and send to AI\") {}\n`);
  await writeFile(path.join(root, "Legal/privacy.md"), `Cloudflare, OpenRouter, and Alibaba Cloud International receive ${DATA_SENT} to ${PURPOSE}. Each processor must protect the data to the same or an equal standard. Retention and deletion are described here.\n`);
}

test("AI processors cannot be treated as no sharing because routing is ZDR or no-training", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ai-disabled-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  addCompleteAISharing(manifest);
  manifest.aiDataSharing = { enabled: false };
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "ai-sharing.declaration" && item.severity === "block" && item.message.includes("AI processors")));
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
  manifest.aiDataSharing.consent.affirmativeAction = "Continue";
  assert.throws(() => validateManifest(manifest), /affirmativeAction/);
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
