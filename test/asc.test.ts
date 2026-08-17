import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { AppStoreConnectClient, createJwt, appStorePlan } from "../src/asc.js";
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
      : url.includes("/appStoreVersions?") ? { data: [{ id: "mac", attributes: { platform: "MAC_OS", versionString: "1.0" } }, { id: "ios", attributes: { platform: "IOS", versionString: "1.0" } }] }
      : url.includes("/appStoreVersions/ios/appStoreVersionLocalizations") ? { data: [{ id: "localization" }] }
      : url.includes("/appStoreVersionLocalizations/localization/appScreenshotSets") ? { data: [{ id: "set" }] }
      : { data: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  const result = await client.discover("com.example.app", { version: "1.0" });
  assert.equal(result.versions.length, 1); assert.ok(paths.some((item) => item.includes("/appStoreVersionLocalizations/localization/appScreenshotSets"))); assert.ok(!paths.some((item) => item.includes("/appStoreVersions/ios/appScreenshotSets")));
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
  const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async () => ({ ok: false, status: 400, text: async () => "password=super-secret Bearer abc.def.ghi" }));
  await assert.rejects(() => client.get("/apps"), (error: Error) => !error.message.includes("super-secret") && !error.message.includes("abc.def.ghi"));
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
