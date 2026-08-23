import path from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AnalysisReport, CheckResult, LocaleCopy, PreflightReport, ShipLayerManifest } from "./types.js";
import { analyzeRepository, findPermissionRequestSites, findValue } from "./scanner.js";
import { readText, relative, resolveContained, walkRepository } from "./fs.js";
import { inspectImage } from "./image.js";
import { validateAscPrivateKey } from "./asc.js";
import { appReviewNotes } from "./generator.js";
import { DEFAULT_MARKETING_FINAL_DIR } from "./marketing.js";
import { aiContradictionFindingId, classifiedAiEndpointFindings, endpointFindingUrl, evidenceSources, externalFindingId, isLoopbackOrPrivateEndpoint, isNonProductionSourcePath, MONETIZATION_CONTRADICTION_FINDING, PURCHASE_UNAVAILABLE_CONTRADICTION_FINDING, productionEvidenceOnly, resolveContradictionOverride, storekitPurchaseEvidence, stripCodeComments } from "./evidence.js";
import { assessNotCollectionAttestation, notCollectionAttestationIssueMessage } from "./collection-attestation.js";
import { assessNotCollectionEvidence } from "./not-collection-evidence.js";
import { assessExternalServiceReadiness } from "./external-service-assessment.js";

// Apple requires ONE uniform size per required display class, and the classes are not
// interchangeable: a 6.5-inch capture does not satisfy the 6.9-inch slot. Each display class is
// its own Set so a per-image gate can check "is this an accepted size for THIS configuration's
// class", not "is this an accepted size somewhere in the whole family" (the latter let a 6.5-inch
// pair pass a 6.9-inch-configured slot — see acceptedDimensionsForConfig below).
const IPHONE_69_INCH_DIMENSIONS = new Set([
  "1320x2868", // iPhone 6.9-inch (e.g. iPhone 16 Pro Max)
  "1290x2796", // iPhone 6.9-inch (e.g. iPhone 17 Pro Max/Air)
  "1260x2736" // iPhone 6.9-inch (e.g. iPhone 17 Pro Max/Air, alternate build)
]);
const IPHONE_65_INCH_DIMENSIONS = new Set([
  "1242x2688", // iPhone 6.5-inch
  "1284x2778" // iPhone 6.5-inch legacy
]);
const IPHONE_SCREENSHOT_DIMENSIONS = new Set([...IPHONE_69_INCH_DIMENSIONS, ...IPHONE_65_INCH_DIMENSIONS]);
// iPad currently has only one required class, but it gets the same structural per-class Set as
// iPhone rather than one flat table: today that is equivalent (there is nothing else to leak from),
// but iPhone's cross-class bug (a 6.5-inch pair passing a 6.9-inch slot) happened precisely because
// a family-wide table was trusted as if it were class-scoped. Adding an 11-inch class here later
// must not silently reintroduce that bug by relying on a flat Set "coincidentally" rejecting it.
const IPAD_13_INCH_DIMENSIONS = new Set([
  "2064x2752", // iPad 13-inch
  "2048x2732" // iPad 13-inch (12.9-inch legacy hardware, same required slot)
]);
const IPAD_SCREENSHOT_DIMENSIONS = new Set([...IPAD_13_INCH_DIMENSIONS]);
// Storefront decks use the focused current marketing classes above. App Review
// screenshots may use any supported capture size for a declared device family.
const IPHONE_REVIEW_SCREENSHOT_DIMENSIONS = new Set([...IPHONE_SCREENSHOT_DIMENSIONS, "1206x2622", "1179x2556", "1170x2532", "1125x2436", "1080x2340", "828x1792", "1242x2208", "750x1334", "640x1136", "640x1096", "640x960", "640x920", "2622x1206", "2556x1179", "2532x1170", "2436x1125", "2340x1080", "1792x828", "2208x1242", "1334x750", "1136x640", "1096x640", "960x640", "920x640"]);
const IPAD_REVIEW_SCREENSHOT_DIMENSIONS = new Set([...IPAD_SCREENSHOT_DIMENSIONS, "2048x2732", "1668x2388", "1668x2224", "1640x2360", "1536x2048", "1488x2266", "1668x2420", "1536x2008", "768x1004", "768x1024", "2266x1488", "2420x1668", "2008x1536", "1004x768", "1024x768"]);
const APPLE_CATEGORIES = new Set(["Books", "Business", "Developer Tools", "Education", "Entertainment", "Finance", "Food & Drink", "Games", "Graphics & Design", "Health & Fitness", "Lifestyle", "Magazines & Newspapers", "Medical", "Music", "Navigation", "News", "Photo & Video", "Productivity", "Reference", "Shopping", "Social Networking", "Sports", "Travel", "Utilities", "Weather"]);

type Add = (id: string, severity: CheckResult["severity"], message: string, remediation?: string) => void;

export async function preflight(repository: string, manifest: ShipLayerManifest, remoteRequested = false, analysis?: AnalysisReport, environment: NodeJS.ProcessEnv = process.env): Promise<PreflightReport> {
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
  if (demo?.required && (!demo.usernameEnv || !demo.passwordEnv || !demo.setupInstructions || demo.credentialsEnteredConfirmation !== "confirmed")) add("review.demo-account", "block", "Demo account is required but secure references, setup instructions, or confirmation that the non-expiring reviewer credentials work and may be entered in App Store Connect are incomplete.", "Set only environment-variable names, record setup instructions, test the credentials in the current build, and explicitly confirm them; never put credentials in the manifest.");
  else if (demo?.required) add("review.demo-account", "pass", "Demo account uses secure environment-variable references and has a human confirmation that the credentials work and may be entered during an authorized apply.");
  else add("review.demo-account", "warn", "No login is required (self-declared; the scanner cannot verify the absence of an auth/login flow).", "Confirm during manual review that first launch truly requires no account or login.");
  const generatedReviewNotes = await appReviewNotes(repository, manifest, scan);
  const reviewBytes = Buffer.byteLength(generatedReviewNotes, "utf8");
  if (reviewBytes > 4_000) add("review.notes.length", "block", `Generated App Review notes have ${reviewBytes} UTF-8 bytes; Apple allows at most 4,000.`, "Shorten review notes, setup instructions, sample data, or scenarios.");
  else add("review.notes.length", "pass", `Generated App Review notes have ${reviewBytes} UTF-8 bytes.`);

  metadataChecks(manifest, add);
  permissionChecks(manifest, add);
  await permissionFlowChecks(repository, manifest, scan, add);
  exportComplianceCheck(manifest, add);
  confirmationChecks(manifest, add);
  await monetizationChecks(repository, manifest, scan, add);
  await aiDataSharingChecks(repository, manifest, scan, add);
  await purchasePresentationChecks(repository, manifest, add);
  screenshotConfigurationChecks(manifest, add);
  await screenshotChecks(repository, manifest, add);
  await marketingScreenshotChecks(repository, manifest, add);
  await purchaseAssetChecks(repository, manifest, add);
  await iconChecks(repository, manifest, add);
  await sourceConsistencyChecks(repository, manifest, scan, add);

  if (remoteRequested) {
    const pairs = [["key ID", manifest.sync.appStoreConnectKeyIdEnv], ["issuer ID", manifest.sync.issuerIdEnv], ["private-key path", manifest.sync.privateKeyPathEnv]] as const;
    const missingReferences = pairs.filter(([, reference]) => !reference).map(([label]) => label);
    const missingValues = pairs.filter(([, reference]) => reference && !environment[reference]).map(([, reference]) => reference as string);
    if (missingReferences.length || missingValues.length) add("asc.credentials", "block", `Remote App Store Connect discovery lacks ${[...missingReferences, ...missingValues].join(", ")}.`, "Set all three environment-variable references and values locally; never put secrets in shiplayer.yml.");
    else {
      const keyPath = environment[manifest.sync.privateKeyPathEnv as string] as string;
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
    // Copy is a human-reviewable proposal (an agent drafts it; ShipLayer only validates it), not a
    // fact — the same trust rule every other proposal in this manifest follows (monetization,
    // permissions, external processors, ...). Absent is never read as approved: only a literal
    // "confirmed" passes.
    if (localized.confirmation !== "confirmed") add(`metadata.${locale}.confirmation`, "block", `${locale} App Store copy is not human-confirmed.`, "Review every drafted field (name, subtitle, description, keywords, promotionalText, whatsNew) against what the app actually does, then set metadata.localizations[locale].confirmation: confirmed.");
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
    keywordHygieneChecks(locale, values, add);
    copyContentChecks(locale, values, add);
  }
  metadataContradictionChecks(manifest, add);
}

// --- keyword hygiene (2.3.7: keywords must be relevant; wasted budget is a real submission cost,
// not just a style nit) -----------------------------------------------------------------------
// Multiple CANDIDATE stems per word, not a single guessed one: a naive single-stem guess gets the
// common case of one word wrong. E.g. "expenses" ends in "-ses", which looks like the sibilant
// "-es" plural (box -> boxes, watch -> watches, whose stem drops "es") but is actually the simple
// "-s" plural of "expense" (whose stem should drop only "s"). Trying both candidates and matching
// on ANY shared candidate (see keywordHygieneChecks below) gets both shapes right without having
// to decide up front which rule applies to a given word.
function keywordStemCandidates(word: string): Set<string> {
  const lower = word.toLowerCase();
  const candidates = new Set<string>([lower]);
  if (lower.length > 4 && lower.endsWith("ies")) candidates.add(`${lower.slice(0, -3)}y`);
  if (lower.length > 3 && lower.endsWith("es")) candidates.add(lower.slice(0, -2));
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) candidates.add(lower.slice(0, -1));
  return candidates;
}
function keywordHygieneChecks(locale: string, values: LocaleCopy, add: Add): void {
  const keywords = values.keywords || [];
  if (!keywords.length) return;
  const untrimmed = keywords.filter((keyword) => keyword !== keyword.trim());
  if (untrimmed.length) add(`metadata.${locale}.keywords.whitespace`, "warn", `${locale} keywords contain leading/trailing whitespace (${untrimmed.map((keyword) => `'${keyword}'`).join(", ")}), which wastes the 100-character keyword budget when joined with commas.`, "Trim whitespace from every keyword; do not add a space after the comma separator.");
  const nameSubtitleWords = new Set(tokenizeWords([values.name, values.subtitle].filter((value): value is string => Boolean(value)).join(" ")));
  const overlapping = keywords.filter((keyword) => tokenizeWords(keyword).some((word) => nameSubtitleWords.has(word)));
  if (overlapping.length) add(`metadata.${locale}.keywords.redundant`, "warn", `${locale} keywords repeat word(s) already in name/subtitle (${overlapping.map((keyword) => `'${keyword}'`).join(", ")}); Apple indexes name/subtitle separately, so repeating them wastes keyword budget.`, "Replace repeated words with new search terms not already covered by name/subtitle.");
  const singleWordKeywords = keywords.filter((keyword) => !/\s/.test(keyword.trim()));
  const byCandidate = new Map<string, string[]>();
  for (const keyword of singleWordKeywords) for (const candidate of keywordStemCandidates(keyword.trim())) byCandidate.set(candidate, [...(byCandidate.get(candidate) || []), keyword]);
  const reportedGroups = new Set<string>();
  for (const group of byCandidate.values()) {
    const distinct = [...new Set(group)];
    if (distinct.length < 2) continue;
    const key = distinct.slice().sort().join(" ");
    if (reportedGroups.has(key)) continue;
    reportedGroups.add(key);
    add(`metadata.${locale}.keywords.plural-duplicate`, "warn", `${locale} keywords contain likely plural/singular duplicates of the same word: ${distinct.map((keyword) => `'${keyword}'`).join(", ")}.`, "Apple treats keywords as a bag of words already; keep only one form and use the freed budget for a new term.");
  }
}
function tokenizeWords(text: string): string[] { return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3); }

