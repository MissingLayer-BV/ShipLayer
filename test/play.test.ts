import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyGooglePlayChanges, planGooglePlayChanges } from "../src/play.js";
import { readPlayManifest } from "../src/play-manifest.js";
import { GooglePlayClient, type PlayFetchLike } from "../src/play-client.js";

function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => body === undefined ? "" : JSON.stringify(body) }; }

async function fixture(mode: "dry-run" | "apply" = "dry-run") {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiplayer-play-"));
  const locale = path.join(root, "build/play-metadata/en-US");
  await mkdir(path.join(locale, "images/phoneScreenshots"), { recursive: true });
  await mkdir(path.join(locale, "changelogs"), { recursive: true });
  await writeFile(path.join(locale, "title.txt"), "Kevser\n");
  await writeFile(path.join(locale, "short_description.txt"), "Daily Quran study\n");
  await writeFile(path.join(locale, "full_description.txt"), "Read, listen and reflect every day.\n");
  await writeFile(path.join(locale, "changelogs/6.txt"), "A refreshed reading experience.\n");
  await writeFile(path.join(locale, "images/phoneScreenshots/01-reader.png"), Buffer.from("reviewed screenshot"));
  await mkdir(path.join(root, "app/build/outputs/bundle/release"), { recursive: true });
  await writeFile(path.join(root, "app/build/outputs/bundle/release/app-release.aab"), Buffer.from("signed aab"));
  await writeFile(path.join(root, "shiplayer-play.yml"), `schemaVersion: 1
packageName: com.example.kevser
metadata:
  directory: build/play-metadata
  confirmation: confirmed
release:
  versionCode: 6
  versionName: "1.3"
  bundle: app/build/outputs/bundle/release/app-release.aab
  track: production
  status: draft
  confirmation: confirmed
sync:
  mode: ${mode}
  serviceAccountJsonEnv: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
`);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const environment = { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "release@example-project.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.googleapis.com/token" }) };
  return { root, environment, manifest: await readPlayManifest(root) };
}

