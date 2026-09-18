import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { AppStoreConnectClient, createJwt, appStorePlan, validateAscPrivateKey } from "../src/asc.js";
import type { ShipLayerManifest } from "../src/types.js";

async function keyMaterial(): Promise<{ privateKeyPath: string; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] }> { const dir = await mkdtemp(path.join(tmpdir(), "shiplayer-key-")); const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); const privateKeyPath = path.join(dir, "AuthKey_TEST.p8"); await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" })); return { privateKeyPath, publicKey: pair.publicKey }; }
async function keyPath(): Promise<string> { return (await keyMaterial()).privateKeyPath; }
test("JWT uses verifiable ES256 claims and does not expose private key material", async () => {
  const { privateKeyPath, publicKey } = await keyMaterial();
  const token = await createJwt({ issuerId: "issuer", keyId: "kid", privateKeyPath }, new Date("2026-01-01T00:00:00Z"));
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "kid", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), { iss: "issuer", aud: "appstoreconnect-v1", exp: 1767226600 });
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  assert.ok(!token.includes("BEGIN PRIVATE"));
});
test("remote discovery selects IOS version and reads screenshot sets through version localizations", async () => {
  const privateKeyPath = await keyPath(); const paths: string[] = [];
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async (url, init) => {
    paths.push(url); assert.match(String(init?.headers && (init.headers as Record<string, string>).Authorization), /^Bearer /);
    const body = url.includes("/apps?") ? { data: [{ id: "app-id" }] }
      : url.includes("/appStoreVersions?") ? { data: [{ id: "mac", attributes: { platform: "MAC_OS", versionString: "1.0" } }, { id: "old-ios", attributes: { platform: "IOS", versionString: "0.9", appStoreState: "READY_FOR_DISTRIBUTION" } }, { id: "ios", attributes: { platform: "IOS", versionString: "1.0", appStoreState: "PREPARE_FOR_SUBMISSION" } }] }
      : url.includes("/apps/app-id/appInfos") ? { data: [{ id: "live-info", attributes: { appStoreState: "READY_FOR_DISTRIBUTION" } }, { id: "draft-info", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } }] }
      : url.includes("/appStoreVersions/ios/appStoreVersionLocalizations") ? { data: [{ id: "localization" }] }
      : url.includes("/appScreenshotSets/set/appScreenshots") ? { data: [{ id: "image", type: "appScreenshots" }] }
      : url.includes("/appStoreVersionLocalizations/localization/appScreenshotSets") ? { data: [{ id: "set" }] }
      : { data: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  const result = await client.discover("com.example.app", { version: "1.0" });
  assert.equal(result.versions.length, 1); assert.equal(result.allIosVersions.length, 2); assert.equal(result.appInfos[0]?.id, "draft-info"); assert.equal(result.screenshotSets.length, 1); assert.equal(result.screenshots.length, 1); assert.ok(paths.some((item) => item.includes("/appInfos/draft-info/appInfoLocalizations"))); assert.ok(!paths.some((item) => item.includes("/appInfos/live-info/appInfoLocalizations"))); assert.ok(paths.some((item) => item.includes("/appStoreVersionLocalizations/localization/appScreenshotSets"))); assert.ok(!paths.some((item) => item.includes("/appStoreVersions/ios/appScreenshotSets")));
});
test("discovery preserves included pagination, one review-detail objects, and subscription products", async () => {
  const privateKeyPath = await keyPath(); const paths: string[] = [];
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async (url) => {
    paths.push(url);
    const body = url.includes("/apps?") ? { data: [{ id: "app" }] }
      : url.includes("appStoreVersions?") ? { data: [{ id: "version", attributes: { platform: "IOS", versionString: "1.0" } }] }
      : url.includes("/appStoreVersions/version/build") ? { data: { id: "build", attributes: { version: "9" } } }
      : url.includes("appStoreReviewDetail") ? { data: { id: "review-detail" } }
      : url.includes("/builds?") ? { data: [{ id: "build", attributes: { version: "9", processingState: "VALID" } }] }
      : url.includes("subscriptionGroups?") ? { data: [{ id: "group" }] }
      : url.includes("subscriptionGroups/group/subscriptions") ? { data: [{ id: "subscription" }] }
      : url.endsWith("/one") ? { data: [{ id: "second-image", type: "appScreenshots" }] }
      : url.includes("/appScreenshotSets/set/appScreenshots") ? { data: [{ id: "first-image", type: "appScreenshots" }], links: { next: "https://api.appstoreconnect.apple.com/v1/one" } }
      : url.includes("appScreenshotSets") ? { data: [{ id: "set" }] }
      : url.includes("appStoreVersionLocalizations") ? { data: [{ id: "locale" }] } : { data: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  const result = await client.discover("com.example.app", { version: "1.0", build: "9" });
  assert.equal(result.reviewDetails.length, 1); assert.equal(result.subscriptions.length, 1); assert.equal(result.screenshots.length, 2); assert.equal(result.builds.length, 1); assert.ok(paths.some((entry) => entry.includes("subscriptionGroups/group/subscriptions")));
});
test("remote plan reports read-only discovery", async () => { const manifest = parse(await (await import("node:fs/promises")).readFile(path.resolve("fixtures/subscription-shiplayer.yml"), "utf8")) as ShipLayerManifest; const privateKeyPath = await keyPath(); const plan = await appStorePlan(manifest, true, { APP_STORE_CONNECT_KEY_ID: "kid", APP_STORE_CONNECT_ISSUER_ID: "issuer", APP_STORE_CONNECT_PRIVATE_KEY_PATH: privateKeyPath }, async (url) => ({ ok: true, status: 200, text: async () => url.includes("/apps?") ? JSON.stringify({ data: [] }) : JSON.stringify({ data: [] }) })); assert.equal(plan.mode, "remote"); assert.ok(plan.operations.some((item) => item.action === "manual")); });

test("remote plan is explicitly unavailable without credentials", async () => {
  const manifest = parse(await (await import("node:fs/promises")).readFile(path.resolve("fixtures/subscription-shiplayer.yml"), "utf8")) as ShipLayerManifest;
  const plan = await appStorePlan(manifest, true, {});
  assert.equal(plan.credentialsPresent, false); assert.match(plan.warnings.join(" "), /No request was made/);
});

test("ASC client follows bounded official pagination and retries 429 reads", async () => {
  const privateKeyPath = await keyPath(); let calls = 0;
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async (url) => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => "0" }, text: async () => "rate limited" };
    if (url.endsWith("/next")) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "two" }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "one" }], links: { next: "https://api.appstoreconnect.apple.com/v1/next" } }) };
  });
  const response = await client.get("/apps");
  assert.deepEqual((response as { data: Array<{ id: string }> }).data.map((item) => item.id), ["one", "two"]);
  assert.equal(calls, 3);
});

