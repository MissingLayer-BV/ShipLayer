import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { detectScreenshotHarness } from "../src/scanner.js";
import { isXCUITestSourcePath } from "../src/evidence.js";
import { ingestCaptures } from "../src/capture.js";
import { preflight, isFamilyScreenshotDimensions, acceptedDimensionsForConfig } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { readManifest, writeManifest } from "../src/manifest.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

const HARNESS_SOURCE = `import XCTest

final class SampleUITests: XCTestCase {
    func testEmptyState() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-empty", "--ui-testing-reset"]
        app.launch()
        keepScreenshot(named: "Empty Home")
    }

    func testPopulatedState() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-populated"]
        app.launch()
        keepScreenshot(named: "Populated Home")
    }

    private func keepScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
`;

// Exercises the two launch-argument bugs a round-1 review found: (a) a method with no local
// `.launchArguments = [...]` of its own (launches via a helper) must never inherit an earlier,
// already-closed method's array; (b) a non-literal element in the array must never be silently
// dropped while keeping the rest, because that shifts every later flag/value pair out of place.
const HELPER_HARNESS_SOURCE = `import XCTest

final class HelperUITests: XCTestCase {
    func testViaLiteral() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-empty"]
        app.launch()
        keepScreenshot(named: "Literal Scenario")
    }

    func testViaHelper() {
        let app = launch(storeName: "abc")
        keepScreenshot(named: "Helper Scenario")
    }

    func testMixedLiteralAndComputed() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing-store", storeName, "--ui-testing-reset"]
        app.launch()
        keepScreenshot(named: "Mixed Scenario")
    }

    private func launch(storeName: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        return app
    }

    private func keepScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
`;

test("detectScreenshotHarness extracts scenarios with nearest launch arguments and never fabricates when no harness exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-harness-"));
  await mkdir(path.join(root, "SampleUITests"), { recursive: true });
  await writeFile(path.join(root, "SampleUITests/SampleUITests.swift"), HARNESS_SOURCE);
  await writeFile(path.join(root, "App.swift"), "import SwiftUI\nstruct App {}\n");
  const harness = await detectScreenshotHarness(root);
  assert.equal(harness.sourceFiles.length, 1);
  assert.equal(harness.scenarios.length, 2);
  const empty = harness.scenarios.find((scenario) => scenario.id === "empty-home");
  assert.ok(empty); assert.equal(empty?.launchArgumentsDetermined, true); assert.deepEqual(empty?.launchArguments, ["--ui-testing-empty", "--ui-testing-reset"]); assert.equal(empty?.testFunction, "testEmptyState");
  const populated = harness.scenarios.find((scenario) => scenario.id === "populated-home");
  assert.ok(populated); assert.equal(populated?.launchArgumentsDetermined, true); assert.deepEqual(populated?.launchArguments, ["--ui-testing-populated"]);

  const bare = await mkdtemp(path.join(tmpdir(), "shiplayer-no-harness-"));
  await writeFile(path.join(bare, "App.swift"), "import SwiftUI\nstruct App {}\n");
  const empty2 = await detectScreenshotHarness(bare);
  assert.equal(empty2.scenarios.length, 0); assert.equal(empty2.sourceFiles.length, 0);
});

test("detectScreenshotHarness never attributes another method's launch arguments and never partially drops a non-literal element", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-harness-launch-args-"));
  await mkdir(path.join(root, "HelperUITests"), { recursive: true });
  await writeFile(path.join(root, "HelperUITests/HelperUITests.swift"), HELPER_HARNESS_SOURCE);
  const harness = await detectScreenshotHarness(root);
  assert.equal(harness.scenarios.length, 3);
  const literal = harness.scenarios.find((scenario) => scenario.id === "literal-scenario");
  assert.ok(literal); assert.equal(literal?.launchArgumentsDetermined, true); assert.deepEqual(literal?.launchArguments, ["--ui-testing-empty"]);
  const helper = harness.scenarios.find((scenario) => scenario.id === "helper-scenario");
  assert.ok(helper); assert.equal(helper?.launchArgumentsDetermined, false); assert.deepEqual(helper?.launchArguments, []);
  const mixed = harness.scenarios.find((scenario) => scenario.id === "mixed-scenario");
  assert.ok(mixed); assert.equal(mixed?.launchArgumentsDetermined, false); assert.deepEqual(mixed?.launchArguments, []);
});

