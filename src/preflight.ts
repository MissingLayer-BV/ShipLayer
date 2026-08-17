import path from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { CheckResult, PreflightReport, ShipLayerManifest } from "./types.js";
import { analyzeRepository, findValue } from "./scanner.js";
import { resolveContained, walkRepository } from "./fs.js";
import { inspectImage } from "./image.js";
import { validateAscPrivateKey } from "./asc.js";
import { appReviewNotes } from "./generator.js";

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

export async function preflight(repository: string, manifest: ShipLayerManifest, remoteRequested = false): Promise<PreflightReport> {
  const results: CheckResult[] = [];
  const add: Add = (id, severity, message, remediation) => results.push({ id, severity, message, remediation });
  const app = manifest.app;

  addRequired(add, "app.name", app.name, "App name is missing.", "Set app.name in shiplayer.yml.");
  addRequired(add, "app.bundle-id", app.bundleId, "Bundle ID is missing.", "Confirm the production bundle ID.");
  addRequired(add, "build.version", Boolean(app.version && app.build), "Version or build is missing.", "Confirm the archive version/build before upload.");
  addRequired(add, "app.primary-category", app.primaryCategory, "Primary App Store category is missing.", "Choose app.primaryCategory.");
  if (app.primaryCategory && !APPLE_CATEGORIES.has(app.primaryCategory)) add("app.primary-category.allowed", "block", `${app.primaryCategory} is not an Apple App Store primary category.`, "Choose an Apple category name from the current App Store Connect list.");
  if (app.secondaryCategory && !APPLE_CATEGORIES.has(app.secondaryCategory)) add("app.secondary-category.allowed", "block", `${app.secondaryCategory} is not an Apple App Store secondary category.`, "Choose an Apple category name from the current App Store Connect list.");
  addRequired(add, "contacts.support-url", isHttps(manifest.contacts.supportUrl), "A public HTTPS Support URL is required.", "Set contacts.supportUrl.");
  addRequired(add, "contacts.privacy-url", isHttps(manifest.contacts.privacyUrl), "A public HTTPS Privacy Policy URL is required.", "Set contacts.privacyUrl after legal review.");
  addRequired(add, "contacts.copyright", manifest.contacts.copyright, "Copyright is missing.", "Set contacts.copyright.");
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
  else add("review.demo-account", "pass", demo?.required ? "Demo account uses secure environment-variable references and has a human confirmation." : "No login is required.");
  const generatedReviewNotes = appReviewNotes(manifest);
  const reviewBytes = Buffer.byteLength(generatedReviewNotes, "utf8");
  if (reviewBytes > 4_000) add("review.notes.length", "block", `Generated App Review notes have ${reviewBytes} UTF-8 bytes; Apple allows at most 4,000.`, "Shorten review notes, setup instructions, sample data, or scenarios.");
  else add("review.notes.length", "pass", `Generated App Review notes have ${reviewBytes} UTF-8 bytes.`);

  metadataChecks(manifest, add);
  permissionChecks(manifest, add);
  exportComplianceCheck(manifest, add);
  confirmationChecks(manifest, add);
  monetizationChecks(manifest, add);
  screenshotConfigurationChecks(manifest, add);
  await screenshotChecks(repository, manifest, add);
  await purchaseAssetChecks(repository, manifest, add);
  await iconChecks(repository, manifest, add);
  await sourceConsistencyChecks(repository, manifest, add);

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
}

