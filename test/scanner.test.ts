import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { analyzeRepository, findValue } from "../src/scanner.js";

const fixture = path.resolve("fixtures/SwiftSubscriptionApp");
test("scanner extracts Swift/Xcode evidence without declaring legal truth", async () => {
  const report = await analyzeRepository(fixture);
  assert.equal(findValue(report, "bundleId"), "com.example.receiptloop");
  assert.equal(findValue(report, "version"), "2.3");
  assert.equal(findValue(report, "build"), "42");
  assert.equal(findValue(report, "encryption"), "false");
  assert.ok(report.findings.some((item) => item.key === "permission:NSCameraUsageDescription"));
  assert.ok(report.findings.some((item) => item.key === "storekitProductId"));
  assert.ok(report.unresolvedQuestions.some((item) => item.includes("App Privacy")));
});

test("scanner ignores test bundle identities and records bounded-file omissions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer scanner "));
  await mkdir(path.join(root, "App.xcodeproj"));
  await writeFile(path.join(root, "App.xcodeproj/project.pbxproj"), "PRODUCT_BUNDLE_IDENTIFIER = com.example.app;\nPRODUCT_BUNDLE_IDENTIFIER = com.example.app.Tests;");
  await writeFile(path.join(root, "oversized.swift"), "x".repeat(1_000_001));
  const report = await analyzeRepository(root);
  assert.equal(findValue(report, "bundleId"), "com.example.app");
  assert.ok(report.findings.some((item) => item.key === "testBundleId"));
  assert.equal(report.ignored.filesOverLimit, 1);
  assert.ok(report.unresolvedQuestions.some((item) => item.includes("oversized")));
});
