// A not-collection determination is safety-critical: prose is audit-only, while readiness rests
// on an explicit human attestation of Apple's observable real-time-service fact and evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../src/preflight.js";
import { validateManifest } from "../src/manifest.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";
import type { NotCollectionAttestation, ShipLayerManifest } from "../src/types.js";

function attestation(overrides: Partial<NotCollectionAttestation> = {}): NotCollectionAttestation {
  return {
    dataNotRetainedBeyondRealTimeService: true,
    basis: "vendor-documentation",
    evidence: { kind: "repo-path", path: "project.yml" },
    confirmation: "confirmed",
    ...overrides
  };
}

function processor(overrides: Partial<ShipLayerManifest["externalProcessors"][number]> = {}): ShipLayerManifest["externalProcessors"][number] {
  return {
    name: "cdn.example.com",
    kind: "network",
    aiPipelineRecipient: false,
    purpose: "App Functionality",
    dataCategories: ["Product Interaction"],
    privacyPolicyUrl: "https://example.com/privacy",
    protectionConfirmation: "confirmed",
    confirmation: "confirmed",
    ...overrides
  };
}

async function reportFor(overrides: Partial<ShipLayerManifest["externalProcessors"][number]>): Promise<Awaited<ReturnType<typeof preflight>>> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-attestation-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor(overrides));
  return preflight(root, manifest);
}

function hasCollectionBlock(report: Awaited<ReturnType<typeof preflight>>): boolean {
  return report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "block");
}

test("a confirmed external processor with no collectionDetermination blocks until answered, and does not also demand a dataProcessing row while unanswered", async () => {
  const report = await reportFor({});
  assert.ok(hasCollectionBlock(report));
  assert.equal(report.results.filter((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction").length, 0);
});

test("collectionDetermination explicitly needs-human-confirmation blocks identically to absent", async () => {
  assert.ok(hasCollectionBlock(await reportFor({ collectionDetermination: "needs-human-confirmation" })));
});

test("a complete structured attestation clears the category blocker without a dataProcessing row", async () => {
  const report = await reportFor({ collectionDetermination: "not-collection", notCollectionAttestation: attestation() });
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "pass"));
  assert.equal(report.results.filter((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction").length, 0);
  assert.equal(report.canSubmit, true);
});

test("legacy not-collection notes remain schema-compatible but block safely without the new attestation", async () => {
  const contradictoryAndArbitraryNotes = [
    "The server logs every request.",
    "Logging is enabled.",
    "Request data is held for 30 days.",
    "A copy is maintained for 30 days.",
    "Request history is preserved indefinitely.",
    "The system records every request.",
    "Request data is written to disk.",
    "The storage period is 30 days.",
    "No cache, data stored for 30 days.",
    "Keine Anfrageprotokolle.",
    "Aucune journalisation des requêtes.",
    "ＴＯＤＯ request",
    "Vendor X has a policy.",
    "nothing to do with storage"
  ];
  for (const collectionDeterminationReason of contradictoryAndArbitraryNotes) {
    const manifest = readyManifest();
    manifest.externalProcessors.push(processor({ collectionDetermination: "not-collection", collectionDeterminationReason }));
    assert.doesNotThrow(() => validateManifest(manifest), collectionDeterminationReason);
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-legacy-note-"));
    await writeReadyAssets(root, manifest);
    const report = await preflight(root, manifest);
    assert.ok(hasCollectionBlock(report), collectionDeterminationReason);
    assert.equal(report.canSubmit, false, collectionDeterminationReason);
  }
});

test("every incomplete, false, unconfirmed, or unusable structured attestation blocks", async () => {
  const cases: Array<{ label: string; value?: NotCollectionAttestation }> = [
    { label: "absent" },
    { label: "pending observable fact", value: attestation({ dataNotRetainedBeyondRealTimeService: "needs-human-confirmation" }) },
    { label: "false observable fact", value: attestation({ dataNotRetainedBeyondRealTimeService: false }) },
    { label: "pending evidence basis", value: attestation({ basis: "needs-human-confirmation" }) },
    { label: "needs-human-confirmation attestation", value: attestation({ confirmation: "needs-human-confirmation" }) },
    { label: "not-applicable attestation", value: attestation({ confirmation: "not-applicable" }) },
    { label: "missing repository evidence", value: attestation({ evidence: { kind: "repo-path", path: "missing-proof.md" } }) }
  ];
  for (const entry of cases) {
    const report = await reportFor({ collectionDetermination: "not-collection", notCollectionAttestation: entry.value });
    assert.ok(hasCollectionBlock(report), entry.label);
    assert.equal(report.canSubmit, false, entry.label);
  }
});

test("public URL and processor-policy evidence are supported only with the literal human attestation", async () => {
  for (const evidence of [{ kind: "public-url", url: "https://vendor.example/privacy/retention" }, { kind: "processor-privacy-policy" }] as const) {
    const report = await reportFor({ collectionDetermination: "not-collection", notCollectionAttestation: attestation({ evidence }) });
    assert.equal(report.canSubmit, true, evidence.kind);
  }
});

test("a declared dataProcessing row requires literal confirmation and known identity/tracking answers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-data-processing-confirmation-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.dataProcessing.push({ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: "unknown", usedForTracking: "unknown", confirmation: "not-applicable" });

  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.Product Interaction" && item.severity === "block"));
  assert.equal(report.canSubmit, false);

  manifest.dataProcessing[0].confirmation = "confirmed";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.Product Interaction.details" && item.severity === "block"));
  assert.equal(report.canSubmit, false);
});

test("collection requires a matching confirmed dataProcessing row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-yes-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "collection" }));
  manifest.dataProcessing.push({ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" });
  let report = await preflight(root, manifest);
  assert.equal(report.canSubmit, true);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction" && item.severity === "pass"));

  manifest.dataProcessing = [];
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction" && item.severity === "block"));
});
