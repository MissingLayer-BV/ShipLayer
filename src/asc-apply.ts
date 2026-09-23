import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AppStoreConnectClient, attribute, credentialsFromEnvironment, dataOf, idOf, type AscResource, type FetchLike, type RemoteDiscovery } from "./asc.js";
import { analyzeRepository } from "./scanner.js";
import { appReviewNotes, submittedReviewNotes } from "./generator.js";
import { preflight } from "./preflight.js";
import { resolveContained } from "./fs.js";
import { DEFAULT_MARKETING_FINAL_DIR } from "./marketing.js";
import type { AnalysisReport, AscApplyResult, AscOperation, AscPlan, ShipLayerManifest } from "./types.js";

interface LocalScreenshot { fileName: string; filePath: string; checksum: string; bytes: Buffer }
export interface LocalScreenshotSet { locale: string; family: "iphone" | "ipad"; displayType: string; source: "marketing" | "raw"; screenshots: LocalScreenshot[] }
interface DesiredState { releaseType: "MANUAL" | "AFTER_APPROVAL"; reviewNotes: string; screenshots: LocalScreenshotSet[]; demoCredentialsPresent: boolean }
interface ApplyContext { client: AppStoreConnectClient; discovery: RemoteDiscovery; desired: DesiredState; credentialsPresent: true }
export interface AscApplyOptions { userConfirmed: true; reviewedPlan: AscPlan; environment?: NodeJS.ProcessEnv; fetcher?: FetchLike }

export async function planAppStoreChanges(repository: string, manifest: ShipLayerManifest, environment: NodeJS.ProcessEnv = process.env, fetcher?: FetchLike): Promise<AscPlan> {
  const credentials = credentialsFromEnvironment(manifest, environment);
  if (!credentials) return { mode: "remote", operations: [], credentialsPresent: false, warnings: ["App Store Connect credentials are unavailable. No request was made and no changes were made."] };
  const context = await createContext(repository, manifest, environment, fetcher);
  return buildPlan(manifest, context.discovery, context.desired);
}

export async function applyAppStoreChanges(repository: string, manifest: ShipLayerManifest, options: AscApplyOptions): Promise<AscApplyResult> {
  if (options.userConfirmed !== true) throw new Error("App Store Connect apply requires an explicit user confirmation; no request was made.");
  if (manifest.sync.mode !== "apply") throw new Error("App Store Connect apply requires sync.mode: apply; no request was made.");
  if (!manifest.app.version || !manifest.app.build) throw new Error("App Store Connect apply requires an explicit version and build; no request was made.");
  if (manifest.app.releaseMode === "scheduled") throw new Error("Scheduled release is not modeled with a confirmed date/time; no request was made.");
  if (options.reviewedPlan.mode !== "remote" || !options.reviewedPlan.credentialsPresent) throw new Error("App Store Connect apply requires the authenticated remote plan that the user reviewed; no request was made.");
  const environment = options.environment || process.env;
  const demo = manifest.review.demoAccount;
  if (demo?.required && (!demo.usernameEnv || !environment[demo.usernameEnv] || !demo.passwordEnv || !environment[demo.passwordEnv])) throw new Error("Required demo-account environment values are unavailable. ShipLayer never reads credentials from the manifest; no request was made.");
  const analysis = await analyzeRepository(repository); const report = await preflight(repository, manifest, true, analysis, environment);
  if (!report.canApply) throw new Error(`App Store Connect apply is blocked by ${report.summary.block} preflight blocker(s); no request was made.`);
  const context = await createContext(repository, manifest, environment, options.fetcher, analysis);
  let discovery = context.discovery;
  assertTarget(manifest, discovery);
  assertReleaseKind(manifest, discovery);
  assertCategoriesAvailable(manifest, discovery);
  let build = uniqueBuild(manifest, discovery);
  if (!build) throw new Error(`Build ${manifest.app.build} for iOS version ${manifest.app.version} was not found in exactly one valid App Store-eligible state; no changes were made.`);
  const operations: AscOperation[] = [];
  const appId = discovery.appId as string;
  let version = discovery.versions[0];
  if (discovery.versions.length > 1) throw new Error(`App Store Connect returned more than one iOS version matching ${manifest.app.version}; ShipLayer will not guess a target. No changes were made.`);
  if (version) {
    assertEditableVersion(version);
    if (discovery.appInfos.length !== 1) throw new Error("ShipLayer could not identify exactly one editable App Info resource for the requested version; no changes were made.");
  }
  assertPlanUnchanged(options.reviewedPlan, buildPlan(manifest, discovery, context.desired));
  if (!version) {
    const response = await context.client.post("/appStoreVersions", { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: manifest.app.version, copyright: manifest.contacts.copyright, releaseType: context.desired.releaseType }, relationships: { app: { data: { type: "apps", id: appId } } } } });
    version = firstResource(response, "creating the App Store version");
    operations.push(applied("version.create", "create", "App Store version", `Created iOS version ${manifest.app.version}.`));
    discovery = await context.client.discover(manifest.app.bundleId, { version: manifest.app.version, build: manifest.app.build });
    assertTarget(manifest, discovery);
    if (discovery.versions.length !== 1 || idOf(discovery.versions[0]) !== idOf(version)) throw new Error("The newly created App Store version could not be rediscovered unambiguously. Partial remote changes may have occurred.");
    version = discovery.versions[0]; assertEditableVersion(version);
    if (discovery.appInfos.length !== 1) throw new Error("The newly created version did not expose exactly one editable App Info resource. Partial remote changes may have occurred.");
    assertCategoriesAvailable(manifest, discovery);
    build = uniqueBuild(manifest, discovery);
    if (!build) throw new Error(`Build ${manifest.app.build} was no longer available after version creation. Partial remote changes may have occurred.`);
  } else {
    const attributes = changedAttributes(version, { copyright: manifest.contacts.copyright, releaseType: context.desired.releaseType });
    if (Object.keys(attributes).length) { await context.client.patch(`/appStoreVersions/${requiredId(version, "App Store version")}`, updateBody("appStoreVersions", version, attributes)); operations.push(applied("version.update", "update", "App Store version", `Updated copyright/release mode for ${manifest.app.version}.`)); }
    else operations.push(matched("version.update", "App Store version", `Version ${manifest.app.version} copyright/release mode already match.`));
  }
  const versionId = requiredId(version, "App Store version");

  const appInfo = discovery.appInfos[0] as AscResource;
  await syncCategories(context.client, manifest, discovery, appInfo, operations);
  const localizationIds = await syncLocalizations(context.client, manifest, discovery, versionId, operations);
  await syncReviewDetails(context.client, manifest, discovery, versionId, context.desired.reviewNotes, environment, operations);
  await syncBuild(context.client, manifest, discovery, versionId, build, operations);
  await syncScreenshots(context.client, discovery, localizationIds, context.desired.screenshots, operations);
  return { applied: operations.some((operation) => operation.status === "applied"), operations, warnings: manualWarnings(manifest) };
}

