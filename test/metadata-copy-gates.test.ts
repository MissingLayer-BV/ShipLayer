import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

function metadataResults(report: Awaited<ReturnType<typeof preflight>>): { severity: string; id: string; message: string }[] {
  return report.results.filter((item) => item.id.startsWith("metadata."));
}

test("App Store copy blocks readiness unless metadata.localizations.<locale>.confirmation is exactly 'confirmed'", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-confirmation-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].confirmation = "needs-human-confirmation";
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.confirmation" && item.severity === "block"));

  delete manifest.metadata.localizations["en-US"].confirmation;
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.confirmation" && item.severity === "block"), "an absent confirmation must never be read as approved");

  manifest.metadata.localizations["en-US"].confirmation = "confirmed";
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.confirmation" && item.severity === "block").length, 0);
});

test("a keyword string at exactly 100 UTF-8 bytes passes and 101 blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-keywords-length-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].keywords = ["a".repeat(100)];
  let report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.keywords" && item.severity === "block").length, 0);

  manifest.metadata.localizations["en-US"].keywords = ["a".repeat(101)];
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.keywords" && item.severity === "block"));
});

test("placeholder text left in any user-facing field blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-placeholder-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "Lorem ipsum dolor sit amet, this app tracks your budget.";
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.placeholder" && item.severity === "block"));

  manifest.metadata.localizations["en-US"].description = "TODO: write the real description.";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.placeholder" && item.severity === "block"));

  manifest.metadata.localizations["en-US"].description = "Track your budget with XXX and never overspend again.";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.placeholder" && item.severity === "block"));

  manifest.metadata.localizations["en-US"].description = "Welcome to <your app>! Track your budget with ease.";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.placeholder" && item.severity === "block"));

  manifest.metadata.localizations["en-US"].description = "A complete, honest App Store description with no placeholders.";
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.description.placeholder").length, 0);
});

test("a reference to another platform blocks, but the common lowercase word 'windows' does not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-platform-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "Also available on Android and Google Play.";
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.other-platform" && item.severity === "block"));

  manifest.metadata.localizations["en-US"].description = "Now available for Windows too.";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.other-platform" && item.severity === "block"));

  manifest.metadata.localizations["en-US"].description = "Manage multiple windows and organize every receipt with ease.";
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.description.other-platform").length, 0, "the lowercase common noun must never false-block");
});

test("pricing, beta/trial/test language, and unsubstantiated superlatives warn, never block (judgment calls)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-judgment-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "Get every feature for only $2.99, the #1 best app in its category. Currently in beta.";
  const report = await preflight(root, manifest);
  const relevant = metadataResults(report).filter((item) => item.id.includes("description"));
  assert.ok(relevant.some((item) => item.id.endsWith(".pricing") && item.severity === "warn"));
  assert.ok(relevant.some((item) => item.id.endsWith(".superlative") && item.severity === "warn"));
  assert.ok(relevant.some((item) => item.id.endsWith(".beta-trial-test") && item.severity === "warn"));
  assert.equal(relevant.filter((item) => item.severity === "block").length, 0);
});

test("keyword hygiene (whitespace, name/subtitle overlap, plural duplicates) warns without blocking", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-keyword-hygiene-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].name = "Budget Tracker";
  manifest.metadata.localizations["en-US"].subtitle = "Track Expenses Fast";
  manifest.metadata.localizations["en-US"].keywords = [" finance", "budget", "expense", "expenses"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.keywords.whitespace" && item.severity === "warn"));
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.keywords.redundant" && item.severity === "warn"));
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.keywords.plural-duplicate" && item.severity === "warn"));
  assert.equal(report.results.filter((item) => item.id.startsWith("metadata.en-US.keywords") && item.severity === "block").length, 0);
});

test("a zero-cost claim ('completely free') blocks on a non-consumable, and honest copy passes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-free-contradiction-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "This app is completely free to use.";
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.monetization-contradiction" && item.severity === "block"));
  assert.equal(report.canSubmit, false);

  manifest.metadata.localizations["en-US"].description = "Unlock lifetime access with a single one-time purchase.";
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.description.monetization-contradiction").length, 0);
});