// Round-2 review High-1: a Swift string-interpolation element ("\(expr)") is itself
// backslash-escape-shaped and previously PASSED the literal-string test, so it was fabricated
// into the plausible-looking (but wrong) fixed value "(expr)" instead of being treated as
// non-literal. BackYet never exposed this because it only uses the bare-variable form
// ("--ui-testing-store", store), which was already correctly rejected.
const INTERPOLATION_HARNESS_SOURCE = `import XCTest

final class InterpUITests: XCTestCase {
    func testInterpolated() {
        let app = XCUIApplication()
        let storeName = "abc"
        app.launchArguments = ["--ui-testing-store", "\\(storeName)", "--reset"]
        app.launch()
        keepScreenshot(named: "Interpolated Scenario")
    }

    private func keepScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
`;

test("detectScreenshotHarness never fabricates a Swift string-interpolation element into a fixed literal value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-harness-interpolation-"));
  await mkdir(path.join(root, "InterpUITests"), { recursive: true });
  await writeFile(path.join(root, "InterpUITests/InterpUITests.swift"), INTERPOLATION_HARNESS_SOURCE);
  const harness = await detectScreenshotHarness(root);
  assert.equal(harness.scenarios.length, 1);
  const interpolated = harness.scenarios[0];
  assert.equal(interpolated.id, "interpolated-scenario");
  // Must NOT resolve to a fabricated concrete value such as ["--ui-testing-store", "(storeName)", "--reset"].
  assert.equal(interpolated.launchArgumentsDetermined, false);
  assert.deepEqual(interpolated.launchArguments, []);
});

test("isXCUITestSourcePath is scoped to *UITests sources and stays independent from production-evidence predicates", () => {
  assert.equal(isXCUITestSourcePath("SampleUITests/SampleUITests.swift"), true);
  assert.equal(isXCUITestSourcePath("App/Views/Home.swift"), false);
  // A plain unit-test target (not UI tests) must not be treated as a screenshot-harness source.
  assert.equal(isXCUITestSourcePath("SampleTests/SampleTests.swift"), false);
});

test("scanner keeps screenshot-harness detection separate from production privacy/purchase evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-harness-separation-"));
  await mkdir(path.join(root, "SampleUITests"), { recursive: true });
  const mixed = `${HARNESS_SOURCE}\nimport StoreKit\nlet endpoint = "https://api.openai.com/v1/chat/completions"\n`;
  await writeFile(path.join(root, "SampleUITests/SampleUITests.swift"), mixed);
  const analysis = await analyzeRepository(root);
  assert.equal(analysis.findings.some((finding) => finding.key.startsWith("endpoint:") || finding.key === "framework:StoreKit"), false);
  const harness = await detectScreenshotHarness(root);
  assert.equal(harness.scenarios.length, 2);
});

test("init proposes needs-human-confirmation scenarios from a detected harness and never fabricates them without one", async () => {
  const withHarness = await mkdtemp(path.join(tmpdir(), "shiplayer-init-harness-"));
  await mkdir(path.join(withHarness, "SampleUITests"), { recursive: true });
  await writeFile(path.join(withHarness, "SampleUITests/SampleUITests.swift"), HARNESS_SOURCE);
  await writeFile(path.join(withHarness, "project.yml"), "name: Sample\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.sample\n");
  let run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", withHarness, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  let manifest = await readManifest(withHarness);
  assert.equal(manifest.screenshots.scenarios.length, 2);
  assert.ok(manifest.screenshots.scenarios.every((scenario) => scenario.confirmation === "needs-human-confirmation"));
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.detectedScreenshotScenarios, 2);

  const withoutHarness = await mkdtemp(path.join(tmpdir(), "shiplayer-init-no-harness-"));
  await writeFile(path.join(withoutHarness, "project.yml"), "name: Sample\nsettings:\n  base:\n    PRODUCT_BUNDLE_IDENTIFIER: com.example.sample\n");
  run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", withoutHarness, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  manifest = await readManifest(withoutHarness);
  assert.equal(manifest.screenshots.scenarios.length, 0);
  const parsedBare = JSON.parse(run.stdout);
  assert.ok(parsedBare.unresolvedQuestions.some((item: string) => item.includes("No screenshot UI-test harness")));
});

