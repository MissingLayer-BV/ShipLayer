import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AscOperation, AscPlan, ShipLayerManifest } from "./types.js";

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
export interface FetchResponse { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }
export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;
export interface AscCredentials { issuerId: string; keyId: string; privateKeyPath: string }
export interface AscResource { type?: string; id?: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: AscResource | AscResource[] | null }> }
export interface RemoteScreenshotGroup { localizationId: string; set: AscResource; screenshots: AscResource[] }
export interface RemoteDiscovery { appId?: string; app?: AscResource; appInfos: AscResource[]; appInfoLocalizations: AscResource[]; /** Every discovered iOS App Store version, retained so release lifecycle can be verified before writes. */ allIosVersions: AscResource[]; /** The requested iOS version only. */ versions: AscResource[]; versionLocalizations: AscResource[]; builds: AscResource[]; selectedBuilds: AscResource[]; reviewDetails: AscResource[]; screenshotSets: AscResource[]; screenshots: AscResource[]; screenshotGroups: RemoteScreenshotGroup[]; categories: AscResource[]; primaryCategories: AscResource[]; secondaryCategories: AscResource[]; inAppPurchases: AscResource[]; subscriptionGroups: AscResource[]; subscriptions: AscResource[] }
export interface DiscoverySelection { version?: string; build?: string }

