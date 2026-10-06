import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptedDimensionsForConfig, isFamilyScreenshotDimensions, preflight } from "../src/preflight.js";
import { ingestCaptures } from "../src/capture.js";
import { localScreenshotSets } from "../src/asc-apply.js";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { validateManifest, writeManifest } from "../src/manifest.js";
import { frameForFamily, IPHONE_DUO_FRAME } from "../src/marketing.js";
import { inspectImage } from "../src/image.js";
import type { ShipLayerManifest } from "../src/types.js";
import { scenariosForFamily } from "../src/types.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

// iPhone Duo (App Store Connect Help, "Screenshot specifications"): outer display 1398x2034,
// inner display 2007x2853, both in portrait or landscape, in one APP_IPHONE_DUO slot.
const OUTER = { width: 1398, height: 2034 };
const INNER = { width: 2007, height: 2853 };

function withDuo(manifest: ShipLayerManifest, dimensions = OUTER): ShipLayerManifest {
  manifest.screenshots.configurations.push({ device: "iPhone Duo", family: "iphone-duo", locale: "en-US", requiredDimensions: dimensions });
  return manifest;
}

async function duoRepository(dimensions = OUTER): Promise<{ root: string; manifest: ShipLayerManifest }> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-duo-"));
  const manifest = withDuo(readyManifest(), dimensions); await writeReadyAssets(root, manifest);
  const directory = path.join(root, manifest.screenshots.rawOutputDir, "iphone-duo", "en-US"); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "home.png"), png(dimensions.width, dimensions.height));
  return { root, manifest };
}

test("the manifest schema accepts an iphone-duo screenshot configuration but not an iphone-duo device family", () => {
  const manifest = withDuo(readyManifest());
  assert.doesNotThrow(() => validateManifest(manifest));
  const family = readyManifest(); (family.app.deviceFamilies as string[]).push("iphone-duo");
  assert.throws(() => validateManifest(family));
});

test("iPhone Duo accepts both displays in either orientation, and is its own display class", () => {
  for (const { width, height } of [OUTER, INNER]) {
    assert.equal(isFamilyScreenshotDimensions("iphone-duo", width, height), true);
    assert.equal(isFamilyScreenshotDimensions("iphone-duo", height, width), true);
    assert.equal(isFamilyScreenshotDimensions("iphone", width, height), false);
  }
  assert.equal(isFamilyScreenshotDimensions("iphone-duo", 1320, 2868), false);
  const accepted = acceptedDimensionsForConfig({ family: "iphone-duo", requiredDimensions: OUTER });
  assert.ok(accepted.has("1398x2034")); assert.ok(accepted.has("2007x2853")); assert.equal(accepted.has("1320x2868"), false);
  assert.equal(acceptedDimensionsForConfig({ family: "iphone-duo", requiredDimensions: { width: 1320, height: 2868 } }).size, 0);
});

test("preflight passes an outer-display Duo capture and warns that its slot is undocumented", async () => {
  const { root, manifest } = await duoRepository();
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone-duo.en-US.home.png.dimensions" && item.severity === "pass"));
  assert.equal(report.results.filter((item) => item.id.startsWith("screenshots.iphone-duo") && item.severity === "block").length, 0);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone-duo/en-US.undocumented-display-type" && item.severity === "warn"));
  // A Duo slot needs the app to run on iPhone; it adds no device family of its own.
  assert.equal(report.results.some((item) => item.id.includes("unsupported-family")), false);
});

test("preflight rejects a 6.9-inch capture in the Duo slot and a Duo capture in the 6.9-inch slot", async () => {
  const { root, manifest } = await duoRepository();
  await writeFile(path.join(root, manifest.screenshots.rawOutputDir, "iphone-duo", "en-US", "home.png"), png(1320, 2868));
  await writeFile(path.join(root, manifest.screenshots.rawOutputDir, "iphone", "en-US", "home.png"), png(OUTER.width, OUTER.height));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone-duo.en-US.home.png.accepted-dimensions" && item.severity === "block"));
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone.en-US.home.png.accepted-dimensions" && item.severity === "block"));
});