test("preflight blocks a screenshot scenario whose confirmation is absent or anything other than confirmed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-scenario-confirmation-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  let report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("screenshots.scenarios.") && item.severity === "block").length, 0);
  // No confirmation field at all — an absent field is NOT treated as implicitly confirmed:
  // `init` always writes it explicitly, so an absent field only happens by hand-authoring or by
  // deleting the line to dodge review, and either way it must still block.
  manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"] }];
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.scenarios.home.confirmation" && item.severity === "block"));
  manifest.screenshots.scenarios[0].confirmation = "needs-human-confirmation";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.scenarios.home.confirmation" && item.severity === "block"));
  manifest.screenshots.scenarios[0].confirmation = "confirmed";
  report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "screenshots.scenarios.home.confirmation").length, 0);
});

test("preflight accepts any Apple-accepted dimension within the configured display class instead of only the exact configured value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-dimension-fix-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  // requiredDimensions defaults to 1320x2868 (iPhone 16 Pro Max, 6.9-inch); a capture from a
  // different but equally-valid 6.9-inch simulator (iPhone 17 Pro Max/Air, 1260x2736) must not
  // be false-blocked.
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), png(1260, 2736));
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.includes("accepted-dimensions") && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.home.png.dimensions" && item.severity === "pass"));
});

test("preflight rejects a 6.5-inch dimension in a 6.9-inch-configured iPhone slot, even though it is a valid App Store size for a different class", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-display-class-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest); // default config requiredDimensions 1320x2868 (6.9-inch)
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), png(1284, 2778)); // 6.5-inch legacy size
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.home.png.accepted-dimensions" && item.severity === "block"));
});

// Round-2 review Low-4: iPad must be gated by the same STRUCTURAL per-class Set lookup as
// iPhone, not a flat family table that only happens to reject an off-class size today because it
// has nothing else in it. acceptedDimensionsForConfig must do a real key lookup for iPad too, so
// adding an 11-inch class later cannot silently reintroduce the cross-class bug iPhone already
// fixed (see the "6.5-inch dimension in a 6.9-inch-configured slot" test above).
test("acceptedDimensionsForConfig structurally scopes iPad to its own display class, not a flat family table", () => {
  const config13 = { family: "ipad" as const, requiredDimensions: { width: 2064, height: 2752 } };
  const accepted = acceptedDimensionsForConfig(config13);
  assert.ok(accepted.has("2064x2752")); assert.ok(accepted.has("2048x2732"));
  // An 11-inch iPad Pro dimension is a real, valid App Store screenshot size — just not for the
  // 13-inch slot this configuration declares — so it must resolve to a class that rejects it.
  assert.equal(accepted.has("1668x2388"), false);
  // A requiredDimensions value that is not itself a recognized iPad size must fail closed (an
  // empty accepted set), the same behavior iPhone already has, not silently fall back to the
  // whole iPad table.
  const configUnrecognized = { family: "ipad" as const, requiredDimensions: { width: 1668, height: 2388 } };
  assert.equal(acceptedDimensionsForConfig(configUnrecognized).size, 0);
});

test("preflight rejects an 11-inch iPad dimension in a 13-inch-configured slot, even though it is a valid App Store size for a different class", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ipad-display-class-"));
  const manifest = readyManifest(); manifest.app.deviceFamilies = ["ipad"]; manifest.screenshots.configurations = [{ device: "iPad Pro 13-inch (M4)", family: "ipad", locale: "en-US", requiredDimensions: { width: 2064, height: 2752 } }]; manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"], confirmation: "confirmed" }];
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "release/raw-screenshots/ipad/en-US"), { recursive: true });
  await writeFile(path.join(root, "release/raw-screenshots/ipad/en-US/home.png"), png(1668, 2388)); // real 11-inch iPad Pro size
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.ipad.en-US.home.png.accepted-dimensions" && item.severity === "block"));
});

test("preflight rejects a screenshot set mixing two individually-valid dimensions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-mixed-dimensions-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"], confirmation: "confirmed" }, { id: "detail", title: "Detail", steps: ["Open detail"], confirmation: "confirmed" }]; await writeReadyAssets(root, manifest);
  // writeReadyAssets already writes home.png at 1320x2868; add an individually-valid but
  // different-sized detail.png. Files are checked in sorted filename order, so detail.png (d <
  // h) becomes the set's reference dimension and home.png is the one that now disagrees.
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), png(1320, 2868));
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/detail.png"), png(1290, 2796));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.home.png.dimensions" && item.severity === "block" && item.message.includes("differs from")));
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.detail.png.dimensions" && item.severity === "pass"));
});

