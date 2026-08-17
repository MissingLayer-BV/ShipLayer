import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
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