export function credentialsFromEnvironment(manifest: ShipLayerManifest, environment: NodeJS.ProcessEnv = process.env): AscCredentials | undefined { const keyId = manifest.sync.appStoreConnectKeyIdEnv ? environment[manifest.sync.appStoreConnectKeyIdEnv] : undefined; const issuerId = manifest.sync.issuerIdEnv ? environment[manifest.sync.issuerIdEnv] : undefined; const privateKeyPath = manifest.sync.privateKeyPathEnv ? environment[manifest.sync.privateKeyPathEnv] : undefined; return keyId && issuerId && privateKeyPath ? { keyId, issuerId, privateKeyPath } : undefined; }
export async function validateAscPrivateKey(privateKeyPath: string) {
  const key = createPrivateKey(await readFile(privateKeyPath, "utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("App Store Connect key must be an EC P-256 private key for ES256.");
  return key;
}
export async function createJwt(credentials: AscCredentials, now = new Date()): Promise<string> { const header = base64url({ alg: "ES256", kid: credentials.keyId, typ: "JWT" }); const payload = base64url({ iss: credentials.issuerId, aud: "appstoreconnect-v1", exp: Math.floor(now.getTime() / 1000) + 1_000 }); const signingInput = `${header}.${payload}`; const key = await validateAscPrivateKey(credentials.privateKeyPath); const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }); return `${signingInput}.${signature.toString("base64url")}`; }
export class AppStoreConnectClient {
  constructor(private readonly credentials: AscCredentials, private readonly fetcher: FetchLike = fetch as unknown as FetchLike, private readonly timeoutMs = 10_000, private readonly assetTimeoutMs = 120_000) {}
  async get(pathOrUrl: string): Promise<unknown> { const first = await this.request("GET", pathOrUrl, undefined, true); const pages = [first]; let next = nextLink(first); for (let count = 0; next && count < 20; count++) { pages.push(await this.request("GET", next, undefined, true)); next = nextLink(pages[pages.length - 1]); } if (next) throw new Error("App Store Connect pagination exceeded the 20-page safety limit."); if (pages.length === 1) return first; return { ...first, data: dedupeResources(pages.flatMap(dataOf)), included: dedupeResources(pages.flatMap(includedOf)) }; }
  async post(pathOrUrl: string, body: unknown): Promise<unknown> { return this.request("POST", pathOrUrl, body, false); }
  async patch(pathOrUrl: string, body: unknown): Promise<unknown> { return this.request("PATCH", pathOrUrl, body, false); }
  async delete(pathOrUrl: string): Promise<void> { await this.request("DELETE", pathOrUrl, undefined, false); }
  async uploadAsset(operations: unknown, bytes: Buffer): Promise<void> {
    if (!Array.isArray(operations) || !operations.length) throw new Error("App Store Connect returned no asset upload operations; the reservation was not committed.");
    const normalized = operations.map((operation, index) => normalizeUploadOperation(operation, index, bytes.length)).sort((left, right) => left.offset - right.offset);
    let cursor = 0;
    for (const operation of normalized) { if (operation.offset !== cursor) throw new Error("App Store Connect returned overlapping or incomplete asset byte ranges; the reservation was not committed."); cursor += operation.length; }
    if (cursor !== bytes.length) throw new Error("App Store Connect asset byte ranges do not cover the complete file; the reservation was not committed.");
    for (const operation of normalized) {
      let uploaded = false; let lastStatus = 0;
      for (let attempt = 0; attempt < 3 && !uploaded; attempt++) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.assetTimeoutMs);
        try { const response = await this.fetcher(operation.url, { method: "PUT", headers: operation.headers, body: bytes.subarray(operation.offset, operation.offset + operation.length) as unknown as BodyInit, signal: controller.signal }); lastStatus = response.status; uploaded = response.ok; if (!uploaded && response.status !== 429 && response.status < 500) break; }
        catch { /* A PUT of one fixed byte range is idempotent; Apple explicitly permits resending failed parts. */ }
        finally { clearTimeout(timer); }
        if (!uploaded && attempt < 2) await delay(100 * (attempt + 1));
      }
      if (!uploaded) throw new Error(`App Store Connect asset upload failed${lastStatus ? ` (${lastStatus})` : ""}; the reservation was not committed. Partial remote changes may have occurred.`);
    }
  }
  private async request(method: "GET" | "POST" | "PATCH" | "DELETE", pathOrUrl: string, body: unknown, retryReads: boolean): Promise<Record<string, unknown>> {
    const url = safeAscUrl(pathOrUrl); const attempts = retryReads ? 3 : 1; let lastError = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const token = await createJwt(this.credentials);
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await this.fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
        const responseBody = await response.text();
        if (!response.ok) {
          lastError = `App Store Connect ${method === "GET" ? "read" : "mutation"} failed (${response.status}): ${redact(responseBody)}`;
          if (!retryReads || (response.status !== 429 && response.status < 500)) throw new Error(`${lastError}${method === "GET" ? "" : " Partial remote changes may have occurred."}`);
          const retryAfter = Number(response.headers?.get("retry-after") || ""); await delay(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 2_000) : 100 * (attempt + 1)); continue;
        }
        try { return responseBody ? JSON.parse(responseBody) as Record<string, unknown> : {}; }
        catch { throw new Error(`App Store Connect returned invalid JSON.${method === "GET" ? " No changes were made." : " Partial remote changes may have occurred."}`); }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") lastError = `App Store Connect request timed out; ${method === "GET" ? "no changes were made" : "partial remote changes may have occurred"}.`;
        else if (error instanceof Error) { lastError = redact(error.message); if (!retryReads || !/\(429\)|\(5\d\d\)/.test(lastError)) throw new Error(lastError); }
        if (attempt < attempts - 1) await delay(100 * (attempt + 1));
      } finally { clearTimeout(timer); }
    }
    throw new Error(lastError || `App Store Connect request failed; ${method === "GET" ? "no changes were made" : "partial remote changes may have occurred"}.`);
  }
  async discover(bundleId: string, selection: DiscoverySelection = {}): Promise<RemoteDiscovery> {
    const appResponse = await this.get(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`) as { data?: Array<{ id: string }> };
    const appId = appResponse.data?.[0]?.id;
    if (!appId) return emptyDiscovery();
    const [appInfosResponse, versionsResponse, inAppPurchases, subscriptionGroupsResponse, categoryResponse, buildResponse] = await Promise.all([
      this.get(`/apps/${appId}/appInfos?limit=200`), this.get(`/apps/${appId}/appStoreVersions?limit=200`), this.get(`/apps/${appId}/inAppPurchasesV2?limit=200`), this.get(`/apps/${appId}/subscriptionGroups?limit=200`), this.get("/appCategories?exists[parent]=false&filter[platforms]=IOS&limit=200"), selection.build ? this.get(`/builds?filter[app]=${encodeURIComponent(appId)}&filter[version]=${encodeURIComponent(selection.build)}&filter[preReleaseVersion.platform]=IOS${selection.version ? `&filter[preReleaseVersion.version]=${encodeURIComponent(selection.version)}` : ""}&include=preReleaseVersion&limit=200`) : Promise.resolve({ data: [] })
    ]);
    const allAppInfos = dataOf(appInfosResponse) as AscResource[];
    const allVersions = dataOf(versionsResponse);
    const allIosVersions = allVersions.filter((value) => attribute(value, "platform") === "IOS") as AscResource[];
    const versions = selection.version ? allIosVersions.filter((value) => attribute(value, "versionString") === selection.version) : allIosVersions;
    const appInfos = targetAppInfos(allAppInfos, versions as AscResource[]);
    const appInfoId = idOf(appInfos[0]);
    // Do not inspect an arbitrary version when a requested version is absent.
    const versionId = idOf(versions[0]);
    const [appInfoLocalizations, versionLocalizations, reviewDetails, selectedBuildResponse, primaryCategories, secondaryCategories] = await Promise.all([
      appInfoId ? this.get(`/appInfos/${appInfoId}/appInfoLocalizations?limit=200`).then(dataOf) : Promise.resolve([]),
      versionId ? this.get(`/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`).then(dataOf) : Promise.resolve([]),
      versionId ? this.get(`/appStoreVersions/${versionId}/appStoreReviewDetail`).then(dataOf) : Promise.resolve([]),
      versionId ? this.get(`/appStoreVersions/${versionId}/build`) : Promise.resolve({}),
      appInfoId ? this.get(`/appInfos/${appInfoId}/relationships/primaryCategory`).then(dataOf) : Promise.resolve([]),
      appInfoId ? this.get(`/appInfos/${appInfoId}/relationships/secondaryCategory`).then(dataOf) : Promise.resolve([])
    ]);
    const selectedBuilds = dataOf(selectedBuildResponse);
    const builds = dataOf(buildResponse);
    const screenshotSetResponses = await Promise.all(versionLocalizations.map(async (localization) => { const localizationId = idOf(localization); const response = localizationId ? await this.get(`/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=200`) : {}; return { localizationId: localizationId || "", sets: dataOf(response) as AscResource[] }; }));
    const screenshotGroups = (await Promise.all(screenshotSetResponses.flatMap(({ localizationId, sets }) => sets.map(async (set) => { const setId = idOf(set); const response = setId ? await this.get(`/appScreenshotSets/${setId}/appScreenshots?limit=50`) : {}; return { localizationId, set, screenshots: dataOf(response) as AscResource[] }; }))));
    const screenshotSets = screenshotGroups.map((group) => group.set);
    const screenshots = screenshotGroups.flatMap((group) => group.screenshots);
    const subscriptionGroups = dataOf(subscriptionGroupsResponse);
    const subscriptionResponses = await Promise.all(subscriptionGroups.map((group) => idOf(group) ? this.get(`/subscriptionGroups/${idOf(group)}/subscriptions?limit=200`) : Promise.resolve({})));
    return { appId, app: appResponse.data?.[0], appInfos: appInfos as AscResource[], appInfoLocalizations: appInfoLocalizations as AscResource[], allIosVersions, versions: versions as AscResource[], versionLocalizations: versionLocalizations as AscResource[], builds: builds as AscResource[], selectedBuilds: selectedBuilds as AscResource[], reviewDetails: reviewDetails as AscResource[], screenshotSets, screenshots, screenshotGroups, categories: dataOf(categoryResponse) as AscResource[], primaryCategories: primaryCategories as AscResource[], secondaryCategories: secondaryCategories as AscResource[], inAppPurchases: dataOf(inAppPurchases) as AscResource[], subscriptionGroups: subscriptionGroups as AscResource[], subscriptions: subscriptionResponses.flatMap(dataOf) as AscResource[] };
  }
}
export function dataOf(value: unknown): unknown[] { const data = (value as { data?: unknown })?.data; return Array.isArray(data) ? data : data && typeof data === "object" ? [data] : []; }
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
export function idOf(value: unknown): string | undefined { return typeof (value as { id?: unknown })?.id === "string" ? (value as { id: string }).id : undefined; }
export function attribute(value: unknown, key: string): unknown { return (value as { attributes?: Record<string, unknown> })?.attributes?.[key]; }
export function relationshipId(value: unknown, key: string): string | undefined { const data = (value as AscResource)?.relationships?.[key]?.data; return !Array.isArray(data) && data ? idOf(data) : undefined; }
function emptyDiscovery(): RemoteDiscovery { return { appInfos: [], appInfoLocalizations: [], allIosVersions: [], versions: [], versionLocalizations: [], builds: [], selectedBuilds: [], reviewDetails: [], screenshotSets: [], screenshots: [], screenshotGroups: [], categories: [], primaryCategories: [], secondaryCategories: [], inAppPurchases: [], subscriptionGroups: [], subscriptions: [] }; }
function targetAppInfos(appInfos: AscResource[], versions: AscResource[]): AscResource[] { if (!versions.length) return []; const state = versionState(versions[0]); const exact = state ? appInfos.filter((resource) => appInfoState(resource) === state) : []; if (exact.length === 1) return exact; const editable = appInfos.filter((resource) => EDITABLE_APP_STATES.has(appInfoState(resource) || "")); return editable.length === 1 ? editable : []; }
const EDITABLE_APP_STATES = new Set(["PREPARE_FOR_SUBMISSION", "INVALID_BINARY", "DEVELOPER_REJECTED", "METADATA_REJECTED", "REJECTED"]);
function versionState(resource: AscResource | undefined): string | undefined { const value = attribute(resource, "appVersionState") ?? attribute(resource, "appStoreState"); return typeof value === "string" ? value : undefined; }
function appInfoState(resource: AscResource): string | undefined { const value = attribute(resource, "appStoreState") ?? attribute(resource, "state"); return typeof value === "string" ? value : undefined; }
function base64url(value: object): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function redact(input: string): string { return input.replace(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, "[REDACTED KEY]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]").replace(/("[^"\\]*(?:password|token|secret|privateKey)[^"\\]*"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\s]+)/gi, '$1"[REDACTED]"').replace(/((?:token|secret|password|signature)=[^\s&]*)/gi, (match) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`).slice(0, 600); }
function normalizeUploadOperation(value: unknown, index: number, fileSize: number): { url: string; offset: number; length: number; headers: Record<string, string> } {
  const item = value as { method?: unknown; url?: unknown; offset?: unknown; length?: unknown; requestHeaders?: unknown };
  if (item.method !== "PUT" || typeof item.url !== "string" || !Number.isInteger(item.offset) || !Number.isInteger(item.length)) throw new Error(`App Store Connect returned an invalid asset upload operation at index ${index}.`);
  const url = new URL(item.url); if (url.protocol !== "https:" || url.username || url.password) throw new Error("App Store Connect returned an unsafe asset upload URL.");
  const offset = item.offset as number; const length = item.length as number;
  if (offset < 0 || length <= 0 || offset + length > fileSize) throw new Error("App Store Connect returned an out-of-range asset upload operation.");
  if (!Array.isArray(item.requestHeaders)) throw new Error("App Store Connect returned invalid asset upload headers.");
  const headers: Record<string, string> = {};
  for (const header of item.requestHeaders as Array<{ name?: unknown; value?: unknown }>) {
    if (typeof header.name !== "string" || typeof header.value !== "string" || /[\r\n]/.test(header.name + header.value) || /^(authorization|cookie|host)$/i.test(header.name)) throw new Error("App Store Connect returned an unsafe asset upload header.");
    headers[header.name] = header.value;
  }
  return { url: url.toString(), offset, length, headers };
}