test("preflight rejects a screenshot set mixing a portrait image with its exact landscape transpose", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-orientation-mix-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "aaa-portrait", title: "Portrait", steps: ["Launch"], confirmation: "confirmed" }, { id: "bbb-landscape", title: "Landscape", steps: ["Rotate"], confirmation: "confirmed" }]; await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/aaa-portrait.png"), png(1320, 2868));
  // A landscape transpose of an accepted size is still individually an accepted dimension (the
  // per-image accepted-dimensions check tolerates orientation), but it is NOT "the same size" as
  // the set's portrait reference — App Store Connect does not reorient screenshots for you.
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/bbb-landscape.png"), png(2868, 1320));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.aaa-portrait.png.dimensions" && item.severity === "pass"));
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.bbb-landscape.png.dimensions" && item.severity === "block" && item.message.includes("differs from")));
});

test("preflight coverage check never lets one file satisfy two scenarios through a dedup-suffix collision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-dedupe-collision-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"], confirmation: "confirmed" }, { id: "home-2", title: "Home Again", steps: ["Launch again"], confirmation: "confirmed" }]; await writeReadyAssets(root, manifest);
  await rm(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"));
  // Only home-2.png exists. The `<id>-*` wildcard convention must credit it to the most specific
  // (longest) matching declared id — "home-2" exactly — never to "home" as well.
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home-2.png"), png(1320, 2868));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.home" && item.severity === "block" && item.message.includes("'home'")));
  assert.equal(report.results.filter((item) => item.id === "screenshots.iphone.en-US.home-2" && item.severity === "block").length, 0);
});

test("preflight rejects an alpha-channel screenshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-alpha-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), png(1320, 2868, true));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.home.png.alpha" && item.severity === "block"));
});

test("capturePlan and marketingProject carry each scenario's confirmation status instead of laundering a proposal into a fact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-confirmation-carry-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"], confirmation: "needs-human-confirmation" }]; await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  const capturePlanJson = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/capture-plan.json"), "utf8"));
  const planScenario = (capturePlanJson.configurations[0].scenarios as Array<{ id: string; confirmation: string }>).find((item) => item.id === "home");
  assert.equal(planScenario?.confirmation, "needs-human-confirmation");
  const marketingJson = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/marketing-composition-plan.json"), "utf8"));
  const slide = (marketingJson.decks[0].slides as Array<{ id: string; confirmation: string }>).find((item) => item.id === "home");
  assert.equal(slide?.confirmation, "needs-human-confirmation");
});

// Round-2 review Moderate-2: preflight blocks a scenario with an ABSENT confirmation field
// (Moderate-7 from the previous round), but the generated artifacts were still defaulting an
// absent field to "confirmed" — the inverse of the laundering defect: the artifact asserted
// something STRONGER than the gate allows. Every place a scenario's confirmation is repeated
// must default an absent field to "needs-human-confirmation", matching preflight.ts exactly.
test("generated artifacts never assert \"confirmed\" for a scenario whose confirmation is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-confirmation-absent-carry-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"] }]; await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  assert.ok(report.results.some((item) => item.id === "screenshots.scenarios.home.confirmation" && item.severity === "block"));
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  const capturePlanJson = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/capture-plan.json"), "utf8"));
  const planScenario = (capturePlanJson.configurations[0].scenarios as Array<{ id: string; confirmation: string }>).find((item) => item.id === "home");
  assert.equal(planScenario?.confirmation, "needs-human-confirmation");
  const marketingJson = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/marketing-composition-plan.json"), "utf8"));
  const slide = (marketingJson.decks[0].slides as Array<{ id: string; confirmation: string }>).find((item) => item.id === "home");
  assert.equal(slide?.confirmation, "needs-human-confirmation");
  const recordingScript = await readFile(path.join(pkg.directory, "review/physical-device-recording-script.md"), "utf8");
  assert.ok(recordingScript.includes("UNVERIFIED"));
});

