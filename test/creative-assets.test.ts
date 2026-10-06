import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateManifest } from "../src/manifest.js";
import { preflight } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { appStorePlan } from "../src/asc.js";
import { EXPORT_MJS } from "../src/marketing.js";
import { buildCreativeSlideEntries, creativeCopyIssues, creativeLayout, CREATIVE_PLACEMENT_SPECS, MAX_CREATIVE_HEADLINE_LENGTH, MAX_CREATIVE_SUBLINE_LENGTH, renderCreativeHtml } from "../src/creative-assets.js";
import type { CreativeAssets, PreflightReport, ShipLayerManifest } from "../src/types.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

function creativeAssets(overrides: Partial<CreativeAssets> = {}): CreativeAssets {
  return {
    outputDir: "app-store-assets/creative",
    wordmark: "Example",
    locales: ["en-US", "tr"],
    placements: { header: {}, searchResults: { screenshot: { family: "iphone", capture: "home" } } },
    localizations: {
      "en-US": { confirmation: "confirmed", header: { headline: "Just talk." }, searchResults: { headline: "An interpreter, not a tap-to-talk translator", subline: "Speak naturally and hear the other language." } },
      tr: { confirmation: "confirmed", header: { headline: "Sadece konuşun." }, searchResults: { headline: "Bas-konuş çevirmen değil, bir tercüman", subline: "Doğal konuşun, diğer dili duyun." } }
    },
    ...overrides
  };
}

function creativeManifest(overrides: Partial<CreativeAssets> = {}): ShipLayerManifest {
  const manifest = readyManifest();
  manifest.app.locales = ["en-US", "tr", "ar-SA", "ja"];
  for (const locale of ["tr", "ar-SA", "ja"]) manifest.metadata.localizations[locale] = { name: "Example", description: "A complete App Store description.", keywords: ["example"], confirmation: "confirmed" };
  manifest.screenshots.configurations.push({ device: "iPhone 16 Pro Max", family: "iphone", locale: "tr", sourceLocale: "en-US", requiredDimensions: { width: 1320, height: 2868 } });
  manifest.creativeAssets = creativeAssets(overrides);
  return manifest;
}

const creativeResults = (report: PreflightReport) => report.results.filter((item) => item.id.startsWith("creative."));

test("schema accepts the creativeAssets contract, style included", () => {
  const manifest = creativeManifest({ style: { background: "#f4efe7", text: "#1c1b19", secondaryText: "#5f5b55", accent: "#0a7cff" } });
  validateManifest(manifest);
  const universal = creativeManifest({ placements: { universal: {} }, localizations: { "en-US": { confirmation: "confirmed", universal: { headline: "x".repeat(MAX_CREATIVE_HEADLINE_LENGTH), subline: "y".repeat(MAX_CREATIVE_SUBLINE_LENGTH) } }, tr: { universal: { headline: "Sadece konuşun." } } } });
  validateManifest(universal);
});

test("schema and validation reject bad creativeAssets shapes", () => {
  const rejects = (mutate: (creative: CreativeAssets) => void, pattern = /Invalid shiplayer/) => { const manifest = creativeManifest(); mutate(manifest.creativeAssets!); assert.throws(() => validateManifest(manifest), pattern); };
  rejects((creative) => { creative.localizations["en-US"].header = { headline: "x".repeat(MAX_CREATIVE_HEADLINE_LENGTH + 1) }; });
  rejects((creative) => { creative.localizations["en-US"].header = { headline: "Just talk.", subline: "y".repeat(MAX_CREATIVE_SUBLINE_LENGTH + 1) }; });
  rejects((creative) => { creative.localizations["en-US"].header = { headline: "Line one\nLine two" }; });
  rejects((creative) => { (creative.placements as Record<string, unknown>).banner = {}; });
  rejects((creative) => { (creative.placements as Record<string, unknown>).header = { screenshot: { family: "iphone", capture: "home" } }; });
  rejects((creative) => { creative.placements = {}; });
  rejects((creative) => { creative.style = { background: "#fff" }; });
  rejects((creative) => { creative.style = { accent: "#0a7cff80" }; });
  rejects((creative) => { creative.locales = ["en-US", "en-US"]; });
  rejects((creative) => { creative.locales = []; });
  rejects((creative) => { (creative as Partial<CreativeAssets>).outputDir = undefined; });
  rejects((creative) => { creative.outputDir = "../outside"; });
  rejects((creative) => { creative.placements.searchResults = { screenshot: { family: "iphone", capture: "Home Screen" } }; });
  rejects((creative) => { delete creative.localizations.tr; }, /creativeAssets.localizations is missing locale tr/);
  rejects((creative) => { delete creative.localizations.tr.searchResults; }, /creativeAssets.localizations.tr needs searchResults copy/);
  rejects((creative) => { creative.localizations.tr.universal = { headline: "Fazla" }; }, /does not declare universal/);
  rejects((creative) => { creative.localizations.ja = { header: { headline: "話すだけ。" }, searchResults: { headline: "話すだけ。" } }; }, /ja is not listed in creativeAssets.locales/);
  rejects((creative) => { creative.locales.push("de-DE"); creative.localizations["de-DE"] = { header: { headline: "Einfach reden." }, searchResults: { headline: "Einfach reden." } }; }, /not declared in app.locales/);
});