test("ASC errors redact sensitive response text and never write", async () => {
  const privateKeyPath = await keyPath();
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async () => ({ ok: false, status: 400, text: async () => 'password=super-secret Bearer abc.def.ghi {"demoAccountPassword":"json-secret\\"still-secret"}' }));
  await assert.rejects(() => client.get("/apps"), (error: Error) => !error.message.includes("super-secret") && !error.message.includes("abc.def.ghi") && !error.message.includes("json-secret") && !error.message.includes("still-secret"));
});

test("ASC mutations are not retried and report possible partial state", async () => {
  const privateKeyPath = await keyPath(); let calls = 0;
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async () => { calls++; return { ok: false, status: 500, text: async () => "temporary" }; });
  await assert.rejects(() => client.post("/appInfoLocalizations", { data: {} }), /Partial remote changes may have occurred/);
  assert.equal(calls, 1);
});

test("ASC retries idempotent PATCH and DELETE mutations after transient server errors", async () => {
  const privateKeyPath = await keyPath(); const calls: string[] = [];
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async (_url, init) => {
    const method = init?.method || "GET"; calls.push(method);
    const methodCalls = calls.filter((value) => value === method).length;
    if (methodCalls === 1) return { ok: false, status: 500, text: async () => "temporary" };
    return { ok: true, status: 200, text: async () => "{}" };
  });
  await client.patch("/appScreenshotSets/set/relationships/appScreenshots", { data: [] });
  await client.delete("/appScreenshots/image");
  assert.deepEqual(calls, ["PATCH", "PATCH", "DELETE", "DELETE"]);
});