test("capture --from ingests, validates, and refuses to fabricate matches for exported PNGs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ingest-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"] }, { id: "detail", title: "Detail", steps: ["Open"] }]; await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const from = await mkdtemp(path.join(tmpdir(), "shiplayer-exported-"));
  await writeFile(path.join(from, "home.png"), png(1320, 2868));
  await writeFile(path.join(from, "detail.png"), png(1320, 2868, true)); // alpha: must be refused
  await writeFile(path.join(from, "unmatched.png"), png(1320, 2868)); // no matching scenario
  const result = await ingestCaptures(root, manifest, { from, family: "iphone", locale: "en-US" });
  assert.equal(result.ingested.length, 1);
  assert.equal(result.ingested[0].scenarioId, "home");
  assert.equal(result.skipped.some((item) => item.sourceFile === "detail.png" && item.reason.includes("alpha")), true);
  assert.equal(result.skipped.some((item) => item.sourceFile === "unmatched.png" && item.reason.includes("no declared screenshot scenario")), true);
  const destination = await readFile(path.join(root, result.destinationDirectory, "home.png"));
  assert.ok(destination.length > 0);
});

test("capture --from reports an unreadable/zero-byte file honestly instead of blaming a missing scenario match", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ingest-zero-byte-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const from = await mkdtemp(path.join(tmpdir(), "shiplayer-exported-zero-byte-"));
  await writeFile(path.join(from, "home.png"), Buffer.alloc(0)); // filename matches scenario "home", but is not a valid image
  const result = await ingestCaptures(root, manifest, { from, family: "iphone", locale: "en-US" });
  assert.equal(result.ingested.length, 0);
  assert.ok(result.skipped.some((item) => item.sourceFile === "home.png" && item.reason.includes("unreadable")));
  assert.equal(result.skipped.some((item) => item.reason.includes("no declared screenshot scenario")), false);
});

test("capture --from recursively finds screenshots nested under subdirectories, e.g. a per-test xcresulttool export layout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ingest-nested-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const from = await mkdtemp(path.join(tmpdir(), "shiplayer-exported-nested-"));
  await mkdir(path.join(from, "testEmptyHomeShowsFirstUseActions"), { recursive: true });
  await writeFile(path.join(from, "testEmptyHomeShowsFirstUseActions", "home.png"), png(1320, 2868));
  const result = await ingestCaptures(root, manifest, { from, family: "iphone", locale: "en-US" });
  assert.equal(result.ingested.length, 1);
  assert.equal(result.ingested[0].scenarioId, "home");
  assert.equal(result.ingested[0].sourceFile, path.join("testEmptyHomeShowsFirstUseActions", "home.png"));
});

test("capture --from rejects a batch mixing two individually-valid dimensions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ingest-mixed-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "aaa-home", title: "Home", steps: ["Launch"] }, { id: "bbb-detail", title: "Detail", steps: ["Open"] }]; await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const from = await mkdtemp(path.join(tmpdir(), "shiplayer-exported-mixed-"));
  // Files are ingested in (sorted) filename order, so aaa-home.png becomes the set's reference
  // dimension and the individually-valid but different bbb-detail.png must be rejected.
  await writeFile(path.join(from, "aaa-home.png"), png(1320, 2868));
  await writeFile(path.join(from, "bbb-detail.png"), png(1260, 2736));
  const result = await ingestCaptures(root, manifest, { from, family: "iphone", locale: "en-US" });
  assert.equal(result.ingested.length, 1);
  assert.equal(result.ingested[0].scenarioId, "aaa-home");
  assert.ok(result.skipped.some((item) => item.sourceFile === "bbb-detail.png" && item.reason.includes("differs from")));
});

test("capture --from rejects a batch mixing a portrait image with its exact landscape transpose", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ingest-orientation-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "aaa-portrait", title: "Portrait", steps: ["Launch"] }, { id: "bbb-landscape", title: "Landscape", steps: ["Rotate"] }]; await writeReadyAssets(root, manifest); await writeManifest(root, manifest);
  const from = await mkdtemp(path.join(tmpdir(), "shiplayer-exported-orientation-"));
  await writeFile(path.join(from, "aaa-portrait.png"), png(1320, 2868));
  await writeFile(path.join(from, "bbb-landscape.png"), png(2868, 1320));
  const result = await ingestCaptures(root, manifest, { from, family: "iphone", locale: "en-US" });
  assert.equal(result.ingested.length, 1);
  assert.equal(result.ingested[0].scenarioId, "aaa-portrait");
  assert.ok(result.skipped.some((item) => item.sourceFile === "bbb-landscape.png" && item.reason.includes("differs from")));
});

