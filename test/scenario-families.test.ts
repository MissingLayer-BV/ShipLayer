import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateManifest } from "../src/manifest.js";
import { localScreenshotSets } from "../src/asc-apply.js";
import { draftScreenshots } from "../src/asc-screenshot-draft.js";
import { buildMarketingSlideEntries } from "../src/marketing.js";
import { scenariosForFamily } from "../src/types.js";
import { png, readyManifest } from "./helpers.js";

// Seven slides on both families plus an iPad-only landscape eighth (2752x2064 in a 2064x2752 set).
function twoFamilyManifest(withIpadOnly = true) {
  const manifest = readyManifest(); manifest.app.version = "1.3"; manifest.sync.mode = "apply"; manifest.screenshots.finalOutputDir = "final"; manifest.app.deviceFamilies = ["iphone", "ipad"];
  manifest.screenshots.configurations = [{ device: "iPhone 16 Pro Max", family: "iphone", locale: "en-US", requiredDimensions: { width: 1320, height: 2868 } }, { device: "iPad Pro 13-inch", family: "ipad", locale: "en-US", requiredDimensions: { width: 2064, height: 2752 } }];
  manifest.screenshots.scenarios = Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}`, title: `Slide ${index + 1}`, caption: `Caption ${index + 1}`, steps: ["Launch"], confirmation: "confirmed" as const }));
  if (withIpadOnly) manifest.screenshots.scenarios.push({ id: "wide", title: "Wide", caption: "Wide caption", steps: ["Launch"], confirmation: "confirmed", families: ["ipad"] });
  return manifest;
}
async function writeDecks(root: string, manifest: ReturnType<typeof twoFamilyManifest>, wide: [number, number] = [2752, 2064]) {
  for (const family of ["iphone", "ipad"] as const) {
    const directory = path.join(root, "final", family, "en-US"); await mkdir(directory, { recursive: true });
    for (const scenario of scenariosForFamily(manifest, family)) { const [w, h] = scenario.id === "wide" ? wide : family === "iphone" ? [1320, 2868] : [2064, 2752]; await writeFile(path.join(directory, `${scenario.id}.png`), png(w, h)); }
  }
}
const stopAfterValidation = { async get() { throw new Error("REACHED-ASC"); } } as any;

test("scenario families: iPhone sets keep 7 slides and iPad sets get 8", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-families-")); try {
    const manifest = twoFamilyManifest(); validateManifest(manifest); await writeDecks(root, manifest);
    const sets = await localScreenshotSets(root, manifest);
    assert.equal(sets.find((set) => set.family === "iphone")!.screenshots.length, 7);
    const ipad = sets.find((set) => set.family === "ipad")!;
    assert.equal(ipad.screenshots.length, 8); assert.equal(ipad.source, "marketing"); assert.equal(ipad.screenshots[7].fileName, "wide.png");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scenario families: a missing iPad-only slide leaves the iPad deck incomplete (raw fallback)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-families-")); try {
    const manifest = twoFamilyManifest(); await writeDecks(root, manifest); await rm(path.join(root, "final/ipad/en-US/wide.png"));
    await mkdir(path.join(root, manifest.screenshots.rawOutputDir, "ipad/en-US"), { recursive: true }); await writeFile(path.join(root, manifest.screenshots.rawOutputDir, "ipad/en-US/s1.png"), png(2064, 2752));
    assert.equal((await localScreenshotSets(root, manifest)).find((set) => set.family === "ipad")!.source, "raw");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scenario families: draftScreenshots accepts the transposed landscape slide and still rejects other sizes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-families-")); try {
    const manifest = twoFamilyManifest(); await writeDecks(root, manifest);
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /REACHED-ASC/);
    await writeDecks(root, manifest, [2752, 2000]);
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /Invalid screenshot en-US\/wide\.png/);
    await writeDecks(root, manifest, [2064, 2752]);
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /REACHED-ASC/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scenario families: draftScreenshots counts scenarios per family and requires one to ten for each", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-families-")); try {
    const manifest = twoFamilyManifest(); await writeDecks(root, manifest);
    await writeFile(path.join(root, "final/iphone/en-US/wide.png"), png(1320, 2868)); // an eighth iPhone file exceeds that family's count of 7
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /Complete marketing decks are required/);
    for (const scenario of manifest.screenshots.scenarios) scenario.families = ["ipad"];
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /One to ten reviewed scenarios are required for iphone/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scenario families: marketing slides are emitted only for the configuration's family", () => {
  const manifest = twoFamilyManifest();
  const entries = buildMarketingSlideEntries({ outputDirectory: "out", rawOutputDir: "raw", finalOutputDir: "final", configurations: manifest.screenshots.configurations, scenarios: manifest.screenshots.scenarios });
  assert.equal(entries.filter((entry) => entry.family === "iphone").length, 7); assert.equal(entries.filter((entry) => entry.family === "ipad").length, 8);
  assert.ok(!entries.some((entry) => entry.family === "iphone" && entry.id === "wide"));
});

test("scenario families: schema and manifest validation reject unknown, duplicate, empty or unshipped families", () => {
  const manifest = twoFamilyManifest(); validateManifest(manifest);
  for (const bad of [["watch"], [], ["ipad", "ipad"]]) { manifest.screenshots.scenarios[7].families = bad as any; assert.throws(() => validateManifest(manifest), /Invalid shiplayer/); }
  manifest.screenshots.scenarios[7].families = ["ipad"]; manifest.app.deviceFamilies = ["iphone"]; manifest.screenshots.configurations.pop();
  assert.throws(() => validateManifest(manifest), /not in app.deviceFamilies/);
});

test("scenario families: a manifest without families applies every scenario to every family", async () => {
  const manifest = twoFamilyManifest(false);
  assert.equal(scenariosForFamily(manifest, "iphone").length, 7); assert.equal(scenariosForFamily(manifest, "ipad").length, 7);
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-families-")); try {
    await writeDecks(root, manifest);
    assert.deepEqual((await localScreenshotSets(root, manifest)).map((set) => set.screenshots.length), [7, 7]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
