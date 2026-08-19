import path from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AnalysisReport, CheckResult, PreflightReport, ShipLayerManifest } from "./types.js";
import { analyzeRepository, findValue } from "./scanner.js";
import { resolveContained, walkRepository } from "./fs.js";
import { inspectImage } from "./image.js";
import { validateAscPrivateKey } from "./asc.js";
import { appReviewNotes } from "./generator.js";
import { aiContradictionFindingId, classifiedAiEndpointFindings, endpointFindingUrl, evidenceSources, externalFindingId, isNonProductionSourcePath, MONETIZATION_CONTRADICTION_FINDING, resolveContradictionOverride, storekitPurchaseEvidence } from "./evidence.js";

const IPHONE_SCREENSHOT_DIMENSIONS = new Set([
  "1320x2868", // iPhone 6.9-inch
  "1290x2796", // iPhone 6.9-inch
  "1260x2736", // iPhone 6.7-inch
  "1242x2688", // iPhone 6.5-inch
  "1284x2778" // iPhone 6.5-inch legacy
]);
const IPAD_SCREENSHOT_DIMENSIONS = new Set([
  "2064x2752", // iPad 13-inch
  "2048x2732" // iPad 12.9-inch
]);
// Storefront decks use the focused current marketing classes above. App Review
// screenshots may use any supported capture size for a declared device family.
const IPHONE_REVIEW_SCREENSHOT_DIMENSIONS = new Set([...IPHONE_SCREENSHOT_DIMENSIONS, "1206x2622", "1179x2556", "1170x2532", "1125x2436", "1080x2340", "828x1792", "1242x2208", "750x1334", "640x1136", "640x1096", "640x960", "640x920", "2622x1206", "2556x1179", "2532x1170", "2436x1125", "2340x1080", "1792x828", "2208x1242", "1334x750", "1136x640", "1096x640", "960x640", "920x640"]);
const IPAD_REVIEW_SCREENSHOT_DIMENSIONS = new Set([...IPAD_SCREENSHOT_DIMENSIONS, "2048x2732", "1668x2388", "1668x2224", "1640x2360", "1536x2048", "1488x2266", "1668x2420", "1536x2008", "768x1004", "768x1024", "2266x1488", "2420x1668", "2008x1536", "1004x768", "1024x768"]);
const APPLE_CATEGORIES = new Set(["Books", "Business", "Developer Tools", "Education", "Entertainment", "Finance", "Food & Drink", "Games", "Graphics & Design", "Health & Fitness", "Lifestyle", "Magazines & Newspapers", "Medical", "Music", "Navigation", "News", "Photo & Video", "Productivity", "Reference", "Shopping", "Social Networking", "Sports", "Travel", "Utilities", "Weather"]);

type Add = (id: string, severity: CheckResult["severity"], message: string, remediation?: string) => void;

export async function preflight(repository: string, manifest: ShipLayerManifest, remoteRequested = false, analysis?: AnalysisReport): Promise<PreflightReport> {
  const results: CheckResult[] = [];
  const add: Add = (id, severity, message, remediation) => results.push({ id, severity, message, remediation });
  const app = manifest.app;
  // A caller (e.g. `prepare`) may already have scanned the repository; reuse that analysis
  // instead of scanning twice. `check`/most callers do not have one yet, so scan here.
  const scan = analysis ?? await analyzeRepository(repository);

  addRequired(add, "app.name", app.name, "App name is missing.", "Set app.name in shiplayer.yml.");
  addRequired(add, "app.bundle-id", app.bundleId, "Bundle ID is missing.", "Confirm the production bundle ID.");
  addRequired(add, "build.version", Boolean(app.version && app.build), "Version or build is missing.", "Confirm the archive version/build before upload.");
  addRequired(add, "app.primary-category", app.primaryCategory, "Primary App Store category is missing.", "Choose app.primaryCategory.");
  if (app.primaryCategory && !APPLE_CATEGORIES.has(app.primaryCategory)) add("app.primary-category.allowed", "block", `${app.primaryCategory} is not an Apple App Store primary category.`, "Choose an Apple category name from the current App Store Connect list.");
  if (app.secondaryCategory && !APPLE_CATEGORIES.has(app.secondaryCategory)) add("app.secondary-category.allowed", "block", `${app.secondaryCategory} is not an Apple App Store secondary category.`, "Choose an Apple category name from the current App Store Connect list.");
  addRequired(add, "contacts.support-url", isHttps(manifest.contacts.supportUrl), "A public HTTPS Support URL is required.", "Set contacts.supportUrl.");
  addRequired(add, "contacts.privacy-url", isHttps(manifest.contacts.privacyUrl), "A public HTTPS Privacy Policy URL is required.", "Set contacts.privacyUrl after legal review.");
  addRequired(add, "contacts.copyright", manifest.contacts.copyright, "Copyright is missing.", "Set contacts.copyright.");
  if (manifest.contacts.copyright && !/^\d{4}\s+\S/.test(manifest.contacts.copyright.trim())) add("contacts.copyright.format", "block", "Copyright must begin with a four-digit year followed by the rights-holder name.", "Use a human-confirmed value such as '2026 Example, Inc.'; do not fabricate the rights holder.");
  if (app.availability === "selected") add("availability.selected", "block", "Selected-territory availability is not modeled in v0.1.", "Choose territories manually in App Store Connect and record the decision before submission.");
  else add("availability", "pass", "Availability is configured for all territories.");
  if (app.releaseMode === "scheduled") add("release.scheduled", "block", "Scheduled release requires a human-confirmed date/time and is not modeled in v0.1.", "Set the release schedule manually in App Store Connect before submission.");
  else add("release.mode", "pass", `Release mode is ${app.releaseMode}.`);
  if (manifest.contacts.supportEmail) add("contacts.support-email", "pass", "Support email is present.");
  else add("contacts.support-email", "warn", "Support email is absent.", "Add a support email for a real support channel.");
  if (app.appStoreAppId) add("app.store-id", "pass", "App Store Connect app ID is present.");
  else add("app.store-id", "block", "App Store Connect app ID is absent; submission cannot target a confirmed app record.", "Create the initial app record manually, then add app.appStoreAppId.");

  const contact = manifest.review.contact;
  addRequired(add, "review.contact", Boolean(contact?.firstName && contact.lastName && contact.email && contact.phone), "App Review contact is incomplete.", "Set first name, last name, email, and phone.");
  const demo = manifest.review.demoAccount;
  if (demo?.required && (!demo.usernameEnv || !demo.passwordEnv || !demo.setupInstructions || demo.credentialsEnteredConfirmation !== "confirmed")) add("review.demo-account", "block", "Demo account is required but secure references, setup instructions, or confirmation that non-expiring reviewer credentials were entered in App Store Connect are incomplete.", "Set only environment-variable names, record setup instructions, and explicitly confirm the credentials were entered in App Store Connect's secure review fields; never put credentials in the manifest.");
  else if (demo?.required) add("review.demo-account", "pass", "Demo account uses secure environment-variable references and has a human confirmation.");
  else add("review.demo-account", "warn", "No login is required (self-declared; the scanner cannot verify the absence of an auth/login flow).", "Confirm during manual review that first launch truly requires no account or login.");
  const generatedReviewNotes = await appReviewNotes(repository, manifest, scan);
  const reviewBytes = Buffer.byteLength(generatedReviewNotes, "utf8");
  if (reviewBytes > 4_000) add("review.notes.length", "block", `Generated App Review notes have ${reviewBytes} UTF-8 bytes; Apple allows at most 4,000.`, "Shorten review notes, setup instructions, sample data, or scenarios.");
  else add("review.notes.length", "pass", `Generated App Review notes have ${reviewBytes} UTF-8 bytes.`);

  metadataChecks(manifest, add);
  permissionChecks(manifest, add);
  exportComplianceCheck(manifest, add);
  confirmationChecks(manifest, add);
  await monetizationChecks(repository, manifest, scan, add);
  await aiDataSharingChecks(repository, manifest, scan, add);
  await purchasePresentationChecks(repository, manifest, add);
  screenshotConfigurationChecks(manifest, add);
  await screenshotChecks(repository, manifest, add);
  await purchaseAssetChecks(repository, manifest, add);
  await iconChecks(repository, manifest, add);
  await sourceConsistencyChecks(repository, manifest, scan, add);

  if (remoteRequested) {
    const pairs = [["key ID", manifest.sync.appStoreConnectKeyIdEnv], ["issuer ID", manifest.sync.issuerIdEnv], ["private-key path", manifest.sync.privateKeyPathEnv]] as const;
    const missingReferences = pairs.filter(([, reference]) => !reference).map(([label]) => label);
    const missingValues = pairs.filter(([, reference]) => reference && !process.env[reference]).map(([, reference]) => reference as string);
    if (missingReferences.length || missingValues.length) add("asc.credentials", "block", `Remote App Store Connect discovery lacks ${[...missingReferences, ...missingValues].join(", ")}.`, "Set all three environment-variable references and values locally; never put secrets in shiplayer.yml.");
    else {
      const keyPath = process.env[manifest.sync.privateKeyPathEnv as string] as string;
      try { await validateAscPrivateKey(keyPath); add("asc.credentials", "pass", "Remote App Store Connect credential references contain a readable EC P-256 private key."); }
      catch { add("asc.credentials", "block", "Remote App Store Connect private-key path is unreadable or not an EC P-256 key.", "Set the private-key path environment variable to a readable EC P-256 .p8 file; never put key material in shiplayer.yml."); }
    }
  }

  const summary = summarize(results);
  // A valid manifest can always be rendered into a local draft package. Submission
  // blockers guard remote/apply/submit, not evidence collection or draft generation.
  return {
    repository: path.resolve(repository),
    results,
    summary,
    canPrepare: true,
    canApply: summary.block === 0 && manifest.sync.mode === "apply",
    canSubmit: summary.block === 0 && manifest.confirmations.privacy === "confirmed" && manifest.confirmations.legal === "confirmed"
  };
}

function addRequired(add: Add, id: string, value: unknown, missing: string, remediation: string): void {
  if (value) add(id, "pass", id === "build.version" ? "Version and build are declared." : `${id} is present.`);
  else add(id, "block", missing, remediation);
}

function isHttps(value: string | undefined): boolean { try { const url = new URL(value || ""); return url.protocol === "https:" && Boolean(url.hostname); } catch { return false; } }
function summarize(results: CheckResult[]): PreflightReport["summary"] { return { pass: results.filter((item) => item.severity === "pass").length, warn: results.filter((item) => item.severity === "warn").length, block: results.filter((item) => item.severity === "block").length }; }

function metadataChecks(manifest: ShipLayerManifest, add: Add): void {
  const limits: Record<string, number> = { name: 30, subtitle: 30, promotionalText: 170, description: 4000, whatsNew: 4000 };
  const primary = manifest.metadata.localizations[manifest.app.primaryLocale];
  for (const field of ["name", "description", "keywords"] as const) {
    const value = field === "keywords" ? primary?.keywords?.join(",") : primary?.[field];
    addRequired(add, `metadata.${field}`, value, `Primary locale ${manifest.app.primaryLocale} has no ${field}.`, `Add ${field} for App Store metadata.`);
  }
  for (const locale of manifest.app.locales) {
    const localized = manifest.metadata.localizations[locale];
    if (!localized) { add(`metadata.${locale}`, "block", `Configured locale ${locale} has no metadata localization.`, "Add localizations for every App Store locale or remove the locale."); continue; }
    for (const field of ["name", "description", "keywords"] as const) {
      const value = field === "keywords" ? localized.keywords?.join(",") : localized[field];
      if (!value) add(`metadata.${locale}.${field}`, "block", `${locale} metadata has no ${field}.`, "Provide complete metadata for every configured locale, or remove that locale.");
    }
  }
  for (const [locale, values] of Object.entries(manifest.metadata.localizations)) {
    for (const [field, limit] of Object.entries(limits)) {
      const value = values[field as keyof typeof values];
      if (typeof value === "string" && value.length > limit) add(`metadata.${locale}.${field}`, "block", `${locale} ${field} has ${value.length} characters; Apple limit is ${limit}.`, "Shorten the text.");
    }
    if (values.name && values.name.length < 2) add(`metadata.${locale}.name.minimum`, "block", `${locale} app name must have at least 2 characters.`, "Use an App Store display name with 2–30 characters.");
    for (const keyword of values.keywords || []) if (keyword.length < 3) add(`metadata.${locale}.keyword.minimum`, "block", `${locale} keyword '${keyword}' must have more than 2 characters.`, "Remove short keywords.");
    const keywords = values.keywords?.join(",") || ""; const keywordBytes = Buffer.byteLength(keywords, "utf8");
    if (keywordBytes > 100) add(`metadata.${locale}.keywords`, "block", `${locale} keywords use ${keywordBytes} UTF-8 bytes; Apple limit is 100 bytes.`, "Shorten keywords.");
  }
}