function playApi() {
  let edit = 0; let committed = false; const calls: Array<{ method: string; url: string; body?: unknown; authorization?: string }> = [];
  const fetcher: PlayFetchLike = async (url, init) => {
    const method = init?.method || "GET"; const raw = init?.body; let body: unknown;
    if (typeof raw === "string" && (init?.headers as Record<string, string> | undefined)?.["Content-Type"] === "application/json") body = JSON.parse(raw);
    else if (Buffer.isBuffer(raw)) {
      const contentType = (init?.headers as Record<string, string> | undefined)?.["Content-Type"];
      if (contentType === "application/json") body = JSON.parse(raw.toString("utf8"));
      else body = `<${raw.length} bytes>`;
    }
    calls.push({ method, url, body, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (url === "https://oauth2.googleapis.com/token") return response({ access_token: "access-token", expires_in: 3600 });
    if (method === "POST" && /\/edits$/.test(url)) return response({ id: `edit-${++edit}` });
    if (method === "DELETE" && /\/edits\/edit-\d+$/.test(url)) return response(undefined, 204);
    if (method === "GET" && /\/listings$/.test(url)) return response({ listings: [{ language: "en-US", title: "Old", shortDescription: "Old", fullDescription: "Old" }] });
    if (method === "GET" && /\/listings\/en-US\/phoneScreenshots$/.test(url)) return response({ images: [{ id: "old", sha256: "old" }] });
    if (method === "DELETE" && /\/listings\/en-US\/phoneScreenshots$/.test(url)) return response({ deleted: [{ id: "old" }] });
    if (method === "POST" && url.includes("/upload/androidpublisher/") && url.includes("/phoneScreenshots")) return response({ image: { id: "new" } });
    if (method === "PUT" && /\/listings\/en-US$/.test(url)) return response(body);
    if (method === "GET" && /\/bundles$/.test(url)) return response({ bundles: [] });
    if (method === "POST" && url.includes("/upload/androidpublisher/") && url.includes("/bundles")) return response({ versionCode: 6, sha256: "new" });
    if (method === "GET" && /\/tracks\/production$/.test(url)) return response({ track: "production", releases: [{ name: "1.2", versionCodes: ["5"], status: "completed" }] });
    if (method === "PUT" && /\/tracks\/production$/.test(url)) return response(body);
    if (method === "POST" && url.endsWith(":validate")) return response({ id: "validated" });
    if (method === "POST" && url.endsWith(":commit")) { committed = true; return response({ id: "committed" }); }
    assert.fail(`unexpected Google Play call: ${method} ${url}`);
  };
  return { fetcher, calls, committed: () => committed };
}

test("Google Play preview compares listings, screenshots, bundle, and draft track without committing", async () => {
  const { root, environment, manifest } = await fixture(); const api = playApi();
  const plan = await planGooglePlayChanges(root, manifest, "all", { environment, fetcher: api.fetcher });
  assert.equal(plan.credentialsPresent, true); assert.equal(plan.ephemeralEditDeleted, true);
  assert.deepEqual(plan.operations.map((item) => item.id), ["listing.en-US", "screenshots.en-US.phoneScreenshots", "bundle.6", "track.production.6"]);
  assert.ok(plan.operations.every((item) => item.status === "planned"));
  assert.equal(api.committed(), false);
  assert.ok(api.calls.some((call) => call.method === "POST" && /\/edits$/.test(call.url)));
  assert.ok(api.calls.some((call) => call.method === "DELETE" && /\/edits\/edit-1$/.test(call.url)));
  assert.ok(!api.calls.some((call) => call.method === "PUT" || call.url.endsWith(":validate") || call.url.endsWith(":commit") || call.url.includes("/upload/androidpublisher/")));
  assert.ok(api.calls.filter((call) => call.url !== "https://oauth2.googleapis.com/token").every((call) => call.authorization === "Bearer access-token"));
  assert.ok(!JSON.stringify(api.calls).includes("BEGIN PRIVATE KEY"));
});

test("Google Play accepts a short-lived federated access token without a service-account key", async () => {
  const { root, manifest } = await fixture(); const api = playApi();
  manifest.sync.accessTokenEnv = "GOOGLE_PLAY_ACCESS_TOKEN";
  const plan = await planGooglePlayChanges(root, manifest, "listings", {
    environment: { GOOGLE_PLAY_ACCESS_TOKEN: "federated-access-token-with-safe-length" },
    fetcher: api.fetcher,
  });
  assert.equal(plan.credentialsPresent, true);
  assert.ok(!api.calls.some((call) => call.url === "https://oauth2.googleapis.com/token"));
  assert.ok(api.calls.every((call) => call.authorization === "Bearer federated-access-token-with-safe-length"));
});

test("Google Play rejects malformed federated access tokens before network access", async () => {
  const { root, manifest } = await fixture(); let calls = 0;
  await assert.rejects(() => planGooglePlayChanges(root, manifest, "listings", {
    environment: { GOOGLE_PLAY_ACCESS_TOKEN: "contains whitespace" },
    fetcher: async () => { calls++; return response({}); },
  }), /valid OAuth access token/);
  assert.equal(calls, 0);
});

test("Google Play retries transient failures only for idempotent requests", async () => {
  let calls = 0;
  const fetcher: PlayFetchLike = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, headers: { get: () => "0" }, text: async () => JSON.stringify({ error: { message: "unavailable" } }) };
    return response({ language: "en-US" });
  };
  const client = await GooglePlayClient.connect({ accessToken: "federated-access-token-with-safe-length" }, fetcher);
  await client.updateListing("com.example.kevser", "edit-1", "en-US", { title: "Kevser" });
  assert.equal(calls, 3);

  calls = 0;
  const uploadClient = await GooglePlayClient.connect({ accessToken: "federated-access-token-with-safe-length" }, async () => {
    calls++;
    return { ok: false, status: 503, headers: { get: () => "0" }, text: async () => JSON.stringify({ error: { message: "unavailable" } }) };
  });
  await assert.rejects(() => uploadClient.uploadImage("com.example.kevser", "edit-1", "en-US", "phoneScreenshots", Buffer.from("image"), "image/png"), /503/);
  assert.equal(calls, 1);
});