test("ASC treats a repeated idempotent DELETE returning 404 as success", async () => {
  const privateKeyPath = await keyPath(); let calls = 0;
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 500, text: async () => "temporary" }
      : { ok: false, status: 404, text: async () => "already deleted" };
  });
  await client.delete("/appScreenshots/image");
  assert.equal(calls, 2);
});

test("ASC validates complete upload byte ranges before contacting the unsigned asset host", async () => {
  const privateKeyPath = await keyPath(); let calls = 0;
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async () => { calls++; return { ok: true, status: 200, text: async () => "" }; });
  await assert.rejects(() => client.uploadAsset([{ method: "PUT", url: "https://upload.example.test/object", offset: 1, length: 2, requestHeaders: [] }], Buffer.from("abc")), /overlapping or incomplete/);
  await assert.rejects(() => client.uploadAsset([{ method: "PUT", url: "http://upload.example.test/object", offset: 0, length: 3, requestHeaders: [] }], Buffer.from("abc")), /unsafe asset upload URL/);
  assert.equal(calls, 0);
});

test("ASC bounds and retries idempotent asset uploads", async () => {
  const privateKeyPath = await keyPath(); let calls = 0;
  const hangingFetcher = async (_url: string, init?: RequestInit): Promise<never> => await new Promise<never>((_resolve, reject) => { calls++; if (init?.signal?.aborted) { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); return; } init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); });
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, hangingFetcher, 10_000, 1);
  await assert.rejects(() => client.uploadAsset([{ method: "PUT", url: "https://upload.example.test/object", offset: 0, length: 3, requestHeaders: [] }], Buffer.from("abc")), /asset upload failed/);
  assert.equal(calls, 3);
});

test("ASC request timeout is bounded and reports no mutation", async () => {
  const privateKeyPath = await keyPath();
  const hangingFetcher = async (_url: string, init?: RequestInit): Promise<never> => await new Promise<never>((_resolve, reject) => {
    if (init?.signal?.aborted) { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); return; }
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, hangingFetcher, 1);
  await assert.rejects(() => client.get("/apps"), /timed out; no changes were made/);
});

test("ASC never signs or sends a JWT to an untrusted URL and rejects RSA keys", async () => {
  const privateKeyPath = await keyPath(); let calls = 0;
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async () => { calls++; return { ok: true, status: 200, text: async () => "{}" }; });
  await assert.rejects(() => client.get("https://attacker.example/v1/apps"), /official HTTPS/);
  await assert.rejects(() => client.get("https://api.appstoreconnect.apple.com/not-v1"), /official HTTPS/);
  await assert.rejects(() => client.get("https://api.appstoreconnect.apple.com/v2/apps"), /official HTTPS/);
  await assert.rejects(() => client.get("https://attacker.example/v2/inAppPurchases/1"), /official HTTPS/);
  assert.equal(calls, 0);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }); const dir = await mkdtemp(path.join(tmpdir(), "shiplayer-rsa-")); const rsaPath = path.join(dir, "key.pem"); await writeFile(rsaPath, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
  await assert.rejects(() => validateAscPrivateKey(rsaPath), /EC P-256/);
  await assert.rejects(() => createJwt({ issuerId: "issuer", keyId: "kid", privateKeyPath: rsaPath }), /EC P-256/);
});