function permissionChecks(manifest: ShipLayerManifest, add: Add): void {
  for (const permission of manifest.permissions) {
    if (!permission.purpose) add(`permission.${permission.key}`, "block", `${permission.key} has no user-facing purpose string.`, "Add a specific purpose string matching actual access.");
    else if (permission.confirmation !== "confirmed") add(`permission.${permission.key}`, "block", `${permission.key} is not human-confirmed.`, "Confirm the permission and purpose before submission.");
    else add(`permission.${permission.key}`, "pass", `${permission.key} has a confirmed purpose string.`);
  }
}

function exportComplianceCheck(manifest: ShipLayerManifest, add: Add): void {
  if (!manifest.build.exportCompliance || manifest.build.exportCompliance === "unknown") add("export-compliance", "block", "Export-compliance/encryption status is unknown.", "Confirm Info.plist declaration and any Apple documentation.");
  else add("export-compliance", "pass", `Export-compliance status is ${manifest.build.exportCompliance}.`);
  if (!manifest.build.signing || manifest.build.signing === "unknown") add("build.signing", "block", "Signing mode is unknown.", "Confirm the archive signing configuration before submission.");
  else add("build.signing", "pass", `Signing mode is ${manifest.build.signing}.`);
}

function confirmationChecks(manifest: ShipLayerManifest, add: Add): void {
  for (const [key, value] of Object.entries(manifest.confirmations)) {
    if (["ageRating", "privacy", "legal"].includes(key) && value !== "confirmed") add(`confirmation.${key}`, "block", `${key === "ageRating" ? "The App Store age-rating questionnaire" : `${key[0].toUpperCase()}${key.slice(1)} declaration`} requires explicit human confirmation.`, `Complete and confirm the ${key === "ageRating" ? "current App Store Connect age-rating questionnaire" : key} declaration before submission.`);
    else if (value === "confirmed" || value === "not-applicable") add(`confirmation.${key}`, "pass", `${key} declaration is ${value}.`);
    else add(`confirmation.${key}`, "block", `${key} declaration requires explicit human confirmation.`, "Confirm only after reviewing the App Store Connect/legal requirement.");
  }
  for (const item of [...manifest.dataProcessing, ...manifest.externalProcessors]) {
    if (item.confirmation === "confirmed" || item.confirmation === "not-applicable") continue;
    const name = "name" in item ? item.name : item.category;
    add(`privacy.${name}`, "block", `${name} requires human privacy confirmation.`, "Confirm collection, use, tracking, identity linkage, and third-party processing.");
  }
  for (const item of manifest.dataProcessing) if (item.confirmation === "confirmed" && (!item.purpose.length || item.linkedToIdentity === "unknown" || item.usedForTracking === "unknown")) add(`privacy.${item.category}.details`, "block", `${item.category} is marked confirmed but purpose, identity linkage, or tracking is still unknown.`, "Record explicit App Privacy answers before submission.");
  for (const item of manifest.externalProcessors) if (item.confirmation === "confirmed" && (!item.purpose || !item.dataCategories.length)) add(`privacy.${item.name}.details`, "block", `${item.name} is marked confirmed but its purpose or data categories are incomplete.`, "Record explicit processor data handling before submission.");
  for (const item of manifest.externalProcessors) if (item.protectionConfirmation !== "confirmed") add(`privacy.${item.name}.protection`, "block", `${item.name} has no confirmation of equal or stronger data protection.`, "Review the processor policy/contract and confirm the privacy policy's equal-protection statement before submission.");
}

async function aiDataSharingChecks(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport, add: Add): Promise<void> {
  // kind: "ai" is itself a signal that this processor belongs in the AI-pipeline disclosure, even
  // if a human has not (yet) flipped aiPipelineRecipient on the same proposal.
  const aiPipelineProcessors = manifest.externalProcessors.filter((processor) => processor.aiPipelineRecipient || processor.kind === "ai");
  const sharing = manifest.aiDataSharing;
  if (!sharing.enabled) {
    let blocked = false;
    if (aiPipelineProcessors.length) { add("ai-sharing.declaration", "block", `AI-pipeline recipients are declared (${aiPipelineProcessors.map((item) => item.name).join(", ")}) but aiDataSharing.enabled is false.`, "Model the exact AI data, recipients, in-context consent, and matching privacy-policy evidence. No-retention/no-training controls do not mean data was not shared."); blocked = true; }

    const { strong, weak } = classifiedAiEndpointFindings(analysis);
    for (const { finding, kind } of strong) {
      const id = kind === "provider" ? "ai-sharing.source-contradiction" : "ai-sharing.source-contradiction-ambiguous-endpoint";
      const url = endpointFindingUrl(finding);
      const sourcePaths = evidenceSources([finding]);
      const override = await resolveContradictionOverride(repository, manifest, aiContradictionFindingId(finding), sourcePaths);
      if (override) {
        add(id, "warn", `AI/inference endpoint evidence for ${url} is human-overridden: ${override.reason}`, "Re-verify this override whenever the source or manifest changes.");
      } else if (kind === "provider") {
        add(id, "block", `Source calls a third-party AI/inference endpoint (${url}) in ${sourcePaths.join(", ")}, but aiDataSharing.enabled is false.`, "Model the AI data sharing disclosure (data sent, recipients, consent, privacy policy), or add a confirmed sourceContradictionOverride naming this exact finding with a reason and evidence that intersects this finding's source paths if this is not a real AI/inference call.");
        blocked = true;
      } else {
        add(id, "block", `Source calls an endpoint shaped like an AI/inference API (${url}) in ${sourcePaths.join(", ")}, on a host ShipLayer does not recognize as a known AI provider — this may be a proxy that forwards to one — but aiDataSharing.enabled is false.`, "Confirm whether this endpoint proxies to a third-party AI/inference provider. If it does, model the AI data sharing disclosure; if it genuinely does not, add a confirmed sourceContradictionOverride naming this exact finding with a reason and evidence that intersects this finding's source paths.");
        blocked = true;
      }
    }
    if (weak.length) add("ai-sharing.possible-processor-link", "warn", `Source references known AI-provider host(s) (${weak.map((finding) => endpointFindingUrl(finding)).join(", ")}) that may indicate an undeclared processor.`, "Confirm whether this is only a documentation/policy link or an actual API call that sends user data; if it sends data, declare aiDataSharing and externalProcessors.");

    if (!blocked) add("ai-sharing.declaration", "pass", "No AI processor or AI data sharing is declared.");
    return;
  }

  const referenced = sharing.processorNames.map((name) => manifest.externalProcessors.find((processor) => processor.name === name));
  if (referenced.some((processor) => !processor)) add("ai-sharing.processors", "block", "AI disclosure names a recipient that is absent from externalProcessors.", "Declare every network/AI recipient with its policy, categories, purpose, and protection confirmation.");
  else if (referenced.some((processor) => !processor?.aiPipelineRecipient)) add("ai-sharing.processors", "block", "AI disclosure names a processor that is not marked as an AI-pipeline recipient.", "Mark only processors that receive data in this AI feature as aiPipelineRecipient and keep unrelated analytics/payment processors out of the AI disclosure.");
  else if (aiPipelineProcessors.some((processor) => !sharing.processorNames.includes(processor.name))) add("ai-sharing.processors", "block", "At least one declared AI provider or intermediary is missing from the in-app recipient list.", "Name every AI provider and intermediary marked aiPipelineRecipient before transmission.");
  else if (referenced.some((processor) => processor?.confirmation !== "confirmed" || processor.protectionConfirmation !== "confirmed")) add("ai-sharing.processors", "block", "AI sharing references a processor whose handling or equal-protection review is unconfirmed.", "Confirm each recipient only after reviewing its role, data policy, and protection obligations.");
  else add("ai-sharing.processors", "pass", `AI sharing names ${sharing.processorNames.join(", ")}.`);

  const consentReady = sharing.consent.shownBeforeTransmission
    && sharing.consent.privacyPolicyLinkVisible
    && sharing.consent.confirmation === "confirmed"
    && /(?:send|share|upload|transmit)/i.test(sharing.consent.affirmativeAction)
    && Boolean(sharing.consent.declinePath);
  if (!consentReady) add("ai-sharing.consent", "block", "The in-context AI disclosure/permission is incomplete or uses a generic affirmative action.", "Before transmission, state what is sent, name who receives it and why, provide a visible privacy link and non-AI decline path, and use an explicit action such as 'Allow and send to AI'.");
  else add("ai-sharing.consent", "pass", "AI sharing has a human-confirmed, explicit pre-transmission consent flow and decline path.");

  const policy = sharing.privacyPolicy;
  const policyReady = policy.identifiesDataAndCollectionMethod
    && policy.identifiesAllUses
    && policy.namesAllProcessors
    && policy.explainsRetentionAndDeletion
    && policy.confirmsEqualProtection
    && policy.confirmation === "confirmed";
  if (!policyReady) add("ai-sharing.privacy-policy", "block", "The AI privacy-policy declaration does not cover all Apple privacy requirements.", "Describe the data and collection method, every use and processor, retention/deletion, consent withdrawal, and equal protection.");
  else add("ai-sharing.privacy-policy", "pass", "AI sharing has a human-confirmed matching privacy-policy declaration.");

  const consentText = await evidenceText(repository, sharing.consent.evidence);
  const policyText = await evidenceText(repository, sharing.privacyPolicy.evidence);
  const consentSourceRoleValid = sharing.consent.evidence.every(isProductionSourceEvidencePath);
  const policyEvidenceRoleValid = sharing.privacyPolicy.evidence.every(isPolicyEvidencePath);
  if (!consentSourceRoleValid) add("ai-sharing.consent-source-role", "block", "AI consent evidence must reference production app source, not tests, scripts, fixtures, generated declarations, or documentation.", "Reference contained production Swift/Objective-C source that renders the disclosure before network transmission.");
  if (!policyEvidenceRoleValid) add("ai-sharing.policy-source-role", "block", "AI privacy-policy evidence must reference a public static policy artifact, not app code, tests, fixtures, samples, tooling, or generated release artifacts.", "Reference contained .md, .markdown, .html, .htm, or .txt policy content that is published as the app's privacy policy.");
  if (!consentText.complete) add("ai-sharing.consent-evidence", "block", "AI consent evidence is missing, symlinked, unreadable, or oversized.", "Reference contained production source that renders the disclosure before network transmission.");
  else {
    const consentSource = stripNonReleaseConditionalCompilation(stripCodeComments(consentText.text));
    const visibleDisclosure = visibleTextEvidence(consentSource).toLocaleLowerCase("en-US");
    const missing = sharing.processorNames.filter((name) => !visibleDisclosure.includes(name.toLocaleLowerCase("en-US")));
    const missingData = sharing.dataSent.filter((data) => !visibleDisclosure.includes(data.toLocaleLowerCase("en-US")));
    const purposeVisible = visibleDisclosure.includes(sharing.purpose.toLocaleLowerCase("en-US"));
    const buttonLabels = visibleUICallArguments(consentSource, new Set(["Button"])).map((value) => value.toLocaleLowerCase("en-US"));
    const actionVisible = buttonLabels.some((value) => value.includes(sharing.consent.affirmativeAction.toLocaleLowerCase("en-US")));
    const declineVisible = buttonLabels.some((value) => value.includes(sharing.consent.declinePath.toLocaleLowerCase("en-US")));
    const privacyLinkVisible = visibleUICallArguments(consentSource, new Set(["Link", "NavigationLink"])).some((value) => /privacy(?:\s+policy)?/i.test(value));
    if (missing.length) add("ai-sharing.consent-recipients", "block", `The in-app consent evidence does not visibly name: ${missing.join(", ")}.`, "Use exact user-facing recipient names in the disclosure shown before transmission.");
    if (missingData.length) add("ai-sharing.consent-data", "block", `The in-app consent evidence does not visibly identify: ${missingData.join(", ")}.`, "State the exact personal data sent before transmission, not only that AI is used.");
    if (!purposeVisible) add("ai-sharing.consent-purpose", "block", "The in-app consent evidence does not visibly state the declared processing purpose.", "Explain why the data is sent before requesting permission.");
    if (!actionVisible) add("ai-sharing.consent-action", "block", `The in-app consent evidence does not render the declared affirmative action “${sharing.consent.affirmativeAction}”.`, "Render an affirmative action that explicitly says data will be sent, shared, uploaded, or transmitted.");
    if (!declineVisible) add("ai-sharing.consent-decline", "block", `The in-app consent evidence does not render the declared non-AI path “${sharing.consent.declinePath}”.`, "Render a clear local/manual path that does not transmit data.");
    if (!privacyLinkVisible) add("ai-sharing.consent-privacy-link", "block", "The in-app consent evidence does not render a visible Privacy Policy link.", "Add a visible Link or NavigationLink labeled Privacy/Privacy Policy to the pre-transmission disclosure.");
    if (consentSourceRoleValid && !missing.length && !missingData.length && purposeVisible && actionVisible && declineVisible && privacyLinkVisible) add("ai-sharing.consent-evidence", "pass", "Production consent evidence names every recipient, the data and purpose, and renders the declared actions and Privacy Policy link.");
  }
  if (!policyText.complete) add("ai-sharing.policy-evidence", "block", "AI privacy-policy evidence is missing, symlinked, unreadable, or oversized.", "Reference the public policy source containing the confirmed AI disclosures.");
  else {
    const policySource = policyText.entries.map((entry) => stripPolicyEvidenceComments(entry.text)).join("\n");
    const normalizedPolicy = policySource.toLocaleLowerCase("en-US");
    const missing = sharing.processorNames.filter((name) => !normalizedPolicy.includes(name.toLocaleLowerCase("en-US")));
    const missingData = sharing.dataSent.filter((data) => !normalizedPolicy.includes(data.toLocaleLowerCase("en-US")));
    const purposeVisible = normalizedPolicy.includes(sharing.purpose.toLocaleLowerCase("en-US"));
    const collectionMethodVisible = /\b(?:select|choose|capture|photograph|upload|send|transmit|submit|provide(?:d)?)\b/i.test(policySource);
    const retentionVisible = /\b(?:retain(?:ed|s|ing)?|retention|delet(?:e|ed|ion)|eras(?:e|ed|ure)|remov(?:e|ed|al)|stor(?:e|ed|age)|keep|discard(?:ed|s)?)\b/i.test(policySource);
    if (missing.length) add("ai-sharing.policy-recipients", "block", `Privacy-policy evidence does not name: ${missing.join(", ")}.`, "Name every processor that receives AI feature data.");
    if (missingData.length) add("ai-sharing.policy-data", "block", `Privacy-policy evidence does not identify: ${missingData.join(", ")}.`, "Describe what is collected/transmitted and how it is obtained.");
    if (!purposeVisible) add("ai-sharing.policy-purpose", "block", "Privacy-policy evidence does not state the declared AI processing purpose/all uses.", "State every use of the transmitted data, including the exact declared AI feature purpose.");
    if (!collectionMethodVisible) add("ai-sharing.policy-collection-method", "block", "Privacy-policy evidence does not explain how the app obtains or transmits the AI feature data.", "Explain whether users select, capture, upload, send, or otherwise provide the data.");
    if (!retentionVisible) add("ai-sharing.policy-retention", "block", "Privacy-policy evidence does not explain retention or deletion.", "Describe processor/app retention and deletion behavior, including limited logs where applicable.");
    const equalProtection = /(?:same|equal).{0,60}protect|protect.{0,60}(?:same|equal)/is.test(policySource);
    if (!equalProtection) add("ai-sharing.policy-protection", "block", "Privacy-policy evidence does not confirm that third-party processors provide the same or equal protection.", "Add the processor-protection statement required by App Review after legal review.");
    if (policyEvidenceRoleValid && !missing.length && !missingData.length && purposeVisible && collectionMethodVisible && retentionVisible && equalProtection) add("ai-sharing.policy-evidence", "pass", "Privacy-policy evidence covers recipients, data, collection/transmission, purpose, retention/deletion, and same-or-equal protection.");
  }
}