// --- placeholder / other-platform / judgment-call content checks (App Review 2.3) -------------
// Every pattern below is a heuristic over natural-language copy, not a proof: a regex can only
// ever approximate "this text makes claim X". Where a common, legitimate phrase would collide
// with a literal claim (e.g. "hassle-free", "distraction-free app", "free up storage" must never
// be confused with a price claim), the pattern is deliberately narrowed or guarded rather than
// left to false-block honest copy — see hasUnguardedMatch below. Placeholder text and explicit
// other-platform references are the two categories precise enough to block outright; pricing,
// beta/trial/test language, and unsubstantiated superlatives are judgment calls Apple's own review
// team makes contextually, so those stay warn-only.
const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /lorem ipsum/i, label: "'Lorem ipsum' placeholder text" },
  { pattern: /\bTODO\b/, label: "'TODO' placeholder text" },
  { pattern: /\bXXX\b/, label: "'XXX' placeholder text" },
  { pattern: /<\s*your\s+app(?:\s+name)?\s*>/i, label: "'<your app>' placeholder text" },
  { pattern: /\[\s*your\s+app(?:\s+name)?\s*\]/i, label: "'[your app]' placeholder text" },
  { pattern: /<\s*app\s+name\s*>/i, label: "'<app name>' placeholder text" },
  { pattern: /\[\s*app\s+name\s*\]/i, label: "'[app name]' placeholder text" }
];
// 2.3.10: no references to another platform/storefront. "Windows" is matched case-sensitively
// only (not /i) — the lowercase common noun ("multiple windows", "window treatments") is far more
// likely in honest copy than the capitalized OS reference, and this check has no negation guard.
const OTHER_PLATFORM_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bandroid\b/i, label: "Android" },
  { pattern: /\bgoogle play\b/i, label: "Google Play" },
  { pattern: /\bplay store\b/i, label: "Play Store" },
  { pattern: /\bWindows\b/, label: "Windows" },
  { pattern: /\bweb version\b/i, label: "Web version" },
  { pattern: /\bdesktop version\b/i, label: "Desktop version" }
];
const PRICING_PATTERNS: RegExp[] = [/[$€£¥]\s?\d/, /\bonly\s+[$€£¥]/i, /\b\d+(?:\.\d{2})?\s?(?:usd|dollars?|eur|euros?|gbp|pounds?)\b/i];
const BETA_TRIAL_TEST_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bbeta\b/i, label: "'beta'" },
  { pattern: /\btrial version\b/i, label: "'trial version'" },
  { pattern: /\btest version\b/i, label: "'test version'" },
  { pattern: /\bwork[\s-]in[\s-]progress\b/i, label: "'work in progress'" },
  { pattern: /\bstill in development\b/i, label: "'still in development'" }
];
const SUPERLATIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /#\s?1\b/, label: "'#1'" },
  { pattern: /\bnumber one\b/i, label: "'number one'" },
  { pattern: /\bbest app\b/i, label: "'best app'" },
  { pattern: /\bworld'?s best\b/i, label: "'world's best'" },
  { pattern: /\btop[\s-]rated\b/i, label: "'top-rated'" },
  { pattern: /\bbest[\s-]in[\s-]class\b/i, label: "'best-in-class'" }
];
function copyFields(values: LocaleCopy): Array<[string, string]> {
  const fields: Array<[string, string | undefined]> = [["name", values.name], ["subtitle", values.subtitle], ["description", values.description], ["promotionalText", values.promotionalText], ["whatsNew", values.whatsNew], ["keywords", values.keywords?.join(", ")]];
  return fields.filter((entry): entry is [string, string] => Boolean(entry[1]));
}
function copyContentChecks(locale: string, values: LocaleCopy, add: Add): void {
  for (const [field, text] of copyFields(values)) {
    for (const { pattern, label } of PLACEHOLDER_PATTERNS) if (pattern.test(text)) add(`metadata.${locale}.${field}.placeholder`, "block", `${locale} ${field} still contains ${label}.`, "Replace every placeholder with real, reviewed copy describing what the app actually does.");
    for (const { pattern, label } of OTHER_PLATFORM_PATTERNS) if (pattern.test(text)) add(`metadata.${locale}.${field}.other-platform`, "block", `${locale} ${field} references another platform (${label}); App Review 2.3.10 forbids this in App Store metadata.`, "Remove the other-platform reference; describe only the iOS/iPadOS app.");
    if (PRICING_PATTERNS.some((pattern) => pattern.test(text))) add(`metadata.${locale}.${field}.pricing`, "warn", `${locale} ${field} appears to state a specific price; Apple review (2.3.12) generally rejects pricing claims in metadata since prices vary by storefront.`, "Describe value/features instead of a specific price; pricing is shown by StoreKit itself.");
    for (const { pattern, label } of BETA_TRIAL_TEST_PATTERNS) if (pattern.test(text)) add(`metadata.${locale}.${field}.beta-trial-test`, "warn", `${locale} ${field} contains ${label}, which can read as an unfinished/non-production release.`, "Confirm this is intentional (e.g. a legitimate free-trial offer description); otherwise remove it before a production listing.");
    for (const { pattern, label } of SUPERLATIVE_PATTERNS) if (pattern.test(text)) add(`metadata.${locale}.${field}.superlative`, "warn", `${locale} ${field} contains the unsubstantiated superlative ${label}.`, "Remove or substantiate the claim (e.g. with an award/ranking source) before submission.");
  }
}

