import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyAppStoreChanges, planAppStoreChanges } from "../src/asc-apply.js";
import type { FetchLike } from "../src/asc.js";
import type { ShipLayerManifest } from "../src/types.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

const emptyReviewedPlan = { mode: "remote" as const, operations: [], credentialsPresent: true, warnings: [] };
async function applyReviewed(root: string, manifest: ShipLayerManifest, environment: NodeJS.ProcessEnv, fetcher: FetchLike) { const reviewedPlan = await planAppStoreChanges(root, manifest, environment, fetcher); return applyAppStoreChanges(root, manifest, { environment, fetcher, reviewedPlan, userConfirmed: true }); }

async function fixture(): Promise<{ root: string; environment: NodeJS.ProcessEnv; privateKeyPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-asc-apply-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }); const privateKeyPath = path.join(root, "AuthKey_TEST.p8"); await writeFile(privateKeyPath, key);
  return { root, privateKeyPath, environment: { APP_STORE_CONNECT_KEY_ID: "kid", APP_STORE_CONNECT_ISSUER_ID: "issuer", APP_STORE_CONNECT_PRIVATE_KEY_PATH: privateKeyPath } };
}

function discoveryBody(url: string): object | undefined {
  if (url.includes("/apps?")) return { data: [{ type: "apps", id: "1234567890", attributes: { bundleId: "com.example.app" } }] };
  if (url.includes("/apps/1234567890/appInfos")) return { data: [{ type: "appInfos", id: "info", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } }] };
  if (url.includes("/apps/1234567890/appStoreVersions")) return { data: [{ type: "appStoreVersions", id: "version", attributes: { platform: "IOS", versionString: "1.0", copyright: "2025 Old", releaseType: "MANUAL", appStoreState: "PREPARE_FOR_SUBMISSION" } }] };
  if (url.includes("/apps/1234567890/inAppPurchasesV2") || url.includes("/apps/1234567890/subscriptionGroups")) return { data: [] };
  if (url.includes("/appCategories?")) return { data: [{ type: "appCategories", id: "PRODUCTIVITY" }, { type: "appCategories", id: "BUSINESS" }] };
  if (url.includes("/builds?")) return { data: [{ type: "builds", id: "build", attributes: { version: "1", processingState: "VALID", expired: false } }] };
  if (url.includes("/appInfos/info/appInfoLocalizations")) return { data: [] };
  if (url.includes("/appStoreVersions/version/appStoreVersionLocalizations")) return { data: [] };
  if (url.includes("/appStoreVersions/version/appStoreReviewDetail")) return { data: null };
  if (url.includes("/appStoreVersions/version/build")) return { data: null };
  if (url.includes("/appInfos/info/relationships/primaryCategory")) return { data: { type: "appCategories", id: "BUSINESS" } };
  if (url.includes("/appInfos/info/relationships/secondaryCategory")) return { data: null };
  return undefined;
}