test("preflight blocks a Duo slot for an app that does not run on iPhone", async () => {
  const { root, manifest } = await duoRepository();
  manifest.app.deviceFamilies = ["ipad"];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "screenshots.iphone-duo/en-US.unsupported-family" && item.severity === "block"));
});

test("capture --from ingests Duo captures into their own folder and refuses other iPhone sizes", async () => {
  const { root, manifest } = await duoRepository(); await writeManifest(root, manifest);
  const from = await mkdtemp(path.join(tmpdir(), "shiplayer-duo-exported-"));
  await writeFile(path.join(from, "home.png"), png(OUTER.width, OUTER.height));
  const result = await ingestCaptures(root, manifest, { from, family: "iphone-duo", locale: "en-US" });
  assert.equal(result.ingested.length, 1);
  assert.ok(result.destinationDirectory.endsWith(`${manifest.screenshots.rawOutputDir}/iphone-duo/en-US`));
  await writeFile(path.join(from, "home.png"), png(1320, 2868));
  const refused = await ingestCaptures(root, manifest, { from, family: "iphone-duo", locale: "en-US" });
  assert.equal(refused.ingested.length, 0);
});

test("a Duo set uploads to APP_IPHONE_DUO, outer or inner display", async () => {
  for (const dimensions of [OUTER, INNER]) {
    const { root, manifest } = await duoRepository(dimensions);
    const sets = await localScreenshotSets(root, manifest);
    assert.equal(sets.find((set) => set.family === "iphone-duo")?.displayType, "APP_IPHONE_DUO");
    assert.equal(sets.find((set) => set.family === "iphone")?.displayType, "APP_IPHONE_67");
  }
});

test("the Duo frame's geometry matches its asset, with a transparent screen in the outer display's aspect", async () => {
  assert.equal(frameForFamily("iphone-duo"), IPHONE_DUO_FRAME);
  const details = await inspectImage(fileURLToPath(new URL(`../assets/device-frames/${IPHONE_DUO_FRAME.assetFile}`, import.meta.url)));
  assert.ok(details?.alpha, "the screen must be cut out of the frame");
  assert.equal(details.width, IPHONE_DUO_FRAME.canvasWidthPx); assert.equal(details.height, IPHONE_DUO_FRAME.canvasHeightPx);
  const screenAspect = (IPHONE_DUO_FRAME.screenWidthPct * IPHONE_DUO_FRAME.canvasWidthPx) / (IPHONE_DUO_FRAME.screenHeightPct * IPHONE_DUO_FRAME.canvasHeightPx);
  assert.ok(Math.abs(screenAspect - OUTER.width / OUTER.height) < 0.001);
});

test("prepare emits Duo slides with the Duo frame next to the iPhone ones", async () => {
  const { root, manifest } = await duoRepository();
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  const assets = await readdir(path.join(pkg.directory, "screenshots/marketing/assets"));
  assert.deepEqual(assets.sort(), ["iphone-duo-frame.png", "iphone-frame.png"]);
  const html = await readFile(path.join(pkg.directory, "screenshots/marketing/slides/iphone-duo/en-US/home.html"), "utf8");
  assert.ok(html.includes("assets/iphone-duo-frame.png"));
  assert.ok(html.includes(`width: ${OUTER.width}px`));
});

test("an iPhone Duo deck uses the iPhone scenarios, never iPad-only ones", () => {
  const manifest = readyManifest();
  manifest.screenshots.scenarios = [
    { id: "home", title: "Home", steps: ["Launch"], confirmation: "confirmed" },
    { id: "phone", title: "Phone only", steps: ["Open"], confirmation: "confirmed", families: ["iphone"] },
    { id: "landscape", title: "iPad only", steps: ["Rotate"], confirmation: "confirmed", families: ["ipad"] }
  ];
  assert.deepEqual(scenariosForFamily(manifest, "iphone-duo").map((scenario) => scenario.id), ["home", "phone"]);
});