// --- cross-check: copy must not contradict what the manifest declares the app actually does ---
// This is the "understanding layer": copy is compared against manifest.monetization,
// manifest.app.deviceFamilies, and manifest.aiDataSharing — the same declarations preflight's own
// monetization/AI gates already cross-check against source evidence elsewhere in this file. A
// regex over natural language can never prove a negative, so every pattern here is deliberately
// narrow (multi-word phrases, not a bare "free") and guarded against the specific false positives
// named in review ("hassle-free", "free up space", "distraction-free app") — see
// hasUnguardedMatch. Where the guard cannot rule out a false read, this stays a warn, never a
// block (the AI-mention check below is warn-only for exactly this reason).
// Both guards below scan EVERY match in the text (a fresh global-flagged copy of the caller's
// pattern), not just the first — an early "guarded" match (e.g. "ad-free" hyphen-compounded, or a
// "no in-app purchase" negation) must never short-circuit a LATER, genuinely unguarded claim
// later in the same field. claimingIpadSupport below already does this correctly; these two did
// not, which was a real false-pass (a paid app could write "An ad-free app you will love. Also:
// this is a free app with no cost at all." and the free claim in the second sentence was never
// even examined). Mirrors claimingIpadSupport's /g-loop shape exactly.
function hasUnguardedMatch(text: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = global.exec(text))) {
    // Reject a match immediately preceded by a hyphen: "ad-free", "hassle-free", "worry-free", and
    // "distraction-free app" (which would otherwise satisfy a bare "free app" phrase) are English's
    // standard "without X" compounding, not a price claim.
    if (!/-\s*$/.test(text.slice(0, match.index))) return true;
    if (match[0].length === 0) global.lastIndex++;
  }
  return false;
}
function hasMatchNotNegatedByNo(text: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = global.exec(text))) {
    if (!/\bno\s*$/i.test(text.slice(Math.max(0, match.index - 6), match.index))) return true;
    if (match[0].length === 0) global.lastIndex++;
  }
  return false;
}
// FREE_CLAIM_PATTERNS claims the app costs NOTHING — false for every monetization type except
// "free", including "paid-app" (a paid-app IS a purchase, just not an in-app one). "free to try"
// is split out on its own: a subscription's genuine, declared free-trial introductory offer makes
// that specific phrase TRUE, so it is suppressed (never checked) only when such an offer is
// actually declared — see hasDeclaredFreeTrialOffer below. "free to download"/"free to use" stay
// in this list unconditionally: a subscription/non-consumable app is never free to download or
// free to use in the way those phrases claim (a free trial does not make the app itself free).
const FREE_CLAIM_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /completely free/i, label: "'completely free'" },
  { pattern: /100%\s*free/i, label: "'100% free'" },
  { pattern: /totally free/i, label: "'totally free'" },
  { pattern: /always free/i, label: "'always free'" },
  { pattern: /free forever/i, label: "'free forever'" },
  { pattern: /entirely free/i, label: "'entirely free'" },
  { pattern: /free of charge/i, label: "'free of charge'" },
  { pattern: /free app\b/i, label: "'free app'" },
  { pattern: /free to (?:download|use)\b/i, label: "'free to download/use'" },
  { pattern: /download(?:ed)? for free\b/i, label: "'download for free'" },
  { pattern: /get it (?:for )?free\b/i, label: "'get it free'" }
];
const FREE_TRIAL_CLAIM_PATTERN = { pattern: /free to try\b/i, label: "'free to try'" };
// NO_PURCHASE_CLAIM_PATTERNS claims the app has no IN-APP purchase — true for "free" AND
// "paid-app" alike (paying once for the app itself is not an in-app purchase), so this must only
// fire for a monetization type that actually models one (non-consumables/subscriptions). "no
// hidden fees/costs" was deliberately dropped: it is a transparency claim ("nothing beyond the
// stated price is sprung on you"), not a claim that no purchase exists at all, and is honestly
// sayable by a paid app, a non-consumable, or a subscription alike — see PR review B1.
const NO_PURCHASE_CLAIM_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /no in-app purchases?\b/i, label: "'no in-app purchases'" },
  { pattern: /no iaps?\b/i, label: "'no IAP'" },
  { pattern: /no purchases? necessary\b/i, label: "'no purchase necessary'" }
];
function hasIapCapability(money: ShipLayerManifest["monetization"]): boolean { return money.type === "non-consumables" || money.type === "subscriptions"; }
function hasDeclaredFreeTrialOffer(money: ShipLayerManifest["monetization"]): boolean { return money.type === "subscriptions" && money.products.some((product) => product.introductoryOffer?.type === "free-trial"); }
const NO_SUBSCRIPTION_PATTERN = { pattern: /no subscriptions?\b/i, label: "'no subscription'" };
const ONE_TIME_PURCHASE_PATTERN = { pattern: /one-time purchase\b/i, label: "'one-time purchase'" };
const PAID_CLAIM_PATTERNS: Array<{ pattern: RegExp; label: string; guardNo?: boolean }> = [
  { pattern: /in-app purchase/i, label: "'in-app purchase'", guardNo: true },
  { pattern: /premium subscription/i, label: "'premium subscription'" },
  { pattern: /requires? (?:a )?subscription/i, label: "'requires a subscription'" },
  { pattern: /\$\d+(?:\.\d{2})?\s*\/\s*(?:month|mo|year|yr|week)\b/i, label: "a subscription price" },
  { pattern: /unlock (?:the )?full version/i, label: "'unlock the full version'" }
];
const IPAD_NEGATION_PATTERN = /\b(?:not|no|isn'?t|is not|doesn'?t|does not|without|excludes?|iphone[\s-]only)\b/i;
const IPAD_TRAILING_NEGATION_PATTERN = /\b(?:not supported|not available|coming soon|unsupported)\b/i;
// A negation word anywhere within a flat character window (the original implementation) is too
// coarse: "There are no ads at all, and it looks stunning on iPad." has "no" ~30 characters before
// "iPad" but they are in different CLAUSES — the negation has nothing to do with iPad support. Stop
// the lookback/lookahead at the nearest clause boundary (sentence-ending punctuation or a comma)
// instead of a fixed distance, so only a negation genuinely modifying the SAME clause as "iPad"
// can clear it. Bounded to 400 characters as a defensive cap for punctuation-free text.
const CLAUSE_BOUNDARY_PATTERN = /[.!?;,\n]/;
function clauseBefore(text: string, index: number): string {
  let boundary = -1;
  for (let cursor = index - 1; cursor >= 0 && index - cursor <= 400; cursor--) { if (CLAUSE_BOUNDARY_PATTERN.test(text[cursor])) { boundary = cursor; break; } }
  return text.slice(boundary + 1, index);
}
function clauseAfter(text: string, index: number): string {
  let boundary = text.length;
  for (let cursor = index; cursor < text.length && cursor - index <= 400; cursor++) { if (CLAUSE_BOUNDARY_PATTERN.test(text[cursor])) { boundary = cursor; break; } }
  return text.slice(index, boundary);
}
function claimingIpadSupport(text: string): boolean {
  const pattern = /\bipad\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const before = clauseBefore(text, match.index);
    const after = clauseAfter(text, match.index);
    if (!IPAD_NEGATION_PATTERN.test(before) && !IPAD_TRAILING_NEGATION_PATTERN.test(after)) return true;
  }
  return false;
}
function mentionsAi(text: string, processorNames: string[]): boolean {
  if (/\bAI\b/.test(text) || /artificial intelligence/i.test(text) || /machine learning/i.test(text)) return true;
  return processorNames.some((name) => name && text.toLocaleLowerCase("en-US").includes(name.toLocaleLowerCase("en-US")));
}
function metadataContradictionChecks(manifest: ShipLayerManifest, add: Add): void {
  const money = manifest.monetization;
  let anyMentionsAi = false;
  const processorNames = manifest.aiDataSharing.enabled ? manifest.aiDataSharing.processorNames : [];
  for (const [locale, values] of Object.entries(manifest.metadata.localizations)) {
    for (const [field, text] of copyFields(values)) {
      if (field === "keywords") continue; // a keyword list is not prose; monetization/platform claims only meaningfully appear in written copy
      const zeroCostClaim = FREE_CLAIM_PATTERNS.find(({ pattern }) => hasUnguardedMatch(text, pattern));
      if (zeroCostClaim && money.type !== "free") add(`metadata.${locale}.${field}.monetization-contradiction`, "block", `${locale} ${field} claims ${zeroCostClaim.label}, but monetization.type is declared '${money.type}', not 'free'.`, "Rewrite the copy to accurately describe the real IAP/subscription model, or correct monetization.type if this app is genuinely free.");
      if (!hasDeclaredFreeTrialOffer(money) && hasUnguardedMatch(text, FREE_TRIAL_CLAIM_PATTERN.pattern) && money.type !== "free") add(`metadata.${locale}.${field}.monetization-contradiction`, "block", `${locale} ${field} claims ${FREE_TRIAL_CLAIM_PATTERN.label}, but monetization.type is declared '${money.type}' with no declared free-trial introductoryOffer.`, "Declare a free-trial introductoryOffer on the subscription product if one genuinely exists, or remove this claim.");
      const noPurchaseClaim = NO_PURCHASE_CLAIM_PATTERNS.find(({ pattern }) => hasUnguardedMatch(text, pattern));
      if (noPurchaseClaim && hasIapCapability(money)) add(`metadata.${locale}.${field}.monetization-contradiction`, "block", `${locale} ${field} claims ${noPurchaseClaim.label}, but monetization.type is declared '${money.type}', which has an in-app purchase.`, "Rewrite the copy to accurately describe the real IAP/subscription model, or correct monetization.type if this app genuinely has no in-app purchase.");
      if (hasUnguardedMatch(text, NO_SUBSCRIPTION_PATTERN.pattern) && money.type === "subscriptions") add(`metadata.${locale}.${field}.monetization-contradiction`, "block", `${locale} ${field} claims ${NO_SUBSCRIPTION_PATTERN.label}, but monetization.type is 'subscriptions'.`, "Rewrite the copy to accurately describe the subscription, or correct monetization.type.");
      if (hasUnguardedMatch(text, ONE_TIME_PURCHASE_PATTERN.pattern) && (money.type === "subscriptions" || money.type === "free")) add(`metadata.${locale}.${field}.monetization-contradiction`, "block", `${locale} ${field} claims ${ONE_TIME_PURCHASE_PATTERN.label}, which contradicts monetization.type '${money.type}' (${money.type === "free" ? "no purchase exists" : "a subscription renews, it is not one-time"}).`, "Rewrite the copy to accurately describe the real monetization model, or correct monetization.type.");
      if (money.type === "free") {
        const paidClaim = PAID_CLAIM_PATTERNS.find(({ pattern, guardNo }) => guardNo ? hasMatchNotNegatedByNo(text, pattern) : pattern.test(text));
        if (paidClaim) add(`metadata.${locale}.${field}.monetization-contradiction`, "block", `${locale} ${field} claims ${paidClaim.label}, but monetization.type is 'free' with no declared purchase.`, "Rewrite the copy to match the real free monetization model, or declare the actual IAP/subscription in monetization.");
      }
      if (!manifest.app.deviceFamilies.includes("ipad") && claimingIpadSupport(text)) add(`metadata.${locale}.${field}.device-family-contradiction`, "block", `${locale} ${field} appears to claim iPad support, but app.deviceFamilies is ${JSON.stringify(manifest.app.deviceFamilies)}.`, "Remove the iPad claim, or add 'ipad' to app.deviceFamilies only after verifying real iPad support.");
      if (mentionsAi(text, processorNames)) anyMentionsAi = true;
    }
  }
  if (manifest.aiDataSharing.enabled && !anyMentionsAi) add("metadata.ai-mention", "warn", "aiDataSharing.enabled is true, but no configured locale's App Store copy mentions AI or names an AI processor.", "Disclose the AI-powered feature in the listing (subtitle/description/whatsNew) so users form accurate expectations before downloading — this app has previously been rejected for undisclosed AI processing.");
}

function permissionChecks(manifest: ShipLayerManifest, add: Add): void {
  for (const permission of manifest.permissions) {
    if (!permission.purpose) add(`permission.${permission.key}`, "block", `${permission.key} has no user-facing purpose string.`, "Add a specific purpose string matching actual access.");
    else if (permission.confirmation !== "confirmed") add(`permission.${permission.key}`, "block", `${permission.key} is not human-confirmed.`, "Confirm the permission and purpose before submission.");
    else add(`permission.${permission.key}`, "pass", `${permission.key} has a confirmed purpose string.`);
  }
}

// --- permission-flow gates (App Review 5.1.1(iv)) --------------------------------------------
// BackYet was rejected because a dismissible custom sheet sat in front of the one-time system
// camera prompt, and its denied-access fallback offered alternatives but no Settings link.
//
// Design: DECLARATIONS BLOCK, HEURISTICS WARN AND CORROBORATE — the same shape as aiDataSharing
// and sourceContradictionOverrides elsewhere in this file. An earlier version of this section
// inverted that: a weak same-file static heuristic was the blocker, and the human declaration was
// only ever checked for "did you answer", never "is the answer acceptable". That let a written
// admission of the exact rejected shape (`dismissibleScreenBeforePrompt: true, confirmation:
// confirmed`) pass with zero blocks, and let a same-file text heuristic both false-pass (two
// unrelated tokens anywhere in one file) and false-block (the ordinary SwiftUI MVVM/ObservableObject
// split — a manager owns the request and publishes status, a view renders the denied UI and the
// Settings link in a DIFFERENT file — which is BackYet's own real architecture for its notifications
// permission, not an edge case). Fixed shape:
//   - permission-flow.<category>.confirmation — always required. Blocks unless permissionFlows has
//     a `confirmed` declaration for the category. Never satisfiable by absence, an unconfirmed
//     entry, or a default value.
//   - permission-flow.<category>.dismissible-screen — blocks whenever a CONFIRMED declaration
//     itself says `dismissibleScreenBeforePrompt: true` — a written admission of the 5.1.1(iv)
//     violation — independent of whether any heuristic below can detect it.
//   - permission-flow.<category>.denied-path-settings-link — blocks unless a CONFIRMED declaration
//     says `deniedPathOffersSettingsLink: true`. This, not a text heuristic, is the authoritative
//     answer to "does the denied path reach Settings" — Apple named this in the rejection text, but
//     no static heuristic can safely PROVE it across real architectures (see settingsLinkCorroborated
//     below), so the human/agent answer is what gates readiness.
//   - permission-flow.<category>.settings-link-heuristic — advisory only (warn/pass, never block).
//     Corroborates the denied-path-settings-link declaration: same-file (or, one hop, a production
//     file that references a type declared in the request-site file — the MVVM manager/view split)
//     correlation of a `.denied`/`.restricted` marker with `UIApplication.openSettingsURLString`,
//     scoped to one enclosing brace region (not "anywhere in the file"), including the common
//     SwiftUI idiom of a denied-branch setting an `@State` flag that a separate `.sheet`/
//     `.confirmationDialog`/`.alert`/`.popover(isPresented: $flag)` reads to present the Settings
//     button (BackYet's own a3e72fd camera shape). A failed corroboration never blocks by itself —
//     it only tells a human/agent the declaration could not be independently verified.
//   - permission-flow.<category>.sheet-gated — the owner's chosen heuristic, independently verified
//     sound by review and unchanged here: blocks only when the permission-request call is
//     reachable, in a given production file, exclusively through a `.sheet`/`.confirmationDialog`/
//     `.alert`/`.popover` presentation (including a function invoked only as that presentation's
//     onDismiss callback) — BackYet's exact rejected shape. Clearable only by a confirmed
//     permissionFlows declaration stating `dismissibleScreenBeforePrompt: false`.
const SETTINGS_LINK_PATTERN = /\bopenSettingsURLString\b/;
const DENIED_MARKER_PATTERN = /\.denied\b|\.restricted\b/g;
// A denied-marker's correlated region must be roughly "one switch/if/function body", not "the rest
// of the type" — bounding this is what keeps the heuristic from degrading back into "anywhere in
// the file" once brace-region matching is in play.
const DENIED_CORRELATION_MAX_SPAN = 4_000;
// `if status == .denied {` puts the marker in the condition, lexically BEFORE the block it really
// belongs to; a small header window lets that shape still count as "inside" the following block.
const DENIED_HEADER_WINDOW = 200;

interface SwiftFunctionRegion { name: string; nameStart: number; bodyStart: number; bodyEnd: number; }
interface TextRegion { start: number; end: number; }

/** Every `func name(...) { ... }` region in `content`, using the same quote-aware balanced-
 * delimiter scan as the rest of this file (matchingDelimiter). A signature ShipLayer cannot find a
 * body brace for within a bounded window (a protocol requirement, or an unusually long generic/
 * where clause) is simply omitted — call sites inside an unrecognized function then have no
 * enclosing function, which fails a gating check open (not gated), never closed. */