test("the copy gate catches every forbidden class", () => {
  const kinds = (text: string) => creativeCopyIssues(text).map((issue) => issue.kind);
  for (const text of ["Visit https://example.com", "See www.example.com", "linkvoice.app", "Learn more at example.co.uk/help", "Write to hello@example.com"]) assert.ok(kinds(text).includes("url"), text);
  for (const text of ["Only $4.99", "4,99 €", "₺49,99", "Just 5 USD a month", "EUR 3", "50% off today", "Save 30%", "%50 indirim"]) assert.ok(kinds(text).includes("pricing"), text);
  for (const text of ["Example©", "Example® Pro", "Example™", "Example (TM)"]) assert.ok(kinds(text).includes("symbol"), text);
  for (const text of ["Editor’s Choice", "Editors' Choice winner", "App of the Day", "Game of the Day", "Apple Design Award finalist"]) assert.deepEqual(kinds(text).filter((kind) => kind !== "other-platform"), ["apple-recognition"], text);
  for (const text of ["Also on Android", "Get it on Google Play", "Play Store favourite", "Galaxy Store", "Now on AppGallery", "Works on Windows", "Play it on Steam"]) assert.ok(kinds(text).includes("other-platform"), text);
  assert.deepEqual(creativeCopyIssues("Award-winning interpreter"), [{ kind: "award", severity: "warn", label: "an award or ranking claim" }]);
  for (const issue of creativeCopyIssues("Only $4.99 at linkvoice.app")) assert.equal(issue.severity, "block");
});

test("the copy gate passes clean localized copy and ordinary words", () => {
  for (const text of ["Just talk.", "An interpreter, not a tap-to-talk translator", "Sadece konuşun. Tercüman sizin için çevirir.", "話すだけ。通訳が声に出して訳します。", "تحدث فقط. يترجم المترجم بصوت عالٍ.", "Open all the windows and let off steam", "Speak 38 languages, 100% hands-free", "e.g. a café menu", "Version 2.5 is faster"]) assert.deepEqual(creativeCopyIssues(text), [], text);
});

test("slide entries carry exact sizes, project-relative paths and the sourceLocale capture fallback", () => {
  const manifest = creativeManifest();
  const entries = buildCreativeSlideEntries({ outputDirectory: "shiplayer-release", rawOutputDir: manifest.screenshots.rawOutputDir, configurations: manifest.screenshots.configurations, creativeAssets: manifest.creativeAssets! });
  assert.deepEqual(entries.map((entry) => `${entry.family}/${entry.locale}`), ["creative-header/en-US", "creative-header/tr", "creative-searchResults/en-US", "creative-searchResults/tr"]);
  const header = entries[0];
  assert.equal(header.width, 3840); assert.equal(header.height, 1646);
  assert.deepEqual(header.safeArea, { left: 1097, top: 493, right: 2743, bottom: 1154 });
  assert.equal(header.htmlRelativePath, "creative/header/en-US.html");
  assert.equal(header.outputRelativePath, "../../../app-store-assets/creative/header/en-US.png");
  assert.equal(header.screenshot, undefined);
  const searchTr = entries[3];
  assert.equal(searchTr.width, 3840); assert.equal(searchTr.height, 2560);
  // tr has no app pixels of its own: its configuration's sourceLocale (en-US) supplies them.
  assert.equal(searchTr.screenshot?.pngHref, "../../../../../release/raw-screenshots/iphone/en-US/home.png");
  assert.equal(searchTr.screenshot?.frameHref, "../../assets/iphone-frame.png");
  assert.equal(searchTr.outputRelativePath, "../../../app-store-assets/creative/searchResults/tr.png");
  assert.equal(CREATIVE_PLACEMENT_SPECS.universal.width, 5244); assert.equal(CREATIVE_PLACEMENT_SPECS.universal.height, 2950);
});

