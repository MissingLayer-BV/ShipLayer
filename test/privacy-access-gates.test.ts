import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../src/preflight.js";
import { analyzeRepository, findRequiredReasonApiSites } from "../src/scanner.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

function privacyInfo(accessTypes: Array<{ type: string; reasons: string[] }>): string {
  const entries = accessTypes.map(({ type, reasons }) => `    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>${type}</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>${reasons.map((reason) => `<string>${reason}</string>`).join("")}</array>
    </dict>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
${entries}
  </array>
</dict>
</plist>
`;
}

test("required-reason API patterns match live calls, not lookalikes", () => {
  const sites = findRequiredReasonApiSites("let saved = UserDefaults.standard.string(forKey: k)\nlet up = ProcessInfo.processInfo.systemUptime\nlet modes = UITextInputMode.activeInputModes\nFileManager.default.attributesOfItem(atPath: p)\nvolumeAvailableCapacityForImportantUsage(&v)\nif (stat(path, &st) == 0) {}\n");
  assert.deepEqual([...new Set(sites.map((site) => site.category))].sort(), [
    "NSPrivacyAccessedAPICategoryActiveKeyboards",
    "NSPrivacyAccessedAPICategoryDiskSpace",
    "NSPrivacyAccessedAPICategoryFileTimestamp",
    "NSPrivacyAccessedAPICategorySystemBootTime",
    "NSPrivacyAccessedAPICategoryUserDefaults",
  ]);
  assert.equal(findRequiredReasonApiSites("event.creationDate = Date()\nlet modified = record.modificationDate\n").length, 0);
});

test("required-reason API use without a privacy-manifest declaration blocks readiness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-access-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "App.swift"), "let saved = UserDefaults.standard.string(forKey: \"lastClaim\")\n");
  const analysis = await analyzeRepository(root);
  assert.ok(analysis.findings.some((finding) => finding.key === "requiredReasonApi:NSPrivacyAccessedAPICategoryUserDefaults"));
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.manifest.access.user-defaults" && item.severity === "block"));
  await writeFile(path.join(root, "PrivacyInfo.xcprivacy"), privacyInfo([{ type: "NSPrivacyAccessedAPICategoryUserDefaults", reasons: ["CA92.1"] }]));
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.manifest.access.user-defaults" && item.severity === "pass"));
});

test("accessed-API declarations without approved reasons stay blocked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-access-reasons-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "App.swift"), "let saved = UserDefaults.standard.string(forKey: \"lastClaim\")\n");
  await writeFile(path.join(root, "PrivacyInfo.xcprivacy"), privacyInfo([{ type: "NSPrivacyAccessedAPICategoryUserDefaults", reasons: [] }]));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.manifest.unparsed" && item.severity === "block"));
  assert.ok(!report.results.some((item) => item.id === "privacy.manifest.access.user-defaults" && item.severity === "pass"));
});

test("commented-out and test-only required-reason API use is not a finding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-access-comment-"));
  await writeFile(path.join(root, "App.swift"), "// let saved = UserDefaults.standard.string(forKey: \"x\")\n/* systemUptime */\n");
  await mkdir(path.join(root, "Tests"), { recursive: true });
  await writeFile(path.join(root, "Tests/WidgetTests.swift"), "let saved = UserDefaults.standard.string(forKey: \"x\")\n");
  const analysis = await analyzeRepository(root);
  assert.ok(!analysis.findings.some((finding) => finding.key.startsWith("requiredReasonApi:")));
});
