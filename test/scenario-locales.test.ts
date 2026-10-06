import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateManifest } from "../src/manifest.js";
import { localScreenshotSets } from "../src/asc-apply.js";
import { draftScreenshots } from "../src/asc-screenshot-draft.js";
import { buildMarketingSlideEntries } from "../src/marketing.js";
import { scenariosFor } from "../src/types.js";
import type { ShipLayerManifest } from "../src/types.js";
import { png, readyManifest } from "./helpers.js";

// Three iPhone slides in en-US and tr; the third ("subs") is limited by locale.
function twoLocaleManifest(): ShipLayerManifest {
  const manifest = readyManifest(); manifest.app.version = "1.3"; manifest.sync.mode = "apply"; manifest.screenshots.finalOutputDir = "final"; manifest.app.deviceFamilies = ["iphone"];
  manifest.app.locales = [manifest.app.primaryLocale, "tr"]; manifest.metadata.localizations.tr = { ...manifest.metadata.localizations[manifest.app.primaryLocale] };
  manifest.screenshots.configurations = manifest.app.locales.map((locale) => ({ device: "iPhone 16 Pro Max", family: "iphone" as const, locale, requiredDimensions: { width: 1320, height: 2868 } }));
  manifest.screenshots.scenarios = ["s1", "s2", "subs"].map((id) => ({ id, title: id, caption: `Caption ${id}`, steps: ["Launch"], confirmation: "confirmed" as const, localizations: id === "subs" ? {} : { tr: { caption: `Tr ${id}`, confirmation: "confirmed" as const } } }));
  manifest.screenshots.scenarios[2].excludeLocales = ["tr"];
  return manifest;
}
async function writeDecks(root: string, manifest: ShipLayerManifest) {
  for (const locale of manifest.app.locales) {
    const directory = path.join(root, "final", "iphone", locale); await mkdir(directory, { recursive: true });
    for (const scenario of scenariosFor(manifest, "iphone", locale)) await writeFile(path.join(directory, `${scenario.id}.png`), png(1320, 2868));
  }
}
// Fails the first App Store Connect read, so a rejection with REACHED-ASC means validation passed; only `get` is ever reached.
const stopAfterValidation = { async get() { throw new Error("REACHED-ASC"); } } as unknown as Parameters<typeof draftScreenshots>[4];

test("scenario locales: an excluded locale needs no caption or file and uploads its smaller deck", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-locales-")); try {
    const manifest = twoLocaleManifest(); validateManifest(manifest); await writeDecks(root, manifest);
    const sets = await localScreenshotSets(root, manifest);
    const tr = sets.find((set) => set.locale === "tr")!; assert.equal(tr.source, "marketing"); assert.equal(tr.screenshots.length, 2);
    assert.equal(sets.find((set) => set.locale !== "tr")!.screenshots.length, 3);
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /REACHED-ASC/);
    manifest.screenshots.scenarios[2].excludeLocales = undefined; manifest.screenshots.scenarios[2].locales = [manifest.app.primaryLocale];
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /REACHED-ASC/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scenario locales: an included locale still requires its caption and file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-locales-")); try {
    const manifest = twoLocaleManifest(); await writeDecks(root, manifest);
    manifest.screenshots.scenarios[2].excludeLocales = undefined;
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /Unconfirmed caption tr\/subs/);
    manifest.screenshots.scenarios[2].localizations = { tr: { caption: "Tr subs", confirmation: "confirmed" } };
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /No screenshots exist in .*iphone\/tr/);
    await mkdir(path.join(root, manifest.screenshots.rawOutputDir, "iphone/tr"), { recursive: true }); await writeFile(path.join(root, manifest.screenshots.rawOutputDir, "iphone/tr/s1.png"), png(1320, 2868));
    assert.equal((await localScreenshotSets(root, manifest)).find((set) => set.locale === "tr")!.source, "raw");
    await assert.rejects(draftScreenshots(root, manifest, false, false, stopAfterValidation), /Complete marketing decks are required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scenario locales: marketing slides skip excluded locales", () => {
  const manifest = twoLocaleManifest();
  const entries = buildMarketingSlideEntries({ outputDirectory: "out", rawOutputDir: "raw", finalOutputDir: "final", configurations: manifest.screenshots.configurations, scenarios: manifest.screenshots.scenarios });
  assert.equal(entries.filter((entry) => entry.locale === "tr").length, 2);
  assert.ok(!entries.some((entry) => entry.locale === "tr" && entry.id === "subs"));
});

test("scenario locales: invalid values and locales with excludeLocales are rejected", () => {
  const manifest = twoLocaleManifest(); validateManifest(manifest);
  const scenario = manifest.screenshots.scenarios[2];
  for (const bad of [[], ["tr", "tr"], [""]]) { scenario.excludeLocales = bad; assert.throws(() => validateManifest(manifest), /Invalid shiplayer/); }
  scenario.excludeLocales = ["de"]; assert.throws(() => validateManifest(manifest), /not in app.locales/);
  scenario.excludeLocales = undefined; scenario.locales = ["de"]; assert.throws(() => validateManifest(manifest), /not in app.locales/);
  scenario.locales = ["tr"]; validateManifest(manifest);
  scenario.excludeLocales = [manifest.app.primaryLocale]; assert.throws(() => validateManifest(manifest), /both locales and excludeLocales/);
});