test("the text block sits inside the safe area, and RTL locales mirror text and device", () => {
  const safeArea = CREATIVE_PLACEMENT_SPECS.searchResults.safeArea;
  const screenshot = { family: "iphone" as const, pngHref: "a.png", jpgHref: "a.jpg", frameHref: "f.png" };
  const inside = (box: { left: number; top: number; width: number; height: number }) => box.left >= safeArea.left && box.top >= safeArea.top && box.left + box.width <= safeArea.right && box.top + box.height <= safeArea.bottom;
  const width = CREATIVE_PLACEMENT_SPECS.searchResults.width;
  const ltr = creativeLayout({ width, safeArea, locale: "en-US", screenshot });
  const rtl = creativeLayout({ width, safeArea, locale: "ar-SA", screenshot });
  assert.ok(inside(ltr.text) && inside(rtl.text));
  assert.ok(ltr.device && rtl.device);
  assert.ok(ltr.text.left + ltr.text.width <= ltr.device.left, "LTR: text leads, device trails");
  assert.ok(rtl.device.left + rtl.device.width <= rtl.text.left, "RTL: device on the left, text on the right");
  const safeWidth = safeArea.right - safeArea.left;
  assert.ok(Math.abs(ltr.text.left + ltr.text.width - (safeArea.left + 0.54 * safeWidth)) < 1, "the text column takes 57% of the safe width, less the gap");
  assert.ok(ltr.device.left >= safeArea.left + 0.57 * safeWidth, "the device stays in its own column");
  assert.deepEqual([ltr.fit.sublineLines, ltr.fit.sublineMin, ltr.fit.headlineMin], [3, 0.07, 0.095], "beside a device the subline may take 3 lines and keeps a legible floor");
  assert.equal(Math.round(ltr.device.top), Math.round(safeArea.top - 0.1 * (safeArea.bottom - safeArea.top)));
  assert.ok(ltr.device.top + ltr.device.height > CREATIVE_PLACEMENT_SPECS.searchResults.height, "the device runs off the bottom edge");
  // An iPad is too wide for its column: it keeps clear of the text and runs past the safe area instead of shrinking.
  const ipad = creativeLayout({ width, safeArea, locale: "en-US", screenshot: { ...screenshot, family: "ipad" } });
  const ipadRtl = creativeLayout({ width, safeArea, locale: "he", screenshot: { ...screenshot, family: "ipad" } });
  assert.ok(ipad.device && ipadRtl.device);
  assert.ok(ipad.text.left + ipad.text.width < ipad.device.left && ipad.device.left + ipad.device.width > safeArea.right && ipad.device.left + ipad.device.width <= width);
  assert.ok(ipadRtl.device.left + ipadRtl.device.width < ipadRtl.text.left && ipadRtl.device.left < safeArea.left && ipadRtl.device.left >= 0);
  const centered = creativeLayout({ width: CREATIVE_PLACEMENT_SPECS.header.width, safeArea: CREATIVE_PLACEMENT_SPECS.header.safeArea, locale: "en-US" });
  const inset = 1646 * 0.01; // glyph-overhang inset inside the safe area
  assert.deepEqual(centered.text, { left: 1097 + inset, top: 493, width: 1646 - 2 * inset, height: 661 });
  assert.equal(centered.device, undefined);
  assert.deepEqual([centered.fit.headlineMax, centered.fit.headlineLines, centered.fit.sublineLines], [0.48, 2, 2]);
});

