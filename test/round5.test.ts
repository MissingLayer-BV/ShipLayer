import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository, findValue } from "../src/scanner.js";
import { preflight } from "../src/preflight.js";
import { writeManifest } from "../src/manifest.js";
import { readManifest } from "../src/manifest.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

test("round-5 rejects reserved nested output and keeps a custom package deterministic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-round5-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeFile(path.join(root, "App.swift"), "import SwiftUI\n");
  const report = await preflight(root, manifest); const firstAnalysis = await analyzeRepository(root);
  await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "safe/.git/evil"), /reserved/); await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "safe/.GIT/evil"), /reserved/); await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "Shiplayer-Release"), /reserved/);
  await assert.rejects(() => generateReleasePackage(root, manifest, firstAnalysis, report, "RELEASE"), /reserved|collides/);
  manifest.screenshots.finalOutputDir = "safe output/screenshots/final";
  await generateReleasePackage(root, manifest, firstAnalysis, report, "safe output");
  const secondAnalysis = await analyzeRepository(root); const secondReport = await preflight(root, manifest);
  manifest.screenshots.finalOutputDir = "safe output/screenshots/final";
  await generateReleasePackage(root, manifest, secondAnalysis, secondReport, "safe output");
  const packageReport = await readFile(path.join(root, "safe output/reports/analysis.json"), "utf8");
  assert.ok(!packageReport.includes("filesScanned")); assert.ok(!packageReport.includes("entriesVisited"));
  assert.match(await readFile(path.join(root, "safe output/legal/privacy-policy-draft.html"), "utf8"), /<\/main><\/body><\/html>$/);
  assert.match(await readFile(path.join(root, "safe output/legal/support-page-draft.html"), "utf8"), /<\/main><\/body><\/html>$/);
});

test("round-6 default CLI prepare allows canonical output but rejects case-aliased source control", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-default-output-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "prepare", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.ok(run.stdout.includes("shiplayer-release")); assert.ok(await readFile(path.join(root, "shiplayer-release/.shiplayer-managed"), "utf8"));
});

test("round-5 accepts an explicitly confirmed Icon Composer asset without a raster catalog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-icon-composer-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await rm(path.join(root, "Assets.xcassets"), { recursive: true, force: true }); await mkdir(path.join(root, "Assets/App.icon/artwork"), { recursive: true }); await writeFile(path.join(root, "Assets/App.icon/icon.json"), "{\"version\":1}"); await writeFile(path.join(root, "Assets/App.icon/artwork/icon.png"), "Icon Composer fixture");
  manifest.app.productionIconAsset = "Assets/App.icon"; manifest.app.productionIconAssetConfirmation = "confirmed";
  const report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id.startsWith("assets.app-icon") && item.severity === "block").length, 0); assert.ok(report.results.some((item) => item.id === "assets.icon-composer" && item.severity === "pass"));
});

test("round-5 keeps harmless source links and oversized binary assets out of source scan blockers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-walker-round5-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await symlink(path.join(root, "README-target.md"), path.join(root, "README-LINK.md")); await writeFile(path.join(root, "README-target.md"), "readme");
  await writeFile(path.join(root, "large.bin"), Buffer.alloc(1_000_001));
  const report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id === "source.scan-coverage" && item.severity === "block").length, 0);
});

test("round-6 accepts valid landscape iPhone and iPad App Review screenshots", async () => {
  const phoneRoot = await mkdtemp(path.join(tmpdir(), "shiplayer-landscape-phone-")); const phone = readyManifest("non-consumables"); await writeReadyAssets(phoneRoot, phone); await writeFile(path.join(phoneRoot, "review/unlock.png"), png(2868, 1320));
  let report = await preflight(phoneRoot, phone); assert.ok(report.results.some((item) => item.id === "purchase.com.example.unlock.asset" && item.severity === "pass"));
  const padRoot = await mkdtemp(path.join(tmpdir(), "shiplayer-landscape-pad-")); const pad = readyManifest("non-consumables"); pad.app.deviceFamilies = ["ipad"]; pad.screenshots.configurations = [{ device: "iPad", family: "ipad", locale: "en-US", requiredDimensions: { width: 2064, height: 2752 } }]; await writeReadyAssets(padRoot, pad); await mkdir(path.join(padRoot, "release/raw-screenshots/ipad/en-US"), { recursive: true }); await writeFile(path.join(padRoot, "release/raw-screenshots/ipad/en-US/home.png"), png(2064, 2752)); await writeFile(path.join(padRoot, "review/unlock.png"), png(2752, 2064));
  report = await preflight(padRoot, pad); assert.ok(report.results.some((item) => item.id === "purchase.com.example.unlock.asset" && item.severity === "pass"));
});

