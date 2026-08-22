import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateReleasePackage } from "../src/generator.js";
import { preflight } from "../src/preflight.js";
import { analyzeRepository } from "../src/scanner.js";
import type { ExternalProcessor, NotCollectionAttestation, ShipLayerManifest } from "../src/types.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

function attestation(overrides: Partial<NotCollectionAttestation> = {}): NotCollectionAttestation {
  return { dataNotRetainedBeyondRealTimeService: true, basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" }, confirmation: "confirmed", ...overrides };
}

function processor(name: string, dataCategories: string[], overrides: Partial<ExternalProcessor> = {}): ExternalProcessor {
  return {
    name,
    kind: "network",
    aiPipelineRecipient: false,
    purpose: "App Functionality",
    dataCategories,
    privacyPolicyUrl: `https://${name}/privacy`,
    protectionConfirmation: "confirmed",
    confirmation: "confirmed",
    evidence: ["Sources/ProcessorClient.swift"],
    ...overrides
  };
}

async function questionnaire(root: string, manifest: ShipLayerManifest): Promise<{ draft: string; report: Awaited<ReturnType<typeof preflight>> }> {
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/ProcessorClient.swift"), "struct ProcessorClient { func send() {} }\n");
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  return { draft: await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8"), report };
}

function hasBlock(report: Awaited<ReturnType<typeof preflight>>, id: string): boolean {
  return report.results.some((item) => item.id === id && item.severity === "block");
}

const ARBITRARY_AUDIT_NOTES = [
  "The server logs every request.",
  "Logging is enabled.",
  "Request data is held for 30 days.",
  "A copy is maintained for 30 days.",
  "Request history is preserved indefinitely.",
  "The system records every request.",
  "Request data is written to disk.",
  "The storage period is 30 days.",
  "Les requêtes sont conservées pendant 30 jours.",
  "No cache, data stored for 30 days.",
  "No logs but data retained forever.",
  "not only stored",
  "It is not false that requests are stored.",
  "Keine Anfrageprotokolle.",
  "Aucune journalisation des requêtes.",
  "No data retention.",
  "Nothing is persisted.",
  "Ephemeral in-memory only.",
  "Requests are temporarily cached then deleted immediately.",
  "Logging is disabled.",
  "The processor doesn't retain raw request data.",
  "Neither request data nor responses are retained.",
  "No raw data retained.",
  "ＴＯＤＯ request",
  "Vendor X has a policy.",
  "nothing to do with storage"
];

test("all structured not-collection rows are aggregate-aware without a global Data Not Collected recommendation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-all-not-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [
    processor("cdn.vendor-a.com", ["Product Interaction"], { collectionDetermination: "not-collection", notCollectionAttestation: attestation() }),
    processor("api.vendor-a.com", ["Email Address"], { privacyPolicyUrl: "https://api.vendor-a.com/privacy", evidence: [], collectionDetermination: "not-collection", notCollectionAttestation: attestation({ basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } }) })
  ];

  const { draft, report } = await questionnaire(root, manifest);
  assert.equal(report.summary.block, 0, report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; "));
  assert.equal(report.canSubmit, true);
  assert.match(draft, /intentionally does not recommend selecting .Data Not Collected./);
  assert.match(draft, /structured real-time-service attestation/);
  assert.match(draft, /This processor alone adds no category disclosure requirement/);
  assert.match(draft, /App Store Connect is aggregate/);
  assert.doesNotMatch(draft, /do not declare these categories/i);
});

test("questionnaire and preflight reject missing attestation, unconfirmed processor, not-applicable processor, and unanswered determination", async () => {
  const cases: Array<{ label: string; overrides: Partial<ExternalProcessor>; expectedDraft: RegExp }> = [
    { label: "missing attestation", overrides: { collectionDetermination: "not-collection" }, expectedDraft: /structured real-time-service attestation is missing/ },
    { label: "pending observable fact", overrides: { collectionDetermination: "not-collection", notCollectionAttestation: attestation({ dataNotRetainedBeyondRealTimeService: "needs-human-confirmation" }) }, expectedDraft: /does not explicitly confirm that transmitted data is not retained/ },
    { label: "needs-human-confirmation processor", overrides: { confirmation: "needs-human-confirmation", collectionDetermination: "not-collection", notCollectionAttestation: attestation() }, expectedDraft: /processor confirmation is needs-human-confirmation/ },
    { label: "not-applicable processor", overrides: { confirmation: "not-applicable", collectionDetermination: "not-collection", notCollectionAttestation: attestation() }, expectedDraft: /processor confirmation is not-applicable/ },
    { label: "absent determination", overrides: {}, expectedDraft: /collection determination is unanswered/ }
  ];

  for (const entry of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-unresolved-"));
    const manifest = readyManifest();
    await writeReadyAssets(root, manifest);
    manifest.externalProcessors = [processor("telemetry.vendor-a.com", ["Product Interaction"], entry.overrides)];

    const { draft, report } = await questionnaire(root, manifest);
    assert.equal(report.canSubmit, false, entry.label);
    assert.ok(hasBlock(report, "privacy.processor.telemetry.vendor-a.com.collection-determination"), entry.label);
    assert.match(draft, /This is not evidence that the app collects no data/, entry.label);
    assert.match(draft, entry.expectedDraft, entry.label);
    assert.match(draft, /intentionally does not recommend selecting .Data Not Collected./, entry.label);
  }
});

