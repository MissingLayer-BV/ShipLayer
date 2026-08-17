import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { AppStoreConnectClient, createJwt, appStorePlan } from "../src/asc.js";
import type { ShipLayerManifest } from "../src/types.js";

async function keyPath(): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), "shiplayer-key-")); const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); const file = path.join(dir, "AuthKey_TEST.p8"); await writeFile(file, pair.privateKey.export({ type: "pkcs8", format: "pem" })); return file; }
test("JWT uses ES256 and does not expose private key material", async () => { const privateKeyPath = await keyPath(); const token = await createJwt({ issuerId: "issuer", keyId: "kid", privateKeyPath }, new Date("2026-01-01T00:00:00Z")); assert.equal(token.split(".").length, 3); assert.ok(!token.includes("BEGIN PRIVATE")); });
test("remote discovery is read-only and mockable", async () => { const privateKeyPath = await keyPath(); const paths: string[] = []; const client = new AppStoreConnectClient({ issuerId: "issuer", keyId: "kid", privateKeyPath }, async (url, init) => { paths.push(url); assert.match(String(init?.headers && (init.headers as Record<string, string>).Authorization), /^Bearer /); return { ok: true, status: 200, text: async () => url.includes("/apps?") ? JSON.stringify({ data: [{ id: "app-id" }] }) : JSON.stringify({ data: [] }) }; }); const result = await client.discover("com.example.app"); assert.equal(result.appId, "app-id"); assert.equal(paths.length, 6); });
test("remote plan reports read-only discovery", async () => { const manifest = parse(await (await import("node:fs/promises")).readFile(path.resolve("fixtures/subscription-shiplayer.yml"), "utf8")) as ShipLayerManifest; const privateKeyPath = await keyPath(); const plan = await appStorePlan(manifest, true, { APP_STORE_CONNECT_KEY_ID: "kid", APP_STORE_CONNECT_ISSUER_ID: "issuer", APP_STORE_CONNECT_PRIVATE_KEY_PATH: privateKeyPath }, async (url) => ({ ok: true, status: 200, text: async () => url.includes("/apps?") ? JSON.stringify({ data: [] }) : JSON.stringify({ data: [] }) })); assert.equal(plan.mode, "remote"); assert.ok(plan.operations.some((item) => item.action === "manual")); });