/**
 * Shared by "free" and "paid-app": neither models an in-app purchase, so StoreKit purchase
 * evidence contradicts either declaration exactly the same way. Returns true when a real,
 * unresolved contradiction blocked readiness (and also blocks purchase.presentation, since it
 * cannot be verified for an undeclared model); false when there is nothing to resolve or a valid
 * override already resolved it.
 */
async function monetizationSourceContradiction(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport, add: Add): Promise<boolean> {
  const storekitEvidence = storekitPurchaseEvidence(analysis);
  if (!storekitEvidence.length) return false;
  const evidenceFiles = evidenceSources(storekitEvidence);
  const override = await resolveContradictionOverride(repository, manifest, MONETIZATION_CONTRADICTION_FINDING, evidenceFiles);
  if (override) {
    add("monetization.source-contradiction", "warn", `Monetization declaration ('${manifest.monetization.type}') is human-overridden despite StoreKit purchase evidence in ${evidenceFiles.join(", ")}: ${override.reason}`, "Re-verify this override whenever the source or manifest changes.");
    return false;
  }
  add("monetization.source-contradiction", "block", `Source shows StoreKit purchase evidence (${evidenceFiles.join(", ")}) but monetization.type is declared '${manifest.monetization.type}', which has no in-app purchase.`, "Declare the actual IAP/subscription model in shiplayer.yml, or add a confirmed sourceContradictionOverride naming 'monetization.source-contradiction' with a reason and evidence that intersects this finding's source paths if this is not a real purchase.");
  add("purchase.presentation", "block", "Purchase presentation cannot be verified because monetization is undeclared despite StoreKit purchase evidence in source.", "Resolve the monetization.source-contradiction blocker first.");
  return true;
}

async function monetizationChecks(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport, add: Add): Promise<void> {
  const money = manifest.monetization;
  if (money.type === "free") {
    const contradicted = await monetizationSourceContradiction(repository, manifest, analysis, add);
    if (contradicted) return;
    if (money.confirmation !== "confirmed") add("monetization", "block", "Free monetization is declared but not human-confirmed.", "Confirm there is truly no IAP/subscription model after reviewing the source.");
    else add("monetization", "pass", "Free app with no declared IAP, confirmed by a human.");
    return;
  }
  if (manifest.confirmations.paidAgreements !== "confirmed") add("confirmation.paidAgreements", "block", "Paid Apps agreement must be explicitly confirmed for paid monetization.", "Activate and confirm the Paid Apps agreement, tax, banking, and applicable business information.");
  if (money.type === "paid-app") {
    const contradicted = await monetizationSourceContradiction(repository, manifest, analysis, add);
    if (!contradicted) add("monetization", "pass", `Paid app price point ${money.pricePointReference} is declared.`);
    return;
  }
  if (money.type === "non-consumables") {
    addRequired(add, "iap.confirmation", money.confirmation === "confirmed", "Non-consumable configuration needs human confirmation.", "Confirm price, availability, paywall, restore, and review assets.");
    addRequired(add, "iap.paywall", money.paywallNavigation, "Non-consumable paywall navigation is missing.", "Describe how App Review reaches the purchase.");
    addRequired(add, "iap.restore", money.restorePath, "Non-consumable Restore Purchases path is missing.", "Describe an in-app Restore Purchases path.");
    for (const product of money.products) productChecks("iap", product, manifest.app.locales, add);
    return;
  }
  addRequired(add, "subscriptions.confirmation", money.confirmation === "confirmed" && money.disclosureConfirmation === "confirmed", "Subscription disclosures need human confirmation.", "Confirm terms, privacy, price/duration, auto-renewal, and restore disclosures.");
  addRequired(add, "subscriptions.paywall", money.paywallNavigation, "Subscription paywall navigation is missing.", "Describe how App Review reaches the paywall.");
  addRequired(add, "subscriptions.restore", money.restorePath, "Subscription restore path is missing.", "Describe Restore Purchases path.");
  if (!isHttps(money.termsUrl) || !isHttps(money.privacyUrl)) add("subscriptions.legal-links", "block", "Subscription terms/privacy links must be public HTTPS URLs.", "Set termsUrl and privacyUrl.");
  else add("subscriptions.legal-links", "pass", "Subscription terms and privacy links are declared.");
  if (money.baseTerritoryConfirmation !== "confirmed") add("subscriptions.base-territory", "block", "Subscription base territory requires human confirmation against the current App Store Connect availability picker.", "Confirm the selected base territory in App Store Connect; ISO syntax alone does not prove storefront availability.");
  else add("subscriptions.base-territory", "pass", `Subscription base territory ${money.baseTerritory} has a human availability confirmation.`);
  if (money.termsOfUse.confirmation !== "confirmed") add("subscriptions.terms-of-use", "block", "Terms of Use/EULA selection requires human confirmation.", "Choose Apple Standard EULA or custom terms only after legal review.");
  else add("subscriptions.terms-of-use", "pass", `Subscription Terms of Use is ${money.termsOfUse.type}.`);
  for (const product of money.products) productChecks("subscription", product, manifest.app.locales, add);
}

