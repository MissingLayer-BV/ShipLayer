import { Ajv2020 } from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";
import path from "node:path";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { readText, safeRelativePath } from "./fs.js";
import schema from "./schema.json" with { type: "json" };
import type { ShipLayerManifest } from "./types.js";
import { assessPublicEvidenceUrl } from "./collection-attestation.js";
import { containsCredentialUrlMaterial, containsDirectCredentialMaterial } from "./secrets.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);
// Update these allow-lists against the current App Store Connect localization and
// availability reference before changing release policy.
const APPLE_LOCALES = new Set("ar-SA bn-BD ca zh-Hans zh-Hant hr cs da nl-NL en-AU en-CA en-GB en-US fi fr-CA fr-FR de-DE el gu-IN he hi hu id it ja kn-IN ko ms ml-IN mr-IN no or-IN pl pt-BR pt-PT pa-IN ro ru sk sl-SI es-MX es-ES sv ta-IN te-IN th tr uk ur-PK vi".split(" "));
// ISO codes are only syntax validation. Storefront availability changes and must
// be human-confirmed against the current App Store Connect territory picker.
const ISO_TERRITORIES = new Set("AFG ALB DZA ASM AND AGO AIA ATA ATG ARG ARM ABW AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BMU BTN BOL BES BIH BWA BVT BRA IOT BRN BGR BFA BDI CPV KHM CMR CAN CYM CAF TCD CHL CHN CXR CCK COL COM COG COD COK COL COM COG COD COK CRI CIV HRV CUB CUW CYP CZE DNK DJI DMA DOM ECU EGY SLV GNQ ERI EST SWZ ETH FLK FRO FJI FIN FRA GUF PYF ATF GAB GMB GEO DEU GHA GIB GRC GRL GRD GLP GUM GTM GGY GIN GNB GUY HTI HMD VAT HND HKG HUN ISL IND IDN IRN IRQ IRL IMN ISR ITA JAM JPN JEY JOR KAZ KEN KIR PRK KOR KWT KGZ LAO LVA LBN LSO LBR LBY LIE LTU LUX MAC MDG MWI MYS MDV MLI MLT MHL MTQ MRT MUS MYT MEX FSM MDA MCO MNG MNE MSR MAR MOZ MMR NAM NRU NPL NLD NCL NZL NIC NER NGA NIU NFK MKD MNP NOR OMN PAK PLW PSE PAN PNG PRY PER PHL PCN POL PRT PRI QAT ROU RUS RWA REU BLM SHN KNA LCA MAF SPM VCT WSM SMR STP SAU SEN SRB SYC SLE SGP SXM SVK SVN SLB SOM ZAF SGS SSD ESP LKA SDN SUR SJM SWE CHE SYR TWN TJK TZA THA TLS TGO TKL TON TTO TUN TUR TKM TCA TUV UGA UKR ARE GBR USA UMI URY UZB VUT VEN VNM VGB VIR WLF ESH YEM ZMB ZWE XKX".split(" "));

