import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateReleasePackage } from "../src/generator.js";
import { preflight } from "../src/preflight.js";
import { analyzeRepository } from "../src/scanner.js";
import type { ExternalProcessor, ShipLayerManifest } from "../src/types.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

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
    ...overrides
  };
}

async function questionnaire(root: string, manifest: ShipLayerManifest): Promise<{ draft: string; report: Awaited<ReturnType<typeof preflight>> }> {
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  return { draft: await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8"), report };
}

function hasBlock(report: Awaited<ReturnType<typeof preflight>>, id: string): boolean {
  return report.results.some((item) => item.id === id && item.severity === "block");
}

const INVALID_NOT_COLLECTION_REASONS = [
  "TODO",
  "I think so",
  "x",
  "Request logs are retained forever.",
  "Requests are stored for 30 days.",
  "Logs are enabled.",
  "The processor keeps a permanent request log.",
  "No cache; requests are stored for 30 days.",
  "ＴＯＤＯ request",
  "T.O.D.O request",
  "T O D O request",
  "T\u200BODO request",
  "T\u0000ODO request",
  "I-think-so request",
  "I_think_so request",
  "N/A request",
  "unknown request",
  "x request"
];

const VALID_NOT_COLLECTION_REASONS = [
  "No data retention.",
  "Nothing is persisted.",
  "No records are kept.",
  "Ephemeral in-memory only.",
  "Keine Anfrageprotokolle.",
  "Aucune journalisation des requêtes.",
  "The response appears only in memory and is discarded immediately.",
  "No request logs."
];

test("questionnaire permits only conditional Data Not Collected guidance for fully confirmed not-collection processors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-all-not-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [
    processor("cdn.example.com", ["Product Interaction"], { collectionDetermination: "not-collection", collectionDeterminationReason: "The CDN only serves the request in real time and does not retain the transmitted data." }),
    processor("api.example.com", ["Email Address"], { collectionDetermination: "not-collection", collectionDeterminationReason: "The API discards the request data immediately after servicing the request." })
  ];

  const { draft, report } = await questionnaire(root, manifest);
  assert.equal(report.summary.block, 0, report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; "));
  assert.equal(report.canSubmit, true);
  assert.match(draft, /support considering .Data Not Collected./);
  assert.match(draft, /This processor alone adds no category disclosure requirement/);
  assert.match(draft, /App Store Connect is aggregate/);
  assert.doesNotMatch(draft, /do not declare these categories/i);
});

test("questionnaire and preflight reject invalid, unconfirmed, not-applicable, and unanswered processor determinations", async () => {
  const cases: Array<{ label: string; overrides: Partial<ExternalProcessor>; expectedDraft: RegExp }> = [
    { label: "missing reason", overrides: { collectionDetermination: "not-collection" }, expectedDraft: /no non-blank human reason/ },
    { label: "whitespace-only reason", overrides: { collectionDetermination: "not-collection", collectionDeterminationReason: "   " }, expectedDraft: /no non-blank human reason/ },
    { label: "needs-human-confirmation processor", overrides: { confirmation: "needs-human-confirmation", collectionDetermination: "not-collection", collectionDeterminationReason: "A proposed real-time service reason." }, expectedDraft: /processor confirmation is needs-human-confirmation/ },
    { label: "not-applicable processor", overrides: { confirmation: "not-applicable", collectionDetermination: "not-collection" }, expectedDraft: /processor confirmation is not-applicable/ },
    { label: "absent determination", overrides: {}, expectedDraft: /collection determination is unanswered/ }
  ];

  for (const entry of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-unresolved-"));
    const manifest = readyManifest();
    await writeReadyAssets(root, manifest);
    manifest.externalProcessors = [processor("telemetry.example.com", ["Product Interaction"], entry.overrides)];

    const { draft, report } = await questionnaire(root, manifest);
    assert.equal(report.canSubmit, false, entry.label);
    assert.ok(hasBlock(report, "privacy.processor.telemetry.example.com.collection-determination"), entry.label);
    assert.match(draft, /This is not evidence that the app collects no data/, entry.label);
    assert.match(draft, entry.expectedDraft, entry.label);
    assert.doesNotMatch(draft, /support considering .Data Not Collected./, entry.label);
  }
});