test("capture --from rejects a dimension outside the configured display class even when it is a valid App Store size for a different class", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-ingest-display-class-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest); await writeManifest(root, manifest); // default config: iphone 1320x2868 (6.9-inch)
  const from = await mkdtemp(path.join(tmpdir(), "shiplayer-exported-display-class-"));
  await writeFile(path.join(from, "home.png"), png(1284, 2778)); // 6.5-inch legacy size
  const result = await ingestCaptures(root, manifest, { from, family: "iphone", locale: "en-US" });
  assert.equal(result.ingested.length, 0);
  assert.ok(result.skipped.some((item) => item.sourceFile === "home.png" && item.reason.includes("not an accepted dimension")));
});

test("isFamilyScreenshotDimensions accepts every Apple-published 6.9-inch iPhone and 13-inch iPad size", () => {
  for (const [width, height] of [[1320, 2868], [1290, 2796], [1260, 2736]]) assert.equal(isFamilyScreenshotDimensions("iphone", width, height), true);
  for (const [width, height] of [[2064, 2752], [2048, 2732]]) assert.equal(isFamilyScreenshotDimensions("ipad", width, height), true);
  assert.equal(isFamilyScreenshotDimensions("iphone", 100, 200), false);
});

test("prepare refuses to write the release package under a .github path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-github-reserved-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  await assert.rejects(() => generateReleasePackage(root, manifest, analysis, report, ".github/workflows"), /reserved/);
});

test("prepare emits a manually-installed workflow_dispatch-only capture workflow with a cost-guard header, plus the harness template/contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-workflow-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  assert.ok(pkg.files.includes("screenshots/capture-workflow.yml"));
  assert.ok(pkg.files.includes("screenshots/ui-test-harness-template.swift"));
  assert.ok(pkg.files.includes("screenshots/ui-test-harness-contract.md"));
  const workflowText = await readFile(path.join(pkg.directory, "screenshots/capture-workflow.yml"), "utf8");
  assert.ok(/bill.*10x|10x.*bill/i.test(workflowText));
  assert.ok(workflowText.includes("must never be made automatic") || workflowText.includes("never gain a push/pull_request/schedule"));
  const workflow = parse(workflowText) as Record<string, unknown>;
  assert.ok("workflow_dispatch" in (workflow.on as Record<string, unknown>));
  assert.equal(Object.keys(workflow.on as Record<string, unknown>).length, 1);
  const jobs = workflow.jobs as Record<string, { "runs-on": string; "timeout-minutes": number; steps: Array<{ name: string; run?: string; with?: Record<string, unknown> }> }>;
  const job = Object.values(jobs)[0];
  assert.equal(job["runs-on"], "macos-latest");
  assert.ok(typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 0);
  assert.ok((workflow.concurrency as Record<string, unknown>)?.["cancel-in-progress"] === true);
  // A zero-screenshot extraction must fail the job loudly rather than finish green with only an
  // annotation, and the current (non-"--legacy") xcresulttool invocation must be tried first.
  const uploadScreens = job.steps.find((step) => step.name === "Upload extracted screenshots");
  assert.equal(uploadScreens?.with?.["if-no-files-found"], "error");
  const extractStep = job.steps.find((step) => step.name.includes("Extract screenshot attachments"));
  const runText = extractStep?.run || "";
  const currentIndex = runText.indexOf("xcresulttool export attachments --path");
  const legacyIndex = runText.indexOf("--legacy");
  assert.ok(currentIndex >= 0 && legacyIndex > currentIndex, "the current xcresulttool syntax must be tried before --legacy");
  const template = await readFile(path.join(pkg.directory, "screenshots/ui-test-harness-template.swift"), "utf8");
  assert.ok(template.includes("keepScreenshot(named:"));
  assert.ok(template.includes("XCTAttachment(screenshot: XCUIScreen.main.screenshot())"));
  const contract = await readFile(path.join(pkg.directory, "screenshots/ui-test-harness-contract.md"), "utf8");
  assert.ok(contract.includes("keepScreenshot(named:)"));
});