function monetizationChecks(manifest: ShipLayerManifest, add: Add): void {
  const money = manifest.monetization;
  if (money.type === "free") { add("monetization", "pass", "Free app with no declared IAP."); return; }
  if (manifest.confirmations.paidAgreements !== "confirmed") add("confirmation.paidAgreements", "block", "Paid Apps agreement must be explicitly confirmed for paid monetization.", "Activate and confirm the Paid Apps agreement, tax, banking, and applicable business information.");
  if (money.type === "paid-app") { add("monetization", "pass", `Paid app price point ${money.pricePointReference} is declared.`); return; }
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
      if (!details.isFile() || details.size === 0 || path.extname(icon) !== ".icon") add("assets.icon-composer", "block", "app.productionIconAsset must select a non-empty contained .icon file.", "Select the Icon Composer .icon file in the Xcode project and keep the manifest path exact.");
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
    const contents = JSON.parse(await readFile(iconCatalog, "utf8")) as { images?: Array<{ filename?: unknown; idiom?: unknown; size?: unknown; scale?: unknown }> };
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
      if (image.idiom === "ios-marketing" && image.size === "1024x1024" && image.scale === "1x") {
        if (details.format !== "png") add(`assets.app-icon.${filename}.format`, "block", `App Store marketing icon ${filename} must be a PNG.`, "Export a flattened 1024×1024 PNG.");
        else if (details.width === 1024 && details.height === 1024 && !details.alpha) validMarketingIcon = true;
      }
    }
    if (!validMarketingIcon) add(`assets.app-icon-marketing.${catalogId}`, "block", "No declared ios-marketing 1024×1024 opaque PNG App Store icon was found.", "Declare a valid ios-marketing 1024×1024 flattened PNG in AppIcon Contents.json.");
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