test("round-6 blocks unparsed privacy manifests and encryption/copyright contradictions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-privacy-round6-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "PrivacyInfo.xcprivacy"), "<dict><key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeMystery</string></dict>"); await writeFile(path.join(root, "Info.plist"), "<key>ITSAppUsesNonExemptEncryption</key><true/>"); manifest.contacts.copyright = "x";
  const report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id === "privacy.manifest.unparsed" && item.severity === "block")); assert.ok(report.results.some((item) => item.id === "consistency.encryption" && item.severity === "block")); assert.ok(report.results.some((item) => item.id === "contacts.copyright.format" && item.severity === "block"));
});

test("round-6 accepts an Xcode universal iOS icon slot and scans Worker endpoints but ignores generated web output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-worker-round6-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Assets.xcassets/AppIcon.appiconset/Contents.json"), JSON.stringify({ images: [{ filename: "icon.png", idiom: "universal", platform: "ios", size: "1024x1024" }] })); await mkdir(path.join(root, "worker"), { recursive: true }); await writeFile(path.join(root, "worker/index.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')"); await mkdir(path.join(root, "design/.next/cache"), { recursive: true }); await writeFile(path.join(root, "design/.next/cache/chunk.js"), "fetch('https://ignore.example')");
  const report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("openrouter.ai") && item.severity === "block")); assert.equal(report.results.filter((item) => item.id.includes("ignore.example")).length, 0); assert.equal(report.results.filter((item) => item.id.startsWith("assets.app-icon") && item.severity === "block").length, 0);
});

test("round-7 treats first-party runtime JS/TS as coverage but ignores generated screenshot/editor tooling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-scope-round7-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), Buffer.alloc(1_000_001)); await symlink(path.join(root, "worker.ts"), path.join(root, "linked-worker.ts"));
  let report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id === "source.scan-coverage" && item.severity === "block"));
  await rm(path.join(root, "worker.ts")); await rm(path.join(root, "linked-worker.ts")); await mkdir(path.join(root, "worker/src"), { recursive: true }); await writeFile(path.join(root, "worker/src/index.ts"), "fetch('https://openrouter.ai/api/v1/chat/completions')"); await writeFile(path.join(root, "worker/src/pages.ts"), "const copy = 'StoreKit Photos Sentry';"); await mkdir(path.join(root, "worker/.wrangler-dry-run"), { recursive: true }); await writeFile(path.join(root, "worker/.wrangler-dry-run/index.js"), "fetch('https://generated.example')"); await mkdir(path.join(root, "design/app-store-screenshots"), { recursive: true }); await writeFile(path.join(root, "design/app-store-screenshots/next-env.d.ts"), "type X = 'https://nextjs.org/docs'");
  const analysis = await analyzeRepository(root); const endpointValues = analysis.findings.filter((item) => item.key.startsWith("endpoint:")).flatMap((item) => Array.isArray(item.value) ? item.value : [item.value]); assert.ok(endpointValues.some((value) => String(value).includes("openrouter.ai"))); assert.ok(!endpointValues.some((value) => String(value).includes("generated.example") || String(value).includes("nextjs.org"))); assert.equal(analysis.findings.filter((item) => item.key === "framework:StoreKit" || item.key === "thirdPartySdkCandidate:Sentry").length, 0);
});