async function createContext(repository: string, manifest: ShipLayerManifest, environment: NodeJS.ProcessEnv, fetcher?: FetchLike, existingAnalysis?: AnalysisReport): Promise<ApplyContext> {
  const credentials = credentialsFromEnvironment(manifest, environment);
  if (!credentials) throw new Error("App Store Connect credentials are unavailable. Set the three environment variables referenced by sync; no request was made.");
  const client = new AppStoreConnectClient(credentials, fetcher);
  const [discovery, analysis, screenshots] = await Promise.all([
    client.discover(manifest.app.bundleId, { version: manifest.app.version, build: manifest.app.build }),
    existingAnalysis ? Promise.resolve(existingAnalysis) : analyzeRepository(repository),
    localScreenshotSets(repository, manifest)
  ]);
  const demo = manifest.review.demoAccount; const demoCredentialsPresent = !demo?.required || Boolean(demo.usernameEnv && environment[demo.usernameEnv] && demo.passwordEnv && environment[demo.passwordEnv]);
  const desired = { releaseType: manifest.app.releaseMode === "automatic" ? "AFTER_APPROVAL" as const : "MANUAL" as const, reviewNotes: submittedReviewNotes(await appReviewNotes(repository, manifest, analysis)), screenshots, demoCredentialsPresent };
  return { client, discovery, desired, credentialsPresent: true };
}

