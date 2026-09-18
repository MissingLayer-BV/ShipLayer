// Regression tests for issue #21: source.insecure-endpoint scanned raw source (so a URL inside a
// `//`/`/* */` comment — e.g. a doc comment describing a local Wrangler dev-proxy flag — blocked
// exactly like a real production HTTP endpoint), treated loopback/private addresses as a
// transport-security risk, and had no override mechanism at all (sourceContradictionOverrides
// resolved exactly three ids, none of them this one).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeRepository } from "../src/scanner.js";
import { preflight } from "../src/preflight.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

// --- comments stripped, loopback/private exempt, overridable -----------------------------------

test("a commented-out http:// URL does not trigger source.insecure-endpoint (or even become an endpoint finding)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-insecure-comment-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "App/Support"), { recursive: true });
  await writeFile(path.join(root, "App/Support/Dev.swift"), "/// Debug builds may point at a local proxy: `http://127.0.0.1:8788/api`.\n/// Do not confuse with the real remote host in a comment: http://insecure.example.com/api\nenum Dev {}\n");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("source.insecure-endpoint.")).length, 0);
  const analysis = await analyzeRepository(root);
  assert.equal(analysis.findings.filter((item) => item.key.startsWith("endpoint:")).length, 0);
});

test("a live uncommented http:// URL to a public host still blocks source.insecure-endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-insecure-live-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Dev.swift"), "let endpoint = \"http://insecure.example.com/api\"\n");
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "source.insecure-endpoint.endpoint:http://insecure.example.com/api" && item.severity === "block"));
});

test("a live http://127.0.0.1 endpoint (loopback) does not trigger source.insecure-endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-insecure-loopback-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Dev.swift"), "let endpoint = \"http://127.0.0.1:8788/api/quran-foundation\"\n");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("source.insecure-endpoint.")).length, 0);
});

test("a live http:// to an RFC1918 private address does not trigger source.insecure-endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-insecure-private-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Dev.swift"), "let endpoint = \"http://192.168.1.50:8080/api\"\n");
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("source.insecure-endpoint.")).length, 0);
});

test("a live http:// to a public host that merely looks private-ish (e.g. 172.32.x.x, outside 172.16-31/12) still blocks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-insecure-notprivate-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Dev.swift"), "let endpoint = \"http://172.32.1.1/api\"\n");
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "source.insecure-endpoint.endpoint:http://172.32.1.1/api" && item.severity === "block"));
});

test("a confirmed sourceContradictionOverride downgrades source.insecure-endpoint to a warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-insecure-override-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Dev.swift"), "let endpoint = \"http://insecure.example.com/api\"\n");
  const findingId = "source.insecure-endpoint.endpoint:http://insecure.example.com/api";
  manifest.sourceContradictionOverrides.push({ finding: findingId, reason: "Sandbox-only integration-test fixture host; never reached from a release build.", evidence: ["Sources/Dev.swift"], confirmation: "confirmed" });
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === findingId && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === findingId && item.severity === "warn"));
});

test("an insecure-endpoint override citing an unrelated file does not clear the block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-insecure-override-unrelated-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Dev.swift"), "let endpoint = \"http://insecure.example.com/api\"\n");
  await writeFile(path.join(root, "NOTES.md"), "Not evidence for anything.\n");
  const findingId = "source.insecure-endpoint.endpoint:http://insecure.example.com/api";
  manifest.sourceContradictionOverrides.push({ finding: findingId, reason: "This does not actually address the flagged file.", evidence: ["NOTES.md"], confirmation: "confirmed" });
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === findingId && item.severity === "block"));
});

// --- stripCodeComments correctness on TS/JS evidence (the bug this fix would otherwise introduce) --

test("a single-quoted TypeScript https URL is detected, not truncated at its own '//' by comment stripping", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ts-singlequote-"));
  await writeFile(path.join(root, "project.yml"), "name: WorkerApp\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.workerapp\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    ITSAppUsesNonExemptEncryption: false\n");
  await mkdir(path.join(root, "worker"), { recursive: true });
  await writeFile(path.join(root, "worker/index.ts"), "fetch('https://api.example.com/v1/data')\n");
  const analysis = await analyzeRepository(root);
  assert.ok(analysis.findings.some((item) => item.key === "endpoint:https://api.example.com/v1/data"));
});

test("a template-literal TypeScript https URL is detected, not truncated at its own '//' by comment stripping", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ts-backtick-"));
  await writeFile(path.join(root, "project.yml"), "name: WorkerApp\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.workerapp2\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    ITSAppUsesNonExemptEncryption: false\n");
  await mkdir(path.join(root, "worker"), { recursive: true });
  await writeFile(path.join(root, "worker/index.ts"), "fetch(`https://api.example.com/v1/data`)\n");
  const analysis = await analyzeRepository(root);
  assert.ok(analysis.findings.some((item) => item.key === "endpoint:https://api.example.com/v1/data"));
});

test("a real // line comment before a single-quoted URL on the same file is still stripped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ts-realcomment-"));
  await writeFile(path.join(root, "project.yml"), "name: WorkerApp\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.workerapp3\n    MARKETING_VERSION: \"1.0\"\n    CURRENT_PROJECT_VERSION: \"1\"\n    IPHONEOS_DEPLOYMENT_TARGET: \"17.0\"\n    TARGETED_DEVICE_FAMILY: \"1\"\n    ITSAppUsesNonExemptEncryption: false\n");
  await mkdir(path.join(root, "worker"), { recursive: true });
  await writeFile(path.join(root, "worker/index.ts"), "// legacy, unused: fetch('http://insecure.example.com/old')\nfetch('https://api.example.com/v1/data')\n");
  const analysis = await analyzeRepository(root);
  const endpointKeys = analysis.findings.filter((item) => item.key.startsWith("endpoint:")).map((item) => item.key);
  assert.ok(endpointKeys.includes("endpoint:https://api.example.com/v1/data"));
  assert.ok(!endpointKeys.includes("endpoint:http://insecure.example.com/old"));
});