test("round-7 requires a separate evidence-backed disposition for every endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-endpoints-round7-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeFile(path.join(root, "worker.ts"), "fetch('https://api.example.test/one'); fetch('https://links.example.test/privacy')");
  manifest.externalServiceDecisions = [{ finding: "endpoint:https://api.example.test/one", disposition: "not-an-external-processor", reason: "Public fixture endpoint.", evidence: ["worker.ts"], confirmation: "confirmed" }];
  let report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("links.example.test") && item.severity === "block"));
  manifest.externalServiceDecisions.push({ finding: "endpoint:https://links.example.test/privacy", disposition: "not-an-external-processor", reason: "Public privacy link.", evidence: ["worker.ts"], confirmation: "confirmed" }); report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id.startsWith("source.external.") && item.severity === "block").length, 0);
});

test("round-7 init maps TARGETED_DEVICE_FAMILY tokens without inventing iPhone support", async () => {
  for (const [value, expected] of [["1", ["iphone"]], ["2", ["ipad"]], ["1,2", ["iphone", "ipad"]]] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-init-family-")); await writeFile(path.join(root, "project.yml"), `name: Family\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.family\n    TARGETED_DEVICE_FAMILY: ${value}\n`);
    const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); const manifest = await readManifest(root); assert.deepEqual(manifest.app.deviceFamilies, expected); assert.deepEqual(manifest.screenshots.configurations.map((item) => item.family), expected);
  }
});

test("round-7 detects runtime sidecar extensions and insecure HTTP endpoints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-runtime-round7-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeFile(path.join(root, "sidecar.mts"), "fetch('HTTP://api.example.test/v1')"); const report = await preflight(root, manifest); assert.ok(report.results.some((item) => item.id.includes("insecure-endpoint") && item.severity === "block"));
});

test("round-8 blocks skipped symlinked source directories but not clearly test-only directory links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-symlink-tree-round8-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const outside = await mkdtemp(path.join(tmpdir(), "shiplayer-outside-source-round8-")); await writeFile(path.join(outside, "Worker.ts"), "fetch('https://external.example.test/v1')"); await symlink(outside, path.join(root, "Sources"));
  let report = await preflight(root, manifest); assert.equal(report.canSubmit, false); assert.ok(report.results.some((item) => item.id === "source.scan-coverage" && item.severity === "block"));
  await rm(path.join(root, "Sources")); await symlink(outside, path.join(root, "ExampleUITests")); await writeFile(path.join(root, "ExampleTests.swift"), "// test fixture");
  report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id === "source.scan-coverage" && item.severity === "block").length, 0);
});

test("round-8 redacts URL credentials and handles static and dynamic template endpoints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-endpoint-redaction-round8-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const sentinel = "SUPERSECRET123456789";
  await writeFile(path.join(root, "worker.ts"), `fetch(\"https://user:${sentinel}@api.example.test/webhook/${sentinel}?api_key=${sentinel}&user=can#private\"); fetch(\"https://[invalid]/${sentinel}?token=${sentinel}\"); const a = \`https://static.example.test/v1\`; const b = \`https://dynamic.example.test/v1/\${42}\`;`);
  manifest.screenshots.finalOutputDir = "release-redaction/screenshots/final";
  const analysis = await analyzeRepository(root); const report = await preflight(root, manifest); const generated = await generateReleasePackage(root, manifest, analysis, report, "release-redaction");
  const renderedPackage = await Promise.all(generated.files.map((file) => readFile(path.join(generated.directory, file), "utf8")));
  const rendered = [JSON.stringify(analysis), JSON.stringify(report), ...renderedPackage].join("\n");
  assert.equal(rendered.includes(sentinel), false); assert.equal(rendered.includes("#private"), false); assert.equal(rendered.includes("user:"), false);
  const endpointKeys = analysis.findings.filter((item) => item.key.startsWith("endpoint:")).map((item) => item.key); assert.ok(endpointKeys.includes("endpoint:https://api.example.test/webhook/:redacted?api_key&user")); assert.ok(endpointKeys.includes("endpoint:https://static.example.test/v1")); assert.ok(endpointKeys.includes("endpoint:https://dynamic.example.test/v1/")); assert.equal(endpointKeys.some((key) => key.includes("%60") || key.includes("%7B") || key.includes("invalid")), false); assert.ok(analysis.unresolvedQuestions.some((item) => item.includes("dynamic endpoint expression"))); assert.ok(analysis.unresolvedQuestions.some((item) => item.includes("malformed HTTP(S) endpoint")));
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "analyze", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.includes(sentinel), false);
});