export function manifestPath(repo: string): string { return path.join(repo, "shiplayer.yml"); }
// screenshots.finalOutputDir is deliberately left UNSET here (unlike rawOutputDir/
// marketingProjectPath, which do get a default): `init` runs before any --out has ever been
// chosen, so it cannot know what the eventual default should resolve to. generateReleasePackage
// computes the correct default from the ACTUAL --out in play when the field is absent, and
// refuses to proceed if that would silently point outside a customized --out (see
// assertFinalOutputDirMatchesOut in generator.ts; PR review round-3 finding N2).
export function defaultManifest(input: Partial<ShipLayerManifest["app"]> = {}): ShipLayerManifest {
  const app = { name: input.name || "", bundleId: input.bundleId || "", deviceFamilies: input.deviceFamilies || ["iphone", "ipad"], locales: input.locales || ["en-US"], primaryLocale: input.primaryLocale || "en-US", availability: input.availability || "all", releaseMode: input.releaseMode || "manual", ...input } as ShipLayerManifest["app"];
  return { schemaVersion: 1, app, contacts: {}, metadata: { localizations: { [app.primaryLocale]: {} } }, permissions: [], permissionFlows: [], dataProcessing: [], externalProcessors: [], aiDataSharing: { enabled: false }, externalServiceDecisions: [], sourceContradictionOverrides: [], secondaryTargetConfirmations: [], review: { demoAccount: { required: false }, recordingScenarios: [] }, screenshots: { scenarios: [], configurations: screenshotConfigs(app.primaryLocale, app.deviceFamilies), rawOutputDir: "release/raw-screenshots", marketingProjectPath: "design/app-store-screenshots" }, monetization: { type: "free", confirmation: "needs-human-confirmation" }, build: { signing: "unknown", exportCompliance: "unknown", testFlightUpload: false }, sync: { mode: "dry-run", appStoreConnectKeyIdEnv: "APP_STORE_CONNECT_KEY_ID", issuerIdEnv: "APP_STORE_CONNECT_ISSUER_ID", privateKeyPathEnv: "APP_STORE_CONNECT_PRIVATE_KEY_PATH" }, confirmations: { privacy: "needs-human-confirmation", legal: "needs-human-confirmation", trader: "needs-human-confirmation", paidAgreements: "needs-human-confirmation", ageRating: "needs-human-confirmation", contentRights: "needs-human-confirmation" } };
}

function screenshotConfigs(locale: string, families: Array<"iphone" | "ipad">): ShipLayerManifest["screenshots"]["configurations"] {
  const configs: ShipLayerManifest["screenshots"]["configurations"] = [];
  if (families.includes("iphone")) configs.push({ device: "iPhone 16 Pro Max", family: "iphone", locale, requiredDimensions: { width: 1320, height: 2868 } });
  if (families.includes("ipad")) configs.push({ device: "iPad Pro 13-inch (M4)", family: "ipad", locale, requiredDimensions: { width: 2064, height: 2752 } });
  return configs;
}