// PR review B1: a bare "no in-app purchases" claim is TRUE for a paid-app (the app itself is a
// purchase, but not an IN-APP one) and must not block. It must still block for a monetization
// type that genuinely does model an in-app purchase (non-consumables/subscriptions). Split from
// the zero-cost claim above (which the original test's single string tested at the same time,
// masking this exact predicate bug — see PR review B1).
test("a 'no in-app purchases' claim passes on a paid-app (true — the purchase is not in-app) but blocks on a non-consumable (false — it has one)", async () => {
  const paidRoot = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-no-iap-paid-app-"));
  const paidManifest = readyManifest("paid-app");
  await writeReadyAssets(paidRoot, paidManifest);
  for (const description of ["Pay once, no IAPs.", "Buy once. There are no in-app purchases.", "One price, no hidden fees, no ads."]) {
    paidManifest.metadata.localizations["en-US"].description = description;
    const report = await preflight(paidRoot, paidManifest);
    assert.equal(report.results.filter((item) => item.id.includes("monetization-contradiction")).length, 0, `expected no block for honest paid-app copy: ${description}`);
  }

  const nonConsumableRoot = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-no-iap-non-consumable-"));
  const nonConsumableManifest = readyManifest("non-consumables");
  await writeReadyAssets(nonConsumableRoot, nonConsumableManifest);
  nonConsumableManifest.metadata.localizations["en-US"].description = "Buy once. There are no in-app purchases.";
  const nonConsumableReport = await preflight(nonConsumableRoot, nonConsumableManifest);
  assert.ok(nonConsumableReport.results.some((item) => item.id === "metadata.en-US.description.monetization-contradiction" && item.severity === "block"));
});

test("'no hidden fees/costs' never blocks (a transparency claim, not a no-purchase claim) on any monetization type", async () => {
  for (const type of ["subscriptions", "non-consumables"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), `shiplayer-copy-no-hidden-fees-${type}-`));
    const manifest = readyManifest(type);
    await writeReadyAssets(root, manifest);
    manifest.metadata.localizations["en-US"].description = type === "subscriptions" ? "Transparent pricing with no hidden costs." : "No hidden fees beyond the one-time unlock.";
    const report = await preflight(root, manifest);
    assert.equal(report.results.filter((item) => item.id.includes("monetization-contradiction")).length, 0, `expected no block for ${type}`);
  }
});

test("'free to try' blocks without a declared free-trial offer, and passes once one is declared", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-free-trial-"));
  const manifest = readyManifest("subscriptions");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "Free to try for 3 days, then Pro renews monthly.";
  delete manifest.monetization.products[0].introductoryOffer;
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.monetization-contradiction" && item.severity === "block"));

  manifest.monetization.products[0].introductoryOffer = { type: "free-trial", duration: "P3D" };
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.description.monetization-contradiction").length, 0);
});

test("'hassle-free' and 'distraction-free app' never trigger the free/paid contradiction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-free-guard-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "A hassle-free, distraction-free app for tracking every receipt.";
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.includes("monetization-contradiction")).length, 0);
});

test("a genuinely free app whose copy says 'free' passes cleanly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-free-honest-"));
  const manifest = readyManifest("free");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "This app is completely free to use, with no in-app purchases.";
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.includes("monetization-contradiction")).length, 0);
});

test("a free app whose copy claims a paid subscription blocks (the inverse contradiction)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-inverse-contradiction-"));
  const manifest = readyManifest("free");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "Requires a premium subscription to unlock all features.";
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.monetization-contradiction" && item.severity === "block"));
});

test("copy claiming iPad support blocks when deviceFamilies is iPhone-only, unless clearly negated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-ipad-"));
  const manifest = readyManifest();
  manifest.app.deviceFamilies = ["iphone"];
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "Beautifully designed for iPad and iPhone alike.";
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.device-family-contradiction" && item.severity === "block"));

  manifest.metadata.localizations["en-US"].description = "This is an iPhone-only app; it is not available on iPad.";
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.description.device-family-contradiction").length, 0);
});

test("copy claiming iPad support does not block when deviceFamilies actually includes ipad", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-ipad-supported-"));
  const manifest = readyManifest();
  manifest.app.deviceFamilies = ["iphone", "ipad"];
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "Beautifully designed for iPad and iPhone alike.";
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.en-US.description.device-family-contradiction").length, 0);
});

// PR review B3: the original negation check scanned a flat 40-character window, so an unrelated
// negation word anywhere nearby (in a DIFFERENT clause) silently cleared the check. "no ads" is
// about as common as App Store copy gets, and neither example below has anything to do with iPad
// support. The fix scopes the negation lookback/lookahead to the same clause (stopping at the
// nearest sentence-ending punctuation or comma) instead of a fixed character count.
test("an unrelated negation in a different clause does not clear a genuine iPad claim (B3)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-ipad-clause-scope-"));
  const manifest = readyManifest();
  manifest.app.deviceFamilies = ["iphone"];
  await writeReadyAssets(root, manifest);
  for (const description of ["There are no ads at all, and it looks stunning on iPad.", "Whether or not you are at your desk, the iPad app keeps everything in sync."]) {
    manifest.metadata.localizations["en-US"].description = description;
    const report = await preflight(root, manifest);
    assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.device-family-contradiction" && item.severity === "block"), `expected a block for: ${description}`);
  }
  // Genuine same-clause negations must still pass cleanly.
  for (const description of ["This is an iPhone-only app; it is not available on iPad.", "Designed for iPhone, not iPad.", "iPad support is coming soon."]) {
    manifest.metadata.localizations["en-US"].description = description;
    const report = await preflight(root, manifest);
    assert.equal(report.results.filter((item) => item.id === "metadata.en-US.description.device-family-contradiction").length, 0, `expected no block for: ${description}`);
  }
});