test("round-8 reads release identity, encryption, and purpose strings from a plain Xcode xcconfig", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-xcconfig-round8-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await rm(path.join(root, "project.yml")); await mkdir(path.join(root, "Example.xcodeproj"));
  await writeFile(path.join(root, "Example.xcodeproj/project.pbxproj"), "GENERATE_INFOPLIST_FILE = YES;\nINFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;\n");
  await writeFile(path.join(root, "Release.xcconfig"), "PRODUCT_BUNDLE_IDENTIFIER = com.example.app\nMARKETING_VERSION = 1.0\nCURRENT_PROJECT_VERSION = 1\nIPHONEOS_DEPLOYMENT_TARGET = 17.0\nTARGETED_DEVICE_FAMILY = 1\nINFOPLIST_KEY_NSCameraUsageDescription = \"Scan a receipt\"\n");
  manifest.permissions = [{ key: "NSCameraUsageDescription", purpose: "Scan a receipt", confirmation: "confirmed", evidence: ["Release.xcconfig"] }];
  const report = await preflight(root, manifest); assert.equal(report.summary.block, 0); assert.ok(report.results.some((item) => item.id === "consistency.encryption" && item.severity === "pass")); assert.ok(report.results.some((item) => item.id === "source.permission.NSCameraUsageDescription.evidence" && item.severity === "pass"));
});

test("round-8 excludes test and screenshot-tooling omissions from production source coverage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-exclusions-round8-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest); await mkdir(path.join(root, "ExampleTests")); await writeFile(path.join(root, "ExampleTests/large.ts"), Buffer.alloc(1_000_001)); await mkdir(path.join(root, "design/app-store-screenshots"), { recursive: true }); await writeFile(path.join(root, "design/app-store-screenshots/editor.ts"), Buffer.alloc(1_000_001));
  const outside = await mkdtemp(path.join(tmpdir(), "shiplayer-test-link-round8-")); await writeFile(path.join(outside, "fixture.ts"), "test only"); await symlink(outside, path.join(root, "ExampleUITests"));
  const report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id === "source.scan-coverage" && item.severity === "block").length, 0);
});