test("creative pages fit their own text and never clip it; export refuses an overflowing page", () => {
  const manifest = creativeManifest();
  manifest.creativeAssets!.localizations["en-US"].confirmation = "needs-human-confirmation";
  const entries = buildCreativeSlideEntries({ outputDirectory: "shiplayer-release", rawOutputDir: manifest.screenshots.rawOutputDir, configurations: manifest.screenshots.configurations, creativeAssets: manifest.creativeAssets! });
  const header = renderCreativeHtml(entries[0]);
  assert.ok(header.includes('data-shiplayer-fit-config="'));
  assert.ok(header.includes("root.dataset.shiplayerOverflow = result.problems.join"));
  assert.ok(header.includes('root.dataset.shiplayerFit = "done"'));
  assert.ok(!header.includes("line-clamp"));
  assert.ok(header.includes(`background: ${"#f4efe7"}`));
  assert.ok(header.includes("Draft — needs confirmation"), "unconfirmed copy renders a draft badge");
  assert.ok(!header.includes('class="device"'));
  assert.ok(!/https?:\/\//.test(header), "renders offline");
  const searchAr = renderCreativeHtml({ ...entries[2], locale: "ar-SA", headline: "تحدث فقط." });
  assert.ok(searchAr.includes('dir="rtl"'));
  assert.ok(searchAr.includes("text-align: right;") && searchAr.includes("letter-spacing: 0;"), "RTL text aligns right; Arabic keeps its own spacing");
  assert.ok(renderCreativeHtml(entries[2]).includes("text-align: left;") && renderCreativeHtml(entries[2]).includes("letter-spacing: -0.03em;"));
  assert.ok(header.includes("text-align: center;"));
  assert.ok(searchAr.includes('class="device"') && searchAr.includes("raw-screenshots/iphone/en-US/home.png"));
  const escaped = renderCreativeHtml({ ...entries[0], headline: "<b>Talk</b> & go" });
  assert.ok(escaped.includes("&lt;b&gt;Talk&lt;/b&gt; &amp; go"));
  const hyphenated = renderCreativeHtml({ ...entries[2], headline: "An interpreter, not a tap-to-talk translator", subline: "Hands-free, no tap-to-talk." });
  assert.ok(hyphenated.includes('not a <span class="nobr">tap-to-talk</span> translator'), "hyphenated words are fitted whole first");
  assert.ok(hyphenated.includes('<span class="nobr">Hands-free,</span> no <span class="nobr">tap-to-talk.</span>'));
  assert.ok(hyphenated.includes(".hyphen-breaks .nobr { white-space: normal; }") && hyphenated.includes("&quot;hyphenKeepRatio&quot;:0.8"), "breaks are allowed when keeping them whole costs more than 20%");
  assert.ok(EXPORT_MJS.includes("dataset.shiplayerOverflow"));
  assert.ok(EXPORT_MJS.includes("slide.textFit && !fit.fitted"));
  assert.ok(EXPORT_MJS.includes("await rm(outputPath, { force: true })"));
  assert.ok(EXPORT_MJS.includes("process.exitCode = 1"));
});

test("prepare emits creative pages, slides.json rows and the frame they need", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-creative-prepare-"));
  const manifest = creativeManifest();
  await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  const slides = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/marketing/slides.json"), "utf8")) as { slides: Array<Record<string, unknown>> };
  const creative = slides.slides.filter((slide) => String(slide.family).startsWith("creative-"));
  assert.equal(creative.length, 4);
  assert.deepEqual(creative[0], { id: "header", family: "creative-header", device: "App Store creative asset", locale: "en-US", width: 3840, height: 1646, confirmed: true, textFit: true, html: "creative/header/en-US.html", output: "../../../app-store-assets/creative/header/en-US.png" });
  assert.ok(pkg.files.includes("screenshots/marketing/creative/searchResults/tr.html"));
  assert.ok(pkg.files.includes("screenshots/marketing/assets/iphone-frame.png"));
  const readme = await readFile(path.join(pkg.directory, "screenshots/marketing/README.md"), "utf8");
  assert.ok(readme.includes("## App Store creative assets"));
  assert.ok(readme.includes("app-store-assets/creative/<placement>/<locale>.png"));
});