function permissionFlowFunctionRegions(content: string): SwiftFunctionRegion[] {
  const regions: SwiftFunctionRegion[] = [];
  for (const match of content.matchAll(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{]*>)?\s*\(/g)) {
    const name = match[1]; const declStart = match.index ?? 0;
    // The name's own position, not "func"'s — permissionFlowCallSiteIndices matches on the NAME,
    // so excluding the declaration itself must compare against the same position.
    const nameStart = declStart + match[0].indexOf(name, 4);
    const parenOpen = declStart + match[0].length - 1;
    const parenClose = matchingDelimiter(content, parenOpen, "(", ")", 20_000);
    if (parenClose < 0) continue;
    const between = content.slice(parenClose + 1, Math.min(content.length, parenClose + 1 + 300));
    const braceOffset = between.search(/\{/);
    const boundaryOffset = between.search(/[;}]/);
    if (braceOffset < 0 || (boundaryOffset >= 0 && boundaryOffset < braceOffset)) continue;
    const braceOpen = parenClose + 1 + braceOffset;
    const braceClose = matchingDelimiter(content, braceOpen, "{", "}", 200_000);
    if (braceClose < 0) continue;
    regions.push({ name, nameStart, bodyStart: braceOpen, bodyEnd: braceClose });
  }
  return regions;
}

/** Every `.sheet(`/`.confirmationDialog(`/`.alert(`/`.popover(` modifier's dismissible region(s):
 * its primary trailing content closure, a second labeled trailing closure (SwiftUI's
 * `} message: { ... }` shape), and an inline `onDismiss: { ... }` closure literal. Also collects
 * the names of any function referenced as a bare `onDismiss: someFunction` value — SwiftUI always
 * runs onDismiss strictly after that presentation is dismissed (Cancel, swipe, or a selection that
 * calls dismiss()), so a function reachable only that way is exactly as gated as one called
 * directly inside the presented screen. */