async function sourceConsistencyChecks(repository: string, manifest: ShipLayerManifest, add: Add): Promise<void> {
  const report = await analyzeRepository(repository);
  for (const contradiction of report.contradictions) add("source.contradiction", "block", contradiction, "Resolve ambiguous production project settings.");
  const compare = (key: "bundleId" | "version" | "build" | "deploymentTarget", expected: string | undefined): void => {
    const detected = findValue(report, key);
    if (!expected || !detected) return;
    if (expected === detected) add(`consistency.${key}`, "pass", `Manifest ${key} matches source evidence.`);
    else add(`consistency.${key}`, "block", `Manifest ${key} (${expected}) disagrees with source evidence (${detected}).`, "Update the manifest or source setting.");
  };
  compare("bundleId", manifest.app.bundleId); compare("version", manifest.app.version); compare("build", manifest.app.build);
  const detectedFamilies = new Set(stringValues(report.findings.find((finding) => finding.key === "deviceFamily")?.value).flatMap((value) => value.split(",").map((part) => part.trim())));
  if (detectedFamilies.size) {
    const declaredFamilies = new Set(manifest.app.deviceFamilies.map((family) => family === "iphone" ? "1" : "2"));
    if (!sameSet(detectedFamilies, declaredFamilies)) add("consistency.device-family", "block", `Manifest device families (${[...declaredFamilies].join(",")}) disagree with production target evidence (${[...detectedFamilies].join(",")}).`, "Update app.deviceFamilies and screenshot coverage, or resolve target evidence ambiguity.");
    else add("consistency.device-family", "pass", "Manifest device families match production target evidence.");
  }
  compare("deploymentTarget", manifest.app.deploymentTarget);
  const detectedEncryption = findValue(report, "encryption");
  if (detectedEncryption === "false" && manifest.build.exportCompliance !== "exempt") add("consistency.encryption", "block", "Source declares ITSAppUsesNonExemptEncryption=false but manifest export compliance is not exempt.", "Align build.exportCompliance with the production Info.plist or resolve the declaration.");
  else if (detectedEncryption === "false") add("consistency.encryption", "pass", "Manifest export compliance matches the source encryption declaration.");
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
  for (const finding of report.findings.filter((item) => item.key.startsWith("thirdPartySdkCandidate:") || item.key === "endpoint")) {
    const findingId = `${finding.key}:${Array.isArray(finding.value) ? finding.value.join(",") : String(finding.value)}`;
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
  const secondary = report.findings.find((finding) => finding.key === "secondaryBundleId");
  if (secondary) {
    const sourcePaths = new Set(secondary.evidence.map((item) => item.source));
    for (const bundleId of stringValues(secondary.value)) {
      const confirmation = manifest.secondaryTargetConfirmations.find((item) => item.bundleId === bundleId);
      if (!confirmation || confirmation.confirmation !== "confirmed" || confirmation.classification === "other-app" || !intersects(await validEvidencePaths(repository, confirmation.evidence || []), sourcePaths)) add(`source.secondary-target.${bundleId}`, "block", `Secondary target ${bundleId} needs an evidence-backed human classification as an extension or widget.`, "Confirm the Xcode target type and record a contained source evidence path.");
      else add(`source.secondary-target.${bundleId}`, "pass", `Secondary target ${bundleId} is confirmed as a ${confirmation.classification}.`);
    }
  }
  const relevantOmissions = report.ignored.filesOverLimitPaths.filter(isRelevantSourcePath); const relevantSymlinks = report.ignored.symlinksIgnored.filter(isRelevantSourcePath); const relevantUnreadable = report.ignored.unreadable.filter(isRelevantSourcePath);
  if (report.ignored.truncated || relevantOmissions.length || relevantUnreadable.length || relevantSymlinks.length) add("source.scan-coverage", "block", `Source scan omitted ${[report.ignored.truncated ? "a truncated entry set" : "", relevantOmissions.length ? `${relevantOmissions.length} relevant oversized source/config file(s)` : "", relevantUnreadable.length ? `${relevantUnreadable.length} relevant unreadable source/config path(s)` : "", relevantSymlinks.length ? `${relevantSymlinks.length} relevant symlinked source/config path(s)` : ""].filter(Boolean).join(", ")}.`, "Inspect omitted source manually and remove/resolve exclusions before claiming submission readiness.");
  else if (report.ignored.filesOverLimit || report.ignored.unreadable.length || report.ignored.symlinksIgnored.length) add("source.scan-coverage", "warn", "Source scan ignored only non-source binary, documentation, or unrelated paths.", "Review ignored paths if they become release-relevant.");
  for (const [index, question] of report.unresolvedQuestions.entries()) add(`source.question.${index + 1}`, "warn", question, "Resolve or record this scanner question during human release review.");
  const storeKit = report.findings.find((finding) => finding.key === "storekitProductId")?.value;
  const sourceIds = new Set(Array.isArray(storeKit) ? storeKit.filter((value): value is string => typeof value === "string") : typeof storeKit === "string" ? [storeKit] : []);
  const manifestIds = new Set(manifest.monetization.type === "subscriptions" || manifest.monetization.type === "non-consumables" ? manifest.monetization.products.map((product) => product.productId) : []);
  for (const id of sourceIds) if (!manifestIds.has(id)) add(`storekit.${id}`, "block", `StoreKit product ${id} is missing from monetization manifest.`);
  for (const id of manifestIds) if (sourceIds.size && !sourceIds.has(id)) add(`manifest.${id}`, "block", `Manifest product ${id} is absent from StoreKit evidence.`);
}

function stringValues(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []; }
function intersects(left: Set<string>, right: Set<string>): boolean { return [...left].some((item) => right.has(item)); }
function sameSet(left: Set<string>, right: Set<string>): boolean { return left.size === right.size && [...left].every((item) => right.has(item)); }
function isRelevantSourcePath(file: string): boolean { return /(?:^|\/)(?:project\.yml|project\.pbxproj|Info\.plist|PrivacyInfo\.xcprivacy|[^/]+\.(?:swift|m|mm|h|entitlements|storekit))$/i.test(file); }
async function validEvidencePaths(repository: string, evidence: string[]): Promise<Set<string>> {
  const valid = new Set<string>();
  for (const value of evidence) {
    try { const target = await resolveContained(repository, value, "evidence path"); const details = await lstat(target); if (details.isFile() && !details.isSymbolicLink()) valid.add(value); } catch { /* invalid evidence is intentionally excluded */ }
  }
  return valid;
}
function isFamilyScreenshotDimensions(family: "iphone" | "ipad", width: number, height: number): boolean { const supported = family === "iphone" ? IPHONE_SCREENSHOT_DIMENSIONS : IPAD_SCREENSHOT_DIMENSIONS; return supported.has(`${width}x${height}`) || supported.has(`${height}x${width}`); }
function isReviewScreenshotDimension(manifest: ShipLayerManifest, width: number, height: number): boolean { return manifest.app.deviceFamilies.some((family) => { const supported = family === "iphone" ? IPHONE_REVIEW_SCREENSHOT_DIMENSIONS : IPAD_REVIEW_SCREENSHOT_DIMENSIONS; return supported.has(`${width}x${height}`); }); }
function sameOrientationOrReverse(width: number, height: number, expectedWidth: number, expectedHeight: number): boolean { return (width === expectedWidth && height === expectedHeight) || (width === expectedHeight && height === expectedWidth); }