test("round-9 does not infer Xcode settings from runtime copy and selects release configuration evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-config-round9-")); const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "worker.ts"), "// PRODUCT_BUNDLE_IDENTIFIER = com.unrelated.docs; MARKETING_VERSION = 999; CURRENT_PROJECT_VERSION = 999; IPHONEOS_DEPLOYMENT_TARGET = 99; TARGETED_DEVICE_FAMILY = 2; INFOPLIST_KEY_NSCameraUsageDescription = 'docs'; INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = YES;"); await writeFile(path.join(root, "Debug.xcconfig"), "// PRODUCT_BUNDLE_IDENTIFIER = com.fake.comment\nPRODUCT_BUNDLE_IDENTIFIER = com.example.app.debug // debug build\nMARKETING_VERSION = 999\n"); await writeFile(path.join(root, "Release.xcconfig"), "// PRODUCT_BUNDLE_IDENTIFIER = com.fake.comment\nPRODUCT_BUNDLE_IDENTIFIER = com.example.app // release build\nMARKETING_VERSION = 1.0 // release\nCURRENT_PROJECT_VERSION = 1\nIPHONEOS_DEPLOYMENT_TARGET = 17.0\nTARGETED_DEVICE_FAMILY = 1\nINFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO\n");
  let analysis = await analyzeRepository(root); assert.equal(analysis.findings.some((item) => String(item.value).includes("com.unrelated.docs") || String(item.value).includes("com.fake.comment") || item.key === "permission:NSCameraUsageDescription"), false); assert.equal(analysis.findings.some((item) => item.key === "secondaryBundleId"), false); assert.equal(findValue(analysis, "bundleId"), "com.example.app"); let report = await preflight(root, manifest); assert.equal(report.results.filter((item) => item.id === "source.contradiction" && item.severity === "block").length, 0);
  await rm(path.join(root, "project.yml")); await mkdir(path.join(root, "Example.xcodeproj")); await writeFile(path.join(root, "Example.xcodeproj/project.pbxproj"), `/* Debug */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = com.example.app.debug;\n    MARKETING_VERSION = 999;\n  };\n  name = Debug;\n};\n/* Release */ = {\n  isa = XCBuildConfiguration;\n  buildSettings = {\n    PRODUCT_BUNDLE_IDENTIFIER = com.example.app;\n    MARKETING_VERSION = 1.0;\n    CURRENT_PROJECT_VERSION = 1;\n    IPHONEOS_DEPLOYMENT_TARGET = 17.0;\n    TARGETED_DEVICE_FAMILY = 1;\n    INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;\n  };\n  name = Release;\n};\n`);
  analysis = await analyzeRepository(root); assert.equal(analysis.findings.some((item) => item.key === "secondaryBundleId"), false); assert.equal(analysis.contradictions.some((item) => item.includes("com.example.app.debug")), false); report = await preflight(root, manifest); assert.equal(report.summary.block, 0);
});

test("round-10 structurally selects XcodeGen release settings without hiding real target bundles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-xcodegen-round10-")); const manifest = readyManifest(); manifest.app.version = "2.0"; manifest.app.build = "2"; manifest.app.deploymentTarget = "17.0"; await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "project.yml"), `name: Example
settings:
  configs:
    Debug:
      PRODUCT_BUNDLE_IDENTIFIER: com.example.app.debug
      MARKETING_VERSION: 999
    Release:
      PRODUCT_BUNDLE_IDENTIFIER: com.example.app
      MARKETING_VERSION: 1.0
      CURRENT_PROJECT_VERSION: 1
      IPHONEOS_DEPLOYMENT_TARGET: 16.0
      TARGETED_DEVICE_FAMILY: 1
      ITSAppUsesNonExemptEncryption: false
targets:
  Example:
    type: application
    settings:
      configs:
        Debug:
          PRODUCT_BUNDLE_IDENTIFIER: com.example.app.debug
        Release:
          PRODUCT_BUNDLE_IDENTIFIER: com.example.app
          MARKETING_VERSION: 2.0
          CURRENT_PROJECT_VERSION: 2
          IPHONEOS_DEPLOYMENT_TARGET: 17.0
          TARGETED_DEVICE_FAMILY: 1
  ExampleWidget:
    type: app-extension
    settings:
      configs:
        Debug:
          PRODUCT_BUNDLE_IDENTIFIER: com.example.app.widget.debug
        Release:
          PRODUCT_BUNDLE_IDENTIFIER: com.example.app.widget
          MARKETING_VERSION: 3.0
          CURRENT_PROJECT_VERSION: 3
          IPHONEOS_DEPLOYMENT_TARGET: 18.0
          TARGETED_DEVICE_FAMILY: 1,2
`);
  manifest.secondaryTargetConfirmations = [{ bundleId: "com.example.app.widget", classification: "widget", evidence: ["project.yml"], confirmation: "confirmed" }];
  const analysis = await analyzeRepository(root);
  assert.equal(findValue(analysis, "bundleId"), "com.example.app");
  assert.equal(findValue(analysis, "version"), "2.0"); assert.equal(findValue(analysis, "build"), "2"); assert.equal(findValue(analysis, "deploymentTarget"), "17.0");
  assert.equal(analysis.findings.some((item) => String(item.value).includes("com.example.app.debug")), false);
  assert.equal(analysis.contradictions.some((item) => item.includes("debug") || item.includes("999")), false);
  assert.equal(analysis.contradictions.some((item) => item.includes("1.0") || item.includes("3.0") || item.includes("18.0")), false);
  assert.deepEqual(analysis.findings.find((item) => item.key === "secondaryBundleId")?.value, ["com.example.app.widget"]);
  const report = await preflight(root, manifest);
  assert.equal(report.summary.block, 0);
  assert.equal(report.canSubmit, true);
});