function buildPlan(manifest: ShipLayerManifest, discovery: RemoteDiscovery, desired: DesiredState): AscPlan {
  const operations: AscOperation[] = [];
  const warnings = manualWarnings(manifest);
  if (!discovery.appId) {
    operations.push(unsupported("app.create", "Apps", "The initial app record does not exist. Create it in App Store Connect and record app.appStoreAppId before applying."));
    return { mode: "remote", operations, credentialsPresent: true, warnings };
  }
  if (manifest.app.appStoreAppId && discovery.appId !== manifest.app.appStoreAppId) {
    operations.push(unsupported("app.identity", "App identity", `Bundle ID lookup returned app ${discovery.appId}, but the manifest names ${manifest.app.appStoreAppId}.`));
    warnings.unshift("App identity mismatch blocks apply.");
    return { mode: "remote", operations, credentialsPresent: true, warnings };
  }
  operations.push(matched("app.identity", "App identity", `Bundle ID ${manifest.app.bundleId} resolves to app ${discovery.appId}.`));
  const remoteReleaseKind = releaseKindFromHistory(manifest, discovery);
  if (manifest.app.releaseKind !== remoteReleaseKind) {
    const declared = manifest.app.releaseKind && manifest.app.releaseKind !== "needs-human-confirmation" ? manifest.app.releaseKind : "unconfirmed";
    operations.push(unsupported("release.kind", "App Store version lifecycle", `App Store Connect history identifies ${manifest.app.version} as ${remoteReleaseKind}, but the manifest declares ${declared}. Update app.releaseKind before apply.`));
    operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate."));
    warnings.unshift("Release lifecycle mismatch blocks apply before any write.");
    return { mode: "remote", operations, credentialsPresent: true, warnings };
  }
  operations.push(matched("release.kind", "App Store version lifecycle", `App Store Connect history confirms ${manifest.app.version} is ${remoteReleaseKind}.`));
  if (manifest.app.releaseMode === "scheduled") {
    operations.push(unsupported("version.release-schedule", "App Store version", "Scheduled release requires a confirmed date and time, which the current manifest does not model. Apply is blocked."));
    operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate."));
    warnings.unshift("Scheduled release cannot be applied until the manifest models and confirms an exact release date and time.");
    return { mode: "remote", operations, credentialsPresent: true, warnings };
  }
  if (discovery.versions.length > 1) { operations.push(unsupported("version.ambiguous", "App Store version", `More than one iOS version matched ${manifest.app.version}; ShipLayer will not guess a target.`)); operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate.")); return { mode: "remote", operations, credentialsPresent: true, warnings }; }
  const version = discovery.versions[0];
  if (version && !isEditableVersion(version)) { operations.push(unsupported("version.state", "App Store version", `Version ${manifest.app.version} is in state ${versionState(version) || "UNKNOWN"}, so a full metadata/build/screenshot apply is not safe.`)); operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate.")); return { mode: "remote", operations, credentialsPresent: true, warnings }; }
  const appInfo = discovery.appInfos[0];
  if (!appInfo && version) { operations.push(unsupported("app-info.missing", "App Info", "No single editable App Info resource was discovered for the requested version; ShipLayer will not guess a target.")); operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate.")); return { mode: "remote", operations, credentialsPresent: true, warnings }; }
  try { assertCategoriesAvailable(manifest, discovery); } catch (error) { operations.push(unsupported("categories.unavailable", "App categories", error instanceof Error ? error.message.replace(/ No changes were made\.$/, "") : String(error))); operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate.")); return { mode: "remote", operations, credentialsPresent: true, warnings }; }
  if (!uniqueBuild(manifest, discovery)) { planBuild(manifest, discovery, operations); operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate.")); return { mode: "remote", operations, credentialsPresent: true, warnings }; }
  if (manifest.review.demoAccount?.required && !desired.demoCredentialsPresent) { operations.push(unsupported("review-details", "App Review details", "Demo-account environment values are unavailable; apply is blocked before any write.")); operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate.")); return { mode: "remote", operations, credentialsPresent: true, warnings }; }
  if (!version) operations.push(planned("version.create", "create", "App Store version", `Create iOS version ${manifest.app.version}.`));
  else operations.push(Object.keys(changedAttributes(version, { copyright: manifest.contacts.copyright, releaseType: desired.releaseType })).length ? planned("version.update", "update", "App Store version", `Update copyright/release mode for ${manifest.app.version}.`) : matched("version.update", "App Store version", `Version ${manifest.app.version} copyright/release mode already match.`));

  planCategories(manifest, discovery, operations);
  const versionCopyDescription = manifest.app.releaseKind === "update" ? "description, keywords, promotional text, What's New, and support/marketing URLs" : "description, keywords, promotional text, and support/marketing URLs";
  for (const [locale, copy] of Object.entries(manifest.metadata.localizations)) {
    const appLocalization = byLocale(discovery.appInfoLocalizations, locale);
    const appAttributes = appInfoLocalizationAttributes(copy, manifest);
    operations.push(!appLocalization ? planned(`app-info-locale.${locale}`, "create", `App Info localization ${locale}`, "Create name, subtitle, and Privacy Policy URL.") : Object.keys(changedAttributes(appLocalization, appAttributes)).length ? planned(`app-info-locale.${locale}`, "update", `App Info localization ${locale}`, "Update name, subtitle, and Privacy Policy URL.") : matched(`app-info-locale.${locale}`, `App Info localization ${locale}`, "Name, subtitle, and Privacy Policy URL already match."));
    const versionLocalization = byLocale(discovery.versionLocalizations, locale);
    const versionAttributes = versionLocalizationAttributes(copy, manifest);
    operations.push(!versionLocalization ? planned(`version-locale.${locale}`, "create", `Version localization ${locale}`, `Create ${versionCopyDescription}.`) : Object.keys(changedAttributes(versionLocalization, versionAttributes)).length ? planned(`version-locale.${locale}`, "update", `Version localization ${locale}`, `Update ${versionCopyDescription}.`) : matched(`version-locale.${locale}`, `Version localization ${locale}`, "Localized version metadata and URLs already match."));
  }
  planReview(manifest, discovery, desired, operations);
  planBuild(manifest, discovery, operations);
  planScreenshots(discovery, desired.screenshots, operations);
  operations.push(unsupported("submit.final", "Review submission", "Final App Review submission remains a separate human-controlled gate."));
  return { mode: "remote", operations, credentialsPresent: true, warnings };
}

function assertTarget(manifest: ShipLayerManifest, discovery: RemoteDiscovery): void {
  if (!discovery.appId) throw new Error("No App Store Connect app matches the manifest bundle ID. Create the initial app record manually; no changes were made.");
  if (!manifest.app.appStoreAppId) throw new Error("app.appStoreAppId is required before apply; no changes were made.");
  if (discovery.appId !== manifest.app.appStoreAppId) throw new Error(`App identity mismatch: bundle ID resolved to ${discovery.appId}, not manifest appStoreAppId ${manifest.app.appStoreAppId}. No changes were made.`);
}

function releaseKindFromHistory(manifest: ShipLayerManifest, discovery: RemoteDiscovery): "first-release" | "update" {
  return discovery.allIosVersions.some((version) => attribute(version, "versionString") !== manifest.app.version) ? "update" : "first-release";
}

function assertReleaseKind(manifest: ShipLayerManifest, discovery: RemoteDiscovery): void {
  const remote = releaseKindFromHistory(manifest, discovery);
  if (manifest.app.releaseKind !== remote) throw new Error(`App Store Connect history identifies ${manifest.app.version} as ${remote}, but app.releaseKind is ${manifest.app.releaseKind || "absent"}. Update the manifest and review a new remote plan. No changes were made.`);
}

async function syncCategories(client: AppStoreConnectClient, manifest: ShipLayerManifest, discovery: RemoteDiscovery, appInfo: AscResource, operations: AscOperation[]): Promise<void> {
  const desiredPrimary = categoryId(manifest.app.primaryCategory);
  const desiredSecondary = manifest.app.secondaryCategory ? categoryId(manifest.app.secondaryCategory) : undefined;
  assertCategoriesAvailable(manifest, discovery);
  const currentPrimary = idOf(discovery.primaryCategories[0]); const currentSecondary = idOf(discovery.secondaryCategories[0]);
  const relationships: Record<string, unknown> = {};
  if (currentPrimary !== desiredPrimary) relationships.primaryCategory = { data: { type: "appCategories", id: desiredPrimary } };
  if (desiredSecondary && currentSecondary !== desiredSecondary) relationships.secondaryCategory = { data: { type: "appCategories", id: desiredSecondary } };
  if (Object.keys(relationships).length) { await client.patch(`/appInfos/${requiredId(appInfo, "App Info")}`, { data: { type: "appInfos", id: requiredId(appInfo, "App Info"), relationships } }); operations.push(applied("categories.update", "update", "App categories", "Updated the explicitly declared primary/secondary categories.")); }
  else operations.push(matched("categories.update", "App categories", "Declared categories already match."));
}

async function syncLocalizations(client: AppStoreConnectClient, manifest: ShipLayerManifest, discovery: RemoteDiscovery, versionId: string, operations: AscOperation[]): Promise<Map<string, string>> {
  const appInfo = discovery.appInfos[0]; const appInfoId = requiredId(appInfo, "App Info"); const versionIds = new Map<string, string>();
  for (const [locale, copy] of Object.entries(manifest.metadata.localizations)) {
    const desiredApp = appInfoLocalizationAttributes(copy, manifest);
    let existingApp = byLocale(discovery.appInfoLocalizations, locale);
    if (!existingApp) {
      try { await client.post("/appInfoLocalizations", { data: { type: "appInfoLocalizations", attributes: { locale, ...desiredApp }, relationships: { appInfo: { data: { type: "appInfos", id: appInfoId } } } } }); operations.push(applied(`app-info-locale.${locale}`, "create", `App Info localization ${locale}`, "Created name, subtitle, and Privacy Policy URL.")); }
      catch (error) {
        existingApp = await recoverDuplicateLocalization(client, `/appInfos/${appInfoId}/appInfoLocalizations?limit=200`, locale, error);
        const changed = changedAttributes(existingApp, desiredApp);
        if (Object.keys(changed).length) await client.patch(`/appInfoLocalizations/${requiredId(existingApp, "App Info localization")}`, updateBody("appInfoLocalizations", existingApp, changed));
        operations.push(applied(`app-info-locale.${locale}`, "update", `App Info localization ${locale}`, "Recovered Apple's duplicate-locale create response and synchronized name, subtitle, and Privacy Policy URL."));
      }
    }
    else { const changed = changedAttributes(existingApp, desiredApp); if (Object.keys(changed).length) { await client.patch(`/appInfoLocalizations/${requiredId(existingApp, "App Info localization")}`, updateBody("appInfoLocalizations", existingApp, changed)); operations.push(applied(`app-info-locale.${locale}`, "update", `App Info localization ${locale}`, "Updated name, subtitle, and Privacy Policy URL.")); } else operations.push(matched(`app-info-locale.${locale}`, `App Info localization ${locale}`, "Already matches.")); }

    const desiredVersion = versionLocalizationAttributes(copy, manifest); let existingVersion = byLocale(discovery.versionLocalizations, locale);
    if (!existingVersion) {
      try { const response = await client.post("/appStoreVersionLocalizations", { data: { type: "appStoreVersionLocalizations", attributes: { locale, ...desiredVersion }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } } }); existingVersion = firstResource(response, `creating ${locale} version localization`); operations.push(applied(`version-locale.${locale}`, "create", `Version localization ${locale}`, "Created localized version metadata and URLs.")); }
      catch (error) {
        existingVersion = await recoverDuplicateLocalization(client, `/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, locale, error);
        const changed = changedAttributes(existingVersion, desiredVersion);
        if (Object.keys(changed).length) await client.patch(`/appStoreVersionLocalizations/${requiredId(existingVersion, "version localization")}`, updateBody("appStoreVersionLocalizations", existingVersion, changed));
        operations.push(applied(`version-locale.${locale}`, "update", `Version localization ${locale}`, "Recovered Apple's duplicate-locale create response and synchronized localized version metadata and URLs."));
      }
    }
    else { const changed = changedAttributes(existingVersion, desiredVersion); if (Object.keys(changed).length) { await client.patch(`/appStoreVersionLocalizations/${requiredId(existingVersion, "version localization")}`, updateBody("appStoreVersionLocalizations", existingVersion, changed)); operations.push(applied(`version-locale.${locale}`, "update", `Version localization ${locale}`, "Updated localized version metadata and URLs.")); } else operations.push(matched(`version-locale.${locale}`, `Version localization ${locale}`, "Already matches.")); }
    versionIds.set(locale, requiredId(existingVersion, "version localization"));
  }
  return versionIds;
}

async function recoverDuplicateLocalization(client: AppStoreConnectClient, resourcePath: string, locale: string, error: unknown): Promise<AscResource> {
  if (!(error instanceof Error) || !/\(409\):[\s\S]*ENTITY_ERROR\.ATTRIBUTE\.INVALID\.DUPLICATE/.test(error.message)) throw error;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
    const localization = byLocale(dataOf(await client.get(resourcePath)) as AscResource[], locale);
    if (localization) return localization;
  }
  throw error;
}

async function syncReviewDetails(client: AppStoreConnectClient, manifest: ShipLayerManifest, discovery: RemoteDiscovery, versionId: string, notes: string, environment: NodeJS.ProcessEnv, operations: AscOperation[]): Promise<void> {
  const contact = manifest.review.contact as Required<NonNullable<ShipLayerManifest["review"]["contact"]>>; const demo = manifest.review.demoAccount;
  const attributes: Record<string, unknown> = { contactFirstName: contact.firstName, contactLastName: contact.lastName, contactEmail: contact.email, contactPhone: contact.phone, demoAccountRequired: Boolean(demo?.required), notes };
  if (demo?.required) {
    const username = demo.usernameEnv ? environment[demo.usernameEnv] : undefined; const password = demo.passwordEnv ? environment[demo.passwordEnv] : undefined;
    if (!username || !password) throw new Error("Required demo-account environment values are unavailable. ShipLayer never reads credentials from the manifest. Partial remote changes may have occurred.");
    attributes.demoAccountName = username; attributes.demoAccountPassword = password;
  }
  const existing = discovery.reviewDetails[0];
  if (!existing) { await client.post("/appStoreReviewDetails", { data: { type: "appStoreReviewDetails", attributes, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } } }); operations.push(applied("review-details", "create", "App Review details", "Created review contact, demo-account setting, and generated notes.")); return; }
  const changed = changedAttributes(existing, attributes);
  if (Object.keys(changed).length) { await client.patch(`/appStoreReviewDetails/${requiredId(existing, "App Review details")}`, updateBody("appStoreReviewDetails", existing, changed)); operations.push(applied("review-details", "update", "App Review details", "Updated review contact, demo-account setting, and generated notes.")); }
  else operations.push(matched("review-details", "App Review details", "Review details already match."));
}

async function syncBuild(client: AppStoreConnectClient, manifest: ShipLayerManifest, discovery: RemoteDiscovery, versionId: string, build: AscResource, operations: AscOperation[]): Promise<void> {
  const desiredId = requiredId(build, "build"); const selectedId = idOf(discovery.selectedBuilds[0]);
  if (selectedId === desiredId) { operations.push(matched("build.attach", "Build", `Build ${manifest.app.build} is already attached.`)); return; }
  await client.patch(`/appStoreVersions/${versionId}/relationships/build`, { data: { type: "builds", id: desiredId } }); operations.push(applied("build.attach", "update", "Build", `Attached build ${manifest.app.build} to version ${manifest.app.version}.`));
}

export async function syncScreenshots(client: Pick<AppStoreConnectClient, "get" | "post" | "patch" | "delete" | "uploadAsset">, discovery: Pick<RemoteDiscovery, "screenshotGroups">, localizationIds: Map<string, string>, localSets: LocalScreenshotSet[], operations: AscOperation[]): Promise<void> {
  for (const local of localSets) {
    const localizationId = localizationIds.get(local.locale); if (!localizationId) throw new Error(`No version localization ID is available for ${local.locale}. Partial remote changes may have occurred.`);
    let remote = discovery.screenshotGroups.find((group) => group.localizationId === localizationId && attribute(group.set, "screenshotDisplayType") === local.displayType);
    if (!remote) { const response = await client.post("/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: local.displayType }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localizationId } } } } }); remote = { localizationId, set: firstResource(response, "creating an App Screenshot Set"), screenshots: [] }; operations.push(applied(`screenshots.${local.family}.${local.locale}.set`, "create", `Screenshots ${local.family}/${local.locale}`, `Created ${local.displayType} screenshot set.`)); }
    const setId = requiredId(remote.set, "App Screenshot Set");
    const unmatched = [...remote.screenshots]; const desiredSlots: Array<{ id?: string; screenshot?: LocalScreenshot }> = []; const missing: LocalScreenshot[] = [];
    for (const screenshot of local.screenshots) { const index = unmatched.findIndex((item) => String(attribute(item, "fileName") || "") === screenshot.fileName && String(attribute(item, "sourceFileChecksum") || "").toLowerCase() === screenshot.checksum); if (index >= 0) { desiredSlots.push({ id: requiredId(unmatched[index], "App Screenshot") }); unmatched.splice(index, 1); } else { desiredSlots.push({ screenshot }); missing.push(screenshot); } }
    const desiredIds = desiredSlots.flatMap((slot) => slot.id ? [slot.id] : []);
    const exactOrder = desiredIds.length === remote.screenshots.length && desiredIds.every((id, index) => id === idOf(remote.screenshots[index]));
    if (!missing.length && !unmatched.length && exactOrder) { operations.push(matched(`screenshots.${local.family}.${local.locale}`, `Screenshots ${local.family}/${local.locale}`, `${local.screenshots.length} screenshot(s) already match by filename, checksum, and order.`)); continue; }
    const deleteStale = async (): Promise<void> => { for (const item of unmatched) await client.delete(`/appScreenshots/${requiredId(item, "App Screenshot")}`); if (unmatched.length) operations.push(applied(`screenshots.${local.family}.${local.locale}.delete`, "delete", `Screenshots ${local.family}/${local.locale}`, `Deleted ${unmatched.length} screenshot(s) absent from the reviewed local deck.`)); };
    if (remote.screenshots.length + missing.length > 10) await deleteStale();
    for (const slot of desiredSlots) if (slot.screenshot) slot.id = await uploadScreenshot(client, setId, slot.screenshot);
    if (remote.screenshots.length + missing.length <= 10) await deleteStale();
    await client.patch(`/appScreenshotSets/${setId}/relationships/appScreenshots`, { data: desiredSlots.map((slot) => ({ type: "appScreenshots", id: slot.id as string })) });
    operations.push(applied(`screenshots.${local.family}.${local.locale}`, "upload", `Screenshots ${local.family}/${local.locale}`, `Synchronized ${local.screenshots.length} reviewed ${local.source} screenshot(s) and their order.`));
  }
}

async function uploadScreenshot(client: Pick<AppStoreConnectClient, "get" | "post" | "patch" | "delete" | "uploadAsset">, setId: string, screenshot: LocalScreenshot): Promise<string> {
  const reservation = await client.post("/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: screenshot.fileName, fileSize: screenshot.bytes.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } } } });
  const resource = firstResource(reservation, "reserving an App Screenshot"); const id = requiredId(resource, "App Screenshot");
  let commitAttempted = false;
  try {
    await client.uploadAsset(attribute(resource, "uploadOperations"), screenshot.bytes);
    commitAttempted = true;
    await client.patch(`/appScreenshots/${id}`, { data: { type: "appScreenshots", id, attributes: { uploaded: true, sourceFileChecksum: screenshot.checksum } } });
    for (let attempt = 0; attempt < 300; attempt++) {
      const response = await client.get(`/appScreenshots/${id}`); const current = firstResource(response, "checking App Screenshot processing"); const delivery = attribute(current, "assetDeliveryState") as { state?: unknown; errors?: unknown } | undefined; const state = delivery?.state;
      if (state === "COMPLETE") return id;
      if (state === "FAILED") { await client.delete(`/appScreenshots/${id}`).catch(() => undefined); throw new Error("App Store Connect failed to process an uploaded screenshot; its failed reservation was removed."); }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("App Store Connect did not finish processing a screenshot within five minutes. The committed asset was left in place; rerun the plan after Apple finishes processing it.");
  } catch (error) {
    if (!commitAttempted) await client.delete(`/appScreenshots/${id}`).catch(() => undefined);
    throw error;
  }
}

export async function localScreenshotSets(repository: string, manifest: ShipLayerManifest): Promise<LocalScreenshotSet[]> {
  const output: LocalScreenshotSet[] = [];
  for (const configuration of manifest.screenshots.configurations) {
    const finalRoot = manifest.screenshots.finalOutputDir || DEFAULT_MARKETING_FINAL_DIR;
    const finalRelative = `${finalRoot}/${configuration.family}/${configuration.locale}`;
    const rawLocale = configuration.sourceLocale ?? configuration.locale;
    const rawRelative = `${manifest.screenshots.rawOutputDir}/${configuration.family}/${rawLocale}`;
    const finalFiles = await listImages(repository, finalRelative);
    const finalComplete = manifest.screenshots.scenarios.every((scenario) => finalFiles.some((file) => path.basename(file, path.extname(file)) === scenario.id));
    const source = finalComplete ? "marketing" as const : "raw" as const; const relativeDirectory = source === "marketing" ? finalRelative : rawRelative; const files = source === "marketing" ? finalFiles : await listImages(repository, rawRelative);
    if (!files.length) throw new Error(`No screenshots exist in ${relativeDirectory}.`);
    const ordered = orderScreenshotFiles(files, manifest.screenshots.scenarios.map((scenario) => scenario.id)); const screenshots: LocalScreenshot[] = [];
    for (const fileName of ordered) { const filePath = await resolveContained(repository, `${relativeDirectory}/${fileName}`, "App Store screenshot"); const details = await lstat(filePath); if (!details.isFile() || details.isSymbolicLink() || details.size > 50 * 1024 * 1024) throw new Error(`Screenshot ${fileName} is not a safe bounded regular file.`); const bytes = await readFile(filePath); screenshots.push({ fileName, filePath, bytes, checksum: createHash("md5").update(bytes).digest("hex") }); }
    output.push({ locale: configuration.locale, family: configuration.family, displayType: displayType(configuration.family, configuration.requiredDimensions.width, configuration.requiredDimensions.height), source, screenshots });
  }
  return output;
}

async function listImages(repository: string, relativeDirectory: string): Promise<string[]> { let directory: string; try { directory = await resolveContained(repository, relativeDirectory, "screenshot directory"); } catch { return []; } try { if (!(await lstat(directory)).isDirectory()) return []; return (await readdir(directory)).filter((file) => /\.(?:png|jpe?g)$/i.test(file)).sort(); } catch { return []; } }
function orderScreenshotFiles(files: string[], scenarios: string[]): string[] { const index = (file: string): number => { const stem = path.basename(file, path.extname(file)); let winner = -1; let length = -1; scenarios.forEach((scenario, candidate) => { if ((stem === scenario || stem.startsWith(`${scenario}-`)) && scenario.length > length) { winner = candidate; length = scenario.length; } }); return winner < 0 ? Number.MAX_SAFE_INTEGER : winner; }; return [...files].sort((left, right) => index(left) - index(right) || left.localeCompare(right)); }
function displayType(family: "iphone" | "ipad", width: number, height: number): string { if (family === "ipad") return "APP_IPAD_PRO_3GEN_129"; const dimensions = new Set([`${width}x${height}`, `${height}x${width}`]); return dimensions.has("1242x2688") || dimensions.has("1284x2778") ? "APP_IPHONE_65" : "APP_IPHONE_67"; }

function planCategories(manifest: ShipLayerManifest, discovery: RemoteDiscovery, operations: AscOperation[]): void { const primary = categoryId(manifest.app.primaryCategory); const secondary = manifest.app.secondaryCategory ? categoryId(manifest.app.secondaryCategory) : undefined; const differs = idOf(discovery.primaryCategories[0]) !== primary || Boolean(secondary && idOf(discovery.secondaryCategories[0]) !== secondary); operations.push(differs ? planned("categories.update", "update", "App categories", "Update the explicitly declared primary/secondary categories.") : matched("categories.update", "App categories", "Declared categories already match.")); }
function planReview(manifest: ShipLayerManifest, discovery: RemoteDiscovery, desiredState: DesiredState, operations: AscOperation[]): void { const contact = manifest.review.contact; const desired = { contactFirstName: contact?.firstName, contactLastName: contact?.lastName, contactEmail: contact?.email, contactPhone: contact?.phone, demoAccountRequired: Boolean(manifest.review.demoAccount?.required), notes: desiredState.reviewNotes }; const existing = discovery.reviewDetails[0]; if (manifest.review.demoAccount?.required && !desiredState.demoCredentialsPresent) { operations.push(unsupported("review-details", "App Review details", "Demo-account environment values are unavailable; apply will remain blocked.")); return; } const secureRefresh = Boolean(manifest.review.demoAccount?.required); operations.push(!existing ? planned("review-details", "create", "App Review details", `Create review contact, demo-account setting, generated notes${secureRefresh ? ", and secure credentials from environment variables" : ""}.`) : secureRefresh || Object.keys(changedAttributes(existing, desired)).length ? planned("review-details", "update", "App Review details", `Update review contact, demo-account setting, generated notes${secureRefresh ? ", and refresh secure credentials from environment variables" : ""}.`) : matched("review-details", "App Review details", "Review details already match.")); }
function planBuild(manifest: ShipLayerManifest, discovery: RemoteDiscovery, operations: AscOperation[]): void { const build = uniqueBuild(manifest, discovery); if (!build) operations.push(unsupported("build.attach", "Build", `Build ${manifest.app.build} for iOS version ${manifest.app.version} is not available and valid.`)); else operations.push(idOf(discovery.selectedBuilds[0]) === idOf(build) ? matched("build.attach", "Build", `Build ${manifest.app.build} is already attached.`) : planned("build.attach", "update", "Build", `Attach build ${manifest.app.build} to version ${manifest.app.version}.`)); }
function planScreenshots(discovery: RemoteDiscovery, localSets: LocalScreenshotSet[], operations: AscOperation[]): void {
  for (const local of localSets) {
    const prefix = `screenshots.${local.family}.${local.locale}`; const resource = `Screenshots ${local.family}/${local.locale}`;
    const localization = byLocale(discovery.versionLocalizations, local.locale); const remote = localization && discovery.screenshotGroups.find((group) => group.localizationId === idOf(localization) && attribute(group.set, "screenshotDisplayType") === local.displayType);
    if (!remote) {
      operations.push(planned(`${prefix}.set`, "create", resource, `Create the ${local.displayType} screenshot set.`));
      local.screenshots.forEach((item, index) => operations.push(planned(`${prefix}.upload.${index + 1}`, "upload", resource, `Upload reviewed ${local.source} asset ${item.fileName} (${item.checksum}).`)));
      operations.push(planned(`${prefix}.order`, "update", resource, `Set ${local.screenshots.length} screenshot(s) to manifest scenario order.`));
      continue;
    }
    const unmatched = [...remote.screenshots]; const desiredIds: Array<string | undefined> = [];
    local.screenshots.forEach((item, index) => { const matchIndex = unmatched.findIndex((candidate) => String(attribute(candidate, "fileName") || "") === item.fileName && String(attribute(candidate, "sourceFileChecksum") || "").toLowerCase() === item.checksum); if (matchIndex >= 0) { desiredIds.push(idOf(unmatched[matchIndex])); unmatched.splice(matchIndex, 1); } else { desiredIds.push(undefined); operations.push(planned(`${prefix}.upload.${index + 1}`, "upload", resource, `Upload reviewed ${local.source} asset ${item.fileName} (${item.checksum}).`)); } });
    unmatched.forEach((item, index) => operations.push(planned(`${prefix}.delete.${index + 1}`, "delete", resource, `Delete remote asset ${String(attribute(item, "fileName") || idOf(item) || "with unknown identity")} because its filename/checksum is absent from the reviewed local deck.`)));
    const exactOrder = desiredIds.every(Boolean) && desiredIds.length === remote.screenshots.length && desiredIds.every((id, index) => id === idOf(remote.screenshots[index]));
    if (!exactOrder || unmatched.length) operations.push(planned(`${prefix}.order`, "update", resource, `Set ${local.screenshots.length} screenshot(s) to manifest scenario order after reconciliation.`));
    if (exactOrder && !unmatched.length) operations.push(matched(prefix, resource, `${local.screenshots.length} screenshot(s) already match by filename, checksum, and order.`));
  }
}

function appInfoLocalizationAttributes(copy: ShipLayerManifest["metadata"]["localizations"][string], manifest: ShipLayerManifest): Record<string, unknown> { return compact({ name: copy.name, subtitle: copy.subtitle, privacyPolicyUrl: copy.privacyPolicyUrl ?? manifest.contacts.privacyUrl }); }
function versionLocalizationAttributes(copy: ShipLayerManifest["metadata"]["localizations"][string], manifest: ShipLayerManifest): Record<string, unknown> { return compact({ description: copy.description, keywords: copy.keywords?.join(","), marketingUrl: copy.marketingUrl ?? manifest.contacts.marketingUrl, promotionalText: copy.promotionalText, supportUrl: copy.supportUrl ?? manifest.contacts.supportUrl, whatsNew: manifest.app.releaseKind === "update" ? copy.whatsNew : undefined }); }
function changedAttributes(resource: AscResource, desired: Record<string, unknown>): Record<string, unknown> { const changed: Record<string, unknown> = {}; for (const [key, value] of Object.entries(compact(desired))) if (!same(attribute(resource, key), value)) changed[key] = value; return changed; }
function compact(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
function updateBody(type: string, resource: AscResource, attributes: Record<string, unknown>): unknown { return { data: { type, id: requiredId(resource, type), attributes } }; }
function byLocale(resources: AscResource[], locale: string): AscResource | undefined { return resources.find((resource) => attribute(resource, "locale") === locale); }
function firstResource(response: unknown, action: string): AscResource { const resource = dataOf(response)[0] as AscResource | undefined; if (!resource?.id) throw new Error(`App Store Connect returned no resource ID after ${action}. Partial remote changes may have occurred.`); return resource; }
function requiredId(resource: AscResource | undefined, label: string): string { const id = idOf(resource); if (!id) throw new Error(`${label} has no resource ID. Partial remote changes may have occurred.`); return id; }
function uniqueBuild(manifest: ShipLayerManifest, discovery: RemoteDiscovery): AscResource | undefined { const eligible = discovery.builds.filter((build) => attribute(build, "version") === manifest.app.build && attribute(build, "processingState") === "VALID" && attribute(build, "expired") !== true && attribute(build, "buildAudienceType") !== "INTERNAL_ONLY"); return eligible.length === 1 ? eligible[0] : undefined; }
function assertCategoriesAvailable(manifest: ShipLayerManifest, discovery: RemoteDiscovery): void { const desiredPrimary = categoryId(manifest.app.primaryCategory); const desiredSecondary = manifest.app.secondaryCategory ? categoryId(manifest.app.secondaryCategory) : undefined; const available = new Set(discovery.categories.map(idOf)); if (!desiredPrimary || !available.has(desiredPrimary)) throw new Error(`Primary category '${manifest.app.primaryCategory || ""}' was not present in Apple's current iOS category list. No changes were made.`); if (desiredSecondary && !available.has(desiredSecondary)) throw new Error(`Secondary category '${manifest.app.secondaryCategory}' was not present in Apple's current iOS category list. No changes were made.`); }
function versionState(version: AscResource): string | undefined { const state = attribute(version, "appVersionState") ?? attribute(version, "appStoreState"); return typeof state === "string" ? state : undefined; }
function isEditableVersion(version: AscResource): boolean { return new Set(["PREPARE_FOR_SUBMISSION", "INVALID_BINARY", "DEVELOPER_REJECTED", "METADATA_REJECTED", "REJECTED"]).has(versionState(version) || ""); }
function assertEditableVersion(version: AscResource): void { if (!isEditableVersion(version)) throw new Error(`App Store version is in state ${versionState(version) || "UNKNOWN"}; a full metadata/build/screenshot apply is not safe. No changes were made.`); }
function assertPlanUnchanged(reviewed: AscPlan, current: AscPlan): void { const signature = (plan: AscPlan): string => JSON.stringify(plan.operations.map((operation) => ({ id: operation.id, action: operation.action, resource: operation.resource, description: operation.description, safety: operation.safety, status: operation.status })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))); if (signature(reviewed) !== signature(current)) throw new Error("App Store Connect changed after the reviewed preview. ShipLayer made no changes; run the remote plan again and review the new diff."); }
function categoryId(name: string | undefined): string | undefined { return name?.toUpperCase().replaceAll("&", "AND").replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""); }
function manualWarnings(manifest: ShipLayerManifest): string[] { const warnings = ["ShipLayer does not submit the version for App Review. Submission remains a separate human action.", "App Privacy answers, age rating, content-rights/legal/trader declarations, agreements, tax/banking, pricing, and territory availability remain human-controlled."]; if (manifest.monetization.type !== "free" && manifest.monetization.type !== "paid-app") warnings.push("In-App Purchase/subscription product configuration and review attachments remain human-controlled."); if (!manifest.app.secondaryCategory) warnings.push("No secondary category is declared, so ShipLayer will preserve any existing secondary category rather than infer or delete it."); return warnings; }
function planned(id: string, action: AscOperation["action"], resource: string, description: string): AscOperation { return { id, action, resource, description, safety: "requires-apply", status: "planned" }; }
function applied(id: string, action: AscOperation["action"], resource: string, description: string): AscOperation { return { id, action, resource, description, safety: "requires-apply", status: "applied" }; }
function matched(id: string, resource: string, description: string): AscOperation { return { id, action: "read", resource, description, safety: "read-only", status: "already-matches" }; }
function unsupported(id: string, resource: string, description: string): AscOperation { return { id, action: "manual", resource, description, safety: "manual", status: "unsupported" }; }