export async function readManifest(repo: string): Promise<ShipLayerManifest> {
  const root = await realpath(repo); const filePath = path.join(root, "shiplayer.yml"); const details = await lstat(filePath);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Manifest ${filePath} must be a regular contained file; refusing to read a symlink/non-file.`);
  const document = parse(await readText(filePath));
  if (!document || typeof document !== "object") throw new Error(`Manifest ${filePath} must contain a YAML object.`);
  validateManifest(document); return document as unknown as ShipLayerManifest;
}
export async function writeManifest(repo: string, manifest: ShipLayerManifest): Promise<void> {
  validateManifest(manifest);
  const root = await realpath(repo); const destination = path.join(root, "shiplayer.yml");
  try {
    const details = await lstat(destination);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("shiplayer.yml must be a regular file; refusing to follow or overwrite a symlink/non-file destination.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = path.join(root, `.shiplayer.yml.stage-${process.pid}-${Date.now()}`);
  try {
    await writeFile(stage, stringify(manifest, { sortMapEntries: true }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    if ((await lstat(stage)).isSymbolicLink()) throw new Error("Manifest staging path cannot be a symlink.");
    await rename(stage, destination);
  } catch (error) { await rm(stage, { force: true }).catch(() => undefined); throw error; }
}
export function validateManifest(candidate: unknown): asserts candidate is ShipLayerManifest {
  if (!validateSchema(candidate)) throw new Error(`Invalid shiplayer.yml:\n${(validateSchema.errors || []).map((error: { instancePath?: string; message?: string }) => `- ${error.instancePath || "/"} ${error.message || "is invalid"}`).join("\n")}`);
  const manifest = candidate as unknown as ShipLayerManifest;
  const errors: string[] = [];
  const ids = new Set<string>();
  const add = (id: string, field: string): void => { if (ids.has(id)) errors.push(`duplicate product ID '${id}' in ${field}`); ids.add(id); };
  const requireHttpsUrl = (label: string, value: string | undefined): void => {
    if (!value) return;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !url.hostname) errors.push(`${label} must be an HTTPS URL with a hostname`);
    } catch { errors.push(`${label} must be an HTTPS URL with a hostname`); }
  };
  requireHttpsUrl("contacts.supportUrl", manifest.contacts.supportUrl);
  requireHttpsUrl("contacts.marketingUrl", manifest.contacts.marketingUrl);
  requireHttpsUrl("contacts.privacyUrl", manifest.contacts.privacyUrl);
  for (const processor of manifest.externalProcessors) {
    requireHttpsUrl(`external processor ${processor.name} privacyPolicyUrl`, processor.privacyPolicyUrl);
    const attestation = processor.notCollectionAttestation;
    const evidence = attestation?.evidence;
    if (evidence?.kind === "repo-path") try { safeRelativePath(evidence.path, `not-collection evidence for ${processor.name}`); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    if (evidence?.kind === "public-url" && assessPublicEvidenceUrl(evidence.url).issue) errors.push(`not-collection public evidence for ${processor.name} must be a credential-safe public HTTPS URL without a query string or fragment`);
    // `init` deliberately preserves a scanner's unconfirmed endpoint/policy proposal so a human
    // can correct it. Only a completed vendor-documentation attestation treats this URL as
    // evidence; all other policy forms are stopped at preflight before they can clear readiness.
    const completedVendorEvidence = evidence?.kind === "processor-privacy-policy" && attestation?.basis === "vendor-documentation" && attestation.confirmation === "confirmed" && attestation.dataNotRetainedBeyondRealTimeService === true;
    if (completedVendorEvidence && assessPublicEvidenceUrl(processor.privacyPolicyUrl).issue) errors.push(`not-collection processor privacy-policy evidence for ${processor.name} must be a credential-safe public HTTPS URL without a query string or fragment`);
  }
  for (const locale of manifest.app.locales) if (!APPLE_LOCALES.has(locale)) errors.push(`app.locales contains unsupported App Store localization '${locale}'`);
  const validateLocalizationMap = (label: string, localizations: Record<string, unknown>): void => {
    for (const locale of Object.keys(localizations)) {
      if (!APPLE_LOCALES.has(locale)) errors.push(`${label} contains unsupported App Store localization '${locale}'`);
      else if (!manifest.app.locales.includes(locale)) errors.push(`${label} contains ${locale}, which is not declared in app.locales`);
    }
  };
  validateLocalizationMap("metadata.localizations", manifest.metadata.localizations);
  for (const [locale, copy] of Object.entries(manifest.metadata.localizations)) {
    requireHttpsUrl(`metadata.localizations.${locale}.supportUrl`, copy.supportUrl);
    requireHttpsUrl(`metadata.localizations.${locale}.marketingUrl`, copy.marketingUrl);
    requireHttpsUrl(`metadata.localizations.${locale}.privacyPolicyUrl`, copy.privacyPolicyUrl);
  }
  for (const locale of manifest.app.locales) if (!manifest.metadata.localizations[locale]) errors.push(`metadata.localizations is missing configured locale ${locale}`);
  validateLocalizationMap("screenshots.localizations", manifest.screenshots.localizations || {});
  for (const scenario of manifest.screenshots.scenarios) validateLocalizationMap(`screenshot scenario ${scenario.id} localizations`, scenario.localizations || {});
  for (const configuration of manifest.screenshots.configurations) {
    if (!APPLE_LOCALES.has(configuration.locale)) errors.push(`screenshots.configurations contains unsupported App Store localization '${configuration.locale}'`);
    else if (!manifest.app.locales.includes(configuration.locale)) errors.push(`screenshots.configurations contains ${configuration.locale}, which is not declared in app.locales`);
  }
  for (const [label, candidatePath] of [["screenshots.rawOutputDir", manifest.screenshots.rawOutputDir], ["screenshots.marketingProjectPath", manifest.screenshots.marketingProjectPath], ["screenshots.finalOutputDir", manifest.screenshots.finalOutputDir]] as const) {
    if (!candidatePath) continue;
    try { safeRelativePath(candidatePath, label); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (manifest.app.productionIconCatalog) try { safeRelativePath(manifest.app.productionIconCatalog, "app.productionIconCatalog"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  if (manifest.app.productionIconAsset) try { safeRelativePath(manifest.app.productionIconAsset, "app.productionIconAsset"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  if (manifest.app.productionIconAsset && !manifest.app.productionIconAssetConfirmation) errors.push("app.productionIconAsset requires productionIconAssetConfirmation");
  if (manifest.app.productionIconCatalog && manifest.app.productionIconAsset) errors.push("app.productionIconCatalog and app.productionIconAsset are mutually exclusive");
  if (manifest.monetization.type === "non-consumables") for (const product of manifest.monetization.products) {
    add(product.productId, "non-consumables");
    validateLocalizationMap(`non-consumable ${product.productId} localizations`, product.localizations);
    for (const locale of manifest.app.locales) if (!product.localizations[locale]) errors.push(`non-consumable ${product.productId} needs ${locale} localization`);
    try { safeRelativePath(product.reviewScreenshot, `review screenshot for ${product.productId}`); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (manifest.monetization.type === "non-consumables" || manifest.monetization.type === "subscriptions") {
    for (const evidence of [...manifest.monetization.purchasePresentation.sourceEvidence, ...manifest.monetization.purchasePresentation.testEvidence]) try { safeRelativePath(evidence, "purchase presentation evidence"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  const duplicateScenario = (label: string, scenarios: ShipLayerManifest["screenshots"]["scenarios"]): void => { const values = new Set<string>(); for (const scenario of scenarios) { if (values.has(scenario.id)) errors.push(`duplicate ${label} scenario ID '${scenario.id}'`); values.add(scenario.id); } };
  duplicateScenario("screenshot", manifest.screenshots.scenarios); duplicateScenario("review", manifest.review.recordingScenarios);
  if (manifest.monetization.type === "subscriptions") {
    requireHttpsUrl("subscriptions.termsUrl", manifest.monetization.termsUrl);
    requireHttpsUrl("subscriptions.privacyUrl", manifest.monetization.privacyUrl);
    if (!ISO_TERRITORIES.has(manifest.monetization.baseTerritory)) errors.push(`subscriptions.baseTerritory '${manifest.monetization.baseTerritory}' is not a recognized ISO territory code; this does not prove App Store availability`);
    validateLocalizationMap("subscription group localizations", manifest.monetization.group.localizations);
    for (const locale of manifest.app.locales) if (!manifest.monetization.group.localizations[locale]?.displayName) errors.push(`subscription group needs ${locale} display-name localization`);
    for (const product of manifest.monetization.products) {
      add(product.productId, "subscriptions");
      validateLocalizationMap(`subscription ${product.productId} localizations`, product.localizations);
      for (const locale of manifest.app.locales) if (!product.localizations[locale]) errors.push(`subscription ${product.productId} needs ${locale} localization`);
      try { safeRelativePath(product.reviewScreenshot, `review screenshot for ${product.productId}`); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      const offer = product.introductoryOffer;
      if (offer && offer.type === "free-trial" && (offer.pricePointReference || offer.numberOfPeriods)) errors.push(`free-trial ${product.productId} cannot have a pricePointReference or numberOfPeriods`);
      if (offer && offer.type !== "free-trial" && !offer.pricePointReference) errors.push(`paid introductory offer ${product.productId} needs a pricePointReference`);
      if (offer?.type === "pay-up-front" && (!["P1M", "P2M", "P3M", "P6M", "P1Y"].includes(offer.duration) || offer.numberOfPeriods)) errors.push(`pay-up-front ${product.productId} must use P1M/P2M/P3M/P6M/P1Y without numberOfPeriods`);
      if (offer?.type === "pay-as-you-go") { const maximum: Record<string, number> = { P1W: 12, P1M: 12, P2M: 6, P3M: 4, P6M: 2, P1Y: 1 }; if (offer.duration !== product.duration || !offer.numberOfPeriods || offer.numberOfPeriods > maximum[product.duration]) errors.push(`pay-as-you-go ${product.productId} must use the product duration with numberOfPeriods in the allowed range`); }
    }
  }
  if (manifest.monetization.type === "non-consumables") {
    const presentation = manifest.monetization.purchasePresentation;
    if (presentation.subscriptionPeriodVisibleBeforePurchase !== "not-applicable" || presentation.offerTermsVisibleBeforePurchase !== "not-applicable" || presentation.termsAndPrivacyLinksVisibleBeforePurchase !== "not-applicable") errors.push("non-consumable purchase presentation must mark subscription-only disclosures not-applicable");
  }
  // Whether these disclosures are actually visible before purchase is a judgment about the real
  // paywall, not something manifest validation may force — a truthful `false` declaration must
  // still load so `purchase.subscription-disclosures`/`purchase.offer-disclosures` (preflight.ts)
  // can block it with an actionable message instead of the manifest refusing to load at all.
  const unique = (label: string, values: string[]): void => { if (new Set(values).size !== values.length) errors.push(`${label} must not contain duplicates`); };
  unique("dataProcessing categories", manifest.dataProcessing.map((item) => item.category));
  unique("external processor names", manifest.externalProcessors.map((item) => item.name));
  unique("external service decision findings", manifest.externalServiceDecisions.map((item) => item.finding));
  unique("source contradiction override findings", manifest.sourceContradictionOverrides.map((item) => item.finding));
  unique("secondary target confirmations", manifest.secondaryTargetConfirmations.map((item) => item.bundleId));
  unique("permission flow categories", manifest.permissionFlows.map((item) => item.category));
  for (const item of manifest.permissionFlows) unique(`permission flow ${item.category} evidence`, item.evidence || []);
  for (const item of manifest.dataProcessing) { unique(`dataProcessing ${item.category} purposes`, item.purpose); unique(`dataProcessing ${item.category} evidence`, item.evidence || []); }
  for (const item of manifest.externalProcessors) { unique(`external processor ${item.name} data categories`, item.dataCategories); unique(`external processor ${item.name} evidence`, item.evidence || []); }
  if (manifest.aiDataSharing.enabled) {
    unique("AI dataSent entries", manifest.aiDataSharing.dataSent);
    unique("AI processorNames", manifest.aiDataSharing.processorNames);
    unique("AI consent evidence", manifest.aiDataSharing.consent.evidence);
    unique("AI privacy-policy evidence", manifest.aiDataSharing.privacyPolicy.evidence);
    for (const evidence of [...manifest.aiDataSharing.consent.evidence, ...manifest.aiDataSharing.privacyPolicy.evidence]) try { safeRelativePath(evidence, "AI disclosure evidence"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    // Whether affirmativeAction clearly says data will be sent/shared/uploaded/transmitted is a
    // judgment about the real button label, not something manifest validation may force — a
    // truthful declaration (whatever the app's real button says) must still load so
    // ai-sharing.consent-action-language (preflight.ts) can block it with an actionable message
    // instead of the manifest refusing to load at all.
  }
  for (const item of manifest.externalServiceDecisions) unique(`external service decision ${item.finding} evidence`, item.evidence);
  for (const item of manifest.sourceContradictionOverrides) unique(`source contradiction override ${item.finding} evidence`, item.evidence);
  for (const item of manifest.secondaryTargetConfirmations) unique(`secondary target ${item.bundleId} evidence`, item.evidence);
  collectSecrets(manifest, "", errors);
  if (!manifest.app.locales.includes(manifest.app.primaryLocale)) errors.push("app.primaryLocale must appear in app.locales");
  if (errors.length) throw new Error(`Invalid shiplayer.yml:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

function collectSecrets(value: unknown, location: string, errors: string[]): void {
  if (typeof value === "string") {
    if (containsDirectCredentialMaterial(value)) errors.push(`${location || "manifest"} appears to contain credential material; use an environment-variable reference instead`);
    if (containsCredentialUrlMaterial(value)) errors.push(`${location || "manifest"} contains a URL with credential material; use a canonical public reference without credentials`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => collectSecrets(item, `${location}[${index}]`, errors)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childLocation = location ? `${location}.${key}` : key;
    if (/^(?:password|token|secret|apiKey|privateKey)$/i.test(key) && typeof child === "string") errors.push(`${childLocation} must not contain direct credential material; use an environment-variable reference instead`);
    else collectSecrets(child, childLocation, errors);
  }
}