test("all-collection rows require and preserve the app-wide data category declaration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-all-collection-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [processor("analytics.example.com", ["Product Interaction"], { collectionDetermination: "collection" })];
  manifest.dataProcessing = [{ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" }];

  const { draft, report } = await questionnaire(root, manifest);
  assert.equal(report.summary.block, 0, report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; "));
  assert.match(draft, /Human-confirmed to be App Privacy collection for this processor/);
  assert.match(draft, /Do not select .Data Not Collected. while any category above remains declared/);
  assert.doesNotMatch(draft, /support considering .Data Not Collected./);
});

test("mixed, shared, and locally collected categories stay aggregate-aware", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-aggregate-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [
    processor("analytics.example.com", ["Product Interaction"], { collectionDetermination: "collection" }),
    processor("cdn.example.com", ["Product Interaction"], { collectionDetermination: "not-collection", collectionDeterminationReason: "The CDN serves the request in real time and discards transmitted data immediately." })
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

test("PrivacyInfo source evidence with no dataProcessing declaration prevents a Data Not Collected claim", async () => {
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
  assert.match(draft, /do not select .Data Not Collected./);
});

test("unreconciled endpoints and an unconfirmed app-wide privacy declaration prevent a Data Not Collected claim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-endpoint-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.confirmations.privacy = "needs-human-confirmation";
  manifest.externalProcessors = [processor("cdn.example.com", ["Product Interaction"], { collectionDetermination: "not-collection", collectionDeterminationReason: "The CDN serves the request in real time and discards transmitted data immediately." })];
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Telemetry.swift"), `let telemetry = "https://telemetry.example.com/v1/events"\n`);

  const { draft, report } = await questionnaire(root, manifest);
  assert.ok(hasBlock(report, "confirmation.privacy"));
  assert.ok(hasBlock(report, "source.external.endpoint:https://telemetry.example.com/v1/events"));
  assert.equal(report.canSubmit, false);
  assert.match(draft, /the app-wide privacy confirmation is needs-human-confirmation/);
  assert.match(draft, /network\/SDK source findings have not been reconciled/);
  assert.match(draft, /UNVERIFIED: the scanner detected 1 network\/SDK finding/);
  assert.doesNotMatch(draft, /support considering .Data Not Collected./);
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

test("questionnaire applies the full not-collection reason corpus consistently with preflight", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-questionnaire-reason-quality-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [processor("cdn.example.com", ["Product Interaction"], { collectionDetermination: "not-collection" })];

  for (const reason of INVALID_NOT_COLLECTION_REASONS) {
    manifest.externalProcessors[0].collectionDeterminationReason = reason;
    const generated = await questionnaire(root, manifest);
    assert.ok(hasBlock(generated.report, "privacy.processor.cdn.example.com.collection-determination"), reason);
    assert.equal(generated.report.canSubmit, false, reason);
    assert.match(generated.draft, /UNVERIFIED: marked not-collection but the reason (?:is a placeholder|is uncertain|affirmatively describes retention)/, reason);
    assert.doesNotMatch(generated.draft, /Human-confirmed not to be App Privacy collection/, reason);
  }

  for (const reason of VALID_NOT_COLLECTION_REASONS) {
    manifest.externalProcessors[0].collectionDeterminationReason = reason;
    const generated = await questionnaire(root, manifest);
    assert.equal(generated.report.summary.block, 0, `${reason}: ${generated.report.results.filter((item) => item.severity === "block").map((item) => item.message).join("; ")}`);
    assert.equal(generated.report.canSubmit, true, reason);
    assert.match(generated.draft, /Human-confirmed not to be App Privacy collection for this processor/, reason);
  }
});