test("check warns when AI sharing is enabled but no locale's copy mentions AI, and stays silent once it does", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-ai-mention-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors = [{ name: "Example AI", kind: "ai", aiPipelineRecipient: true, purpose: "Summarize receipts", dataCategories: ["Other User Content"], privacyPolicyUrl: "https://example.com/ai-privacy", protectionConfirmation: "confirmed", confirmation: "confirmed" }];
  manifest.aiDataSharing = { enabled: true, dataSent: ["Receipt photo"], purpose: "Summarize receipts", processorNames: ["Example AI"], consent: { shownBeforeTransmission: true, affirmativeAction: "Send to AI", declinePath: "Enter manually", privacyPolicyLinkVisible: true, evidence: [], confirmation: "confirmed" }, privacyPolicy: { identifiesDataAndCollectionMethod: true, identifiesAllUses: true, namesAllProcessors: true, explainsRetentionAndDeletion: true, confirmsEqualProtection: true, evidence: [], confirmation: "confirmed" } };
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.ai-mention" && item.severity === "warn"));

  manifest.metadata.localizations["en-US"].whatsNew = "New: our AI-powered receipt scanner reads totals automatically.";
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.ai-mention").length, 0);
});

test("the AI-mention check stays silent when AI sharing is not enabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-ai-mention-disabled-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "metadata.ai-mention").length, 0);
});

test("prepare writes the drafted copy, character counts, and honest confirmation status into metadata/<locale>.json, never stamping 'confirmed' itself", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-generator-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"] = { name: "Example", subtitle: "Track every receipt", description: "A complete App Store description.", keywords: ["example", "receipts"], confirmation: "needs-human-confirmation" };
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  const json = JSON.parse(await readFile(path.join(generated.directory, "metadata/en-US.json"), "utf8"));
  assert.equal(json.confirmation, "needs-human-confirmation", "generator must never launder an unconfirmed proposal into 'confirmed'");
  assert.equal(json.name, "Example");
  assert.equal(json.subtitle, "Track every receipt");
  assert.equal(json.characterLimits.keywords, 100);
  assert.equal(json.characterCounts.name, "Example".length);
  assert.equal(json.characterCounts.subtitle, "Track every receipt".length);
  assert.equal(json.characterCounts.keywords, Buffer.byteLength("example,receipts", "utf8"));

  manifest.metadata.localizations["en-US"].confirmation = "confirmed";
  const confirmedReport = await preflight(root, manifest, false, analysis);
  const confirmedGenerated = await generateReleasePackage(root, manifest, analysis, confirmedReport, "shiplayer-release");
  const confirmedJson = JSON.parse(await readFile(path.join(confirmedGenerated.directory, "metadata/en-US.json"), "utf8"));
  assert.equal(confirmedJson.confirmation, "confirmed");
});

// PR review B2 (top severity — a false pass): hasUnguardedMatch/hasMatchNotNegatedByNo used to
// call pattern.exec(text) once and return on that single match, so an early GUARDED match (e.g.
// "ad-free" hyphen-compounded, or a "no in-app purchase" negation) short-circuited the whole
// check and a LATER, genuinely unguarded claim in the same field was never even examined. Fixed
// to loop every match, mirroring claimingIpadSupport's own correct /g-loop shape.
test("an early guarded match never hides a later genuine free-claim in the same field (B2)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-multi-match-free-"));
  const manifest = readyManifest("paid-app");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "An ad-free app you will love. Also: this is a free app with no cost at all.";
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.monetization-contradiction" && item.severity === "block"));
  assert.equal(report.canSubmit, false);
});

test("an early negated match never hides a later genuine paid-claim in the same field (B2)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-multi-match-paid-"));
  const manifest = readyManifest("free");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "No in-app purchases in the basic tier. Unlock Pro with an in-app purchase.";
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "metadata.en-US.description.monetization-contradiction" && item.severity === "block"));
});

test("the multi-match fix still lets a genuinely all-guarded field pass (control)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-copy-multi-match-control-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  manifest.metadata.localizations["en-US"].description = "A hassle-free, distraction-free app for tracking every receipt.";
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.includes("monetization-contradiction")).length, 0);
});