function permissionFlowDismissibleRegions(content: string): { regions: TextRegion[]; onDismissNames: Set<string> } {
  const regions: TextRegion[] = []; const onDismissNames = new Set<string>();
  for (const match of content.matchAll(/\.(?:sheet|confirmationDialog|alert|popover)\s*\(/g)) {
    const argsOpen = (match.index ?? 0) + match[0].length - 1;
    const argsClose = matchingDelimiter(content, argsOpen, "(", ")", 20_000);
    if (argsClose < 0) continue;
    const argsText = content.slice(argsOpen + 1, argsClose);
    // No trailing `[,)]` requirement: argsText is sliced to EXCLUDE the call's own closing paren
    // (matchingDelimiter returns that index, not a substring including it), so `onDismiss:` as the
    // last/only argument would never be followed by a `,` or `)` inside argsText itself. A bare
    // trailing word boundary is sufficient and correct regardless of what (if anything) follows.
    const namedDismiss = argsText.match(/\bonDismiss\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (namedDismiss && namedDismiss[1] !== "nil") onDismissNames.add(namedDismiss[1]);
    const inlineDismiss = argsText.match(/\bonDismiss\s*:\s*\{/);
    if (inlineDismiss) {
      const braceIndex = argsOpen + 1 + (inlineDismiss.index ?? 0) + inlineDismiss[0].length - 1;
      const braceClose = matchingDelimiter(content, braceIndex, "{", "}", 50_000);
      if (braceClose >= 0) regions.push({ start: braceIndex, end: braceClose });
    }
    const gap = content.slice(argsClose + 1, argsClose + 1 + 40).match(/^\s*/);
    const afterSpace = argsClose + 1 + (gap ? gap[0].length : 0);
    if (content[afterSpace] !== "{") continue;
    const firstClose = matchingDelimiter(content, afterSpace, "{", "}", 50_000);
    if (firstClose < 0) continue;
    regions.push({ start: afterSpace, end: firstClose });
    const labelWindow = content.slice(firstClose + 1, firstClose + 1 + 60);
    const labelMatch = labelWindow.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*\{/);
    if (!labelMatch) continue;
    const secondBrace = firstClose + 1 + labelMatch[0].lastIndexOf("{");
    const secondClose = matchingDelimiter(content, secondBrace, "{", "}", 50_000);
    if (secondClose >= 0) regions.push({ start: secondBrace, end: secondClose });
  }
  return { regions, onDismissNames };
}

function withinAnyRegion(index: number, regions: TextRegion[]): boolean { return regions.some((region) => index >= region.start && index <= region.end); }
function permissionFlowEnclosingFunction(index: number, functions: SwiftFunctionRegion[]): SwiftFunctionRegion | undefined {
  let best: SwiftFunctionRegion | undefined;
  for (const region of functions) if (index > region.bodyStart && index < region.bodyEnd && (!best || region.bodyEnd - region.bodyStart < best.bodyEnd - best.bodyStart)) best = region;
  return best;
}
function permissionFlowCallSiteIndices(content: string, name: string, functions: SwiftFunctionRegion[]): number[] {
  const declStarts = new Set(functions.filter((item) => item.name === name).map((item) => item.nameStart));
  const pattern = new RegExp(`\\b${escapePermissionFlowRegex(name)}\\s*\\(`, "g");
  const indices: number[] = [];
  for (const match of content.matchAll(pattern)) { const index = match.index ?? 0; if (!declStarts.has(index)) indices.push(index); }
  return indices;
}
/** True when EVERY call site of `name` is itself gated: lexically inside a dismissible-
 * presentation region, or inside a function that is (recursively) exclusively gated the same way.
 * A function with zero found call sites is treated as an entry point, not gated (fail open) — this
 * is deliberately the same direction as an unrecognized/unclassifiable call site below: this
 * heuristic must never manufacture a block it cannot actually support with a located call chain. */
function isFunctionExclusivelyGated(name: string, content: string, functions: SwiftFunctionRegion[], regions: TextRegion[], onDismissNames: Set<string>, memo: Map<string, boolean>, stack: Set<string>, depth: number): boolean {
  if (memo.has(name)) return memo.get(name) as boolean;
  if (stack.has(name) || depth > 12) return false;
  stack.add(name);
  let result: boolean;
  if (onDismissNames.has(name)) result = true;
  else {
    const sites = permissionFlowCallSiteIndices(content, name, functions);
    result = sites.length > 0 && sites.every((index) => {
      if (withinAnyRegion(index, regions)) return true;
      const enclosing = permissionFlowEnclosingFunction(index, functions);
      return enclosing ? isFunctionExclusivelyGated(enclosing.name, content, functions, regions, onDismissNames, memo, stack, depth + 1) : false;
    });
  }
  stack.delete(name); memo.set(name, result);
  return result;
}
function isRequestSiteGated(index: number, content: string, functions: SwiftFunctionRegion[], regions: TextRegion[], onDismissNames: Set<string>): boolean {
  if (withinAnyRegion(index, regions)) return true;
  const enclosing = permissionFlowEnclosingFunction(index, functions);
  return enclosing ? isFunctionExclusivelyGated(enclosing.name, content, functions, regions, onDismissNames, new Map(), new Set(), 0) : false;
}

// --- settings-link corroboration (advisory only — see the module comment above) ---------------

/** Every `{ ... }` region in `content` in ONE pass (a stack of open-brace indices, popped on each
 * matching close), quote-aware. Reused for both the direct denied/settings-link correlation below
 * and, structurally, mirrors matchingDelimiter's own quote handling. Independent of
 * permissionFlowFunctionRegions because a correlated region is very often NOT a whole function body
 * (a `switch`/`if` block, or a `.sheet`/`.confirmationDialog` trailing closure). */
function swiftBraceRegions(content: string): TextRegion[] {
  const regions: TextRegion[] = []; const stack: number[] = []; let quote = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (quote) { if (character === "\\" && index + 1 < content.length) { index++; continue; } if (character === "\"") quote = false; continue; }
    if (character === "\"") { quote = true; continue; }
    if (character === "{") { stack.push(index); continue; }
    if (character === "}") { const open = stack.pop(); if (open !== undefined) regions.push({ start: open, end: index }); }
  }
  return regions;
}
/** Regions containing `index`, extended backward by DENIED_HEADER_WINDOW so a marker in an `if`/
 * `switch` CONDITION (lexically before that statement's own `{`) still counts as "inside" it,
 * sorted innermost (smallest) first so a bounded local check tries the tightest scope first. */
function enclosingRegionsNear(index: number, regions: TextRegion[]): TextRegion[] {
  return regions.filter((region) => index >= region.start - DENIED_HEADER_WINDOW && index < region.end).sort((left, right) => (left.end - left.start) - (right.end - right.start));
}
/** Every `.sheet`/`.confirmationDialog`/`.alert`/`.popover(isPresented: $name, ...)` binding whose
 * OWN primary content closure reaches `openSettingsURLString` — directly, or through exactly one
 * function-call hop to a function (found via permissionFlowFunctionRegions) whose body contains it.
 * Models SwiftUI's common declarative idiom: a denied-branch sets `name = true`, and a SEPARATE
 * modifier bound to `$name` presents the actual Settings button — BackYet's own a3e72fd camera
 * shape (`isShowingCameraPermissionDenied` set in `beginCameraCapture()`'s `.denied` case, read by
 * a `.confirmationDialog` whose button calls `openSystemSettings()`). */
function settingsPresentingFlags(content: string, functions: SwiftFunctionRegion[]): Set<string> {
  const flags = new Set<string>();
  for (const match of content.matchAll(/\.(?:sheet|confirmationDialog|alert|popover)\s*\(/g)) {
    const argsOpen = (match.index ?? 0) + match[0].length - 1;
    const argsClose = matchingDelimiter(content, argsOpen, "(", ")", 20_000);
    if (argsClose < 0) continue;
    const isPresented = content.slice(argsOpen + 1, argsClose).match(/\bisPresented\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)/);
    if (!isPresented) continue;
    const gap = content.slice(argsClose + 1, argsClose + 1 + 40).match(/^\s*/);
    const afterSpace = argsClose + 1 + (gap ? gap[0].length : 0);
    if (content[afterSpace] !== "{") continue;
    const firstClose = matchingDelimiter(content, afterSpace, "{", "}", 50_000);
    if (firstClose < 0) continue;
    const region = content.slice(afterSpace, firstClose);
    const reachesSettings = SETTINGS_LINK_PATTERN.test(region) || functions.some((fn) => new RegExp(`\\b${escapePermissionFlowRegex(fn.name)}\\s*\\(`).test(region) && SETTINGS_LINK_PATTERN.test(content.slice(fn.bodyStart, fn.bodyEnd)));
    if (reachesSettings) flags.add(isPresented[1]);
  }
  return flags;
}
/**
 * True when a `.denied`/`.restricted` marker's own local, bounded enclosing region either (a)
 * directly contains `openSettingsURLString`, or (b) sets one of `settingsPresentingFlags` to
 * `true`. Deliberately scoped (not "anywhere in the file") — see the module comment.
 *
 * `categorySiteIndices`, when given, additionally requires that SAME region to contain a genuine
 * request-site index for the category under test — this is what stops a file that happens to
 * handle TWO permissions (e.g. a shared PermissionCoordinator) from letting one category's real
 * denied+Settings-link handling "corroborate" an unrelated category that has no such handling of
 * its own at all. Omitted for the one-hop joined-file check in settingsLinkCorroborated below,
 * where the type-name join itself already provides the category scoping — the whole point of that
 * join is to find a file that renders the denied UI WITHOUT itself calling the request API.
 */
function hasLocalDeniedSettingsCorrelation(content: string, categorySiteIndices?: number[]): boolean {
  const regions = swiftBraceRegions(content);
  const functions = permissionFlowFunctionRegions(content);
  const flags = settingsPresentingFlags(content, functions);
  const flagAssignment = flags.size ? new RegExp(`\\b(?:${[...flags].map(escapePermissionFlowRegex).join("|")})\\s*=\\s*true\\b`) : undefined;
  for (const match of content.matchAll(DENIED_MARKER_PATTERN)) {
    const deniedIndex = match.index ?? 0;
    if (categorySiteIndices) {
      // Category scoping uses the enclosing FUNCTION boundary specifically, not the generic
      // brace-region walk below: a brace region wide enough to satisfy the size cap can span
      // multiple unrelated functions in the same type (e.g. a PermissionCoordinator handling both
      // camera and notifications), which would otherwise let one category's real denied+Settings-
      // link handling "corroborate" a completely different category that has no such handling at
      // all — the exact cross-category leak this parameter exists to prevent. A denied marker with
      // no enclosing function (e.g. written directly in a computed `var body`) cannot be scoped
      // this way and is skipped for the category check — a corroboration this heuristic cannot
      // actually support must never be manufactured; it only ever costs a "warn", not a false pass.
      const enclosingFn = permissionFlowEnclosingFunction(deniedIndex, functions);
      if (!enclosingFn || !categorySiteIndices.some((index) => index > enclosingFn.bodyStart && index < enclosingFn.bodyEnd)) continue;
    }
    for (const region of enclosingRegionsNear(deniedIndex, regions)) {
      if (region.end - region.start > DENIED_CORRELATION_MAX_SPAN) break;
      const text = content.slice(region.start, region.end);
      if (SETTINGS_LINK_PATTERN.test(text)) return true;
      if (flagAssignment && flagAssignment.test(text)) return true;
    }
  }
  return false;
}
/** Top-level type names `content` DECLARES (class/struct/enum/actor at any indentation — nested
 * types included, extensions excluded since they don't introduce a new type identity). Used only
 * for the one-hop join below. */
function declaredTypeNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(/^[ \t]*(?:(?:public|private|internal|fileprivate|open|final)\s+)*(?:class|struct|enum|actor)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) names.push(match[1]);
  return names;
}
function escapePermissionFlowRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Whether ShipLayer's static heuristic can corroborate a denied-state Settings link for one
 * category: same-file first, then — because the request/authorization-check file and the file that
 * actually renders the denied-state Settings UI are routinely different files under ordinary
 * SwiftUI MVVM/ObservableObject architecture (a manager owns the request, a view renders the denied
 * UI) — a ONE-HOP join through a type name the request-site file declares, referenced by another
 * production file that itself has a local correlation. Deliberately NOT "openSettingsURLString
 * exists anywhere in the app": that widening would also corroborate a Settings link that has
 * nothing to do with this permission (see the module comment). Advisory only — see above.
 */
async function settingsLinkCorroborated(repository: string, category: string, evidenceEntries: Array<{ path: string; text: string }>): Promise<{ corroborated: boolean; source?: string }> {
  const cleanedEntries = evidenceEntries.map((entry) => ({ path: entry.path, cleaned: stripNonReleaseConditionalCompilation(stripCodeComments(entry.text)) }));
  for (const entry of cleanedEntries) {
    const categorySites = findPermissionRequestSites(entry.cleaned).filter((site) => site.category === category).map((site) => site.index);
    if (hasLocalDeniedSettingsCorrelation(entry.cleaned, categorySites)) return { corroborated: true, source: entry.path };
  }

  const joinTypes = new Set<string>();
  for (const entry of cleanedEntries) for (const name of declaredTypeNames(entry.cleaned)) joinTypes.add(name);
  if (!joinTypes.size) return { corroborated: false };
  const joinPattern = new RegExp(`\\b(?:${[...joinTypes].map(escapePermissionFlowRegex).join("|")})\\b`);
  const evidencePaths = new Set(evidenceEntries.map((entry) => entry.path));

  const root = path.resolve(repository);
  let walked: Awaited<ReturnType<typeof walkRepository>>;
  try { walked = await walkRepository(root); } catch { return { corroborated: false }; }
  for (const file of walked.files) {
    if (!/\.(?:swift|m|mm)$/i.test(file)) continue;
    const relativePath = relative(root, file);
    if (evidencePaths.has(relativePath) || !isProductionSourceEvidencePath(relativePath)) continue;
    let text: string;
    try { text = await readText(file); } catch { continue; }
    const commentStripped = stripCodeComments(text);
    if (!joinPattern.test(commentStripped)) continue;
    // No category-site requirement here: this file was found BECAUSE it references a type the
    // request-site file declares, which is already the category-scoping signal — requiring a
    // request-site match here too would defeat the entire point of the join (the ordinary SwiftUI
    // MVVM split has the denied UI in a view file that never calls the request API itself).
    if (hasLocalDeniedSettingsCorrelation(stripNonReleaseConditionalCompilation(commentStripped))) return { corroborated: true, source: relativePath };
  }
  return { corroborated: false };
}

async function permissionFlowChecks(repository: string, manifest: ShipLayerManifest, analysis: AnalysisReport, add: Add): Promise<void> {
  const findings = productionEvidenceOnly(analysis.findings.filter((item) => item.key.startsWith("permissionFlow:")));
  for (const finding of findings) {
    const category = finding.key.slice("permissionFlow:".length);
    const evidenceSourcesForCategory = [...new Set(finding.evidence.map((item) => item.source))].sort();
    const declaration = manifest.permissionFlows.find((item) => item.category === category);
    const confirmed = declaration?.confirmation === "confirmed";

    if (!confirmed) add(`permission-flow.${category}.confirmation`, "block", `ShipLayer detected a runtime ${category} permission request in ${evidenceSourcesForCategory.join(", ")}, but permissionFlows has no human-confirmed declaration for '${category}' answering whether a dismissible custom screen can appear before the system permission prompt, and whether the denied-state path offers a link to Settings (App Review guideline 5.1.1(iv)).`, "Add a permissionFlows entry for this category, and set confirmation: confirmed only after verifying the real on-device flow.");
    else add(`permission-flow.${category}.confirmation`, "pass", `permissionFlows has a human-confirmed flow declaration for '${category}'.`);

    // These two only fire once a human has actually committed to an answer — while unconfirmed,
    // the confirmation block above already covers it; a written but unconfirmed guess must not
    // itself carry any weight in either direction.
    if (confirmed && declaration) {
      if (declaration.dismissibleScreenBeforePrompt === true) add(`permission-flow.${category}.dismissible-screen`, "block", `permissionFlows for '${category}' confirms the user CAN dismiss a custom screen before the system permission prompt — a written admission of the exact shape Apple rejected under 5.1.1(iv) (a dismissible screen in front of the one-time system prompt). This blocks independent of any heuristic.`, `Restructure the flow so the request is reachable directly, or so the custom screen always proceeds to the prompt with no Cancel/dismiss, then set dismissibleScreenBeforePrompt: false only after verifying the real on-device flow.`);
      else add(`permission-flow.${category}.dismissible-screen`, "pass", `permissionFlows confirms '${category}' has no dismissible screen before the system prompt.`);

      if (declaration.deniedPathOffersSettingsLink !== true) add(`permission-flow.${category}.denied-path-settings-link`, "block", `permissionFlows for '${category}' does not confirm that the denied-access path offers a link to Settings (App Review guideline 5.1.1(iv): "it may be helpful to include a notification to inform the user and provide a link to the Settings app").`, `Add a denied-state UI with a link to Settings (UIApplication.openSettingsURLString), then set deniedPathOffersSettingsLink: true only after verifying the real on-device flow.`);
      else add(`permission-flow.${category}.denied-path-settings-link`, "pass", `permissionFlows confirms '${category}''s denied-access path offers a link to Settings.`);
    }

    // Advisory only, from here down — see the module comment. Neither of the following two checks
    // can ever produce "block": a heuristic this weak must never gate readiness, only corroborate
    // or fail to corroborate what the declaration above already says.
    const evidence = await evidenceText(repository, evidenceSourcesForCategory);
    if (!evidence.complete) add(`permission-flow.${category}.settings-link-heuristic`, "warn", `ShipLayer could not re-read production evidence for '${category}' to attempt static corroboration of a denied-path Settings link; this is informational only and does not block — permissionFlows.deniedPathOffersSettingsLink is the authoritative declaration.`, "Verify the denied-path Settings link manually.");
    else {
      const { corroborated, source } = await settingsLinkCorroborated(repository, category, evidence.entries);
      if (corroborated) add(`permission-flow.${category}.settings-link-heuristic`, "pass", `ShipLayer found a denied-state marker and UIApplication.openSettingsURLString near each other in ${source}. This is a weak textual signal, not proof that '${category}' has a working denied-path route to Settings: the two can be unrelated, and the one-hop type join is not category-scoped. Verify the real flow; permissionFlows.deniedPathOffersSettingsLink is what actually gates this.`);
      else add(`permission-flow.${category}.settings-link-heuristic`, "warn", `ShipLayer's static heuristic could not corroborate a denied-path Settings link for '${category}' (same-file, or one-hop through a referenced type, correlation of a denied/restricted marker with UIApplication.openSettingsURLString). This is informational only and does not block — permissionFlows.deniedPathOffersSettingsLink is the authoritative declaration; verify it is accurate.`, "Verify the denied-path Settings link manually, or add one so this can be corroborated.");
    }

    let gatedFile: string | undefined; let gatedExcerpt: string | undefined;
    if (evidence.complete) {
      for (const entry of evidence.entries) {
        if (gatedFile) break;
        const cleaned = stripNonReleaseConditionalCompilation(stripCodeComments(entry.text));
        const sites = findPermissionRequestSites(cleaned).filter((site) => site.category === category);
        if (!sites.length) continue;
        const functions = permissionFlowFunctionRegions(cleaned);
        const { regions, onDismissNames } = permissionFlowDismissibleRegions(cleaned);
        const gatedSite = sites.find((site) => isRequestSiteGated(site.index, cleaned, functions, regions, onDismissNames));
        if (gatedSite) { gatedFile = entry.path; gatedExcerpt = gatedSite.excerpt; }
      }
    }

    if (gatedFile) {
      const cleared = confirmed && declaration?.dismissibleScreenBeforePrompt === false;
      if (!cleared) add(`permission-flow.${category}.sheet-gated`, "block", `${gatedFile} only reaches the ${category} permission request (${gatedExcerpt}) from inside a dismissible sheet/confirmationDialog/alert/popover. This is the exact shape Apple rejected under 5.1.1(iv): a dismissible custom screen in front of the one-time system prompt.`, `Either restructure ${gatedFile} so the request is reachable directly, or so the custom screen always proceeds to the prompt with no Cancel/dismiss; or, only after verifying the screen truly cannot be dismissed, set permissionFlows['${category}'].dismissibleScreenBeforePrompt: false and confirmation: confirmed.`);
      else add(`permission-flow.${category}.sheet-gated`, "pass", `permissionFlows confirms '${category}' has no dismissible screen before the system prompt.`);
    }
  }
  for (const declaration of manifest.permissionFlows) if (!findings.some((finding) => finding.key === `permissionFlow:${declaration.category}`)) add(`permission-flow.${declaration.category}`, "warn", `permissionFlows declares '${declaration.category}' but ShipLayer found no matching runtime permission-request source evidence.`, "Verify this declaration is still accurate, or remove it if the app no longer requests this permission this way.");
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
  for (const item of manifest.dataProcessing) {
    if (item.confirmation !== "confirmed") add(`privacy.${item.category}`, "block", `${item.category} is a declared App Privacy data category but is not human-confirmed.`, "Confirm collection, use, tracking, and identity linkage, or remove this dataProcessing row if it is not applicable. A declared data category cannot use confirmation: not-applicable.");
  }
  // A row in externalProcessors is itself a claim that the app uses that processor. Unlike a
  // dataProcessing row, it therefore cannot be marked "not-applicable": that value used to let
  // a declared processor bypass both this confirmation gate and the collection-determination
  // checks below, producing a false-green canSubmit result.
  for (const processor of manifest.externalProcessors) if (processor.confirmation !== "confirmed") {
    add(`privacy.${processor.name}`, "block", `${processor.name} is a declared external processor but is not human-confirmed.`, "Confirm that this processor is used and its actual data handling, or remove the row if it is not applicable to this app. A declared processor cannot use confirmation: not-applicable.");
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

  // A truthful affirmativeAction declaration (whatever the app's real button says) must always
  // be loadable; this check is where Apple's transmission-language expectation is judged, not
  // manifest validation (see src/manifest.ts) — a manifest that could not hold the real label
  // would leave the app unable to reach `check` at all.
  const affirmativeActionSaysTransmission = /(?:send|share|upload|transmit)/i.test(sharing.consent.affirmativeAction);
  if (!affirmativeActionSaysTransmission) add("ai-sharing.consent-action-language", "block", `The declared affirmative action "${sharing.consent.affirmativeAction}" does not clearly say data will be sent, shared, uploaded, or transmitted.`, `Apple expects the pre-transmission action to explicitly state that data leaves the device (e.g. "Allow & Send to AI", "Scan & Upload"). Rename the action, then re-confirm it still matches what the production consent screen renders.`);
  const consentReady = sharing.consent.shownBeforeTransmission
    && sharing.consent.privacyPolicyLinkVisible
    && sharing.consent.confirmation === "confirmed"
    && affirmativeActionSaysTransmission
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
    // These booleans are a truthful, human-declared statement about the real paywall, not
    // something manifest validation may force to true (see src/manifest.ts) — a subscription
    // that genuinely does not show this before purchase must still be declarable so this gate
    // can block it with an actionable message instead of the manifest refusing to load.
    if (presentation.subscriptionPeriodVisibleBeforePurchase !== true || presentation.termsAndPrivacyLinksVisibleBeforePurchase !== true) add("purchase.subscription-disclosures", "block", "Subscription billing period or Terms/Privacy links are not confirmed visible before purchase.", "Show the billing period and both Terms of Use and Privacy Policy links on the paywall before purchase, then declare subscriptionPeriodVisibleBeforePurchase and termsAndPrivacyLinksVisibleBeforePurchase as true only once that is actually true.");
    if (money.products.some((product) => product.introductoryOffer) && presentation.offerTermsVisibleBeforePurchase !== true) add("purchase.offer-disclosures", "block", "Introductory-offer terms are not confirmed visible before purchase.", "Show the trial/introductory-offer terms on the paywall before purchase, then declare offerTermsVisibleBeforePurchase as true only once that is actually true.");
  }

  const source = await evidenceText(repository, presentation.sourceEvidence);
  const tests = await evidenceText(repository, presentation.testEvidence);
  const sourceRoleValid = presentation.sourceEvidence.every(isProductionSourceEvidencePath);
  const testRoleValid = presentation.testEvidence.every(isTestSourceEvidencePath);
  if (!sourceRoleValid) add("purchase.presentation-source-role", "block", "Purchase source evidence must reference production app source, not tests, fixtures, scripts, generated declarations, or documentation.", "Reference the contained production Swift/Objective-C paywall source.");
  if (!testRoleValid) add("purchase.presentation-test-role", "block", "Purchase test evidence must reference conventional test source paths.", "Reference contained UI/unit/snapshot test source under a Tests or UITests target/path.");
  // Shared with the test-evidence branch below, so a hard-coded price literal found in
  // production source can be cross-referenced against what the tests actually assert.
  let sourceCode = "";
  if (!source.complete) add("purchase.presentation-source", "block", "Purchase presentation source evidence is missing, symlinked, unreadable, or oversized.", "Reference production StoreKit/paywall source files.");
  else {
    sourceCode = stripNonReleaseConditionalCompilation(stripCodeComments(source.text));
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
    if (!unavailableStateRendered) {
      // This is a same-file heuristic, not a manifest-vs-source disagreement, but it can be
      // wrong about a real paywall shaped differently than it expects (e.g. the purchase-capable
      // control is a custom component reached through an enum case rather than a literal Button
      // with a recognized .disabled predicate) exactly the way a *.source-contradiction finding
      // can be wrong — so it is resolved through the same evidence-intersecting human override,
      // never silently, and it downgrades to a visible warning rather than clearing.
      const override = await resolveContradictionOverride(repository, manifest, PURCHASE_UNAVAILABLE_CONTRADICTION_FINDING, presentation.sourceEvidence);
      if (override) add("purchase.unavailable-source", "warn", `Purchase evidence in ${presentation.sourceEvidence.join(", ")} does not visibly keep payment unavailable while product/price data is loading or unavailable, but this is human-overridden: ${override.reason}`, "Re-verify this override whenever the source or manifest changes.");
      else add("purchase.unavailable-source", "block", "Purchase evidence does not keep payment unavailable while product/price data is loading or unavailable.", "Disable or withhold the purchase action until Product loads and render an explicit loading/unavailable/retry state, or add a confirmed sourceContradictionOverride naming 'purchase.unavailable-source' with a reason and evidence that intersects this finding's source paths if the real paywall does keep payment unavailable this way.");
    }

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
    const priceNamedPattern = /(?:displayPrice|paywall\.price|localized.{0,30}price|price.{0,30}(?:visible|exist|label))/is;
    const visiblePriceTested = positiveAssertions.some((value) => priceNamedPattern.test(value));
    const unavailableTested = assertions.some(isPurchaseUnavailableAssertion);
    // Scoped narrowly on purpose: only an assertion that is BOTH about the price (same
    // content filter as visiblePriceTested above) AND equality-shaped (XCTAssertEqual/#expect
    // ==, the only shapes that can assert "equals this literal" at all) can taint the result —
    // an unrelated existence assertion elsewhere in the same evidence file (routine when
    // testEvidence references a whole *UITests.swift file) can never trigger this.
    const hardcodedPriceLiterals = hardcodedPriceLiteralsInSource(sourceCode);
    let hardcodedPriceLiteral: string | undefined;
    for (const value of assertions) {
      if (!priceNamedPattern.test(value) || !isEqualityShapedAssertion(value)) continue;
      const found = hardcodedPriceLiteralInAssertion(value, hardcodedPriceLiterals);
      if (found) { hardcodedPriceLiteral = found; break; }
    }
    if (!visiblePriceTested) add("purchase.presentation-tests", "block", "Test evidence does not assert that the localized price is visible before purchase.", "Add a focused UI/snapshot assertion for visible localized pricing.");
    else if (hardcodedPriceLiteral) add("purchase.presentation-tests", "block", `Test evidence compares the price to "${hardcodedPriceLiteral}", a literal also hard-coded in production source, instead of proving the displayed value originates from StoreKit's Product.displayPrice.`, "Assert only that the price element exists/is visible (e.g. `.exists`, `.waitForExistence`), not equality with a specific fixed string; if the value must be launched with a test flag, drive it from real StoreKit Testing configuration rather than an in-app constant.");
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
    if (testRoleValid && Boolean(testBodies) && visiblePriceTested && !hardcodedPriceLiteral && unavailableTested && subscriptionTestsReady) add("purchase.presentation-tests", "pass", "Test evidence covers visible localized pricing, unavailable state, and applicable subscription disclosures.");
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
  // App Store allows at most 10 screenshots per family/locale set, and the marketing composition
  // project (see src/marketing.ts) renders exactly one slide per scenario for EVERY configured
  // family/locale — so more than 10 scenarios is already known, at prepare time, to over-produce
  // every set it renders. Warn here instead of only discovering it after a full render (the
  // post-hoc marketingScreenshotChecks/screenshotChecks file-count block below still catches it,
  // but only after `npm install && npm run export` has already done the (wasted) work).
  if (manifest.screenshots.scenarios.length > 10) add("screenshots.scenarios.count", "warn", `${manifest.screenshots.scenarios.length} screenshot scenarios are declared; App Store allows at most 10 screenshots per family/locale set. The marketing composition project will render one slide per scenario for every configured family/locale, over-producing each set.`, "Reduce to 10 or fewer scenarios, or accept that check will block the resulting set(s) after rendering.");
  // A scenario detected from an existing UI-test harness, or copied from the generated template,
  // is never silently promoted to confirmed — a human must verify the real on-screen navigation.
  // An absent confirmation field also blocks (rather than being treated as implicitly confirmed):
  // `init` always writes it explicitly now, so the only way to see it absent is a hand-authored
  // scenario or someone deleting the line to dodge review, and treating that as "confirmed" would
  // make deletion a silent, undetectable bypass of this exact gate.
  for (const scenario of manifest.screenshots.scenarios) {
    if (scenario.confirmation !== "confirmed") add(`screenshots.scenarios.${scenario.id}.confirmation`, "block", `Screenshot scenario '${scenario.id}' is not human-confirmed.`, "Verify the real on-screen navigation, then set confirmation: confirmed.");
    // A caption is optional (the slide still renders legibly with a placeholder), so this is a
    // warn, never a block. `init`'s unresolved question only fires for scenarios it detects from
    // an existing harness at init time; a scenario hand-added afterward gets no other reminder
    // from the CLI at all, only the rendered slide's own italic placeholder styling. Surfacing it
    // here too means `check` -- the one command actually re-run before every submission -- says
    // so as well, not just a one-time init message an agent may not still have in context.
    if (!scenario.caption) add(`screenshots.scenarios.${scenario.id}.caption`, "warn", `Screenshot scenario '${scenario.id}' has no drafted caption yet; its marketing slide falls back to the scenario title as a placeholder.`, "Draft a concise, human-reviewed caption (one idea per slide, max 100 characters, no line breaks) in screenshots.scenarios[].caption.");
  }
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
    // Apple accepts multiple dimensions per required DISPLAY CLASS (a 6.9" iPhone capture may
    // legitimately be 1320x2868, 1290x2796, or 1260x2736 depending on which simulator produced
    // it), so any size within THIS configuration's own class passes — but a 6.5-inch capture
    // must never satisfy a 6.9-inch-configured slot, so the accepted set is scoped to the class
    // config.requiredDimensions itself belongs to, never the whole iphone/ipad family. What IS
    // required is that every screenshot actually captured for this one family/locale slot is
    // EXACTLY identical to the others in both width and height (no orientation-swap tolerance
    // here — a portrait image and its landscape transpose are not "the same size" for a single
    // screenshot set); the first accepted image in the directory sets that reference.
    const acceptedForConfig = acceptedDimensionsForConfig(config);
    let reference: { width: number; height: number; image: string } | undefined;
    for (const image of imageFiles) {
      const details = await inspectImage(path.join(directory, image));
      const imageId = `${id}.${image}`;
      if (!details) { add(imageId, "block", `Could not inspect ${image}; use a readable PNG/JPEG without alpha.`); continue; }
      if (details.alpha) add(`${imageId}.alpha`, "block", `${image} has an alpha channel.`, "Export a flattened PNG/JPEG without transparency.");
      if (!acceptedForConfig.has(`${details.width}x${details.height}`) && !acceptedForConfig.has(`${details.height}x${details.width}`)) { add(`${imageId}.accepted-dimensions`, "block", `${image} is ${details.width}×${details.height}, which is not an accepted dimension for this ${config.family} ${dimensionClassLabel(config)} configuration (expected one of ${[...acceptedForConfig].join(", ") || "none — the configured requiredDimensions itself is not a recognized App Store size"}).`, "Export an accepted screenshot size for the configured display class."); continue; }
      if (!reference) { reference = { width: details.width, height: details.height, image }; add(`${imageId}.dimensions`, "pass", `${image} is an accepted ${config.family} dimension (${details.width}×${details.height}).`); }
      else if (details.width !== reference.width || details.height !== reference.height) add(`${imageId}.dimensions`, "block", `${image} is ${details.width}×${details.height}, which differs from ${reference.image} (${reference.width}×${reference.height}) already in this set; App Store Connect requires one uniform size per screenshot set.`, "Re-export every screenshot in this locale/family at the same exact dimension.");
      else add(`${imageId}.dimensions`, "pass", `${image} matches ${reference.image}'s dimensions.`);
    }
    // Coverage: a file satisfies a scenario via an exact stem match, or via the `<id>-*` wildcard
    // convention — but only when this scenario's id is the MOST SPECIFIC (longest) declared id
    // the file could plausibly belong to. Without this, a scenario id that is itself a hyphenated
    // extension of another id (e.g. a dedup suffix "home" / "home-2") lets one file such as
    // home-2.png satisfy both scenarios at once, silently passing a set that is missing a real
    // screenshot for "home".
    const scenarioIds = manifest.screenshots.scenarios.map((scenario) => scenario.id);
    for (const scenario of new Set(scenarioIds)) {
      const covered = imageFiles.some((image) => {
        const stem = path.basename(image, path.extname(image));
        if (stem === scenario) return true;
        if (!stem.startsWith(`${scenario}-`)) return false;
        const mostSpecific = scenarioIds.filter((candidate) => stem === candidate || stem.startsWith(`${candidate}-`)).sort((a, b) => b.length - a.length)[0];
        return mostSpecific === scenario;
      });
      if (!covered) add(`${id}.${scenario}`, "block", `No screenshot file corresponds to scenario '${scenario}'.`, `Capture ${scenario}.png (or ${scenario}-*.png) for this declared scenario.`);
    }
  }
}

// The rendered marketing PNGs (shiplayer prepare's screenshots/marketing/ project, exported by a
// human/agent running its own README-documented commands — see src/marketing.ts) get the SAME
// exact-dimension/uniform-size/count/no-alpha validation as raw captures above, because they are
// candidates for what actually gets uploaded and Apple applies the identical rules to them. This
// intentionally uses the real decoded pixel dimensions and a real alpha-channel inspection of each
// file on disk (inspectImage), never a self-declared value from slides.json or shiplayer.yml, so a
// broken/stale export cannot pass by merely claiming to be correct.
//
// The output location is manifest.screenshots.finalOutputDir — an explicit, persisted field
// (defaulting to DEFAULT_MARKETING_FINAL_DIR for a manifest that predates this field), the SAME
// field emitMarketingProject() uses to compute where export.mjs actually writes. This is
// deliberate: it must never be a hardcoded convention independent of what generateReleasePackage
// actually used, or a custom `--out`/finalOutputDir would make this check silently look at the
// wrong (or a stale) directory and report nothing — indistinguishable from "validated and fine"
// (see PR review finding F4).
//
// Unlike the raw-capture gate, an absent/empty final directory is never a blocker: rendering the
// marketing project is an optional, additional step in v0.1 (nothing in `apply`/`submit` consumes
// it yet), so a repository that has not run the export project must not be blocked by this check.
async function marketingScreenshotChecks(repository: string, manifest: ShipLayerManifest, add: Add): Promise<void> {
  const finalOutputDir = manifest.screenshots.finalOutputDir || DEFAULT_MARKETING_FINAL_DIR;
  // export.mjs always writes exactly `${scenario.id}.png` (no wildcard/suffix convention, unlike
  // raw captures) -- so a rendered file whose stem matches no CURRENT scenario id is orphaned: a
  // leftover from a scenario that has since been removed or renamed. preserveNonDeterministicMarketingArtifacts
  // in generator.ts carries the final/ directory forward across `prepare` reruns (see PR review
  // finding F3) precisely so a real render survives; nothing else ever prunes it when a scenario
  // disappears. Without this check, that orphaned PNG sits in the set `check` approves and a human
  // uploads it as if it still represented a current scenario. See PR review finding N5.
  const currentScenarioIds = new Set(manifest.screenshots.scenarios.map((scenario) => scenario.id));
  for (const config of manifest.screenshots.configurations) {
    const id = `marketing.${config.family}.${config.locale}`;
    const relativeDirectory = `${finalOutputDir}/${config.family}/${config.locale}`;
    let directory: string;
    try { directory = await resolveContained(repository, relativeDirectory, `marketing screenshots for ${config.family}`); }
    catch { continue; }
    if (!existsSync(directory)) continue;
    let imageFiles: string[];
    try { imageFiles = (await readdir(directory)).filter((file) => /\.(png|jpe?g)$/i.test(file)).sort(); }
    catch { add(id, "block", `Marketing screenshot directory is unreadable: ${relativeDirectory}.`); continue; }
    if (!imageFiles.length) { add(id, "block", `${relativeDirectory} exists but contains no rendered PNG/JPEG marketing screenshots.`, "Run npm install && npm run export inside screenshots/marketing, or remove the empty directory."); continue; }
    if (imageFiles.length > 10) add(`${id}.count`, "block", `${imageFiles.length} rendered marketing screenshots found; App Store allows at most 10.`);
    else add(`${id}.count`, "pass", `${imageFiles.length} rendered marketing screenshot(s) found.`);
    const acceptedForConfig = acceptedDimensionsForConfig(config);
    let reference: { width: number; height: number; image: string } | undefined;
    for (const image of imageFiles) {
      const details = await inspectImage(path.join(directory, image));
      const imageId = `${id}.${image}`;
      if (!details) { add(imageId, "block", `Could not inspect rendered marketing screenshot ${image}; it must be a readable PNG/JPEG without alpha.`); continue; }
      const stem = path.basename(image, path.extname(image));
      if (!currentScenarioIds.has(stem)) { add(`${imageId}.orphaned`, "block", `Rendered marketing screenshot ${image} does not correspond to any current screenshot scenario; it is left over from a removed or renamed scenario.`, "Delete this file (or the whole stale set) from the finalOutputDir and re-run npm run export, or restore the matching scenario in shiplayer.yml."); continue; }
      if (details.alpha) add(`${imageId}.alpha`, "block", `Rendered marketing screenshot ${image} has an alpha channel; Apple rejects screenshots with transparency.`, "export.mjs must emit alpha-free PNGs; re-run the export.");
      if (!acceptedForConfig.has(`${details.width}x${details.height}`) && !acceptedForConfig.has(`${details.height}x${details.width}`)) { add(`${imageId}.accepted-dimensions`, "block", `Rendered marketing screenshot ${image} is ${details.width}×${details.height}, which is not an accepted dimension for this ${config.family} ${dimensionClassLabel(config)} configuration.`, "Fix the slide's target width/height and re-render."); continue; }
      if (!reference) { reference = { width: details.width, height: details.height, image }; add(`${imageId}.dimensions`, "pass", `${image} is an accepted ${config.family} dimension (${details.width}×${details.height}).`); }
      else if (details.width !== reference.width || details.height !== reference.height) add(`${imageId}.dimensions`, "block", `Rendered marketing screenshot ${image} is ${details.width}×${details.height}, which differs from ${reference.image} (${reference.width}×${reference.height}) already in this set; App Store Connect requires one uniform size per screenshot set.`);
      else add(`${imageId}.dimensions`, "pass", `${image} matches ${reference.image}'s dimensions.`);
    }
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
  const externalReadiness = await assessExternalServiceReadiness(repository, manifest, report);
  for (const { finding, assessment } of externalReadiness.findings) {
    const findingId = externalFindingId(finding);
    if (finding.key.startsWith("endpoint:http://") && !isLoopbackOrPrivateEndpoint(finding.key.slice("endpoint:".length))) {
      const insecureEndpointId = `source.insecure-endpoint.${findingId}`;
      const insecureSourcePaths = new Set(finding.evidence.map((item) => item.source));
      const insecureOverride = await resolveContradictionOverride(repository, manifest, insecureEndpointId, insecureSourcePaths);
      if (insecureOverride) add(insecureEndpointId, "warn", `Source declares insecure HTTP endpoint ${String(finding.value)}, but this is human-overridden: ${insecureOverride.reason}`, "Re-verify this override whenever the source or manifest changes.");
      else add(insecureEndpointId, "block", `Source declares insecure HTTP endpoint ${String(finding.value)}.`, `Use HTTPS or document an App Transport Security exception, or add a confirmed sourceContradictionOverride naming '${insecureEndpointId}' with a reason and evidence that intersects this finding's source.`);
    }
    if (!assessment.usable || !assessment.decision) { add(`source.external.${findingId}`, "block", `Source heuristic '${findingId}' is unresolved: ${assessment.issue || "its disposition cannot be used"}.`, assessment.remediation); continue; }
    const decision = assessment.decision;
    if (decision.disposition === "reference-only") {
      if (finding.evidence.some((item) => item.runtimeNetworkRequest)) add(`source.external.${findingId}.runtime-reference`, "warn", `Source syntax places '${findingId}' in a recognizable network-request call, but a human confirmed this literal is reference-only. ShipLayer does not prove reachability; re-verify this disposition when source changes.`);
      add(`source.external.${findingId}`, "pass", `Source heuristic '${findingId}' has a human-confirmed reference-only disposition.`);
    } else if (decision.disposition === "declared-processor") add(`source.external.${findingId}`, "pass", `Source heuristic '${findingId}' has a human-confirmed processor disposition.`);
    else add(`source.external.${findingId}`, "pass", `Source heuristic '${findingId}' has a human-confirmed non-processor disposition.`);
  }
  for (const _decision of externalReadiness.staleReferenceOnly) {
    add("source.external.stale-reference-only", "block", "A reference-only decision does not match a current scanner HTTP(S) endpoint finding.", "Remove the stale reference-only decision or update it to the exact current scanner endpoint finding with matching source evidence. ShipLayer cannot treat an unbound reference-only declaration as resolved.");
  }
  for (const processor of manifest.externalProcessors) {
    // Whether this processor's receipt of data is "collection" under Apple's App Privacy
    // definition is a legal judgment ShipLayer must route to a human, never decide itself — see
    // Apple's own definition (developer.apple.com/app-store/app-privacy-details/): data
    // transmitted off-device only to service the request in real time and not retained (Apple's
    // own examples: an auth token or IP address on a server call, or data discarded immediately
    // after servicing the request) falls OUTSIDE "collection" entirely, which covers most CDN
    // edge traffic and read-only API calls. `collectionDetermination` is optional and unset/
    // "needs-human-confirmation" by default; absence must NEVER be read as "not-collection" — it
    // blocks exactly like every other unconfirmed fact in this manifest until a human answers.
    // Collection determinations only carry weight after the processor row itself has been
    // confirmed. Do not turn an unconfirmed (or incorrectly not-applicable) proposal into a
    // passing App Privacy conclusion merely because it happens to contain a determination.
    if (processor.confirmation !== "confirmed") {
      add(`privacy.processor.${processor.name}.collection-determination`, "block", `${processor.name}'s collection determination cannot be relied on because the declared processor is not human-confirmed.`, "Confirm the processor first, then record whether its receipt of data is App Privacy collection and, for not-collection, the structured real-time-service attestation and evidence.");
      continue;
    }
    const determination = processor.collectionDetermination;
    if (determination !== "collection" && determination !== "not-collection") { add(`privacy.processor.${processor.name}.collection-determination`, "block", `${processor.name} has no human-confirmed determination of whether its receipt of data is "collection" under Apple's App Privacy definition.`, "Set externalProcessors[].collectionDetermination to 'collection' or 'not-collection', based on whether this processor retains data beyond servicing the request in real time — see references/questions.md."); continue; }
    if (determination === "not-collection") {
      const attestation = processor.notCollectionAttestation;
      const assessment = assessNotCollectionAttestation(attestation);
      if (assessment.issue || !attestation) { add(`privacy.processor.${processor.name}.collection-determination`, "block", `${processor.name} is declared 'not-collection' but ${notCollectionAttestationIssueMessage(assessment.issue || "missing")}.`, "Record a literal human-confirmed real-time-service attestation (dataNotRetainedBeyondRealTimeService: true), a checked evidence basis, and a non-secret evidence reference. Free-form audit notes cannot clear this blocker."); continue; }
      const evidenceGate = assessNotCollectionEvidence(manifest, report, processor);
      if (evidenceGate.issue) { add(`privacy.processor.${processor.name}.collection-determination`, "block", `${processor.name}'s structured not-collection attestation cannot use its evidence: ${evidenceGate.issue}.`, evidenceGate.remediation); continue; }
      add(`privacy.processor.${processor.name}.collection-determination`, "pass", `${processor.name} is human-confirmed not to constitute "collection" under Apple's App Privacy definition, based on a structured real-time-service attestation (${attestation.basis}; ${notCollectionEvidenceLabel(attestation.evidence)}). ShipLayer verified ${evidenceGate.verified}; it did not retrieve evidence or infer the retention fact from document/source text.`);
      continue; // a confirmed non-collection processor makes no App Privacy claim, so no dataProcessing row can or should be demanded for it
    }
    add(`privacy.processor.${processor.name}.collection-determination`, "pass", `${processor.name} is human-confirmed to constitute "collection" under Apple's App Privacy definition.`);
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

function notCollectionEvidenceLabel(evidence: NonNullable<ShipLayerManifest["externalProcessors"][number]["notCollectionAttestation"]>["evidence"]): string {
  if (evidence.kind === "repo-path") return "legacy repository evidence (which cannot clear readiness)";
  if (evidence.kind === "public-url") return "a legacy public URL (which cannot clear readiness)";
  return "the processor privacy-policy URL";
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
      // Only genuine Text(...)/Label(...) content inside the closure counts as visible — not the
      // closure's raw source text, which can contain arbitrary non-rendered statements (e.g. a
      // sibling log(...)/track(...) call) that must never be mistaken for on-screen copy.
      if (explicitLabel) visibleParts.push(...visibleUICallArguments(explicitLabel.body, new Set(["Text", "Label"])));
      else if (/\b(?:action|destination)\s*:/.test(rawArguments)) visibleParts.push(...visibleUICallArguments(firstClosure.body, new Set(["Text", "Label"])));
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
  // Design-system wrappers around Button/Link (e.g. PrimaryActionButton, CheckoutLink) are the
  // normal way real SwiftUI apps render controls, not an edge case; a wrapper that follows Swift
  // naming convention by ending in the control it wraps is inspected the same way the literal
  // name above is (unlabeled first argument, a `title:`/`label:` string argument, or an
  // `action:`/`destination:` closure) — this widens WHICH calls are looked inside, not what
  // counts as evidence once found, so a wrapped value must still trace to the real content.
  const wrapperRoles = [...names].filter((name) => name === "Button" || name === "Link" || name === "NavigationLink");
  if (wrapperRoles.length) {
    const suffixPattern = new RegExp(`\\b([A-Z]\\w*(?:${wrapperRoles.join("|")}))\\s*\\(`, "g");
    for (const match of source.matchAll(suffixPattern)) {
      if (names.has(match[1])) continue;
      const opening = source.indexOf("(", match.index);
      const closing = matchingDelimiter(source, opening, "(", ")", 2_000);
      if (closing < 0) continue;
      const rawArguments = source.slice(opening + 1, closing);
      const visibleParts: string[] = [];
      const topLevelArguments = splitTopLevelArguments(rawArguments);
      const firstArgument = topLevelArguments[0];
      if (firstArgument && !/^[A-Za-z_]\w*\s*:/.test(firstArgument)) visibleParts.push(firstArgument);
      const titleArgument = topLevelArguments.find((argument) => /^(?:title|label)\s*:\s*(?!\{)/.test(argument));
      if (titleArgument) visibleParts.push(titleArgument.replace(/^(?:title|label)\s*:\s*/, ""));
      const firstClosure = closureImmediatelyAfter(source, closing + 1);
      if (firstClosure) {
        const explicitLabel = labeledClosureImmediatelyAfter(source, firstClosure.end + 1, "label");
        // Same restriction as the literal-name loop above: only genuine Text(...)/Label(...)
        // content inside the closure counts, never the closure's raw source text.
        if (explicitLabel) visibleParts.push(...visibleUICallArguments(explicitLabel.body, new Set(["Text", "Label"])));
        else if (/\b(?:action|destination)\s*:/.test(rawArguments)) visibleParts.push(...visibleUICallArguments(firstClosure.body, new Set(["Text", "Label"])));
      }
      if (visibleParts.length) argumentsList.push(visibleParts.join("\n"));
    }
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
// A bare currency-formatted literal (e.g. "$9.99", "9,99 €") found verbatim in production
// source is strong, narrow evidence of an in-app constant, not a derived StoreKit value — the
// same shape SKILL.md already forbids approving as "hard-coded, debug-only, ... prices". This
// only flags strings that are ENTIRELY a price token, never prose that happens to mention money.
const HARDCODED_PRICE_LITERAL = /^[$€£¥]\s?\d[\d.,]*$|^\d[\d.,]*\s?[$€£¥]$/;
function hardcodedPriceLiteralsInSource(source: string): Set<string> {
  const literals = new Set<string>();
  for (const match of source.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    const value = match[1].trim();
    if (HARDCODED_PRICE_LITERAL.test(value)) literals.add(value);
  }
  return literals;
}
// Returns the specific hard-coded source literal a test assertion's string argument(s) contain,
// if any — a test that compares the observed price to a value that is ALSO a bare literal
// constant in production source (not a `.displayPrice`-derived interpolation) proves the test
// exercised the constant, not StoreKit, regardless of any other assertion in the same evidence.
function hardcodedPriceLiteralInAssertion(evidence: string, literals: Set<string>): string | undefined {
  if (!literals.size) return undefined;
  for (const match of evidence.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    for (const literal of literals) if (match[1].includes(literal)) return literal;
  }
  return undefined;
}
// XCTAssertEqual(a, b) or #expect(a == b) — the only shapes that can actually assert "this
// value equals that specific literal", as opposed to an existence/visibility check
// (.exists/.waitForExistence) that says nothing about a literal string at all. Restricting the
// hard-coded-fixture scan to this shape (plus the price-named content filter at the call site)
// keeps an unrelated existence assertion elsewhere in the same evidence file from ever being
// examined for a coincidental literal match.
function isEqualityShapedAssertion(evidence: string): boolean {
  if (/^\s*XCTAssertEqual\s*\(/.test(evidence)) return callArguments(evidence).length >= 2;
  if (/^\s*#expect\s*\(/.test(evidence)) {
    const argumentsList = callArguments(evidence);
    if (!argumentsList.length) return false;
    const comparison = splitDirectBooleanComparison(stripOuterParentheses(argumentsList[0]));
    return Boolean(comparison) && comparison![1] === "==";
  }
  return false;
}
function hasVisibleLocalizedPrice(source: string): boolean {
  const visibleArguments = visibleUICallArguments(source, new Set(["Text", "Button", "Label"]));
  if (visibleArguments.some((value) => /\.displayPrice\b/.test(value))) return true;
  const tracedNames = new Set<string>();
  for (const match of source.matchAll(/\b(?:let|var)\s+([A-Za-z_]\w*)\s*=\s*[^\n;]*\.displayPrice\b/g)) tracedNames.add(match[1]);
  // A switch/if/guard `case` pattern can destructure an associated value straight into a local
  // named `displayPrice` (e.g. `case .available(_, let displayPrice):`) instead of an
  // assignment. The bound NAME alone proves nothing — an enum can just as easily carry a
  // hard-coded fixture under a `displayPrice` label (e.g. `.ready(displayPrice: "$0.99")`) with
  // no StoreKit involved at all. Only trust the binding when this SAME evidence also contains a
  // genuine `.displayPrice` member read somewhere (a literal dot before the identifier, i.e. an
  // actual property access such as `product.displayPrice`, not just the bare bound name) — the
  // same real API surface the assignment form above already requires on its right-hand side.
  const hasRealDisplayPriceMemberRead = /\.displayPrice\b/.test(source);
  if (hasRealDisplayPriceMemberRead) {
    for (const match of source.matchAll(/\bcase\b[^{;]{0,200}?\blet\s+(displayPrice)\b/g)) tracedNames.add(match[1]);
  }
  for (const name of tracedNames) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (visibleArguments.some((value) => new RegExp(`\\\\\\(${escapedName}\\b`).test(value))) return true;
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
// Exported for reuse by src/capture.ts screenshot ingestion, so both the preflight gate and the
// ingestion pre-check read Apple's accepted dimensions from this single table — never two
// independently-maintained copies that could drift.
export function isFamilyScreenshotDimensions(family: "iphone" | "ipad", width: number, height: number): boolean { const supported = family === "iphone" ? IPHONE_SCREENSHOT_DIMENSIONS : IPAD_SCREENSHOT_DIMENSIONS; return supported.has(`${width}x${height}`) || supported.has(`${height}x${width}`); }
// Scopes the accepted set to the DISPLAY CLASS a configuration's own requiredDimensions belongs
// to (e.g. 6.9-inch vs 6.5-inch iPhone), not the whole iphone/ipad family — two classes both
// containing dimensions accepted "somewhere" is exactly how a 6.5-inch pair previously passed a
// 6.9-inch-configured slot. Returns an empty Set when requiredDimensions itself is not a
// recognized size at all (screenshotConfigurationChecks already blocks that configuration on its
// own; every per-image check then correctly fails closed instead of silently accepting anything).
export function acceptedDimensionsForConfig(config: { family: "iphone" | "ipad"; requiredDimensions: { width: number; height: number } }): Set<string> {
  const key = `${config.requiredDimensions.width}x${config.requiredDimensions.height}`; const keyReverse = `${config.requiredDimensions.height}x${config.requiredDimensions.width}`;
  if (config.family === "ipad") { if (IPAD_13_INCH_DIMENSIONS.has(key) || IPAD_13_INCH_DIMENSIONS.has(keyReverse)) return IPAD_13_INCH_DIMENSIONS; return new Set(); }
  if (IPHONE_69_INCH_DIMENSIONS.has(key) || IPHONE_69_INCH_DIMENSIONS.has(keyReverse)) return IPHONE_69_INCH_DIMENSIONS;
  if (IPHONE_65_INCH_DIMENSIONS.has(key) || IPHONE_65_INCH_DIMENSIONS.has(keyReverse)) return IPHONE_65_INCH_DIMENSIONS;
  return new Set();
}
function dimensionClassLabel(config: { family: "iphone" | "ipad"; requiredDimensions: { width: number; height: number } }): string {
  const accepted = acceptedDimensionsForConfig(config);
  if (accepted === IPHONE_69_INCH_DIMENSIONS) return "6.9-inch";
  if (accepted === IPHONE_65_INCH_DIMENSIONS) return "6.5-inch";
  if (accepted === IPAD_13_INCH_DIMENSIONS) return "13-inch";
  return "unrecognized-display-class";
}
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