async function purchasePresentationChecks(repository: string, manifest: ShipLayerManifest, add: Add): Promise<void> {
  const money = manifest.monetization;
  if (money.type !== "non-consumables" && money.type !== "subscriptions") return;
  const presentation = money.purchasePresentation;
  const declared = presentation.confirmation === "confirmed"
    && presentation.localizedPriceSource === "storekit-display-price"
    && presentation.localizedPriceVisibleBeforePurchase
    && presentation.purchaseDisabledUntilPriceLoaded;
  if (!declared) add("purchase.presentation", "block", "Purchase presentation does not guarantee a localized StoreKit price before payment starts.", "Load Product first, visibly render Product.displayPrice, and keep purchase disabled while the product/price is loading or unavailable.");
  else add("purchase.presentation", "pass", "Purchase presentation declares visible StoreKit-localized pricing before purchase.");

  if (money.type === "subscriptions") {
    if (presentation.subscriptionPeriodVisibleBeforePurchase !== true || presentation.termsAndPrivacyLinksVisibleBeforePurchase !== true) add("purchase.subscription-disclosures", "block", "Subscription billing period or Terms/Privacy links are not confirmed visible before purchase.");
    if (money.products.some((product) => product.introductoryOffer) && presentation.offerTermsVisibleBeforePurchase !== true) add("purchase.offer-disclosures", "block", "Introductory-offer terms are not confirmed visible before purchase.");
  }

  const source = await evidenceText(repository, presentation.sourceEvidence);
  const tests = await evidenceText(repository, presentation.testEvidence);
  const sourceRoleValid = presentation.sourceEvidence.every(isProductionSourceEvidencePath);
  const testRoleValid = presentation.testEvidence.every(isTestSourceEvidencePath);
  if (!sourceRoleValid) add("purchase.presentation-source-role", "block", "Purchase source evidence must reference production app source, not tests, fixtures, scripts, generated declarations, or documentation.", "Reference the contained production Swift/Objective-C paywall source.");
  if (!testRoleValid) add("purchase.presentation-test-role", "block", "Purchase test evidence must reference conventional test source paths.", "Reference contained UI/unit/snapshot test source under a Tests or UITests target/path.");
  if (!source.complete) add("purchase.presentation-source", "block", "Purchase presentation source evidence is missing, symlinked, unreadable, or oversized.", "Reference production StoreKit/paywall source files.");
  else {
    const sourceCode = stripNonReleaseConditionalCompilation(stripCodeComments(source.text));
    const customProductViewStyle = hasUnverifiedCustomProductViewStyle(sourceCode);
    const customSubscriptionControlStyle = hasUnverifiedCustomSubscriptionStoreControlStyle(sourceCode);
    const renderedProductView = hasRenderedSwiftUICall(sourceCode, "ProductView");
    const renderedStoreView = money.type === "non-consumables" && hasRenderedSwiftUICall(sourceCode, "StoreView");
    const customStyledMerchandising = customProductViewStyle && (renderedProductView || renderedStoreView);
    const productView = !customStyledMerchandising && renderedProductView;
    const renderedSubscriptionStoreView = hasRenderedSwiftUICall(sourceCode, "SubscriptionStoreView");
    const customStyledSubscriptionStore = customSubscriptionControlStyle && renderedSubscriptionStoreView;
    const subscriptionStoreView = !customStyledSubscriptionStore && renderedSubscriptionStoreView;
    const storeView = !customStyledMerchandising && renderedStoreView;
    const storeKitMerchandisingView = productView || subscriptionStoreView || storeView;
    const localizedPriceRendered = storeKitMerchandisingView || hasVisibleLocalizedPrice(sourceCode);
    const unavailableStateRendered = storeKitMerchandisingView || hasUnavailablePurchaseState(sourceCode);
    if (!localizedPriceRendered) add("purchase.localized-price-source", "block", "Purchase evidence does not visibly render StoreKit Product.displayPrice or a StoreKit merchandising view.", "Render displayPrice in Text/Button/Label (directly or through a displayed local value); an unused displayPrice read is insufficient.");
    if (customStyledMerchandising) add("purchase.custom-product-view-style", "block", "Purchase evidence applies an unverified custom ProductViewStyle, so StoreKit-owned price and loading presentation cannot be assumed.", "Use a built-in .automatic, .compact, .regular, or .large productViewStyle, or replace the custom style with a fully evidenced custom paywall.");
    if (customStyledSubscriptionStore) add("purchase.custom-subscription-control-style", "block", "Subscription evidence applies an unverified custom SubscriptionStoreControlStyle, so automatic price, period, and offer presentation cannot be assumed.", "Use a built-in .automatic, .buttons, .picker, .prominentPicker, .compactPicker, .pagedPicker, or .pagedProminentPicker subscriptionStoreControlStyle, or replace it with a fully evidenced custom paywall.");
    if (!storeKitMerchandisingView && !/\.purchase\s*\(/.test(sourceCode)) add("purchase.call-source", "block", "Purchase evidence does not include a StoreKit purchase call or a supported StoreKit-owned merchandising view.", "Reference the source that starts StoreKit purchase after price availability, or ProductView/SubscriptionStoreView.");
    if (!unavailableStateRendered) add("purchase.unavailable-source", "block", "Purchase evidence does not keep payment unavailable while product/price data is loading or unavailable.", "Disable or withhold the purchase action until Product loads and render an explicit loading/unavailable/retry state.");

    if (money.type === "subscriptions") {
      const periodRendered = subscriptionStoreView || hasVisibleSubscriptionPeriod(sourceCode);
      const legalLinksRendered = subscriptionStoreView || hasVisibleTermsAndPrivacyLinks(sourceCode);
      const offerRendered = !money.products.some((product) => product.introductoryOffer) || subscriptionStoreView || hasVisibleOfferTerms(sourceCode);
      if (!periodRendered) add("purchase.subscription-period-source", "block", "Subscription source evidence does not visibly render the billing period before purchase.", "Show the subscription period/renewal cadence alongside the localized price.");
      if (!offerRendered) add("purchase.offer-terms-source", "block", "Subscription source evidence does not visibly render applicable introductory-offer terms.", "Show the trial/introductory duration and what happens after the offer before purchase.");
      if (!legalLinksRendered) add("purchase.legal-links-source", "block", "Subscription source evidence does not visibly render both Terms of Use and Privacy Policy links.", "Render visible Terms and Privacy links using the declared public URLs.");
    }

    if (sourceRoleValid) {
      const sourceHasAll = !customStyledMerchandising && !customStyledSubscriptionStore && localizedPriceRendered
        && (storeKitMerchandisingView || /\.purchase\s*\(/.test(sourceCode))
        && unavailableStateRendered
        && (money.type !== "subscriptions" || ((subscriptionStoreView || hasVisibleSubscriptionPeriod(sourceCode))
          && (subscriptionStoreView || hasVisibleTermsAndPrivacyLinks(sourceCode))
          && (!money.products.some((product) => product.introductoryOffer) || subscriptionStoreView || hasVisibleOfferTerms(sourceCode))));
      if (sourceHasAll) add("purchase.presentation-source", "pass", "Production evidence visibly presents StoreKit pricing, unavailable/loading behavior, purchase handling, and applicable subscription disclosures.");
    }
  }
  if (!tests.complete) add("purchase.presentation-tests", "block", "Purchase presentation test evidence is missing, symlinked, unreadable, or oversized.", "Add a UI or snapshot test proving the localized price is visible before the purchase action and no purchase can start while unavailable.");
  else {
    const testSource = stripCodeComments(tests.text);
    const testBodies = credibleSwiftTestBodies(testSource);
    if (!testBodies) add("purchase.presentation-test-container", "block", "Purchase test evidence is not contained in a credible XCTest or Swift Testing test method.", "Reference compiling test source with import XCTest, an XCTestCase test method, or import Testing and an @Test function.");
    const assertions = assertionEvidence(testBodies);
    const positiveAssertions = assertions.filter(isPositiveVisibilityAssertion);
    const visiblePriceTested = positiveAssertions.some((value) => /(?:displayPrice|paywall\.price|localized.{0,30}price|price.{0,30}(?:visible|exist|label))/is.test(value));
    const unavailableTested = assertions.some(isPurchaseUnavailableAssertion);
    if (!visiblePriceTested) add("purchase.presentation-tests", "block", "Test evidence does not assert that the localized price is visible before purchase.", "Add a focused UI/snapshot assertion for visible localized pricing.");
    if (!unavailableTested) add("purchase.unavailable-tests", "block", "Test evidence does not assert that purchase is disabled/unavailable before Product pricing loads.", "Add a focused assertion that the purchase action is disabled or absent in the loading/unavailable state.");
    let subscriptionTestsReady = true;
    if (money.type === "subscriptions") {
      const periodTested = positiveAssertions.some((value) => /(?:paywall\.period|billing.{0,30}period|subscription.{0,30}period|(?:week|month|year).{0,30}(?:visible|exist|label))/is.test(value));
      const legalLinksTested = positiveAssertions.some((value) => /(?:terms|terms of use)/i.test(value)) && positiveAssertions.some((value) => /privacy(?: policy)?/i.test(value));
      const offerTested = !money.products.some((product) => product.introductoryOffer) || positiveAssertions.some((value) => /(?:paywall\.offer|introductory|free trial|trial.{0,30}(?:visible|exist|label))/is.test(value));
      if (!periodTested) add("purchase.subscription-period-tests", "block", "Test evidence does not assert that the subscription billing period is visible.", "Assert the period/renewal cadence is present before purchase.");
      if (!offerTested) add("purchase.offer-terms-tests", "block", "Test evidence does not assert that applicable introductory-offer terms are visible.", "Assert the trial/introductory terms are present before purchase.");
      if (!legalLinksTested) add("purchase.legal-links-tests", "block", "Test evidence does not assert that both Terms and Privacy links are visible.", "Assert both legal links exist on the paywall.");
      subscriptionTestsReady = periodTested && offerTested && legalLinksTested;
    }
    if (testRoleValid && Boolean(testBodies) && visiblePriceTested && unavailableTested && subscriptionTestsReady) add("purchase.presentation-tests", "pass", "Test evidence covers visible localized pricing, unavailable state, and applicable subscription disclosures.");
  }
}

function productChecks(prefix: string, product: { productId: string; pricePointReference: string; localizations: Record<string, { displayName: string; description: string }>; familySharing: boolean; reviewNotes: string; reviewScreenshot: string }, locales: string[], add: Add): void {
  if (!product.pricePointReference) add(`${prefix}.${product.productId}.price`, "block", `${product.productId} has no price point reference.`);
  if (!product.reviewNotes) add(`${prefix}.${product.productId}.review-notes`, "block", `${product.productId} has no App Review notes.`);
  if (!product.reviewScreenshot) add(`${prefix}.${product.productId}.review-screenshot`, "block", `${product.productId} has no App Review screenshot.`);
  for (const locale of locales) {
    const localized = product.localizations[locale];
    if (!localized?.displayName || !localized.description) add(`${prefix}.${product.productId}.${locale}`, "block", `${product.productId} lacks complete ${locale} localization.`, "Add display name and description for every configured app locale.");
  }
}

function screenshotConfigurationChecks(manifest: ShipLayerManifest, add: Add): void {
  const seen = new Set<string>();
  for (const config of manifest.screenshots.configurations) {
    const key = `${config.family}/${config.locale}`;
    if (seen.has(key)) add(`screenshots.${key}.duplicate`, "block", `Duplicate screenshot configuration for ${key}.`, "Keep one deterministic configuration per family and locale.");
    seen.add(key);
    if (!manifest.app.deviceFamilies.includes(config.family)) add(`screenshots.${key}.unsupported-family`, "block", `${config.family} screenshots are configured but the app does not declare that device family.`);
    if (!manifest.app.locales.includes(config.locale)) add(`screenshots.${key}.unsupported-locale`, "block", `${config.locale} screenshots are configured but app.locales does not include it.`);
    const dimensions = `${config.requiredDimensions.width}x${config.requiredDimensions.height}`;
    if (!isFamilyScreenshotDimensions(config.family, config.requiredDimensions.width, config.requiredDimensions.height)) add(`screenshots.${key}.accepted-dimensions`, "block", `${dimensions} is not a supported ${config.family} App Store screenshot dimension.`, "Use a supported device class or update ShipLayer after verifying Apple's current requirements.");
  }
  for (const family of manifest.app.deviceFamilies) {
    if (!manifest.screenshots.configurations.some((item) => item.family === family && item.locale === manifest.app.primaryLocale)) add(`screenshots.${family}.${manifest.app.primaryLocale}`, "block", `No primary-locale screenshot configuration exists for supported ${family}.`, "Add actual App Store screenshot coverage for the primary locale.");
    for (const locale of manifest.app.locales.filter((item) => item !== manifest.app.primaryLocale)) if (!manifest.screenshots.configurations.some((item) => item.family === family && item.locale === locale)) add(`screenshots.${family}.${locale}`, "warn", `No localized screenshot deck exists for ${family}/${locale}; App Store Connect may fall back to the primary locale.`, "Add a localized deck only when that locale requires distinct marketing screenshots.");
  }
  if (!manifest.screenshots.scenarios.length) add("screenshots.scenarios", "block", "No screenshot/recording scenarios exist.", "Define real app-state scenarios and launch arguments.");
  else add("screenshots.scenarios", "pass", `${manifest.screenshots.scenarios.length} screenshot scenarios are defined.`);
}

async function screenshotChecks(repository: string, manifest: ShipLayerManifest, add: Add): Promise<void> {
  for (const config of manifest.screenshots.configurations) {
    const id = `screenshots.${config.family}.${config.locale}`;
    const relativeDirectory = `${manifest.screenshots.rawOutputDir}/${config.family}/${config.locale}`;
    let directory: string;
    try { directory = await resolveContained(repository, relativeDirectory, `screenshots for ${config.family}`); }
    catch (error) { add(id, "block", error instanceof Error ? error.message : String(error)); continue; }
    if (!existsSync(directory)) { add(id, "block", `Screenshot directory does not exist: ${relativeDirectory}.`, "Capture actual app screenshots in this directory."); continue; }
    let imageFiles: string[];
    try { imageFiles = (await readdir(directory)).filter((file) => /\.(png|jpe?g)$/i.test(file)).sort(); }
    catch { add(id, "block", `Screenshot directory is unreadable: ${relativeDirectory}.`); continue; }
    if (!imageFiles.length) { add(id, "block", `No PNG/JPEG screenshots found for ${config.family}/${config.locale}.`, "Capture at least one actual app screenshot."); continue; }
    if (imageFiles.length > 10) add(`${id}.count`, "block", `${imageFiles.length} screenshots found; App Store allows at most 10.`);
    else add(`${id}.count`, "pass", `${imageFiles.length} screenshot(s) found.`);
    for (const image of imageFiles) {
      const details = await inspectImage(path.join(directory, image));
      const imageId = `${id}.${image}`;
      if (!details) { add(imageId, "block", `Could not inspect ${image}; use a readable PNG/JPEG without alpha.`); continue; }
      if (!isFamilyScreenshotDimensions(config.family, details.width, details.height)) add(`${imageId}.accepted-dimensions`, "block", `${image} is ${details.width}×${details.height}, which is not an accepted ${config.family} App Store screenshot dimension.`, "Export an accepted screenshot size for the configured family.");
      else if (!sameOrientationOrReverse(details.width, details.height, config.requiredDimensions.width, config.requiredDimensions.height)) add(`${imageId}.dimensions`, "block", `${image} is ${details.width}×${details.height}; config requests ${config.requiredDimensions.width}×${config.requiredDimensions.height}.`, "Export exactly the configured Apple display size, in portrait or landscape orientation.");
      else add(`${imageId}.dimensions`, "pass", `${image} matches configured dimensions.`);
      if (details.alpha) add(`${imageId}.alpha`, "block", `${image} has an alpha channel.`, "Export a flattened PNG/JPEG without transparency.");
    }
    const scenarioIds = new Set(manifest.screenshots.scenarios.map((scenario) => scenario.id));
    for (const scenario of scenarioIds) if (!imageFiles.some((image) => path.basename(image, path.extname(image)) === scenario || path.basename(image).startsWith(`${scenario}-`))) add(`${id}.${scenario}`, "block", `No screenshot file corresponds to scenario '${scenario}'.`, `Capture ${scenario}.png (or ${scenario}-*.png) for this declared scenario.`);
  }
}

async function iconChecks(repository: string, manifest: ShipLayerManifest, add: Add): Promise<void> {
  const files = (await walkRepository(repository)).assetFiles;
  if (manifest.app.productionIconAsset) {
    try {
      const icon = await resolveContained(repository, manifest.app.productionIconAsset, "app.productionIconAsset");
      const details = await lstat(icon);
      if (path.extname(icon) !== ".icon" || (!(details.isFile() && details.size > 0) && !(details.isDirectory() && await nonEmptySafeIconBundle(icon)))) add("assets.icon-composer", "block", "app.productionIconAsset must select a non-empty contained .icon file or package without symlinks.", "Select the Icon Composer .icon asset in the Xcode project and keep the manifest path exact.");
      else if (manifest.app.productionIconAssetConfirmation !== "confirmed") add("assets.icon-composer", "block", "Icon Composer .icon exists but Project Editor/archive verification has not been human-confirmed.", "Confirm the Project Editor selects this .icon asset and inspect the archived build, then set productionIconAssetConfirmation: confirmed.");
      else add("assets.icon-composer", "pass", "Selected Icon Composer .icon exists and Xcode/archive selection was human-confirmed.");
    } catch { add("assets.icon-composer", "block", "app.productionIconAsset is missing, unsafe, or unreadable.", "Select a contained regular .icon file."); }
    return;
  }
  const iconCatalogs = files.filter((file) => file.endsWith("AppIcon.appiconset/Contents.json")).sort();
  if (!iconCatalogs.length) { add("assets.app-icon", "block", "No AppIcon.appiconset was found.", "Add an app icon asset catalog."); return; }
  let selected = iconCatalogs.length === 1 ? iconCatalogs[0] : undefined;
  if (iconCatalogs.length > 1) {
    if (!manifest.app.productionIconCatalog) add("assets.app-icon.ambiguous", "block", `Multiple AppIcon catalogs were found (${iconCatalogs.map((item) => path.relative(repository, item)).join(", ")}). Set app.productionIconCatalog to the contained production AppIcon.appiconset path.`, "Select/model the production target icon catalog before submission.");
    else {
      try {
        const configured = await resolveContained(repository, manifest.app.productionIconCatalog, "app.productionIconCatalog"); const contents = path.join(configured, "Contents.json");
        if (!iconCatalogs.includes(contents)) add("assets.app-icon.selected", "block", `app.productionIconCatalog does not select a discovered AppIcon.appiconset: ${manifest.app.productionIconCatalog}.`, "Set it to the exact contained production AppIcon.appiconset directory.");
        else selected = contents;
      } catch { add("assets.app-icon.selected", "block", "app.productionIconCatalog is unsafe or unreadable.", "Set it to the exact contained production AppIcon.appiconset directory."); }
    }
  } else if (manifest.app.productionIconCatalog) {
    const selectedRelative = path.relative(repository, selected as string).replace(/\/Contents\.json$/, "").split(path.sep).join("/");
    if (manifest.app.productionIconCatalog !== selectedRelative) add("assets.app-icon.selected", "block", `app.productionIconCatalog does not match the sole discovered catalog ${selectedRelative}.`, "Correct the path or remove it when there is only one catalog.");
  }
  if (selected) await validateIconCatalog(repository, files, selected, add);
}

async function validateIconCatalog(repository: string, files: string[], iconCatalog: string, add: Add): Promise<void> {
  const catalogId = path.relative(repository, iconCatalog).replaceAll(path.sep, "/");
  add(`assets.app-icon.${catalogId}`, "pass", `App icon asset catalog found at ${catalogId}.`);
  const folder = path.dirname(iconCatalog);
  const rasterFiles = files.filter((file) => path.dirname(file) === folder && /\.(png|jpe?g)$/i.test(file));
  if (!rasterFiles.length) { add(`assets.app-icon-images.${catalogId}`, "block", "The AppIcon asset catalog has no raster image files.", "Add and verify app icon raster assets before upload."); return; }
  try {
    const contents = JSON.parse(await readFile(iconCatalog, "utf8")) as { images?: Array<{ filename?: unknown; idiom?: unknown; platform?: unknown; size?: unknown; scale?: unknown }> };
    const declared = (contents.images || []).map((image) => image.filename).filter((file): file is string => typeof file === "string" && file.length > 0);
    if (!declared.length) add(`assets.app-icon-declarations.${catalogId}`, "block", "AppIcon Contents.json does not declare any raster icon filename.", "Generate/assign the required app icon image assets.");
    let validMarketingIcon = false;
    for (const image of contents.images || []) {
      if (typeof image.filename !== "string" || !image.filename) continue;
      const filename = image.filename;
      const raster = rasterFiles.find((file) => path.basename(file) === filename);
      if (!raster) { add(`assets.app-icon.${filename}`, "block", `AppIcon Contents.json references missing raster file ${filename}.`, "Add the referenced icon image or update Contents.json."); continue; }
      const details = await inspectImage(raster);
      if (!details) { add(`assets.app-icon.${filename}`, "block", `App icon ${filename} is corrupt or unreadable.`, "Export a valid flattened 1024×1024 PNG."); continue; }
      if (details.alpha) add(`assets.app-icon.${filename}.alpha`, "block", `App icon ${filename} has transparency.`, "Export a flattened app icon without alpha.");
      const legacyMarketing = image.idiom === "ios-marketing" && image.size === "1024x1024" && image.scale === "1x";
      const universalIos = image.idiom === "universal" && image.platform === "ios" && image.size === "1024x1024";
      if (legacyMarketing || universalIos) {
        if (details.format !== "png") add(`assets.app-icon.${filename}.format`, "block", `App Store marketing icon ${filename} must be a PNG.`, "Export a flattened 1024×1024 PNG.");
        else if (details.width === 1024 && details.height === 1024 && !details.alpha) validMarketingIcon = true;
      }
    }
    if (!validMarketingIcon) add(`assets.app-icon-marketing.${catalogId}`, "block", "No declared 1024×1024 opaque PNG App Store icon was found in an ios-marketing or universal iOS slot.", "Declare a valid ios-marketing or universal/platform iOS 1024×1024 flattened PNG in AppIcon Contents.json.");
  } catch { add(`assets.app-icon-contents.${catalogId}`, "block", "AppIcon Contents.json is unreadable or malformed.", "Regenerate the app icon asset catalog."); }
}

async function purchaseAssetChecks(repository: string, manifest: ShipLayerManifest, add: Add): Promise<void> {
  const products = manifest.monetization.type === "subscriptions" || manifest.monetization.type === "non-consumables" ? manifest.monetization.products : [];
  for (const product of products) {
    try {
      const image = await resolveContained(repository, product.reviewScreenshot, `review screenshot for ${product.productId}`);
      const details = await inspectImage(image);
      if (!details) add(`purchase.${product.productId}.asset`, "block", `Review screenshot for ${product.productId} is missing, symlinked, or unreadable: ${product.reviewScreenshot}.`);
      else if (details.alpha) add(`purchase.${product.productId}.asset-alpha`, "block", `Review screenshot for ${product.productId} has alpha.`);
      else if (!isReviewScreenshotDimension(manifest, details.width, details.height)) add(`purchase.${product.productId}.asset-dimensions`, "block", `Review screenshot for ${product.productId} is ${details.width}×${details.height}; upload a supported screenshot dimension for this app.`);
      else add(`purchase.${product.productId}.asset`, "pass", `Review screenshot exists for ${product.productId}.`);
    } catch { add(`purchase.${product.productId}.asset`, "block", `Review screenshot for ${product.productId} is missing or unreadable: ${product.reviewScreenshot}.`); }
  }
}

async function sourceConsistencyChecks(repository: string, manifest: ShipLayerManifest, report: AnalysisReport, add: Add): Promise<void> {
  if (!report.project.xcodeProjects.length && !report.project.workspaces.length && !report.project.projectYml.length) add("source.project", "block", "No Xcode project, workspace, or XcodeGen project.yml evidence was found.", "Run ShipLayer against the native app repository and retain a readable production project definition.");
  else add("source.project", "pass", "Native project definition evidence was found.");
  for (const contradiction of report.contradictions) add("source.contradiction", "block", contradiction, "Resolve ambiguous production project settings.");
  const compare = (key: "bundleId" | "version" | "build" | "deploymentTarget", expected: string | undefined): void => {
    const detected = findValue(report, key);
    if (!expected || !detected) return;
    if (expected === detected) add(`consistency.${key}`, "pass", `Manifest ${key} matches source evidence.`);
    else add(`consistency.${key}`, "block", `Manifest ${key} (${expected}) disagrees with source evidence (${detected}).`, "Update the manifest or source setting.");
  };
  compare("bundleId", manifest.app.bundleId); compare("version", manifest.app.version); compare("build", manifest.app.build);
  for (const [key, value] of [["bundleId", manifest.app.bundleId], ["version", manifest.app.version], ["build", manifest.app.build]] as const) if (!findValue(report, key)) add(`source.${key}`, "block", `No production ${key} evidence was found for manifest value ${value || "MISSING"}.`, "Add/read the production Xcode setting or Info.plist; ShipLayer does not infer submission identity from the manifest.");
  const detectedFamilies = new Set(stringValues(report.findings.find((finding) => finding.key === "deviceFamily")?.value).flatMap((value) => value.split(",").map((part) => part.trim())));
  if (detectedFamilies.size) {
    const declaredFamilies = new Set(manifest.app.deviceFamilies.map((family) => family === "iphone" ? "1" : "2"));
    if (!sameSet(detectedFamilies, declaredFamilies)) add("consistency.device-family", "block", `Manifest device families (${[...declaredFamilies].join(",")}) disagree with production target evidence (${[...detectedFamilies].join(",")}).`, "Update app.deviceFamilies and screenshot coverage, or resolve target evidence ambiguity.");
    else add("consistency.device-family", "pass", "Manifest device families match production target evidence.");
  }
  else add("source.device-family", "block", "No production TARGETED_DEVICE_FAMILY evidence was found.", "Add/read the production Xcode target setting; screenshot coverage cannot be inferred from the manifest.");
  compare("deploymentTarget", manifest.app.deploymentTarget);
  if (manifest.app.deploymentTarget && !findValue(report, "deploymentTarget")) add("source.deployment-target", "block", "Manifest deployment target has no production Xcode evidence.", "Add/read IPHONEOS_DEPLOYMENT_TARGET from the production target.");
  const detectedSigning = findValue(report, "codeSignStyle");
  if (detectedSigning) {
    const normalizedSigning = /^automatic$/i.test(detectedSigning) ? "automatic" : /^manual$/i.test(detectedSigning) ? "manual" : undefined;
    if (normalizedSigning) {
      if (manifest.build.signing === normalizedSigning) add("consistency.signing", "pass", "Manifest build.signing matches source evidence.");
      else add("consistency.signing", "block", `Manifest build.signing (${manifest.build.signing}) disagrees with source evidence (${normalizedSigning}).`, "Update the manifest or the production CODE_SIGN_STYLE setting.");
    }
  }
  const detectedEncryption = findValue(report, "encryption");
  // Multiple production declarations are not a harmless generic contradiction:
  // export compliance is a submission gate, so surface it under the actionable
  // encryption check as well. `findValue` deliberately declines ambiguous
  // findings, which otherwise used to hide a true Info.plist declaration behind
  // a project-setting default.
  if (report.contradictions.some((item) => item.startsWith("encryption has conflicting values:"))) add("consistency.encryption", "block", "Production encryption declarations conflict across project settings or Info.plists.", "Resolve ITSAppUsesNonExemptEncryption to one production value, then confirm the matching export-compliance status.");
  else if (detectedEncryption === "false" && manifest.build.exportCompliance !== "exempt") add("consistency.encryption", "block", "Source declares ITSAppUsesNonExemptEncryption=false but manifest export compliance is not exempt.", "Align build.exportCompliance with the production Info.plist or resolve the declaration.");
  else if (detectedEncryption === "false") add("consistency.encryption", "pass", "Manifest export compliance matches the source encryption declaration.");
  else if (detectedEncryption === "true" && manifest.build.exportCompliance !== "documentation-required") add("consistency.encryption", "block", "Source declares ITSAppUsesNonExemptEncryption=true but manifest export compliance is not documentation-required.", "Confirm export documentation with Apple and align build.exportCompliance.");
  else if (detectedEncryption === "true") add("consistency.encryption", "pass", "Manifest export compliance matches the source encryption declaration.");
  else if (detectedEncryption === "declared") add("consistency.encryption", "block", "Source declares export encryption but its value is ambiguous.", "Resolve the production Info.plist value and confirm export compliance.");
  else if (!detectedEncryption) add("source.encryption", "block", "No production export-compliance/encryption evidence was found.", "Declare and verify ITSAppUsesNonExemptEncryption in the production target before submission.");
  for (const permission of manifest.permissions) {
    const evidence = permission.evidence || []; const valid = await validEvidencePaths(repository, evidence);
    if (evidence.length && valid.size !== evidence.length) add(`manifest.permission.${permission.key}.evidence`, "block", `${permission.key} references missing, symlinked, or out-of-repository evidence.`, "Use only exact contained, regular source files as evidence.");
  }
  for (const processor of manifest.externalProcessors) {
    const evidence = processor.evidence || []; const valid = await validEvidencePaths(repository, evidence);
    if (evidence.length && valid.size !== evidence.length) add(`manifest.processor.${processor.name}.evidence`, "block", `${processor.name} references missing, symlinked, or out-of-repository evidence.`, "Use only exact contained, regular source files as evidence.");
  }
  for (const item of manifest.dataProcessing) {
    const evidence = item.evidence || []; const valid = await validEvidencePaths(repository, evidence);
    if (evidence.length && valid.size !== evidence.length) add(`manifest.data-processing.${item.category}.evidence`, "block", `${item.category} references missing, symlinked, or out-of-repository privacy evidence.`, "Use only exact contained, regular source files as evidence.");
  }
  for (const decision of manifest.externalServiceDecisions) {
    const valid = await validEvidencePaths(repository, decision.evidence);
    if (valid.size !== decision.evidence.length) add(`manifest.external-decision.${decision.finding}.evidence`, "block", `External-service decision '${decision.finding}' references missing, symlinked, or out-of-repository evidence.`, "Use only exact contained, regular source files as evidence.");
  }
  for (const override of manifest.sourceContradictionOverrides) {
    const valid = await validEvidencePaths(repository, override.evidence);
    if (valid.size !== override.evidence.length) add(`manifest.contradiction-override.${override.finding}.evidence`, "block", `Contradiction override '${override.finding}' references missing, symlinked, or out-of-repository evidence.`, "Use only exact contained, regular source files as evidence.");
  }
  for (const finding of report.findings.filter((item) => item.key.startsWith("permission:"))) {
    const key = finding.key.slice("permission:".length);
    const permission = manifest.permissions.find((item) => item.key === key);
    if (!permission) { add(`source.permission.${key}`, "block", `Source evidence declares ${key}, but the manifest has no matching permission declaration.`, "Add a human-confirmed permission declaration or remove the source capability."); continue; }
    const detectedPurposes = stringValues(finding.value); const sourcePaths = new Set(finding.evidence.map((item) => item.source)); const evidence = await validEvidencePaths(repository, permission.evidence || []);
    if (!detectedPurposes.includes(permission.purpose || "")) add(`source.permission.${key}.purpose`, "block", `${key} purpose differs from the Info.plist evidence.`, "Use the exact user-facing Info.plist purpose string or update the source declaration.");
    if (!intersects(evidence, sourcePaths)) add(`source.permission.${key}.evidence`, "block", `${key} must cite an existing source evidence file that matches the scanner finding.`, "Reference the matching Info.plist path; evidence must be a contained, non-symlinked file.");
    else add(`source.permission.${key}.evidence`, "pass", `${key} manifest evidence matches source evidence.`);
  }
  for (const permission of manifest.permissions) if (!report.findings.some((finding) => finding.key === `permission:${permission.key}`) && !(permission.evidence || []).length) add(`manifest.permission.${permission.key}`, "warn", `${permission.key} has no scanner evidence or manifest evidence path.`, "Verify the purpose string and add source evidence if this permission is used.");
  for (const finding of report.findings.filter((item) => item.key.startsWith("thirdPartySdkCandidate:") || item.key.startsWith("endpoint:"))) {
    const findingId = externalFindingId(finding);
    if (finding.key.startsWith("endpoint:http://")) add(`source.insecure-endpoint.${findingId}`, "block", `Source declares insecure HTTP endpoint ${String(finding.value)}.`, "Use HTTPS or document an App Transport Security exception and resolve it with human review.");
    const decision = manifest.externalServiceDecisions.find((item) => item.finding === findingId);
    if (!decision || decision.confirmation !== "confirmed" || !decision.reason || !decision.evidence.length) { add(`source.external.${findingId}`, "block", `Source heuristic '${findingId}' has no confirmed processor/disposition decision.`, "Declare the processor or explicitly record why it is not an external processor, with source evidence."); continue; }
    const sourcePaths = new Set(finding.evidence.map((item) => item.source)); const decisionEvidence = await validEvidencePaths(repository, decision.evidence);
    if (!intersects(decisionEvidence, sourcePaths)) { add(`source.external.${findingId}`, "block", `Disposition for '${findingId}' must cite an existing source evidence file that matches the scanner finding.`, "Reference exact contained, non-symlinked source evidence."); continue; }
    if (decision.disposition === "declared-processor") {
      const linkedProcessor = manifest.externalProcessors.find((processor) => processor.confirmation === "confirmed" && intersects(new Set(processor.evidence || []), decisionEvidence));
      if (!linkedProcessor || !intersects(await validEvidencePaths(repository, linkedProcessor.evidence || []), decisionEvidence)) add(`source.external.${findingId}`, "block", `Processor decision for '${findingId}' is not linked to a confirmed external processor evidence record.`, "Add the matching external processor with confirmed data categories and evidence.");
      else add(`source.external.${findingId}`, "pass", `Source heuristic '${findingId}' has a human-confirmed processor disposition.`);
    } else add(`source.external.${findingId}`, "pass", `Source heuristic '${findingId}' has a human-confirmed non-processor disposition.`);
  }
  for (const processor of manifest.externalProcessors.filter((item) => item.confirmation === "confirmed")) {
    for (const category of processor.dataCategories) {
      const declaration = manifest.dataProcessing.find((item) => item.category === category && item.confirmation === "confirmed" && item.purpose.includes(processor.purpose));
      if (!declaration) add(`privacy.processor.${processor.name}.${category}`, "block", `${processor.name} declares ${category} for ${processor.purpose}, but no matching confirmed App Privacy dataProcessing row exists.`, "Add the processor-collected category/purpose to dataProcessing and explicitly confirm identity/tracking answers.");
      else add(`privacy.processor.${processor.name}.${category}`, "pass", `${processor.name} has a matching confirmed App Privacy declaration for ${category}.`);
    }
  }
  for (const finding of report.findings.filter((item) => item.key.startsWith("privacyManifestData:"))) {
    const category = finding.key.slice("privacyManifestData:".length);
    for (const encoded of stringValues(finding.value)) {
      try {
        const expected = JSON.parse(encoded) as { linkedToIdentity?: unknown; usedForTracking?: unknown; purposes?: unknown };
        const declaration = manifest.dataProcessing.find((item) => item.category === category && item.confirmation === "confirmed");
        if (!declaration || declaration.linkedToIdentity !== expected.linkedToIdentity || declaration.usedForTracking !== expected.usedForTracking || !Array.isArray(expected.purposes) || expected.purposes.some((purpose) => !declaration.purpose.includes(purpose))) add(`privacy.manifest.${category}`, "block", `PrivacyInfo.xcprivacy evidence for ${category} is not matched by a confirmed dataProcessing declaration.`, "Add or correct the App Privacy category, purposes, identity linkage, and tracking answers; source evidence is a proposal, not legal truth.");
        else add(`privacy.manifest.${category}`, "pass", `Confirmed dataProcessing declaration matches PrivacyInfo.xcprivacy evidence for ${category}.`);
      } catch { add(`privacy.manifest.${category}`, "block", `PrivacyInfo.xcprivacy evidence for ${category} could not be interpreted safely.`, "Review and explicitly model this data category before submission."); }
    }
  }
  for (const finding of report.findings.filter((item) => item.key === "privacyManifestUnparsed")) add("privacy.manifest.unparsed", "block", `PrivacyInfo.xcprivacy contains unsupported or incomplete collected-data declaration(s): ${stringValues(finding.value).join(", ")}.`, "Map each declaration to the exact App Privacy category/purpose or obtain a human-reviewed manual disposition before submission.");
  const secondary = report.findings.find((finding) => finding.key === "secondaryBundleId");
  if (secondary) {
    const sourcePaths = new Set(secondary.evidence.map((item) => item.source));
    for (const bundleId of stringValues(secondary.value)) {
      const confirmation = manifest.secondaryTargetConfirmations.find((item) => item.bundleId === bundleId);
      if (!confirmation || confirmation.confirmation !== "confirmed" || confirmation.classification === "other-app" || !intersects(await validEvidencePaths(repository, confirmation.evidence || []), sourcePaths)) add(`source.secondary-target.${bundleId}`, "block", `Secondary target ${bundleId} needs an evidence-backed human classification as an extension or widget.`, "Confirm the Xcode target type and record a contained source evidence path.");
      else add(`source.secondary-target.${bundleId}`, "pass", `Secondary target ${bundleId} is confirmed as a ${confirmation.classification}.`);
    }
  }
  const relevantOmissions = report.ignored.filesOverLimitPaths.filter(isRelevantSourcePath); const relevantSymlinks = report.ignored.symlinkFilesIgnored.filter(isRelevantSourcePath); const relevantUnreadable = report.ignored.unreadable.filter(isRelevantSourcePath); const omittedSourceDirectories = report.ignored.symlinkDirectoriesIgnored.filter((directory) => !isNonProductionSourcePath(directory));
  if (report.ignored.truncated || relevantOmissions.length || relevantUnreadable.length || relevantSymlinks.length || omittedSourceDirectories.length) add("source.scan-coverage", "block", `Source scan omitted ${[report.ignored.truncated ? "a truncated entry set" : "", relevantOmissions.length ? `${relevantOmissions.length} relevant oversized source/config file(s)` : "", relevantUnreadable.length ? `${relevantUnreadable.length} relevant unreadable source/config path(s)` : "", relevantSymlinks.length ? `${relevantSymlinks.length} relevant symlinked source/config path(s)` : "", omittedSourceDirectories.length ? `${omittedSourceDirectories.length} symlinked directory tree(s)` : ""].filter(Boolean).join(", ")}.`, "Inspect omitted source manually and remove/resolve exclusions before claiming submission readiness.");
  else if (report.ignored.filesOverLimit || report.ignored.unreadable.length || report.ignored.symlinksIgnored.length) add("source.scan-coverage", "warn", "Source scan ignored only non-source binary, documentation, or unrelated paths.", "Review ignored paths if they become release-relevant.");
  // Scanner-tooling noise (e.g. which conventional test-only paths were excluded from
  // heuristics) is informational, not actionable; it stays in the analysis report but is not
  // surfaced as a preflight warning. Actionable questions are prefixed once here — the
  // generator's remaining-human-actions list reads report.results, so it no longer needs a
  // separate "Scanner question:" pass over analysis.unresolvedQuestions.
  const actionableQuestions = report.unresolvedQuestions.filter((question) => !question.startsWith("Excluded conventional test-only source "));
  for (const [index, question] of actionableQuestions.entries()) add(`source.question.${index + 1}`, "warn", `Scanner question: ${question}`, "Resolve or record this scanner question during human release review.");
  const storeKit = report.findings.find((finding) => finding.key === "storekitProductId")?.value;
  const sourceIds = new Set(Array.isArray(storeKit) ? storeKit.filter((value): value is string => typeof value === "string") : typeof storeKit === "string" ? [storeKit] : []);
  const manifestIds = new Set(manifest.monetization.type === "subscriptions" || manifest.monetization.type === "non-consumables" ? manifest.monetization.products.map((product) => product.productId) : []);
  for (const id of sourceIds) if (!manifestIds.has(id)) add(`storekit.${id}`, "block", `StoreKit product ${id} is missing from monetization manifest.`);
  for (const id of manifestIds) if (sourceIds.size && !sourceIds.has(id)) add(`manifest.${id}`, "block", `Manifest product ${id} is absent from StoreKit evidence.`);
}

function stringValues(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []; }
function intersects(left: Set<string>, right: Set<string>): boolean { return [...left].some((item) => right.has(item)); }
function sameSet(left: Set<string>, right: Set<string>): boolean { return left.size === right.size && [...left].every((item) => right.has(item)); }
function isRelevantSourcePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return !isNonProductionSourcePath(normalized) && /(?:^|\/)(?:project\.yml|project\.pbxproj|Info\.plist|\.xcconfig|PrivacyInfo\.xcprivacy|[^/]+\.(?:swift|m|mm|h|ts|tsx|js|jsx|mjs|cjs|mts|cts|entitlements|storekit))$/i.test(normalized);
}
function isProductionSourceEvidencePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return !isNonProductionSourcePath(normalized)
    && !parts.some((component) => /^(?:fixtures?|samples?|examples?|docs?|testdata)$/i.test(component))
    && /\.(?:swift|m|mm)$/i.test(normalized);
}
function isTestSourceEvidencePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return isNonProductionSourcePath(normalized) && /\.(?:swift|m|mm)$/i.test(normalized);
}
function isPolicyEvidencePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return !isNonProductionSourcePath(normalized)
    && !parts.some((component) => /^(?:fixtures?|samples?|testdata|shiplayer-release|release|dist|build|deriveddata|node_modules|scripts?|tools?)$/i.test(component))
    && /\.(?:md|markdown|html?|txt)$/i.test(normalized);
}
function stripCodeComments(source: string): string {
  let output = "";
  let index = 0;
  let state: "normal" | "string" | "multiline-string" | "line-comment" | "block-comment" = "normal";
  let blockDepth = 0;
  while (index < source.length) {
    if (state === "normal") {
      if (source.startsWith("//", index)) { state = "line-comment"; index += 2; continue; }
      if (source.startsWith("/*", index)) { state = "block-comment"; blockDepth = 1; index += 2; continue; }
      if (source.startsWith('"""', index)) { output += '"""'; state = "multiline-string"; index += 3; continue; }
      if (source[index] === '"') { output += source[index]; state = "string"; index++; continue; }
      output += source[index++];
      continue;
    }
    if (state === "line-comment") {
      if (source[index] === "\n") { output += "\n"; state = "normal"; }
      index++;
      continue;
    }
    if (state === "block-comment") {
      if (source.startsWith("/*", index)) { blockDepth++; index += 2; continue; }
      if (source.startsWith("*/", index)) { blockDepth--; index += 2; if (blockDepth === 0) state = "normal"; continue; }
      if (source[index] === "\n") output += "\n";
      index++;
      continue;
    }
    if (state === "multiline-string") {
      if (source.startsWith('"""', index)) { output += '"""'; state = "normal"; index += 3; continue; }
      output += source[index++];
      continue;
    }
    output += source[index];
    if (source[index] === "\\" && index + 1 < source.length) output += source[++index];
    else if (source[index] === '"') state = "normal";
    index++;
  }
  return output;
}
function stripNonReleaseConditionalCompilation(source: string): string {
  type ConditionalFrame = { parentActive: boolean; selected: boolean; uncertainPrior: boolean };
  const frames: ConditionalFrame[] = [];
  const output: string[] = [];
  let active = true;
  for (const line of source.split(/(?<=\n)/)) {
    const directive = line.match(/^\s*#(if|elseif)\s+(.+?)\s*$/);
    if (directive?.[1] === "if") {
      const eligibility = conditionalCompilationEligibility(directive[2]);
      frames.push({ parentActive: active, selected: eligibility === "eligible", uncertainPrior: eligibility === "unknown" });
      active = active && eligibility === "eligible";
      output.push(line.endsWith("\n") ? "\n" : "");
      continue;
    }
    if (directive?.[1] === "elseif") {
      const frame = frames.at(-1);
      if (frame) {
        const eligibility = conditionalCompilationEligibility(directive[2]);
        active = frame.parentActive && !frame.selected && !frame.uncertainPrior && eligibility === "eligible";
        if (active) frame.selected = true;
        if (!frame.selected && eligibility === "unknown") frame.uncertainPrior = true;
      }
      output.push(line.endsWith("\n") ? "\n" : "");
      continue;
    }
    if (/^\s*#else\b/.test(line)) {
      const frame = frames.at(-1);
      if (frame) { active = frame.parentActive && !frame.selected && !frame.uncertainPrior; if (active) frame.selected = true; }
      output.push(line.endsWith("\n") ? "\n" : "");
      continue;
    }
    if (/^\s*#endif\b/.test(line)) {
      const frame = frames.pop();
      if (frame) active = frame.parentActive;
      output.push(line.endsWith("\n") ? "\n" : "");
      continue;
    }
    output.push(active ? line : (line.endsWith("\n") ? "\n" : ""));
  }
  return output.join("");
}
function conditionalCompilationEligibility(condition: string): "eligible" | "excluded" | "unknown" {
  const value = stripOuterParentheses(condition.replace(/\s+/g, " ").trim());
  const orTerms = value.split(/\s*\|\|\s*/);
  if (orTerms.length > 1) {
    const results = orTerms.map(conditionalCompilationEligibility);
    return results.includes("eligible") ? "eligible" : results.every((item) => item === "excluded") ? "excluded" : "unknown";
  }
  const andTerms = value.split(/\s*&&\s*/);
  if (andTerms.length > 1) {
    const results = andTerms.map(conditionalCompilationEligibility);
    return results.includes("excluded") ? "excluded" : results.every((item) => item === "eligible") ? "eligible" : "unknown";
  }
  if (/^false$/i.test(value) || /^DEBUG$/i.test(value) || /^targetEnvironment\s*\(\s*simulator\s*\)$/i.test(value) || /^os\s*\(\s*(?:macOS|tvOS|watchOS|visionOS)\s*\)$/i.test(value) || /^!\s*os\s*\(\s*iOS\s*\)$/i.test(value) || /^!\s*canImport\s*\(\s*(?:StoreKit|SwiftUI)\s*\)$/i.test(value)) return "excluded";
  if (/^true$/i.test(value) || /^!\s*DEBUG$/i.test(value) || /^!\s*targetEnvironment\s*\(\s*simulator\s*\)$/i.test(value) || /^os\s*\(\s*iOS\s*\)$/i.test(value) || /^!\s*os\s*\(\s*(?:macOS|tvOS|watchOS|visionOS)\s*\)$/i.test(value) || /^canImport\s*\(\s*(?:StoreKit|SwiftUI)\s*\)$/i.test(value)) return "eligible";
  return "unknown";
}
function stripPolicyEvidenceComments(source: string): string { return source.replace(/<!--[\s\S]*?-->/g, ""); }
function assertionEvidence(source: string): string[] {
  const evidence: string[] = [];
  for (const match of source.matchAll(/(?:\bXCTAssert[A-Za-z]*|#expect|\bassertSnapshot)\s*\(/g)) {
    const start = match.index;
    const opening = source.indexOf("(", start);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = opening; index < source.length && index - opening <= 2_000; index++) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === "(") depth++;
      else if (character === ")" && --depth === 0) { evidence.push(source.slice(start, index + 1)); break; }
    }
  }
  return evidence;
}
function isPositiveVisibilityAssertion(evidence: string): boolean {
  if (/\bassertSnapshot\s*\(/.test(evidence)) return true;
  const argumentsList = callArguments(evidence);
  if (!argumentsList.length) return false;
  if (/^\s*(?:XCTAssert|XCTAssertTrue|#expect)\s*\(/.test(evidence)) return isDirectVisibilityExpression(argumentsList[0]);
  if (!/^\s*XCTAssertEqual\s*\(/.test(evidence) || argumentsList.length < 2) return false;
  const left = stripOuterParentheses(argumentsList[0]);
  const right = stripOuterParentheses(argumentsList[1]);
  return (isDirectVisibilityExpression(left) && right === "true") || (left === "true" && isDirectVisibilityExpression(right));
}
function isPurchaseUnavailableAssertion(evidence: string): boolean {
  if (!/(?:purchase|buy|subscribe|unlock|canPurchase|isEnabled)/i.test(evidence)) return false;
  const argumentsList = callArguments(evidence);
  if (!argumentsList.length) return false;
  if (/^\s*XCTAssertFalse\s*\(/.test(evidence)) return isDirectAvailabilityState(argumentsList[0]);
  if (/^\s*XCTAssertEqual\s*\(/.test(evidence) && argumentsList.length >= 2) {
    const left = stripOuterParentheses(argumentsList[0]);
    const right = stripOuterParentheses(argumentsList[1]);
    return (isDirectAvailabilityState(left) && right === "false") || (left === "false" && isDirectAvailabilityState(right));
  }
  if (!/^\s*(?:XCTAssertTrue|XCTAssert|#expect)\s*\(/.test(evidence)) return false;
  const expression = stripOuterParentheses(argumentsList[0]);
  if (expression.startsWith("!")) return isDirectAvailabilityState(stripOuterParentheses(expression.slice(1)));
  const comparison = splitDirectBooleanComparison(expression);
  if (!comparison) return false;
  const [left, operator, right] = comparison;
  return (isDirectAvailabilityState(left) && ((operator === "==" && right === "false") || (operator === "!=" && right === "true")))
    || (isDirectAvailabilityState(right) && ((operator === "==" && left === "false") || (operator === "!=" && left === "true")));
}
function isDirectVisibilityExpression(expression: string): boolean {
  const value = maskStringLiterals(stripOuterParentheses(expression));
  if (/!(?!=)/.test(value) || hasTopLevelBooleanOrTernaryOperator(value)) return false;
  return /(?:\.exists\b|\.waitForExistence\s*\([^()]*\))\s*$/.test(value);
}
function isDirectAvailabilityState(expression: string): boolean {
  const value = maskStringLiterals(stripOuterParentheses(expression));
  if (/!(?!=)/.test(value) || hasTopLevelBooleanOrTernaryOperator(value)) return false;
  return /(?:\.isEnabled\b|\.exists\b|\bcanPurchase\b)\s*$/.test(value);
}
function hasTopLevelBooleanOrTernaryOperator(source: string): boolean {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (parentheses === 0 && brackets === 0 && braces === 0) {
      if (source.startsWith("&&", index) || source.startsWith("||", index) || source.startsWith("==", index) || source.startsWith("!=", index)) return true;
      if (character === ":" || (character === "?" && source[index + 1] !== ".")) return true;
    }
  }
  return false;
}
function splitDirectBooleanComparison(expression: string): [string, "==" | "!=", string] | undefined {
  const value = stripOuterParentheses(expression);
  const match = value.match(/^([\s\S]+?)\s*(==|!=)\s*([\s\S]+)$/);
  if (!match || /(?:&&|\|\|)/.test(value)) return undefined;
  return [stripOuterParentheses(match[1]), match[2] as "==" | "!=", stripOuterParentheses(match[3])];
}
function maskStringLiterals(source: string): string { return source.replace(/"(?:\\.|[^"\\])*"/g, '""'); }
function stripOuterParentheses(source: string): string {
  let value = source.trim();
  while (value.startsWith("(") && matchingDelimiter(value, 0, "(", ")", value.length) === value.length - 1) value = value.slice(1, -1).trim();
  return value;
}
function callArguments(source: string): string[] {
  const opening = source.indexOf("(");
  if (opening < 0) return [];
  const closing = matchingDelimiter(source, opening, "(", ")", source.length);
  return closing < 0 ? [] : splitTopLevelArguments(source.slice(opening + 1, closing));
}
function splitTopLevelArguments(source: string): string[] {
  const values: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === "," && parentheses === 0 && brackets === 0 && braces === 0) { values.push(source.slice(start, index).trim()); start = index + 1; }
  }
  values.push(source.slice(start).trim());
  return values.filter(Boolean);
}
function visibleUICallArguments(source: string, names: Set<string>): string[] {
  const argumentsList: string[] = [];
  for (const match of source.matchAll(/\b(Text|Button|Label|Link|NavigationLink)\s*\(/g)) {
    if (!names.has(match[1])) continue;
    const opening = source.indexOf("(", match.index);
    const closing = matchingDelimiter(source, opening, "(", ")", 2_000);
    if (closing < 0) continue;
    const rawArguments = source.slice(opening + 1, closing);
    if (match[1] === "Text" || match[1] === "Label") { argumentsList.push(rawArguments); continue; }
    const visibleParts: string[] = [];
    const firstArgument = splitTopLevelArguments(rawArguments)[0];
    if (firstArgument && !/^[A-Za-z_]\w*\s*:/.test(firstArgument)) visibleParts.push(firstArgument);
    const firstClosure = closureImmediatelyAfter(source, closing + 1);
    if (firstClosure) {
      const explicitLabel = labeledClosureImmediatelyAfter(source, firstClosure.end + 1, "label");
      if (explicitLabel) visibleParts.push(explicitLabel.body);
      else if (/\b(?:action|destination)\s*:/.test(rawArguments)) visibleParts.push(firstClosure.body);
    }
    if (visibleParts.length) argumentsList.push(visibleParts.join("\n"));
  }
  for (const match of source.matchAll(/\b(Button|Label|Link|NavigationLink)\s*\{/g)) {
    if (!names.has(match[1])) continue;
    const opening = source.indexOf("{", match.index);
    const closing = matchingDelimiter(source, opening, "{", "}", 3_000);
    if (closing < 0) continue;
    const label = labeledClosureImmediatelyAfter(source, closing + 1, "label");
    if (label) argumentsList.push(label.body);
  }
  return argumentsList;
}
function closureImmediatelyAfter(source: string, start: number): { body: string; end: number } | undefined {
  const offset = source.slice(start).search(/\S/);
  const opening = offset < 0 ? -1 : start + offset;
  if (opening < 0 || source[opening] !== "{") return undefined;
  const closing = matchingDelimiter(source, opening, "{", "}", 3_000);
  return closing < 0 ? undefined : { body: source.slice(opening + 1, closing), end: closing };
}
function labeledClosureImmediatelyAfter(source: string, start: number, label: string): { body: string; end: number } | undefined {
  const match = source.slice(start, start + 1_000).match(new RegExp(`^\\s*${label}\\s*:\\s*\\{`));
  if (!match) return undefined;
  const opening = start + match[0].lastIndexOf("{");
  const closing = matchingDelimiter(source, opening, "{", "}", 3_000);
  return closing < 0 ? undefined : { body: source.slice(opening + 1, closing), end: closing };
}
function matchingDelimiter(source: string, opening: number, open: string, close: string, limit: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = opening; index < source.length && index - opening <= limit; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === open) depth++;
    else if (character === close && --depth === 0) return index;
  }
  return -1;
}
function balancedBlock(source: string, opening: number, limit = 50_000): string {
  const closing = matchingDelimiter(source, opening, "{", "}", limit);
  return closing < 0 ? "" : source.slice(opening + 1, closing);
}
function credibleSwiftTestBodies(source: string): string {
  const bodies: string[] = [];
  if (/\bimport\s+XCTest\b/.test(source) && /:\s*XCTestCase\b/.test(source)) {
    for (const match of source.matchAll(/\bfunc\s+test[A-Za-z0-9_]*\s*\([^)]*\)[^{]*\{/g)) {
      const opening = source.indexOf("{", match.index);
      const body = balancedBlock(source, opening);
      if (body) bodies.push(body);
    }
  }
  if (/\bimport\s+Testing\b/.test(source)) {
    for (const match of source.matchAll(/@Test(?:\s*\([^)]*\))?[\s\S]{0,500}?\bfunc\s+[A-Za-z_]\w*\s*\([^)]*\)[^{]*\{/g)) {
      const opening = source.indexOf("{", match.index);
      const body = balancedBlock(source, opening);
      if (body) bodies.push(body);
    }
  }
  return bodies.join("\n");
}
function hasRenderedSwiftUICall(source: string, name: "ProductView" | "SubscriptionStoreView" | "StoreView"): boolean {
  for (const match of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
    if (!isInsideAssignmentExpression(source, match.index)) return true;
  }
  return false;
}
function isInsideAssignmentExpression(source: string, index: number): boolean {
  for (const declaration of source.matchAll(/\b(?:let|var)\s+[A-Za-z_]\w*(?:\s*:\s*[^=\n]+)?\s*=(?!=)/g)) {
    if (declaration.index >= index || isConditionalBinding(source, declaration.index)) continue;
    const equals = declaration.index + declaration[0].lastIndexOf("=");
    if (index > equals && index < swiftInitializerEnd(source, equals + 1)) return true;
  }
  return false;
}
function isConditionalBinding(source: string, declaration: number): boolean {
  const boundary = Math.max(source.lastIndexOf("{", declaration), source.lastIndexOf("}", declaration), source.lastIndexOf(";", declaration));
  return /\b(?:if|guard|while|for)\b[\s\S]*$/.test(source.slice(boundary + 1, declaration));
}
function swiftInitializerEnd(source: string, start: number): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let inString = false;
  let escaped = false;
  let lastSignificant = "=";
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; lastSignificant = character; continue; }
    if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "{") braces++;
    else if (character === "}") braces--;
    if (parentheses === 0 && brackets === 0 && braces === 0) {
      if (character === ";") return index;
      if (character === "\n" && !/[=([{,:+\-*/?&|.]$/.test(lastSignificant)) return index;
    }
    if (!/\s/.test(character)) lastSignificant = character;
  }
  return source.length;
}
function hasUnverifiedCustomProductViewStyle(source: string): boolean {
  for (const match of source.matchAll(/\.productViewStyle\s*\(/g)) {
    const opening = source.indexOf("(", match.index);
    const closing = matchingDelimiter(source, opening, "(", ")", 1_000);
    if (closing < 0) return true;
    const style = stripOuterParentheses(source.slice(opening + 1, closing));
    if (!/^\.(?:automatic|compact|regular|large)$/.test(style)) return true;
  }
  return false;
}
function hasUnverifiedCustomSubscriptionStoreControlStyle(source: string): boolean {
  for (const match of source.matchAll(/\.subscriptionStoreControlStyle\s*\(/g)) {
    const opening = source.indexOf("(", match.index);
    const closing = matchingDelimiter(source, opening, "(", ")", 1_000);
    if (closing < 0) return true;
    const style = stripOuterParentheses(splitTopLevelArguments(source.slice(opening + 1, closing))[0] ?? "");
    if (!/^\.(?:automatic|buttons|picker|prominentPicker|compactPicker|pagedPicker|pagedProminentPicker)$/.test(style)) return true;
  }
  return false;
}
function visibleTextEvidence(source: string): string {
  const visibleSource = maskHiddenControlClosures(source);
  const visibleArguments = visibleUICallArguments(visibleSource, new Set(["Text", "Label"]));
  const resolved = [...visibleArguments];
  for (const match of visibleSource.matchAll(/\b(?:let|var)\s+([A-Za-z_]\w*)\s*=\s*"([^"\n]{1,2000})"/g)) {
    const nearbySource = visibleSource.slice(match.index, match.index + 2_000);
    const nearbyVisible = visibleUICallArguments(nearbySource, new Set(["Text", "Label"]));
    const reference = new RegExp(`\\b${match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (nearbyVisible.some((value) => reference.test(value))) resolved.push(match[2]);
  }
  return resolved.join("\n");
}
function maskHiddenControlClosures(source: string): string {
  const ranges: Array<[number, number]> = [];
  for (const match of source.matchAll(/\b(Button|Link|NavigationLink)\s*\(/g)) {
    const opening = source.indexOf("(", match.index);
    const closing = matchingDelimiter(source, opening, "(", ")", 2_000);
    if (closing < 0) continue;
    const rawArguments = source.slice(opening + 1, closing);
    for (const hidden of rawArguments.matchAll(/\b(?:action|destination)\s*:\s*\{/g)) {
      const hiddenOpening = opening + 1 + hidden.index + hidden[0].lastIndexOf("{");
      const hiddenClosing = matchingDelimiter(source, hiddenOpening, "{", "}", 3_000);
      if (hiddenClosing >= 0) ranges.push([hiddenOpening, hiddenClosing]);
    }
    const firstClosure = closureImmediatelyAfter(source, closing + 1);
    if (!firstClosure) continue;
    const firstArgument = splitTopLevelArguments(rawArguments)[0];
    const explicitLabel = labeledClosureImmediatelyAfter(source, firstClosure.end + 1, "label");
    if (explicitLabel || (firstArgument && !/^[A-Za-z_]\w*\s*:/.test(firstArgument))) ranges.push([source.indexOf("{", closing + 1), firstClosure.end]);
  }
  for (const match of source.matchAll(/\b(Button|Link|NavigationLink)\s*\{/g)) {
    const opening = source.indexOf("{", match.index);
    const closing = matchingDelimiter(source, opening, "{", "}", 3_000);
    if (closing >= 0) ranges.push([opening, closing]);
  }
  if (!ranges.length) return source;
  const characters = [...source];
  for (const [start, end] of ranges) for (let index = start; index <= end; index++) if (characters[index] !== "\n") characters[index] = " ";
  return characters.join("");
}
function hasVisibleLocalizedPrice(source: string): boolean {
  const visibleArguments = visibleUICallArguments(source, new Set(["Text", "Button", "Label"]));
  if (visibleArguments.some((value) => /\.displayPrice\b/.test(value))) return true;
  for (const match of source.matchAll(/\b(?:let|var)\s+([A-Za-z_]\w*)\s*=\s*[^\n;]*\.displayPrice\b/g)) {
    const name = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (visibleArguments.some((value) => new RegExp(`\\\\\\(${name}\\b`).test(value))) return true;
  }
  return false;
}
function hasUnavailablePurchaseState(source: string): boolean {
  for (const branch of source.matchAll(/\bif\s+let\s+[^{}\n]*(?:product|price)[^{}]*\{/gi)) {
    const opening = source.indexOf("{", branch.index);
    const body = balancedBlock(source, opening);
    if (/\bButton\s*(?:\(|\{)/.test(body) && /\.purchase\s*\(/.test(body)) return true;
  }
  for (const button of purchaseButtonEvidence(source)) {
    if (!/\.purchase\s*\(/.test(button.core)) continue;
    if (button.disabledPredicates.some(isSafePurchaseDisabledPredicate)) return true;
  }
  return false;
}
function purchaseButtonEvidence(source: string): Array<{ core: string; disabledPredicates: string[] }> {
  const evidence: Array<{ core: string; disabledPredicates: string[] }> = [];
  for (const match of source.matchAll(/\bButton\s*(\(|\{)/g)) {
    const opening = source.indexOf(match[1], match.index);
    const closing = matchingDelimiter(source, opening, match[1], match[1] === "(" ? ")" : "}", 5_000);
    if (closing < 0) continue;
    let end = closing;
    const firstClosure = match[1] === "(" ? closureImmediatelyAfter(source, closing + 1) : undefined;
    if (firstClosure) end = firstClosure.end;
    const labelClosure = labeledClosureImmediatelyAfter(source, end + 1, "label");
    if (labelClosure) end = labelClosure.end;
    const disabledPredicates: string[] = [];
    let cursor = end + 1;
    while (cursor < source.length) {
      const whitespace = source.slice(cursor).match(/^\s*/)?.[0].length || 0;
      cursor += whitespace;
      const modifier = source.slice(cursor).match(/^\.([A-Za-z_]\w*)\s*\(/);
      if (!modifier) break;
      const modifierOpening = cursor + modifier[0].lastIndexOf("(");
      const modifierClosing = matchingDelimiter(source, modifierOpening, "(", ")", 2_000);
      if (modifierClosing < 0) break;
      if (modifier[1] === "disabled") disabledPredicates.push(source.slice(modifierOpening + 1, modifierClosing));
      cursor = modifierClosing + 1;
    }
    evidence.push({ core: source.slice(match.index, end + 1), disabledPredicates });
  }
  return evidence;
}
function isSafePurchaseDisabledPredicate(predicate: string): boolean {
  const value = stripOuterParentheses(predicate).replace(/\s+/g, " ").trim();
  if (/(?:&&|\|\|)/.test(value)) return false;
  if (/^(?:[A-Za-z_]\w*\.)*(?:isLoading|loading|priceLoading|productLoading)$/i.test(value)) return true;
  if (/^(?:[A-Za-z_]\w*\.)*(?:product|price)\s*==\s*nil$/i.test(value)) return true;
  return /^!\s*(?:[A-Za-z_]\w*\.)*(?:isAvailable|available|canPurchase|priceLoaded|productLoaded)$/i.test(value);
}
function hasVisibleSubscriptionPeriod(source: string): boolean {
  return visibleUICallArguments(source, new Set(["Text", "Button", "Label"])).some((value) => /(?:subscriptionPeriod|billing\s+period|billed\s+(?:weekly|monthly|yearly)|renews?\s+(?:weekly|monthly|yearly)|per\s+(?:week|month|year))/i.test(value));
}
function hasVisibleOfferTerms(source: string): boolean {
  return visibleUICallArguments(source, new Set(["Text", "Button", "Label"])).some((value) => /(?:introductory\s+offer|free\s+trial|trial\s+(?:then|followed|renews|for)|offer\s+terms)/i.test(value));
}
function hasVisibleTermsAndPrivacyLinks(source: string): boolean {
  const links = visibleUICallArguments(source, new Set(["Link", "NavigationLink"]));
  const hasTermsLink = links.some((value) => /(?:terms|terms of use)/i.test(value));
  const hasPrivacyLink = links.some((value) => /privacy(?: policy)?/i.test(value));
  return hasTermsLink && hasPrivacyLink;
}
async function validEvidencePaths(repository: string, evidence: string[]): Promise<Set<string>> {
  const valid = new Set<string>();
  for (const value of evidence) {
    try { const target = await resolveContained(repository, value, "evidence path"); const details = await lstat(target); if (details.isFile() && !details.isSymbolicLink()) valid.add(value); } catch { /* invalid evidence is intentionally excluded */ }
  }
  return valid;
}
async function evidenceText(repository: string, evidence: string[]): Promise<{ complete: boolean; text: string; entries: Array<{ path: string; text: string }> }> {
  const chunks: string[] = [];
  const entries: Array<{ path: string; text: string }> = [];
  for (const value of evidence) {
    try {
      const target = await resolveContained(repository, value, "evidence path");
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink() || details.size > 1_000_000) return { complete: false, text: "", entries: [] };
      const text = await readFile(target, "utf8");
      chunks.push(text);
      entries.push({ path: value, text });
    } catch {
      return { complete: false, text: "", entries: [] };
    }
  }
  return { complete: evidence.length > 0 && chunks.length === evidence.length, text: chunks.join("\n"), entries };
}
function isFamilyScreenshotDimensions(family: "iphone" | "ipad", width: number, height: number): boolean { const supported = family === "iphone" ? IPHONE_SCREENSHOT_DIMENSIONS : IPAD_SCREENSHOT_DIMENSIONS; return supported.has(`${width}x${height}`) || supported.has(`${height}x${width}`); }
async function nonEmptySafeIconBundle(directory: string): Promise<boolean> {
  const pending = [directory]; let entries = 0; let contentFiles = 0;
  while (pending.length) {
    const current = pending.pop() as string; let children;
    try { children = await readdir(current, { withFileTypes: true }); } catch { return false; }
    for (const child of children) {
      if (++entries > 256 || child.isSymbolicLink()) return false;
      const target = path.join(current, child.name);
      if (child.isDirectory()) pending.push(target);
      else if (child.isFile()) { const details = await lstat(target); if (details.size > 0) contentFiles++; }
    }
  }
  return contentFiles > 0;
}
function isReviewScreenshotDimension(manifest: ShipLayerManifest, width: number, height: number): boolean { return manifest.app.deviceFamilies.some((family) => { const supported = family === "iphone" ? IPHONE_REVIEW_SCREENSHOT_DIMENSIONS : IPAD_REVIEW_SCREENSHOT_DIMENSIONS; return supported.has(`${width}x${height}`) || supported.has(`${height}x${width}`); }); }
function sameOrientationOrReverse(width: number, height: number, expectedWidth: number, expectedHeight: number): boolean { return (width === expectedWidth && height === expectedHeight) || (width === expectedHeight && height === expectedWidth); }