test("round-11 scopes native Xcode extension settings and honors application target overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-pbx-target-round11-")); const manifest = readyManifest(); manifest.app.version = "2.0"; manifest.app.build = "2"; manifest.app.deploymentTarget = "17.0"; await writeReadyAssets(root, manifest); await rm(path.join(root, "project.yml")); await mkdir(path.join(root, "Example.xcodeproj"));
  await writeFile(path.join(root, "Example.xcodeproj/project.pbxproj"), `APPPROJREL /* Release */ = {
  isa = XCBuildConfiguration;
  buildSettings = {
    PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
    MARKETING_VERSION = 1.0;
    CURRENT_PROJECT_VERSION = 1;
    IPHONEOS_DEPLOYMENT_TARGET = 16.0;
    TARGETED_DEVICE_FAMILY = 1;
    INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;
  };
  name = Release;
};
APPRELEASE /* Release */ = {
  isa = XCBuildConfiguration;
  buildSettings = {
    PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
    MARKETING_VERSION = 2.0;
    CURRENT_PROJECT_VERSION = 2;
    IPHONEOS_DEPLOYMENT_TARGET = 17.0;
    TARGETED_DEVICE_FAMILY = 1;
  };
  name = Release;
};
WIDGETREL /* Release */ = {
  isa = XCBuildConfiguration;
  buildSettings = {
    PRODUCT_BUNDLE_IDENTIFIER = com.example.app.widget;
    MARKETING_VERSION = 3.0;
    CURRENT_PROJECT_VERSION = 3;
    IPHONEOS_DEPLOYMENT_TARGET = 18.0;
    TARGETED_DEVICE_FAMILY = 1,2;
  };
  name = Release;
};
PROJECTLIST /* Build configuration list for PBXProject */ = {
  isa = XCConfigurationList;
  buildConfigurations = (APPPROJREL /* Release */);
};
APPLIST01 /* Build configuration list for PBXNativeTarget */ = {
  isa = XCConfigurationList;
  buildConfigurations = (APPRELEASE /* Release */);
};
WIDGETLIST /* Build configuration list for PBXNativeTarget */ = {
  isa = XCConfigurationList;
  buildConfigurations = (WIDGETREL /* Release */);
};
PROJECTOBJ /* Project object */ = {
  isa = PBXProject;
  buildConfigurationList = PROJECTLIST /* Build configuration list */;
};
APPTARGET /* Example */ = {
  isa = PBXNativeTarget;
  buildConfigurationList = APPLIST01 /* Build configuration list */;
  productType = "com.apple.product-type.application";
};
WIDGETTGT /* Example Widget */ = {
  isa = PBXNativeTarget;
  buildConfigurationList = WIDGETLIST /* Build configuration list */;
  productType = "com.apple.product-type.app-extension";
};
`);
  manifest.secondaryTargetConfirmations = [{ bundleId: "com.example.app.widget", classification: "widget", evidence: ["Example.xcodeproj/project.pbxproj"], confirmation: "confirmed" }];
  const analysis = await analyzeRepository(root);
  assert.equal(findValue(analysis, "bundleId"), "com.example.app"); assert.equal(findValue(analysis, "version"), "2.0"); assert.equal(findValue(analysis, "build"), "2"); assert.equal(findValue(analysis, "deploymentTarget"), "17.0"); assert.equal(findValue(analysis, "deviceFamily"), "1");
  assert.equal(analysis.contradictions.length, 0); assert.deepEqual(analysis.findings.find((item) => item.key === "secondaryBundleId")?.value, ["com.example.app.widget"]);
  const report = await preflight(root, manifest); assert.equal(report.summary.block, 0); assert.equal(report.canSubmit, true);
});