test("remote App Store Connect change plan performs GET requests only", async () => {
  const { root, environment } = await fixture(); const manifest = readyManifest(); const calls: Array<{ url: string; method: string }> = [];
  const fetcher: FetchLike = async (url, init) => { const method = init?.method || "GET"; calls.push({ url, method }); const body = discoveryBody(url); assert.ok(body, `unexpected request ${method} ${url}`); return { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
  const plan = await planAppStoreChanges(root, manifest, environment, fetcher);
  assert.equal(plan.credentialsPresent, true); assert.ok(plan.operations.some((operation) => operation.id === "version.update" && operation.status === "planned"));
  assert.ok(plan.operations.some((operation) => operation.id === "screenshots.iphone.en-US.set" && operation.action === "create")); assert.ok(plan.operations.some((operation) => operation.id === "screenshots.iphone.en-US.upload.1" && operation.action === "upload" && operation.description.includes("home.png")));
  assert.ok(calls.length > 0); assert.deepEqual(new Set(calls.map((call) => call.method)), new Set(["GET"])); assert.ok(calls.some((call) => call.url.includes("/appStoreReviewDetail"))); assert.ok(!calls.some((call) => call.url.includes("appStoreVersionAppReviewDetail")));
});

test("apply implementation rejects dry-run manifests before any network request", async () => {
  const { root, environment } = await fixture(); const manifest = readyManifest(); let calls = 0;
  await assert.rejects(() => applyAppStoreChanges(root, manifest, { environment, reviewedPlan: emptyReviewedPlan, userConfirmed: true, fetcher: async () => { calls++; return json({}, 200); } }), /sync.mode: apply/);
  assert.equal(calls, 0);
});

test("apply performs no mutation when remote prerequisites are unsafe", async (context) => {
  for (const blocked of ["missing-app-info", "missing-build", "non-editable-version"] as const) await context.test(blocked, async () => {
    const { root, environment } = await fixture(); const manifest = readyManifest(); manifest.sync.mode = "apply"; const methods: string[] = [];
    const fetcher: FetchLike = async (url, init) => {
      const method = init?.method || "GET"; methods.push(method); assert.equal(method, "GET");
      if (blocked === "missing-app-info" && url.includes("/apps/1234567890/appInfos")) return json({ data: [] }, 200);
      if (blocked === "missing-build" && url.includes("/builds?")) return json({ data: [] }, 200);
      if (blocked === "non-editable-version" && url.includes("/apps/1234567890/appStoreVersions")) return json({ data: [{ type: "appStoreVersions", id: "version", attributes: { platform: "IOS", versionString: "1.0", appStoreState: "READY_FOR_REVIEW" } }] }, 200);
      const body = discoveryBody(url); assert.ok(body, `unexpected request ${method} ${url}`); return json(body, 200);
    };
    await assert.rejects(() => applyReviewed(root, manifest, environment, fetcher), /no changes were made|No changes were made/);
    assert.deepEqual(new Set(methods), new Set(["GET"]));
  });
});

test("scheduled release and missing explicit confirmation are rejected before network access", async () => {
  const { root, environment } = await fixture(); const manifest = readyManifest(); manifest.sync.mode = "apply"; let calls = 0;
  const fetcher: FetchLike = async () => { calls++; return json({}, 200); };
  await assert.rejects(() => applyAppStoreChanges(root, manifest, { environment, fetcher, reviewedPlan: emptyReviewedPlan, userConfirmed: false as true }), /explicit user confirmation/);
  manifest.app.releaseMode = "scheduled";
  await assert.rejects(() => applyAppStoreChanges(root, manifest, { environment, fetcher, reviewedPlan: emptyReviewedPlan, userConfirmed: true }), /Scheduled release/);
  assert.equal(calls, 0);
});

test("apply stops without mutation when the remote diff changes after review", async () => {
  const { root, environment } = await fixture(); const manifest = readyManifest(); manifest.sync.mode = "apply"; let discoveryRound = 0; const methods: string[] = [];
  const fetcher: FetchLike = async (url, init) => {
    const method = init?.method || "GET"; methods.push(method); assert.equal(method, "GET");
    if (url.includes("/apps?")) { discoveryRound++; return json({ data: [{ type: "apps", id: "1234567890", attributes: { bundleId: "com.example.app" } }] }, 200); }
    if (url.includes("/apps/1234567890/appStoreVersions")) return json({ data: [{ type: "appStoreVersions", id: "version", attributes: { platform: "IOS", versionString: "1.0", copyright: discoveryRound === 1 ? "2025 Old" : "2026 Example", releaseType: "MANUAL", appStoreState: "PREPARE_FOR_SUBMISSION" } }] }, 200);
    const body = discoveryBody(url); assert.ok(body, `unexpected request ${method} ${url}`); return json(body, 200);
  };
  await assert.rejects(() => applyReviewed(root, manifest, environment, fetcher), /changed after the reviewed preview/);
  assert.deepEqual(new Set(methods), new Set(["GET"]));
});

test("explicit apply synchronizes metadata, review details, build, and screenshot upload without sending JWT to the asset host", async () => {
  const { root, environment } = await fixture(); const manifest = readyManifest(); manifest.sync.mode = "apply";
  manifest.metadata.localizations["en-US"] = { ...manifest.metadata.localizations["en-US"], promotionalText: "A localized promotion", supportUrl: "https://example.com/en/support", marketingUrl: "https://example.com/en", privacyPolicyUrl: "https://example.com/en/privacy" };
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetcher: FetchLike = async (url, init) => {
    const method = init?.method || "GET"; const headers = (init?.headers || {}) as Record<string, string>; let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body); calls.push({ url, method, headers, body });
    if (url.startsWith("https://upload.example.test/")) { assert.equal(method, "PUT"); assert.equal(headers.Authorization, undefined); assert.equal(headers["Content-Type"], "image/png"); return { ok: true, status: 200, text: async () => "" }; }
    assert.match(headers.Authorization || "", /^Bearer /);
    if (method === "GET") {
      const discovered = discoveryBody(url); if (discovered) return { ok: true, status: 200, text: async () => JSON.stringify(discovered) };
      if (url.includes("/appScreenshots/screenshot")) return { ok: true, status: 200, text: async () => JSON.stringify({ data: { type: "appScreenshots", id: "screenshot", attributes: { assetDeliveryState: { state: "COMPLETE", errors: [] } } } }) };
    }
    if (method === "POST" && url.endsWith("/appInfoLocalizations")) return json({ data: { type: "appInfoLocalizations", id: "app-locale", attributes: { locale: "en-US" } } }, 201);
    if (method === "POST" && url.endsWith("/appStoreVersionLocalizations")) return json({ data: { type: "appStoreVersionLocalizations", id: "version-locale", attributes: { locale: "en-US" } } }, 201);
    if (method === "POST" && url.endsWith("/appStoreReviewDetails")) return json({ data: { type: "appStoreReviewDetails", id: "review" } }, 201);
    if (method === "POST" && url.endsWith("/appScreenshotSets")) return json({ data: { type: "appScreenshotSets", id: "set", attributes: { screenshotDisplayType: "APP_IPHONE_67" } } }, 201);
    if (method === "POST" && url.endsWith("/appScreenshots")) {
      const size = Number((body as { data: { attributes: { fileSize: number } } }).data.attributes.fileSize);
      return json({ data: { type: "appScreenshots", id: "screenshot", attributes: { uploadOperations: [{ method: "PUT", url: "https://upload.example.test/object?signature=secret", offset: 0, length: size, requestHeaders: [{ name: "Content-Type", value: "image/png" }] }] } } }, 201);
    }
    if (method === "PATCH" || method === "DELETE") return json({}, 204);
    assert.fail(`unexpected request ${method} ${url}`);
  };
  const result = await applyReviewed(root, manifest, environment, fetcher);
  assert.equal(result.applied, true); assert.ok(result.operations.some((operation) => operation.id === "build.attach" && operation.status === "applied")); assert.ok(result.operations.some((operation) => operation.id === "screenshots.iphone.en-US" && operation.status === "applied"));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/appStoreVersions/version/relationships/build")));
  const set = calls.find((call) => call.method === "POST" && call.url.endsWith("/appScreenshotSets")); assert.equal((set?.body as { data: { attributes: { screenshotDisplayType: string } } }).data.attributes.screenshotDisplayType, "APP_IPHONE_67");
  const appLocalization = calls.find((call) => call.method === "POST" && call.url.endsWith("/appInfoLocalizations"));
  assert.equal((appLocalization?.body as { data: { attributes: { privacyPolicyUrl: string } } }).data.attributes.privacyPolicyUrl, "https://example.com/en/privacy");
  const versionLocalization = calls.find((call) => call.method === "POST" && call.url.endsWith("/appStoreVersionLocalizations"));
  assert.deepEqual((versionLocalization?.body as { data: { attributes: Record<string, string> } }).data.attributes, { locale: "en-US", description: "A complete App Store description.", keywords: "example", marketingUrl: "https://example.com/en", promotionalText: "A localized promotion", supportUrl: "https://example.com/en/support" });
  const commit = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/appScreenshots/screenshot")); assert.match((commit?.body as { data: { attributes: { sourceFileChecksum: string } } }).data.attributes.sourceFileChecksum, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(calls.map((call) => ({ method: call.method, url: call.url, body: call.body }))).includes("BEGIN PRIVATE"));
});

test("apply creates a missing version, rediscovers its editable App Info, and never edits the live App Info", async () => {
  const { root, environment } = await fixture(); const manifest = readyManifest(); manifest.sync.mode = "apply"; let created = false; const calls: Array<{ url: string; method: string }> = [];
  const fetcher: FetchLike = async (url, init) => {
    const method = init?.method || "GET"; calls.push({ url, method });
    if (url.startsWith("https://upload.example.test/")) return { ok: true, status: 200, text: async () => "" };
    if (method === "GET") {
      if (url.includes("/apps?")) return json({ data: [{ type: "apps", id: "1234567890", attributes: { bundleId: "com.example.app" } }] }, 200);
      if (url.includes("/apps/1234567890/appInfos")) return json({ data: created ? [{ type: "appInfos", id: "live-info", attributes: { appStoreState: "READY_FOR_DISTRIBUTION" } }, { type: "appInfos", id: "draft-info", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } }] : [{ type: "appInfos", id: "live-info", attributes: { appStoreState: "READY_FOR_DISTRIBUTION" } }] }, 200);
      if (url.includes("/apps/1234567890/appStoreVersions")) return json({ data: created ? [{ type: "appStoreVersions", id: "version", attributes: { platform: "IOS", versionString: "1.0", copyright: "2026 Example", releaseType: "MANUAL", appStoreState: "PREPARE_FOR_SUBMISSION" } }] : [] }, 200);
      if (url.includes("/apps/1234567890/inAppPurchasesV2") || url.includes("/apps/1234567890/subscriptionGroups")) return json({ data: [] }, 200);
      if (url.includes("/appCategories?")) return json({ data: [{ type: "appCategories", id: "PRODUCTIVITY" }] }, 200);
      if (url.includes("/builds?")) return json({ data: [{ type: "builds", id: "build", attributes: { version: "1", processingState: "VALID", expired: false } }] }, 200);
      if (url.includes("/appInfos/draft-info/appInfoLocalizations") || url.includes("/appStoreVersions/version/appStoreVersionLocalizations")) return json({ data: [] }, 200);
      if (url.includes("/appInfos/draft-info/relationships/primaryCategory") || url.includes("/appInfos/draft-info/relationships/secondaryCategory") || url.includes("/appStoreVersions/version/appStoreReviewDetail") || url.includes("/appStoreVersions/version/build")) return json({ data: null }, 200);
      if (url.includes("/appScreenshots/screenshot")) return json({ data: { type: "appScreenshots", id: "screenshot", attributes: { assetDeliveryState: { state: "COMPLETE" } } } }, 200);
    }
    if (method === "POST" && url.endsWith("/appStoreVersions")) { created = true; return json({ data: { type: "appStoreVersions", id: "version" } }, 201); }
    if (method === "POST" && url.endsWith("/appInfoLocalizations")) return json({ data: { type: "appInfoLocalizations", id: "app-locale", attributes: { locale: "en-US" } } }, 201);
    if (method === "POST" && url.endsWith("/appStoreVersionLocalizations")) return json({ data: { type: "appStoreVersionLocalizations", id: "version-locale", attributes: { locale: "en-US" } } }, 201);
    if (method === "POST" && url.endsWith("/appStoreReviewDetails")) return json({ data: { type: "appStoreReviewDetails", id: "review" } }, 201);
    if (method === "POST" && url.endsWith("/appScreenshotSets")) return json({ data: { type: "appScreenshotSets", id: "set" } }, 201);
    if (method === "POST" && url.endsWith("/appScreenshots")) { const size = Number(JSON.parse(init?.body as string).data.attributes.fileSize); return json({ data: { type: "appScreenshots", id: "screenshot", attributes: { uploadOperations: [{ method: "PUT", url: "https://upload.example.test/object", offset: 0, length: size, requestHeaders: [] }] } } }, 201); }
    if (method === "PATCH" || method === "DELETE") return json({}, 204);
    assert.fail(`unexpected request ${method} ${url}`);
  };
  await applyReviewed(root, manifest, environment, fetcher);
  const createIndex = calls.findIndex((call) => call.method === "POST" && call.url.endsWith("/appStoreVersions")); const draftReadIndex = calls.findIndex((call) => call.url.includes("/appInfos/draft-info/appInfoLocalizations"));
  assert.ok(createIndex >= 0 && draftReadIndex > createIndex); assert.ok(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/appInfos/draft-info"))); assert.ok(!calls.some((call) => call.url.includes("/appInfos/live-info/") || call.url.endsWith("/appInfos/live-info")));
});

test("apply corrects screenshot order without uploading or deleting matching assets", async () => {
  const { root, environment } = await fixture(); const manifest = readyManifest(); manifest.sync.mode = "apply";
  manifest.screenshots.scenarios.push({ id: "search", title: "Search", steps: ["Open search"], confirmation: "confirmed" });
  const screenshotDirectory = path.join(root, manifest.screenshots.rawOutputDir, "iphone", "en-US");
  await writeFile(path.join(screenshotDirectory, "search.png"), png(1320, 2868));
  const homeChecksum = createHash("md5").update(await readFile(path.join(screenshotDirectory, "home.png"))).digest("hex");
  const searchChecksum = createHash("md5").update(await readFile(path.join(screenshotDirectory, "search.png"))).digest("hex");
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetcher: FetchLike = async (url, init) => {
    const method = init?.method || "GET"; const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined; calls.push({ url, method, body });
    if (method === "GET") {
      if (url.includes("/apps/1234567890/appStoreVersions")) return json({ data: [{ type: "appStoreVersions", id: "version", attributes: { platform: "IOS", versionString: "1.0", copyright: "2026 Example", releaseType: "MANUAL", appStoreState: "PREPARE_FOR_SUBMISSION" } }] }, 200);
      if (url.includes("/appInfos/info/appInfoLocalizations")) return json({ data: [{ type: "appInfoLocalizations", id: "app-locale", attributes: { locale: "en-US", name: "Example", privacyPolicyUrl: "https://example.com/privacy" } }] }, 200);
      if (url.includes("/appStoreVersions/version/appStoreVersionLocalizations")) return json({ data: [{ type: "appStoreVersionLocalizations", id: "version-locale", attributes: { locale: "en-US", description: "A complete App Store description.", keywords: "example", supportUrl: "https://example.com/support" } }] }, 200);
      if (url.includes("/appStoreVersionLocalizations/version-locale/appScreenshotSets")) return json({ data: [{ type: "appScreenshotSets", id: "set", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }] }, 200);
      if (url.includes("/appScreenshotSets/set/appScreenshots")) return json({ data: [{ type: "appScreenshots", id: "search", attributes: { fileName: "search.png", sourceFileChecksum: searchChecksum } }, { type: "appScreenshots", id: "home", attributes: { fileName: "home.png", sourceFileChecksum: homeChecksum } }] }, 200);
      if (url.includes("/appInfos/info/relationships/primaryCategory")) return json({ data: { type: "appCategories", id: "PRODUCTIVITY" } }, 200);
      if (url.includes("/appStoreVersions/version/build")) return json({ data: { type: "builds", id: "build" } }, 200);
      const discovered = discoveryBody(url); if (discovered) return json(discovered, 200);
    }
    if (method === "POST" && url.endsWith("/appStoreReviewDetails")) return json({ data: { type: "appStoreReviewDetails", id: "review" } }, 201);
    if (method === "PATCH") return json({}, 204);
    assert.fail(`unexpected request ${method} ${url}`);
  };
  const result = await applyReviewed(root, manifest, environment, fetcher);
  assert.ok(result.operations.some((operation) => operation.id === "screenshots.iphone.en-US" && operation.status === "applied"));
  assert.ok(!calls.some((call) => call.method === "POST" && call.url.endsWith("/appScreenshots")));
  assert.ok(!calls.some((call) => call.method === "DELETE"));
  const reorder = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/appScreenshotSets/set/relationships/appScreenshots"));
  assert.deepEqual((reorder?.body as { data: Array<{ id: string }> }).data.map((item) => item.id), ["home", "search"]);
});

function json(body: object, status: number): { ok: boolean; status: number; text(): Promise<string> } { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }; }
