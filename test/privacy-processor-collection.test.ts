// Regression tests for issue #22: a confirmed externalProcessors[] row with dataCategories always
// demanded a matching confirmed App Privacy dataProcessing row, with no way to record that the
// processor's receipt of data does not meet Apple's own definition of "collection" (data
// transmitted only to service the request in real time and not retained). The only exits were
// declaring collection that may not be true, or a permanent blocker.
//
// externalProcessors[].collectionDetermination is a human-confirmed, three-state field
// ("collection" | "not-collection" | "needs-human-confirmation") that is optional and unanswered
// by default, so absence must block exactly like every other unconfirmed fact — never silently
// read as "not-collection".
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../src/preflight.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";
import type { ShipLayerManifest } from "../src/types.js";

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

test("a confirmed external processor with no collectionDetermination blocks until answered, and does not also demand a dataProcessing row while unanswered", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-absent-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor());
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "block"));
  assert.equal(report.results.filter((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction").length, 0);
});

test("collectionDetermination explicitly 'needs-human-confirmation' blocks identically to an absent value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-explicit-unconfirmed-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "needs-human-confirmation" }));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "block"));
});

test("collectionDetermination 'not-collection' with a reason clears the category blocker without a dataProcessing row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-not-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "not-collection", collectionDeterminationReason: "Edge CDN cache; upstream logs are not retained beyond the request per the vendor's published no-logging policy." }));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "pass"));
  assert.equal(report.results.filter((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction").length, 0);
});

test("collectionDetermination 'not-collection' without a reason still blocks (cannot clear by omission)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-not-noreason-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "not-collection" }));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "block"));
});

test("collectionDetermination 'not-collection' with a whitespace-only reason still blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-not-blankreason-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "not-collection", collectionDeterminationReason: "   " }));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "block"));
});

test("not-collection reasons reject placeholders and uncertainty but accept concise concrete request-handling facts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-reason-quality-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "not-collection" }));

  for (const reason of ["TODO", "I think so", "x"]) {
    manifest.externalProcessors[0].collectionDeterminationReason = reason;
    const report = await preflight(root, manifest);
    assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "block"), reason);
    assert.equal(report.canSubmit, false, reason);
  }

  manifest.externalProcessors[0].collectionDeterminationReason = "No request logs.";
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "pass"));
  assert.equal(report.summary.block, 0, report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; "));
  assert.equal(report.canSubmit, true);
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

test("collectionDetermination 'collection' with a matching confirmed dataProcessing row passes both checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-yes-matched-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "collection" }));
  manifest.dataProcessing.push({ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" });
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "pass"));
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction" && item.severity === "pass"));
});

test("collectionDetermination 'collection' without a matching dataProcessing row still demands it (a real collection determination is not itself the clearance)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-yes-unmatched-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ collectionDetermination: "collection" }));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.collection-determination" && item.severity === "pass"));
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.example.com.Product Interaction" && item.severity === "block"));
});