export async function appStorePlan(manifest: ShipLayerManifest, remote = false, environment: NodeJS.ProcessEnv = process.env, fetcher?: FetchLike): Promise<AscPlan> {
  const operations = baseOperations(manifest); const credentials = credentialsFromEnvironment(manifest, environment);
  if (!remote) return { mode: "offline", operations, credentialsPresent: Boolean(credentials), warnings: ["Offline dry-run: no App Store Connect request was made.", "Initial app record creation, agreements, banking/tax/trader declarations, privacy/legal confirmation, and final submission are human-controlled."] };
  if (!credentials) return { mode: "remote", operations, credentialsPresent: false, warnings: ["Remote discovery was requested but credentials are unavailable. No request was made."] };
  const discovery = await new AppStoreConnectClient(credentials, fetcher).discover(manifest.app.bundleId, { version: manifest.app.version, build: manifest.app.build });
  const warnings = [`Remote discovery completed for ${discovery.appId || "no matching app"}. This command performed reads only.`, "Use `shiplayer plan --remote` for the precise change set. App Store Connect writes require sync.mode: apply plus the explicit apply confirmation flags."];
  if (!discovery.appId) operations.unshift({ id: "manual.create-app-record", action: "manual", resource: "Apps", description: "Create the initial app record in App Store Connect UI, then add app.appStoreAppId.", safety: "manual", status: "unsupported" });
  else if (manifest.app.appStoreAppId && manifest.app.appStoreAppId !== discovery.appId) { warnings.push(`Discovered app ID ${discovery.appId} disagrees with manifest appStoreAppId ${manifest.app.appStoreAppId}. No comparison was accepted.`); }
  else for (const operation of operations) if (operation.resource === "App identity") operation.status = "already-matches";
  if (manifest.app.version && !discovery.versions.length) warnings.push(`Requested iOS version ${manifest.app.version} was not discovered; an explicitly authorized apply can create it.`);
  if (manifest.app.build && !discovery.builds.length) warnings.push(`Requested build ${manifest.app.build} was not discovered; apply will remain blocked until that build is processed and App Store eligible.`);
  return { mode: "remote", operations, credentialsPresent: true, warnings };
}
function baseOperations(manifest: ShipLayerManifest): AscOperation[] { const operations: AscOperation[] = [
  { id: "read.app", action: "read", resource: "App identity", description: `Discover app with bundle ID ${manifest.app.bundleId || "MISSING"}.`, safety: "read-only", status: "planned" },
  { id: "read.metadata", action: "read", resource: "App metadata/localizations", description: "Read current metadata so a remote plan can calculate exact differences.", safety: "read-only", status: "planned" },
  { id: "read.build", action: "read", resource: "Build", description: `Locate requested build ${manifest.app.build || "MISSING"} for version ${manifest.app.version || "MISSING"}.`, safety: "read-only", status: "planned" },
  { id: "apply.metadata", action: "update", resource: "Version, metadata, review details and build", description: "After a remote preview and explicit authorization, create/update the version, localizations, URLs, categories, review details, and selected build.", safety: "requires-apply", status: "planned" },
  { id: "apply.screenshots", action: "upload", resource: "Screenshots", description: "After a remote preview and explicit authorization, reconcile reviewed local screenshot decks by checksum and order.", safety: "requires-apply", status: "planned" },
  { id: "manual.privacy-compliance", action: "manual", resource: "App Privacy and compliance", description: "Human completes App Privacy, age rating, content rights, trader, legal, agreement, tax/banking and support-page checks in App Store Connect. v0.1 cannot perform declarations.", safety: "manual", status: "unsupported" },
  { id: "submit.final", action: "submit", resource: "Review submission", description: "Select the approved build and submit only after an explicit final command and human confirmation.", safety: "requires-submit", status: "unsupported" }
]; if (manifest.monetization.type === "subscriptions") operations.splice(3, 0, { id: "read.subscriptions", action: "read", resource: "Subscription group/products", description: "Read subscription groups/products. A human configures pricing, availability, localizations, review assets, paywall, restore and disclosures.", safety: "read-only", status: "planned" }, { id: "manual.subscriptions", action: "manual", resource: "Subscription configuration", description: "Configure subscription groups/products, pricing, availability, localizations, review assets, paywall, restore path and terms manually, then attach the first subscription to the app-version review submission. v0.1 performs no StoreKit writes.", safety: "manual", status: "unsupported" }); else if (manifest.monetization.type === "non-consumables") operations.splice(3, 0, { id: "read.iap", action: "read", resource: "In-App Purchases", description: "Read In-App Purchase product discovery. A human verifies prices, localizations, and review assets.", safety: "read-only", status: "planned" }, { id: "manual.iap", action: "manual", resource: "In-App Purchase configuration", description: "Configure price, availability, localization, review assets, paywall and restore manually, then attach the first IAP to the app-version review submission. v0.1 performs no StoreKit writes.", safety: "manual", status: "unsupported" }); return operations; }
