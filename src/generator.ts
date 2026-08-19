import path from "node:path";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { stringify } from "yaml";
import { ensureDirectory, resolveContained, safeRelativePath, stableJson, writeText } from "./fs.js";
import type { AnalysisReport, PreflightReport, ShipLayerManifest } from "./types.js";
import { aiContradictionFindingId, classifiedAiEndpointFindings, endpointFindingUrl, evidenceSources, externalFindingId, externalServiceFindings, MONETIZATION_CONTRADICTION_FINDING, resolveContradictionOverride, storekitPurchaseEvidence } from "./evidence.js";

export interface PreparedPackage { directory: string; files: string[] }
const RESERVED_OUTPUT_ROOTS = new Set([".git", ".shiplayer-staging", "node_modules", "pods", "carthage", "deriveddata", "build", ".build", "dist", ".swiftpm", "vendor", "release", "shiplayer.yml"]);
export async function generateReleasePackage(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport, preflight: PreflightReport, outputDirectory: string): Promise<PreparedPackage> {
  assertManifestPaths(manifest); const outputRelative = safeRelativePath(outputDirectory, "--out"); assertOutputPath(outputRelative); assertOutputDoesNotCollide(manifest, outputRelative); const out = await resolveContained(repository, outputRelative, "--out"); await ensureOutputParent(repository, outputRelative); await assertManagedDestination(out); const stage = await createStage(repository); const files: string[] = []; const emit = async (relativePath: string, contents: string): Promise<void> => { assertNoSecretOutput(contents, relativePath); await writeText(path.join(stage, relativePath), contents); files.push(relativePath); };
  try {
  await emit("manifest.normalized.yml", stringify(manifest, { sortMapEntries: true }));
  // Entry counts include ignored/generated directory entries, which can legitimately
  // change after a prior prepare. Keep the package report reproducible instead of
  // pretending that a runtime traversal counter is stable release metadata.
  const { entriesVisited: _entriesVisited, filesScanned: _filesScanned, filesOverLimit: _filesOverLimit, filesOverLimitPaths: _filesOverLimitPaths, ...packageIgnored } = analysis.ignored;
  const packageAnalysis = { ...analysis, repository: ".", scannedAt: "omitted-for-deterministic-package", ignored: { ...packageIgnored, directories: analysis.ignored.directories.filter((directory) => !/(^|\/)(?:shiplayer-)?release(?:-|$)|(^|\/)\.shiplayer-staging(?:\/|$)/.test(directory)) } };
  const packagePreflight = { ...preflight, repository: "." };
  await emit("reports/analysis.json", stableJson(packageAnalysis)); await emit("reports/preflight.json", stableJson(packagePreflight)); await emit("reports/preflight.md", preflightMarkdown(packagePreflight));
  for (const [locale, copy] of Object.entries(manifest.metadata.localizations)) await emit(`metadata/${locale}.json`, stableJson({ locale, ...copy, characterLimits: { name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100, whatsNew: 4000 } }));
  await emit("privacy/questionnaire-draft.md", await privacyDraft(repository, manifest, analysis)); await emit("privacy/evidence-matrix.json", stableJson({ disclaimer: "Draft only. Apple privacy declarations require human confirmation and must include third-party processing. No-retention/no-training controls do not mean data was not shared.", permissions: manifest.permissions, dataProcessing: manifest.dataProcessing, externalProcessors: manifest.externalProcessors, aiDataSharing: manifest.aiDataSharing, externalServiceDecisions: manifest.externalServiceDecisions, sourceContradictionOverrides: manifest.sourceContradictionOverrides }));
  await emit("compliance/age-rating-and-content-rights.md", complianceDraft(manifest));
  await emit("legal/privacy-policy-draft.html", await privacyPage(repository, manifest, analysis)); await emit("legal/support-page-draft.html", await supportPage(repository, manifest, analysis)); await emit("legal/terms-of-use-draft.md", await termsOfUseDraft(repository, manifest, analysis));
  await emit("review/app-review-notes.md", await appReviewNotes(repository, manifest, analysis)); await emit("review/physical-device-recording-script.md", recordingScript(manifest, analysis));
  await emit("screenshots/capture-plan.json", stableJson(capturePlan(manifest))); await emit("screenshots/marketing-composition-plan.json", stableJson(marketingProject(manifest))); await emit("storekit/checklist.md", await storeKitChecklist(repository, manifest, analysis));
  await emit("app-store-connect/dry-run-plan.md", dryRunPlan(manifest)); await emit("remaining-human-actions.md", humanActions(packagePreflight));
    await writeText(path.join(stage, ".shiplayer-managed"), "ShipLayer managed release package v1\n"); files.push(".shiplayer-managed"); await installStage(stage, out); return { directory: out, files: files.sort() };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
function assertOutputPath(outputRelative: string): void { const components = outputRelative.split("/"); const reserved = components.find((component) => RESERVED_OUTPUT_ROOTS.has(component.toLowerCase()) || component.toLowerCase() === "shiplayer-release"); if (reserved && !(components.length === 1 && reserved === "shiplayer-release")) throw new Error(`--out cannot use reserved or source-control path '${reserved}'. Use a separate managed release directory.`); }
function assertOutputDoesNotCollide(manifest: ShipLayerManifest, outputRelative: string): void {
  const inputs = ["shiplayer.yml", manifest.screenshots.rawOutputDir, manifest.screenshots.marketingProjectPath, ...(manifest.monetization.type === "subscriptions" || manifest.monetization.type === "non-consumables" ? manifest.monetization.products.map((product) => product.reviewScreenshot) : [])].filter((item): item is string => Boolean(item)).map((item) => safeRelativePath(item, "manifest input"));
  const normalizedOutput = outputRelative.toLocaleLowerCase("en-US");
  if (inputs.map((input) => input.toLocaleLowerCase("en-US")).some((input) => normalizedOutput === input || normalizedOutput.startsWith(`${input}/`) || input.startsWith(`${normalizedOutput}/`))) throw new Error("--out collides with a manifest source input. Choose a separate managed release directory.");
}
async function createStage(repository: string): Promise<string> {
  const root = await resolveContained(repository, ".shiplayer-staging", "staging directory");
  try { if ((await lstat(root)).isSymbolicLink()) throw new Error("staging directory cannot be a symlink."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("staging directory cannot be a symlink.");
  const stage = path.join(root, `package-${process.pid}-${Date.now()}`); await mkdir(stage, { mode: 0o700 }); return stage;
}
async function ensureOutputParent(repository: string, outputRelative: string): Promise<void> {
  const parentRelative = path.posix.dirname(outputRelative); if (parentRelative === ".") return;
  const parent = await resolveContained(repository, parentRelative, "--out parent directory"); await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) throw new Error("--out parent directory cannot be a symlink.");
}
async function assertManagedDestination(destination: string): Promise<void> { let details; try { details = await lstat(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } if (details.isSymbolicLink()) throw new Error("--out cannot be a symlink."); if (!details.isDirectory()) throw new Error("--out exists but is not a directory."); const marker = path.join(destination, ".shiplayer-managed"); let markerInfo; try { markerInfo = await lstat(marker); } catch { throw new Error("--out is not a ShipLayer-managed package; refusing to overwrite unrelated files."); } if (markerInfo.isSymbolicLink()) throw new Error("Managed output marker cannot be a symlink."); if (!(await readFile(marker, "utf8")).startsWith("ShipLayer managed release package v1")) throw new Error("--out is not a ShipLayer-managed package; refusing to overwrite unrelated files."); }
async function installStage(stage: string, destination: string): Promise<void> {
  let exists = true; try { await lstat(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  if (!exists) { await rename(stage, destination); return; }
  const backup = path.join(path.dirname(destination), `.${path.basename(destination)}.shiplayer-backup-${process.pid}-${Date.now()}`);
  try {
    await rename(destination, backup);
    try { await rename(stage, destination); }
    catch (error) { await rename(backup, destination).catch(() => undefined); throw error; }
    await rm(backup, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) { throw error; }
}
function assertManifestPaths(manifest: ShipLayerManifest): void { safeRelativePath(manifest.screenshots.rawOutputDir, "screenshots.rawOutputDir"); if (manifest.screenshots.marketingProjectPath) safeRelativePath(manifest.screenshots.marketingProjectPath, "screenshots.marketingProjectPath"); if (manifest.monetization.type === "non-consumables" || manifest.monetization.type === "subscriptions") for (const product of manifest.monetization.products) safeRelativePath(product.reviewScreenshot, `review screenshot for ${product.productId}`); }
function assertNoSecretOutput(contents: string, label: string): void { if (/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i.test(contents) || /\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|secret|password|private[ _-]?key)\s*[:=]\s*\S+/i.test(contents) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(contents)) throw new Error(`Refusing to generate ${label} because it appears to contain credential material.`); }

// --- shared "did the scan contradict this declaration" helpers, used by every generated ------
// artifact below that would otherwise assert a confident absence it never actually checked.

/** Undefined when monetization is non-consumables/subscriptions (already declares purchases) or no StoreKit evidence exists. */
async function monetizationContradictionInfo(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<{ evidenceFiles: string[]; overrideReason?: string } | undefined> {
  if (manifest.monetization.type === "non-consumables" || manifest.monetization.type === "subscriptions") return undefined;
  const evidence = storekitPurchaseEvidence(analysis);
  if (!evidence.length) return undefined;
  const evidenceFiles = evidenceSources(evidence);
  const override = await resolveContradictionOverride(repository, manifest, MONETIZATION_CONTRADICTION_FINDING, evidenceFiles);
  return { evidenceFiles, overrideReason: override?.reason };
}

/** Undefined when aiDataSharing.enabled is true, or no AI/inference endpoint evidence exists. */
async function aiContradictionInfo(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<{ unresolvedEndpoints: string[]; overriddenReasons: string[] } | undefined> {
  if (manifest.aiDataSharing.enabled) return undefined;
  const { strong } = classifiedAiEndpointFindings(analysis);
  if (!strong.length) return undefined;
  const unresolvedEndpoints: string[] = []; const overriddenReasons: string[] = [];
  for (const item of strong) {
    const override = await resolveContradictionOverride(repository, manifest, aiContradictionFindingId(item.finding), evidenceSources([item.finding]));
    if (override) overriddenReasons.push(override.reason); else unresolvedEndpoints.push(endpointFindingUrl(item.finding));
  }
  if (!unresolvedEndpoints.length && !overriddenReasons.length) return undefined;
  return { unresolvedEndpoints, overriddenReasons };
}

async function privacyDraft(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> {
  const lines = ["# App Privacy questionnaire draft", "", "> Not legal advice. Confirm each answer in App Store Connect; do not submit this draft unreviewed.", "", "## Protected-resource permissions"];
  const unresolvedPermissions = analysis.findings.filter((finding) => finding.key.startsWith("permission:") && !manifest.permissions.some((permission) => finding.key === `permission:${permission.key}`));
  if (manifest.permissions.length) lines.push(...manifest.permissions.map((permission) => `- **${permission.key}** — ${permission.purpose || "Purpose missing"}; confirmation: ${permission.confirmation}.`));
  else if (unresolvedPermissions.length) lines.push(`- UNVERIFIED: no permissions are declared, but the scanner detected ${unresolvedPermissions.map((finding) => finding.key.slice("permission:".length)).join(", ")} in source. Reconcile before submission.`);
  else lines.push("- No permissions declared. Confirm this is accurate.");
  lines.push("", "## Data categories", ...(manifest.dataProcessing.length ? manifest.dataProcessing.map((item) => `- **${item.category}** — purposes: ${item.purpose.join(", ") || "missing"}; linked to identity: ${item.linkedToIdentity}; tracking: ${item.usedForTracking}; confirmation: ${item.confirmation}.`) : ["- No data categories declared. Confirm all collection, including processor collection."]));
  const unresolvedServices = unresolvedExternalServiceMessage(manifest, analysis);
  if (manifest.externalProcessors.length) lines.push("", "## External processors", ...manifest.externalProcessors.map((processor) => `- **${processor.name}** (${processor.kind}) — ${processor.purpose}; data: ${processor.dataCategories.join(", ")}; AI-pipeline recipient: ${processor.aiPipelineRecipient}; policy: ${processor.privacyPolicyUrl}; equal protection: ${processor.protectionConfirmation}; confirmation: ${processor.confirmation}.`));
  else if (unresolvedServices) lines.push("", "## External processors", `- ${unresolvedServices}`);
  else lines.push("", "## External processors", "- No external processors declared. Confirm SDKs and network endpoints.");
  const aiContradiction = await aiContradictionInfo(repository, manifest, analysis);
  if (manifest.aiDataSharing.enabled) lines.push("", "## Third-party AI sharing", `- Data sent: ${manifest.aiDataSharing.dataSent.join("; ")}\n- Purpose: ${manifest.aiDataSharing.purpose}\n- Named recipients: ${manifest.aiDataSharing.processorNames.join(", ")}\n- Pre-transmission consent action: ${manifest.aiDataSharing.consent.affirmativeAction}\n- Decline path: ${manifest.aiDataSharing.consent.declinePath}\n- Reminder: no-training or Zero Data Retention controls reduce use/retention but do not mean the data was never shared.`);
  else if (aiContradiction?.unresolvedEndpoints.length) lines.push("", "## Third-party AI sharing", `- UNVERIFIED: no third-party AI data sharing is declared, but the scanner detected a call to ${aiContradiction.unresolvedEndpoints.join(", ")} shaped like an AI/inference API. Reconcile before submission; see the ai-sharing.source-contradiction preflight blocker.`);
  else if (aiContradiction?.overriddenReasons.length) lines.push("", "## Third-party AI sharing", `- No third-party AI data sharing is declared. AI/inference endpoint evidence was human-overridden: ${aiContradiction.overriddenReasons.join("; ")}.`);
  else lines.push("", "## Third-party AI sharing", "- No third-party AI data sharing declared. Confirm this matches all source endpoints and SDKs.");
  return `${lines.join("\n")}\n`;
}
function complianceDraft(manifest: ShipLayerManifest): string { return `# Age rating and content-rights checklist\n\n> Draft only; not legal advice. ShipLayer never infers these declarations from source code.\n\n- Age-rating questionnaire: **${manifest.confirmations.ageRating}**. Complete the current App Store Connect questionnaire and record any regional ratings.\n- Content rights: **${manifest.confirmations.contentRights}**. Confirm whether the app contains, shows, or accesses third-party content, then make the App Store Connect declaration.\n`; }
async function privacyPage(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> {
  const app = escapeHtml(manifest.app.name || "This app"); const permissions = manifest.permissions.filter((item) => item.confirmation === "confirmed"); const processors = manifest.externalProcessors.filter((item) => item.confirmation === "confirmed");
  const aiContradiction = await aiContradictionInfo(repository, manifest, analysis);
  const ai = manifest.aiDataSharing.enabled ? `<h2>Optional third-party AI processing</h2><p>After an in-app disclosure and explicit permission, the app sends ${escapeHtml(manifest.aiDataSharing.dataSent.join("; "))} to ${escapeHtml(manifest.aiDataSharing.processorNames.join(", "))} for ${escapeHtml(manifest.aiDataSharing.purpose)}. Users can decline via ${escapeHtml(manifest.aiDataSharing.consent.declinePath)}.</p><p>Explain actual collection/transmission, retention and deletion, consent withdrawal, international transfers, and how every processor provides the same or equal protection. Do not claim that Zero Data Retention or no-training means no sharing occurred.</p>` : aiContradiction?.unresolvedEndpoints.length ? `<h2>Optional third-party AI processing</h2><p><strong>UNVERIFIED:</strong> no AI data sharing is declared, but the scan detected a call to ${escapeHtml(aiContradiction.unresolvedEndpoints.join(", "))} shaped like an AI/inference API. This must be reconciled before publishing.</p>` : "";
  const unresolvedPermissions = analysis.findings.filter((finding) => finding.key.startsWith("permission:") && !manifest.permissions.some((permission) => finding.key === `permission:${permission.key}` && permission.confirmation === "confirmed"));
  const permissionsHtml = permissions.map((item) => `<li>${escapeHtml(item.key)}: ${escapeHtml(item.purpose || "purpose to be confirmed")}.</li>`).join("") || (unresolvedPermissions.length ? `<li>UNVERIFIED: the scanner detected ${escapeHtml(unresolvedPermissions.map((finding) => finding.key.slice("permission:".length)).join(", "))} with no confirmed manifest permission.</li>` : "<li>No confirmed permissions are listed.</li>");
  const noProcessorsClaim = unresolvedExternalServiceHtml(manifest, analysis, "<li>No confirmed third-party processors are listed.</li>");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${app} Privacy Policy</title></head><body><main><h1>${app} Privacy Policy</h1><p><strong>Draft generated by ShipLayer.</strong> Publish only after legal review and confirmation of every statement.</p><h2>Information handled by the app</h2><ul>${manifest.dataProcessing.filter((item) => item.confirmation === "confirmed").map((item) => `<li>${escapeHtml(item.category)}: used for ${escapeHtml(item.purpose.join(", ") || "the app's functionality")}.</li>`).join("") || "<li>Confirm and describe data handling before publishing.</li>"}</ul><h2>Device permissions</h2><ul>${permissionsHtml}</ul><h2>Service providers</h2><ul>${processors.map((item) => `<li>${escapeHtml(item.name)} (${escapeHtml(item.kind)}): ${escapeHtml(item.purpose)}. Policy: <a href="${escapeHtml(item.privacyPolicyUrl)}">${escapeHtml(item.privacyPolicyUrl)}</a>.</li>`).join("") || noProcessorsClaim}</ul>${ai}<h2>Contact</h2><p>${manifest.contacts.supportEmail ? `Contact <a href="mailto:${escapeHtml(manifest.contacts.supportEmail)}">${escapeHtml(manifest.contacts.supportEmail)}</a>.` : "Add a support contact before publishing."}</p></main></body></html>`;
}
/**
 * Never let a generated artifact assert "none/no confirmed X" when the scanner detected source
 * evidence that has not been reconciled with a confirmed manifest disposition. Returns the
 * caller's clean-bill-of-health `<li>` HTML only when there is genuinely nothing unresolved;
 * otherwise a `<li>` naming the unresolved finding(s), escaped for HTML.
 */
function unresolvedExternalServiceHtml(manifest: ShipLayerManifest, analysis: AnalysisReport, cleanFallbackHtml: string): string {
  const message = unresolvedExternalServiceMessage(manifest, analysis);
  return message ? `<li>${escapeHtml(message)}</li>` : cleanFallbackHtml;
}
/** Same check as unresolvedExternalServiceHtml, returning plain text (or undefined if clean) for Markdown/plain-text artifacts. */
function unresolvedExternalServiceMessage(manifest: ShipLayerManifest, analysis: AnalysisReport): string | undefined {
  const unresolved = externalServiceFindings(analysis).filter((finding) => !manifest.externalServiceDecisions.some((decision) => decision.finding === externalFindingId(finding) && decision.confirmation === "confirmed"));
  if (!unresolved.length) return undefined;
  return `UNVERIFIED: the scanner detected ${unresolved.length} network/SDK finding(s) not yet reconciled with a confirmed processor or disposition: ${unresolved.map((finding) => externalFindingId(finding)).join(", ")}. Confirm each before submission.`;
}
async function supportPage(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> { const app = escapeHtml(manifest.app.name || "This app"); const restore = await restoreText(repository, manifest, analysis); return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${app} Support</title></head><body><main><h1>${app} Support</h1><p><strong>Draft generated by ShipLayer. Review before publishing.</strong></p><p>For help with ${app}, contact ${manifest.contacts.supportEmail ? `<a href="mailto:${escapeHtml(manifest.contacts.supportEmail)}">${escapeHtml(manifest.contacts.supportEmail)}</a>` : "the support email to be added"}.</p><h2>Purchases</h2><p>${escapeHtml(restore)}</p></main></body></html>`; }
async function termsOfUseDraft(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> {
  if (manifest.monetization.type !== "subscriptions") {
    const contradiction = await monetizationContradictionInfo(repository, manifest, analysis);
    const caveat = contradiction && !contradiction.overrideReason ? ` The scanner detected StoreKit purchase evidence in ${contradiction.evidenceFiles.join(", ")} that disagrees with this declaration — see the monetization.source-contradiction preflight blocker before assuming no Terms of Use artifact is needed.` : "";
    return `# Terms of Use / EULA\n\n> Draft only; not legal advice. This release has no declared auto-renewable subscription Terms of Use artifact.${caveat}\n`;
  }
  const terms = manifest.monetization.termsOfUse;
  return `# Terms of Use / EULA\n\n> Draft only; not legal advice. A human must confirm the App Store Connect selection and publish/review any custom terms.\n\n- Selection: **${terms.type}**\n- Confirmation: **${terms.confirmation}**\n- Public terms URL: ${manifest.monetization.termsUrl}\n\n${terms.type === "apple-standard-eula" ? "Use Apple's Standard Licensed Application End User License Agreement in App Store Connect. Verify it is appropriate for this app before submission." : "Use the public custom Terms of Use URL above only after legal review. ShipLayer does not author or validate custom legal terms."}\n`;
}
export async function appReviewNotes(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> {
  const confirmedProcessors = manifest.externalProcessors.filter((processor) => processor.confirmation === "confirmed");
  const unresolvedServices = unresolvedExternalServiceMessage(manifest, analysis);
  const externalServicesLines = confirmedProcessors.map((processor) => `- ${processor.name}: ${processor.purpose}.`);
  if (unresolvedServices) externalServicesLines.push(`- ${unresolvedServices}`);
  else if (!externalServicesLines.length) externalServicesLines.push("- No confirmed external processors are listed. Confirm this is accurate before submission.");
  const monetizationLine = await monetizationText(repository, manifest, analysis);
  const lines = [`# ${manifest.app.name || "App"} — App Review Notes`, "", "> Draft only. Verify every statement and enter actual demo credentials in App Store Connect's secure review fields, not this file.", "", "## Access", manifest.review.demoAccount?.required ? `A demo account is required. Configure the reviewer username/password in App Store Connect secure fields. ${manifest.review.demoAccount.setupInstructions || "Setup instructions are missing."}` : "No account, registration, or login is required.", "", "## Setup", ...(manifest.review.sampleData?.length ? manifest.review.sampleData.map((sample) => `- ${sample}`) : ["- Use the normal first-run flow. Add sample content as described in the recording script."]), "", "## External services", ...externalServicesLines, ...(manifest.aiDataSharing.enabled ? ["", "## Third-party AI consent", `Before transmission the app states that it sends ${manifest.aiDataSharing.dataSent.join("; ")} to ${manifest.aiDataSharing.processorNames.join(", ")} for ${manifest.aiDataSharing.purpose}. The affirmative action is “${manifest.aiDataSharing.consent.affirmativeAction}”; the non-AI path is ${manifest.aiDataSharing.consent.declinePath}.`] : []), "", "## Monetization", monetizationLine, "", "## Recording scenarios", ...manifest.review.recordingScenarios.map((scenario, index) => `${index + 1}. ${scenario.title}: ${scenario.steps.join(" → ")}`)];
  if (manifest.review.notes) lines.push("", "## Additional notes", manifest.review.notes); return `${lines.join("\n")}\n`;
}
function recordingScript(manifest: ShipLayerManifest, analysis: AnalysisReport): string {
  const scenarios = manifest.review.recordingScenarios.length ? manifest.review.recordingScenarios : manifest.screenshots.scenarios;
  const aiEvidence = manifest.aiDataSharing.enabled || classifiedAiEndpointFindings(analysis).strong.length > 0;
  const storeKitEvidence = manifest.monetization.type === "subscriptions" || manifest.monetization.type === "non-consumables" || storekitPurchaseEvidence(analysis).length > 0;
  const gates = [aiEvidence ? "Show the complete AI data/recipient disclosure, privacy link, explicit permission action, and decline/manual path before any network transmission." : "", storeKitEvidence ? "Show StoreKit's localized price visibly loaded before the enabled purchase action, then show purchase and Restore Purchases." : ""].filter(Boolean);
  return `# Physical-device App Review recording\n\nRecord one continuous video on a physical device. Begin by launching the current submitted build. Show any permission prompt, login, paywall/purchase/restore flow, and the core workflow. Do not use a simulator recording.\n${gates.map((gate) => `- ${gate}`).join("\n")}\n\n${scenarios.map((scenario, index) => `## ${index + 1}. ${scenario.title}\n${scenario.launchArguments?.length ? `Launch arguments: ${scenario.launchArguments.join(" ")}\n` : ""}${scenario.steps.map((step) => `- ${step}`).join("\n")}`).join("\n\n")}\n`;
}
function capturePlan(manifest: ShipLayerManifest): object { return { command: "shiplayer capture <repo>", prerequisites: ["macOS with Xcode for direct simulator capture", "Configured scheme and launch arguments", "No paid CI is used automatically"], configurations: manifest.screenshots.configurations.map((configuration) => ({ ...configuration, outputDirectory: `${manifest.screenshots.rawOutputDir}/${configuration.family}/${configuration.locale}`, scenarios: manifest.screenshots.scenarios.map((scenario) => ({ id: scenario.id, outputFile: `${scenario.id}.png`, title: scenario.title, launchArguments: scenario.launchArguments || [], steps: scenario.steps })) })), note: "This is a neutral hand-off. Create or use a separate app-store-screenshots scaffold/template; this JSON is not directly importable by that editor. Raw device screenshots must show the actual app and use each scenario ID as the filename." }; }
function marketingProject(manifest: ShipLayerManifest): object { return { version: 1, purpose: "Neutral hand-off plan for a separately installed app-store-screenshots editor; not an editor project file.", rawScreenshotRoot: manifest.screenshots.rawOutputDir, decks: manifest.screenshots.configurations.map((configuration) => ({ family: configuration.family, device: configuration.device, locale: configuration.locale, outputPath: `${manifest.screenshots.rawOutputDir}/${configuration.family}/${configuration.locale}/{scenario-id}.png`, slides: manifest.screenshots.scenarios.map((scenario, index) => ({ id: scenario.id, order: index, headline: scenario.title, body: scenario.steps[0] || "Describe this feature" })) })) }; }
async function storeKitChecklist(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> {
  const lines = ["# StoreKit / App Store Connect checklist", "", `Monetization model: **${manifest.monetization.type}**`, ""];
  if (manifest.monetization.type === "free" || manifest.monetization.type === "paid-app") {
    const contradiction = await monetizationContradictionInfo(repository, manifest, analysis);
    if (contradiction && !contradiction.overrideReason) lines.push(`- UNVERIFIED: monetization is declared '${manifest.monetization.type}', but the scanner found StoreKit purchase evidence in ${contradiction.evidenceFiles.join(", ")}. Resolve this before submission; see the monetization.source-contradiction preflight blocker.`);
    else if (manifest.monetization.type === "free") lines.push("- No StoreKit products configured.");
    else lines.push(`- Configure paid app price point: ${manifest.monetization.pricePointReference}.`);
  } else if (manifest.monetization.type === "non-consumables") for (const product of manifest.monetization.products) lines.push(`- Non-consumable: ${product.productId} — ${product.referenceName}; primary localization required: ${manifest.app.primaryLocale}.`);
  else { lines.push(`- Subscription group: ${manifest.monetization.group.referenceName}.`, `- Group localizations: ${Object.entries(manifest.monetization.group.localizations).map(([locale, copy]) => `${locale}=${copy.displayName}`).join(", ")}.`, `- Base territory: ${manifest.monetization.baseTerritory}.`, `- Paywall navigation: ${manifest.monetization.paywallNavigation}.`, `- Restore path: ${manifest.monetization.restorePath}.`); for (const product of manifest.monetization.products) lines.push(`- Level ${product.level}: ${product.productId}; ${product.duration}; intro offer: ${product.introductoryOffer ? `${product.introductoryOffer.type} ${product.introductoryOffer.duration}${product.introductoryOffer.numberOfPeriods ? ` × ${product.introductoryOffer.numberOfPeriods} periods` : ""}` : "none"}.`); }
  if (manifest.monetization.type === "subscriptions" || manifest.monetization.type === "non-consumables") lines.push("", "- Load the StoreKit Product before purchase.", "- Show Product.displayPrice (localized for the current storefront) before enabling the purchase action.", "- If the Product or price is unavailable, disable purchase and show retry without starting payment.", "- Keep UI/snapshot evidence proving the visible price before purchase.");
  lines.push("", "Before submission, confirm StoreKit product IDs match code and App Store Connect, paywall copy displays price/duration where required, Restore Purchases works, and review screenshots/notes are attached.");
  return `${lines.join("\n")}\n`;
}
function dryRunPlan(manifest: ShipLayerManifest): string { return `# App Store Connect dry-run plan\n\nShipLayer has not made any remote changes. A future explicit command may perform read-only discovery of:\n\n- App identity and version metadata for \`${manifest.app.bundleId || "MISSING_BUNDLE_ID"}\`\n- Localizations, build availability, screenshot sets, and App Review details\n- In-App Purchase/subscription state\n\nManual-only or human-confirmed steps remain: initial app record creation, agreements, tax/banking, trader declarations, privacy/legal declarations, asset review, and final submission.\n`; }
function humanActions(report: PreflightReport): string { const actions = [...report.results.filter((result) => result.severity !== "pass").map((result) => `${result.message}${result.remediation ? ` — ${result.remediation}` : ""}`), "Verify/create the App Store Connect app record and enter its ID in the manifest.", "Enter and verify metadata, URLs, contacts, copyright, category, availability, release mode, and select the uploaded build/version in App Store Connect.", "Upload and review actual App Store screenshots for every supported device family.", "Confirm Apple Silicon Mac and Apple Vision Pro availability/compatibility, or leave each disabled after testing the chosen distribution.", "Complete App Privacy, age rating, content-rights, trader, agreement, tax/banking, and legal declarations in App Store Connect.", "Verify the public Support URL contains usable contact information.", "Perform all IAP/subscription pricing, availability, localization, review-asset, paywall, restore, and disclosure setup manually where applicable; attach a first IAP/subscription to the app-version review submission.", "Make the final review submission/release decision in App Store Connect; ShipLayer v0.1 never submits it."]; return `# Remaining human actions\n\n${[...new Set(actions)].sort().map((action) => `- [ ] ${action}`).join("\n")}\n\nNever treat generated privacy/legal text as legal advice. Confirm every declaration in App Store Connect.\n`; }
function preflightMarkdown(report: PreflightReport): string { return `# ShipLayer preflight\n\n| Result | Count |\n|---|---:|\n| Pass | ${report.summary.pass} |\n| Warning | ${report.summary.warn} |\n| Blocker | ${report.summary.block} |\n\n${report.results.map((result) => `- **${result.severity.toUpperCase()}** \`${result.id}\` — ${result.message}${result.remediation ? ` _${result.remediation}_` : ""}`).join("\n")}\n`; }
async function monetizationText(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> {
  if (manifest.monetization.type === "free" || manifest.monetization.type === "paid-app") {
    const contradiction = await monetizationContradictionInfo(repository, manifest, analysis);
    if (contradiction) {
      const evidenceFiles = contradiction.evidenceFiles.join(", ");
      if (contradiction.overrideReason) return `No In-App Purchases or subscriptions are declared. Source contains StoreKit purchase evidence in ${evidenceFiles}; a human has overridden this as not a real purchase: ${contradiction.overrideReason}. Verify before submission.`;
      return `UNVERIFIED: no In-App Purchases or subscriptions are declared, but the scanner detected StoreKit purchase evidence in ${evidenceFiles} that has not been reconciled with this manifest. Resolve this contradiction before submission.`;
    }
    return manifest.monetization.type === "free" ? "No In-App Purchases or subscriptions are offered." : `The app is paid at price point ${manifest.monetization.pricePointReference}.`;
  }
  if (manifest.monetization.type === "non-consumables") return `Non-consumable products: ${manifest.monetization.products.map((product) => product.productId).join(", ")}. Include each product's paywall navigation and Restore Purchases path in the final notes.`;
  return `Auto-renewable subscription group ${manifest.monetization.group.referenceName}. Reviewer navigation: ${manifest.monetization.paywallNavigation}. Restore path: ${manifest.monetization.restorePath}.`;
}
async function restoreText(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport): Promise<string> {
  if (manifest.monetization.type === "free" || manifest.monetization.type === "paid-app") {
    const contradiction = await monetizationContradictionInfo(repository, manifest, analysis);
    if (contradiction && !contradiction.overrideReason) return `UNVERIFIED: this app does not declare restorable in-app purchases, but the scanner detected StoreKit purchase evidence in ${contradiction.evidenceFiles.join(", ")}. Resolve this before publishing.`;
    return "This app does not offer restorable in-app purchases.";
  }
  return manifest.monetization.type === "subscriptions" ? `To restore a subscription, ${manifest.monetization.restorePath}` : `To restore a previous purchase, ${manifest.monetization.restorePath}`;
}
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