test("Google Play reconciles an ambiguous screenshot transport failure before retrying upload", async () => {
  const { root, environment, manifest } = await fixture("apply");
  const api = playApi();
  const reviewedPlan = await planGooglePlayChanges(root, manifest, "listings", { environment, fetcher: api.fetcher });
  let screenshotsDeleted = false; let failedUpload = false; let uploadAttempts = 0;
  const fetcher: PlayFetchLike = async (url, init) => {
    const method = init?.method || "GET";
    if (method === "DELETE" && /\/listings\/en-US\/phoneScreenshots$/.test(url)) screenshotsDeleted = true;
    if (screenshotsDeleted && method === "GET" && /\/listings\/en-US\/phoneScreenshots$/.test(url)) return response({ images: [] });
    if (screenshotsDeleted && method === "POST" && url.includes("/phoneScreenshots")) {
      uploadAttempts++;
      if (!failedUpload) { failedUpload = true; throw new TypeError("fetch failed"); }
    }
    return api.fetcher(url, init);
  };
  const result = await applyGooglePlayChanges(root, manifest, "listings", { environment, fetcher, userConfirmed: true, reviewedPlan });
  assert.equal(result.committed, true);
  assert.equal(uploadAttempts, 2);
});

test("Google Play apply requires both manifest and CLI gates before network access", async () => {
  const { root, environment, manifest } = await fixture("dry-run"); let calls = 0;
  const fetcher: PlayFetchLike = async () => { calls++; return response({}); };
  const reviewedPlan = { mode: "remote-preview" as const, packageName: manifest.packageName, scope: "listings" as const, operations: [], credentialsPresent: true, warnings: [], ephemeralEditDeleted: true };
  await assert.rejects(() => applyGooglePlayChanges(root, manifest, "listings", { environment, fetcher, userConfirmed: true, reviewedPlan }), /sync.mode is dry-run/);
  manifest.sync.mode = "apply";
  await assert.rejects(() => applyGooglePlayChanges(root, manifest, "listings", { environment, fetcher, userConfirmed: false, reviewedPlan }), /explicit user confirmation/);
  assert.equal(calls, 0);
});

test("Google Play apply validates and commits reviewed listing, screenshots, bundle, and production draft", async () => {
  const { root, environment, manifest } = await fixture("apply"); const api = playApi();
  const reviewedPlan = await planGooglePlayChanges(root, manifest, "all", { environment, fetcher: api.fetcher });
  const result = await applyGooglePlayChanges(root, manifest, "all", { environment, fetcher: api.fetcher, userConfirmed: true, reviewedPlan });
  assert.equal(result.applied, true); assert.equal(result.committed, true); assert.equal(api.committed(), true);
  assert.ok(result.operations.every((item) => item.status === "applied"));
  const listing = api.calls.find((call) => call.method === "PUT" && /\/listings\/en-US$/.test(call.url));
  assert.deepEqual(listing?.body, { language: "en-US", title: "Kevser", shortDescription: "Daily Quran study", fullDescription: "Read, listen and reflect every day." });
  const track = api.calls.find((call) => call.method === "PUT" && /\/tracks\/production$/.test(call.url));
  const releases = (track?.body as { releases: Array<Record<string, unknown>> }).releases;
  assert.deepEqual(releases.at(-1), { name: "1.3", versionCodes: ["6"], releaseNotes: [{ language: "en-US", text: "A refreshed reading experience." }], status: "draft" });
  assert.ok(api.calls.some((call) => call.url.endsWith(":validate")));
  assert.ok(api.calls.some((call) => call.url.endsWith(":commit")));
});

test("Google Play manifest refuses a completed production rollout", async () => {
  const { root } = await fixture();
  const file = path.join(root, "shiplayer-play.yml");
  const current = await import("node:fs/promises").then(({ readFile }) => readFile(file, "utf8"));
  await writeFile(file, current.replace("status: draft", "status: completed"));
  await assert.rejects(() => readPlayManifest(root), /only permits draft production releases/);
});