test("all collection rows require and preserve the app-wide data category declaration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-all-collection-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [processor("analytics.example.com", ["Product Interaction"], { collectionDetermination: "collection" })];
  manifest.dataProcessing = [{ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" }];

  const { draft, report } = await questionnaire(root, manifest);
  assert.equal(report.summary.block, 0, report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; "));
  assert.match(draft, /Human-confirmed to be App Privacy collection for this processor/);
  assert.match(draft, /Do not select .Data Not Collected. while any category above remains declared/);
  assert.doesNotMatch(draft, /do not declare these categories/i);
});

test("mixed, shared, and locally collected categories stay aggregate-aware", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-aggregate-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [
    processor("analytics.example.com", ["Product Interaction"], { collectionDetermination: "collection" }),
    processor("cdn.vendor-a.com", ["Product Interaction"], { collectionDetermination: "not-collection", notCollectionAttestation: attestation() })
  ];
  // Product Interaction is shared by both processors; Email Address is collected locally.
  manifest.dataProcessing = [
    { category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" },
    { category: "Email Address", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" }
  ];

  const { draft, report } = await questionnaire(root, manifest);
  assert.equal(report.summary.block, 0, report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; "));
  assert.match(draft, /does not remove a category collected locally or by another processor/);
  assert.match(draft, /This processor alone adds no category disclosure requirement/);
  assert.match(draft, /Product Interaction/);
  assert.match(draft, /Email Address/);
  assert.doesNotMatch(draft, /do not declare these categories/i);
});

test("PrivacyInfo source evidence with no dataProcessing declaration is explicitly unresolved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-privacy-manifest-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "PrivacyInfo.xcprivacy"), `<dict>
<key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeProductInteraction</string>
<key>NSPrivacyCollectedDataTypeLinked</key><false/>
<key>NSPrivacyCollectedDataTypeTracking</key><false/>
<key>NSPrivacyCollectedDataTypePurposes</key><array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
</dict>`);

  const { draft, report } = await questionnaire(root, manifest);
  assert.ok(hasBlock(report, "privacy.manifest.Product Interaction"));
  assert.equal(report.canSubmit, false);
  assert.match(draft, /source declares collected-data privacy evidence .*privacyManifestData:Product Interaction/);
  assert.match(draft, /intentionally does not recommend selecting .Data Not Collected./);
});

test("unreconciled endpoints and an unconfirmed app-wide privacy declaration remain explicit even with a valid attestation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-endpoint-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.confirmations.privacy = "needs-human-confirmation";
  manifest.externalProcessors = [processor("cdn.vendor-a.com", ["Product Interaction"], { collectionDetermination: "not-collection", notCollectionAttestation: attestation() })];
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Telemetry.swift"), `let telemetry = "https://telemetry.example.com/v1/events"\n`);

  const { draft, report } = await questionnaire(root, manifest);
  assert.ok(hasBlock(report, "confirmation.privacy"));
  assert.ok(hasBlock(report, "source.external.endpoint:https://telemetry.example.com/v1/events"));
  assert.equal(report.canSubmit, false);
  assert.match(draft, /the app-wide privacy confirmation is needs-human-confirmation/);
  assert.match(draft, /network\/SDK source findings have not been reconciled/);
  assert.match(draft, /UNVERIFIED: the scanner detected 1 network\/SDK finding/);
});

test("an unconfirmed dataProcessing row is explicitly unresolved in the questionnaire and blocks submit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-data-processing-confirmation-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.dataProcessing = [{ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: "unknown", usedForTracking: "unknown", confirmation: "not-applicable" }];

  const { draft, report } = await questionnaire(root, manifest);
  assert.ok(hasBlock(report, "privacy.Product Interaction"));
  assert.equal(report.canSubmit, false);
  assert.match(draft, /UNVERIFIED: declared App Privacy category is not human-confirmed/);
  assert.match(draft, /confirmation: not-applicable/);
  assert.match(draft, /Do not select .Data Not Collected. while any category above remains declared/);
});

test("arbitrary audit prose cannot affect readiness, while a valid structured attestation works regardless of its language", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-audit-prose-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [processor("cdn.vendor-a.com", ["Product Interaction"], { collectionDetermination: "not-collection" })];

  for (const collectionDeterminationReason of ARBITRARY_AUDIT_NOTES) {
    manifest.externalProcessors[0].collectionDeterminationReason = collectionDeterminationReason;
    manifest.externalProcessors[0].notCollectionAttestation = undefined;
    let generated = await questionnaire(root, manifest);
    assert.ok(hasBlock(generated.report, "privacy.processor.cdn.vendor-a.com.collection-determination"), collectionDeterminationReason);
    assert.equal(generated.report.canSubmit, false, collectionDeterminationReason);
    assert.match(generated.draft, /structured real-time-service attestation is missing/, collectionDeterminationReason);

    manifest.externalProcessors[0].notCollectionAttestation = attestation();
    generated = await questionnaire(root, manifest);
    assert.equal(generated.report.summary.block, 0, `${collectionDeterminationReason}: ${generated.report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; ")}`);
    assert.equal(generated.report.canSubmit, true, collectionDeterminationReason);
    assert.match(generated.draft, /Human-confirmed not to be App Privacy collection for this processor/, collectionDeterminationReason);
    assert.match(generated.draft, /Audit note \(not semantically validated by ShipLayer\)/, collectionDeterminationReason);
  }
});