test("prepare refuses a creative outputDir inside --out, overlapping screenshot decks, or under a reserved path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-creative-paths-"));
  const base = creativeManifest(); await writeReadyAssets(root, base);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, base, false, analysis);
  for (const [outputDir, pattern] of [["shiplayer-release/creative", /overlaps --out/], ["captures/creative", /overlaps screenshots.rawOutputDir/], ["final-decks", /overlaps screenshots.finalOutputDir/], [".github/creative", /reserved or source-control path '.github'/]] as const) {
    const manifest = creativeManifest({ outputDir });
    manifest.screenshots.rawOutputDir = "captures";
    manifest.screenshots.finalOutputDir = "final-decks/screens";
    await assert.rejects(generateReleasePackage(root, manifest, analysis, report, "shiplayer-release"), pattern, outputDir);
  }
});

test("check blocks forbidden copy, unconfirmed copy and a missing capture, naming the path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-creative-check-"));
  const manifest = creativeManifest({ wordmark: "Example™" });
  manifest.screenshots.configurations.pop(); // tr loses its sourceLocale fallback
  manifest.creativeAssets!.localizations["en-US"].header = { headline: "Only $4.99 on linkvoice.app", subline: "Also on Android" };
  manifest.creativeAssets!.localizations.tr.confirmation = "needs-human-confirmation";
  await writeReadyAssets(root, manifest);
  const results = creativeResults(await preflight(root, manifest));
  const blocked = new Set(results.filter((item) => item.severity === "block").map((item) => item.id));
  for (const id of ["creative.wordmark.symbol", "creative.header.en-US.headline.pricing", "creative.header.en-US.headline.url", "creative.header.en-US.subline.other-platform", "creative.tr.confirmation", "creative.searchResults.tr.capture"]) assert.ok(blocked.has(id), id);
  assert.ok(results.find((item) => item.id === "creative.searchResults.tr.capture")?.message.includes("release/raw-screenshots/iphone/tr/home.png"));
  assert.ok(results.some((item) => item.id === "creative.searchResults.en-US.capture" && item.severity === "pass"));
  assert.ok(results.some((item) => item.id === "creative.tr.copy" && item.severity === "pass"));
  assert.ok(!blocked.has("creative.en-US.confirmation"));
});

test("check warns before rendering and inspects rendered PNGs for size and alpha", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-creative-render-"));
  const manifest = creativeManifest();
  await writeReadyAssets(root, manifest);
  let results = creativeResults(await preflight(root, manifest));
  assert.ok(results.some((item) => item.id === "creative.header.en-US.render" && item.severity === "warn" && item.message.includes("app-store-assets/creative/header/en-US.png")));
  assert.equal(results.filter((item) => item.severity === "block").length, 0);
  const dir = path.join(root, "app-store-assets/creative");
  await mkdir(path.join(dir, "header"), { recursive: true }); await mkdir(path.join(dir, "searchResults"), { recursive: true });
  await writeFile(path.join(dir, "header/en-US.png"), png(3840, 1646));
  await writeFile(path.join(dir, "header/tr.png"), png(3840, 1646, true));
  await writeFile(path.join(dir, "searchResults/en-US.png"), png(3840, 2560));
  await writeFile(path.join(dir, "searchResults/tr.png"), png(3840, 1646));
  results = creativeResults(await preflight(root, manifest));
  const severity = (id: string) => results.find((item) => item.id === id)?.severity;
  assert.equal(severity("creative.header.en-US.render.dimensions"), "pass");
  assert.equal(severity("creative.header.tr.render.alpha"), "block");
  assert.equal(severity("creative.searchResults.en-US.render.dimensions"), "pass");
  assert.equal(severity("creative.searchResults.tr.render.dimensions"), "block");
  assert.equal(results.some((item) => item.id.endsWith(".render") && item.severity === "warn"), false);
});

test("the App Store Connect plan lists the creative-asset upload as a manual step", async () => {
  const manifest = creativeManifest();
  const plan = await appStorePlan(manifest, false, {});
  const step = plan.operations.find((operation) => operation.id === "manual.creative-assets");
  assert.equal(step?.action, "manual");
  assert.equal(plan.operations.at(-1)?.id, "submit.final");
  assert.equal((await appStorePlan(readyManifest(), false, {})).operations.some((operation) => operation.id === "manual.creative-assets"), false);
});
