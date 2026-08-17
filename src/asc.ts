import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AscOperation, AscPlan, ShipLayerManifest } from "./types.js";

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
export interface FetchResponse { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }
export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;
export interface AscCredentials { issuerId: string; keyId: string; privateKeyPath: string }
export interface RemoteDiscovery { appId?: string; app?: unknown; appInfos: unknown[]; appInfoLocalizations: unknown[]; versions: unknown[]; versionLocalizations: unknown[]; builds: unknown[]; reviewDetails: unknown[]; screenshotSets: unknown[]; screenshots: unknown[]; inAppPurchases: unknown[]; subscriptionGroups: unknown[]; subscriptions: unknown[] }
export interface DiscoverySelection { version?: string; build?: string }

export function credentialsFromEnvironment(manifest: ShipLayerManifest, environment: NodeJS.ProcessEnv = process.env): AscCredentials | undefined { const keyId = manifest.sync.appStoreConnectKeyIdEnv ? environment[manifest.sync.appStoreConnectKeyIdEnv] : undefined; const issuerId = manifest.sync.issuerIdEnv ? environment[manifest.sync.issuerIdEnv] : undefined; const privateKeyPath = manifest.sync.privateKeyPathEnv ? environment[manifest.sync.privateKeyPathEnv] : undefined; return keyId && issuerId && privateKeyPath ? { keyId, issuerId, privateKeyPath } : undefined; }
export async function validateAscPrivateKey(privateKeyPath: string) {
  const key = createPrivateKey(await readFile(privateKeyPath, "utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("App Store Connect key must be an EC P-256 private key for ES256.");
  return key;
}
export async function createJwt(credentials: AscCredentials, now = new Date()): Promise<string> { const header = base64url({ alg: "ES256", kid: credentials.keyId, typ: "JWT" }); const payload = base64url({ iss: credentials.issuerId, aud: "appstoreconnect-v1", exp: Math.floor(now.getTime() / 1000) + 1_000 }); const signingInput = `${header}.${payload}`; const key = await validateAscPrivateKey(credentials.privateKeyPath); const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }); return `${signingInput}.${signature.toString("base64url")}`; }
export class AppStoreConnectClient {
  constructor(private readonly credentials: AscCredentials, private readonly fetcher: FetchLike = fetch as unknown as FetchLike, private readonly timeoutMs = 10_000) {}
  async get(pathOrUrl: string): Promise<unknown> { const first = await this.request(pathOrUrl); const pages = [first]; let next = nextLink(first); for (let count = 0; next && count < 20; count++) { pages.push(await this.request(next)); next = nextLink(pages[pages.length - 1]); } if (next) throw new Error("App Store Connect pagination exceeded the 20-page safety limit."); if (pages.length === 1) return first; return { ...first, data: dedupeResources(pages.flatMap(dataOf)), included: dedupeResources(pages.flatMap(includedOf)) }; }
  private async request(pathOrUrl: string): Promise<Record<string, unknown>> { const url = safeAscUrl(pathOrUrl); let lastError = ""; for (let attempt = 0; attempt < 3; attempt++) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); try { const token = await createJwt(this.credentials); const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: controller.signal }); const body = await response.text(); if (!response.ok) { lastError = `App Store Connect read failed (${response.status}): ${redact(body)}`; if (response.status !== 429 && response.status < 500) throw new Error(lastError); const retryAfter = Number(response.headers?.get("retry-after") || ""); await delay(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 2_000) : 100 * (attempt + 1)); continue; } try { return body ? JSON.parse(body) as Record<string, unknown> : {}; } catch { throw new Error("App Store Connect returned invalid JSON; no changes were made."); } } catch (error) { if (error instanceof Error && error.name === "AbortError") lastError = "App Store Connect request timed out; no changes were made."; else if (error instanceof Error) { lastError = redact(error.message); if (!/\(429\)|\(5\d\d\)/.test(lastError)) throw new Error(lastError); } if (attempt < 2) await delay(100 * (attempt + 1)); } finally { clearTimeout(timer); } } throw new Error(lastError || "App Store Connect request failed; no changes were made."); }
  async discover(bundleId: string, selection: DiscoverySelection = {}): Promise<RemoteDiscovery> {
    const appResponse = await this.get(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`) as { data?: Array<{ id: string }> };
    const appId = appResponse.data?.[0]?.id;
    if (!appId) return emptyDiscovery();
    const [appInfosResponse, versionsResponse, inAppPurchases, subscriptionGroupsResponse] = await Promise.all([
      this.get(`/apps/${appId}/appInfos?limit=200`), this.get(`/apps/${appId}/appStoreVersions?limit=200`), this.get(`/apps/${appId}/inAppPurchasesV2?limit=200`), this.get(`/apps/${appId}/subscriptionGroups?limit=200`)
    ]);
    const appInfos = dataOf(appInfosResponse);
    const allVersions = dataOf(versionsResponse);
    const iosVersions = allVersions.filter((value) => attribute(value, "platform") === "IOS");
    const versions = selection.version ? iosVersions.filter((value) => attribute(value, "versionString") === selection.version) : iosVersions;
    const appInfoId = idOf(appInfos[0]);
    // Do not inspect an arbitrary version when a requested version is absent.
    const versionId = idOf(versions[0]);
    const [appInfoLocalizations, versionLocalizations, reviewDetails, selectedBuildResponse] = await Promise.all([
      appInfoId ? this.get(`/appInfos/${appInfoId}/appInfoLocalizations?limit=200`).then(dataOf) : Promise.resolve([]),
      versionId ? this.get(`/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`).then(dataOf) : Promise.resolve([]),
      versionId ? this.get(`/appStoreVersions/${versionId}/appStoreVersionAppReviewDetail`).then(dataOf) : Promise.resolve([]),
      versionId ? this.get(`/appStoreVersions/${versionId}/build`) : Promise.resolve({})
    ]);
    const builds = selection.build ? dataOf(selectedBuildResponse).filter((value) => attribute(value, "version") === selection.build) : dataOf(selectedBuildResponse);
    const screenshotResponses = await Promise.all(versionLocalizations.map((localization) => { const localizationId = idOf(localization); return localizationId ? this.get(`/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?include=appScreenshots&limit=200`) : Promise.resolve({}); }));
    const screenshotSets = screenshotResponses.flatMap(dataOf);
    const screenshots = screenshotResponses.flatMap(includedOf).filter((item) => (item as { type?: unknown }).type === "appScreenshots");
    const subscriptionGroups = dataOf(subscriptionGroupsResponse);
    const subscriptionResponses = await Promise.all(subscriptionGroups.map((group) => idOf(group) ? this.get(`/subscriptionGroups/${idOf(group)}/subscriptions?limit=200`) : Promise.resolve({})));
    return { appId, app: appResponse.data?.[0], appInfos, appInfoLocalizations, versions, versionLocalizations, builds, reviewDetails, screenshotSets, screenshots, inAppPurchases: dataOf(inAppPurchases), subscriptionGroups, subscriptions: subscriptionResponses.flatMap(dataOf) };
  }
}
function dataOf(value: unknown): unknown[] { const data = (value as { data?: unknown })?.data; return Array.isArray(data) ? data : data && typeof data === "object" ? [data] : []; }
function includedOf(value: unknown): unknown[] { return Array.isArray((value as { included?: unknown[] }).included) ? (value as { included: unknown[] }).included : []; }
function dedupeResources(values: unknown[]): unknown[] { const seen = new Map<string, unknown>(); for (const value of values) { const key = `${String((value as { type?: unknown }).type || "")}:${String(idOf(value) || "")}:${JSON.stringify(value)}`; if (!seen.has(key)) seen.set(key, value); } return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value); }
function safeAscUrl(pathOrUrl: string): string {
  const candidate = pathOrUrl.startsWith("/") ? `${API_ROOT}${pathOrUrl}` : pathOrUrl;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error("App Store Connect request URL is invalid."); }
  if (url.protocol !== "https:" || url.hostname !== "api.appstoreconnect.apple.com" || url.port || !url.pathname.startsWith("/v1/")) throw new Error("App Store Connect requests are restricted to the official HTTPS /v1 API host.");
  return url.toString();
}
function nextLink(value: unknown): string | undefined { const next = (value as { links?: { next?: unknown } })?.links?.next; if (typeof next !== "string") return undefined; safeAscUrl(next); return next; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function idOf(value: unknown): string | undefined { return typeof (value as { id?: unknown })?.id === "string" ? (value as { id: string }).id : undefined; }
function attribute(value: unknown, key: string): string | undefined { const candidate = (value as { attributes?: Record<string, unknown> })?.attributes?.[key]; return typeof candidate === "string" ? candidate : undefined; }
function emptyDiscovery(): RemoteDiscovery { return { appInfos: [], appInfoLocalizations: [], versions: [], versionLocalizations: [], builds: [], reviewDetails: [], screenshotSets: [], screenshots: [], inAppPurchases: [], subscriptionGroups: [], subscriptions: [] }; }
function base64url(value: object): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function redact(input: string): string { return input.replace(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, "[REDACTED KEY]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]").replace(/(token|secret|password)=[^\s&]+/gi, "$1=[REDACTED]").slice(0, 600); }

export async function appStorePlan(manifest: ShipLayerManifest, remote = false, environment: NodeJS.ProcessEnv = process.env, fetcher?: FetchLike): Promise<AscPlan> {
  const operations = baseOperations(manifest); const credentials = credentialsFromEnvironment(manifest, environment);
  if (!remote) return { mode: "offline", operations, credentialsPresent: Boolean(credentials), warnings: ["Offline dry-run: no App Store Connect request was made.", "Initial app record creation, agreements, banking/tax/trader declarations, privacy/legal confirmation, and final submission are human-controlled."] };
  if (!credentials) return { mode: "remote", operations, credentialsPresent: false, warnings: ["Remote discovery was requested but credentials are unavailable. No request was made."] };
  const discovery = await new AppStoreConnectClient(credentials, fetcher).discover(manifest.app.bundleId, { version: manifest.app.version, build: manifest.app.build });
  const warnings = [`Remote discovery completed for ${discovery.appId || "no matching app"}. This command performed reads only.`, "ShipLayer v0.1 does not mutate App Store Connect; use the generated plan to perform reviewed UI/API operations."];
  if (!discovery.appId) operations.unshift({ id: "manual.create-app-record", action: "manual", resource: "Apps", description: "Create the initial app record in App Store Connect UI, then add app.appStoreAppId.", safety: "manual", status: "unsupported" });
  else if (manifest.app.appStoreAppId && manifest.app.appStoreAppId !== discovery.appId) { warnings.push(`Discovered app ID ${discovery.appId} disagrees with manifest appStoreAppId ${manifest.app.appStoreAppId}. No comparison was accepted.`); }
  else for (const operation of operations) if (operation.resource === "App identity") operation.status = "already-matches";
  if (manifest.app.version && !discovery.versions.length) warnings.push(`Requested iOS version ${manifest.app.version} was not discovered; create/select it manually.`);
  if (manifest.app.build && !discovery.builds.length) warnings.push(`Requested build ${manifest.app.build} was not attached to the requested iOS version; select/attach it manually.`);
  return { mode: "remote", operations, credentialsPresent: true, warnings };
}
function baseOperations(manifest: ShipLayerManifest): AscOperation[] { const operations: AscOperation[] = [
  { id: "read.app", action: "read", resource: "App identity", description: `Discover app with bundle ID ${manifest.app.bundleId || "MISSING"}.`, safety: "read-only", status: "planned" },
  { id: "read.metadata", action: "read", resource: "App metadata/localizations", description: "Read discovery candidates only; v0.1 does not calculate or apply metadata differences.", safety: "read-only", status: "planned" },
  { id: "read.build", action: "read", resource: "Build", description: `Locate requested build ${manifest.app.build || "MISSING"} for version ${manifest.app.version || "MISSING"}.`, safety: "read-only", status: "planned" },
  { id: "manual.record-and-metadata", action: "manual", resource: "App record, metadata, availability, release", description: "Create/verify the app record, enter metadata/URLs/contact, select category/territories/release mode, and select the uploaded build/version in App Store Connect. v0.1 does not write these fields.", safety: "manual", status: "unsupported" },
  { id: "manual.screenshots", action: "manual", resource: "Screenshots", description: "Review and upload accepted marketing screenshots in App Store Connect. v0.1 does not reserve, upload, commit, or process assets.", safety: "manual", status: "unsupported" },
  { id: "manual.privacy-compliance", action: "manual", resource: "App Privacy and compliance", description: "Human completes App Privacy, age rating, content rights, trader, legal, agreement, tax/banking and support-page checks in App Store Connect. v0.1 cannot perform declarations.", safety: "manual", status: "unsupported" },
  { id: "submit.final", action: "submit", resource: "Review submission", description: "Select the approved build and submit only after an explicit final command and human confirmation.", safety: "requires-submit", status: "unsupported" }
]; if (manifest.monetization.type === "subscriptions") operations.splice(3, 0, { id: "read.subscriptions", action: "read", resource: "Subscription group/products", description: "Read subscription groups/products. A human configures pricing, availability, localizations, review assets, paywall, restore and disclosures.", safety: "read-only", status: "planned" }, { id: "manual.subscriptions", action: "manual", resource: "Subscription configuration", description: "Configure subscription groups/products, pricing, availability, localizations, review assets, paywall, restore path and terms manually. v0.1 performs no StoreKit writes.", safety: "manual", status: "unsupported" }); else if (manifest.monetization.type === "non-consumables") operations.splice(3, 0, { id: "read.iap", action: "read", resource: "In-App Purchases", description: "Read In-App Purchase product discovery. A human verifies prices, localizations, and review assets.", safety: "read-only", status: "planned" }, { id: "manual.iap", action: "manual", resource: "In-App Purchase configuration", description: "Configure price, availability, localization, review assets, paywall and restore manually. v0.1 performs no StoreKit writes.", safety: "manual", status: "unsupported" }); return operations; }
