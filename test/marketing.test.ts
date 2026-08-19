import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest } from "../src/manifest.js";
import { preflight } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { inspectImage } from "../src/image.js";
import { deflateSync, inflateSync } from "node:zlib";
import { buildMarketingSlideEntries, DEFAULT_MARKETING_FINAL_DIR, EXPORT_MJS, renderPackageJson, renderReadme, renderSlideHtml, SLIDE_BACKGROUND_RGB, STRIP_ALPHA_MJS, MAX_CAPTION_LENGTH } from "../src/marketing.js";
import { png, readyManifest, writeReadyAssets } from "./helpers.js";

// ---------------------------------------------------------------------------------------------
// Schema validation: caption length / newline rejection (section 3 of the brief).
// ---------------------------------------------------------------------------------------------

test("schema accepts a sane caption and rejects an over-long or newline-containing one", () => {
  const manifest = readyManifest();
  manifest.screenshots.scenarios[0].caption = "Track every workout in seconds";
  validateManifest(manifest);

  manifest.screenshots.scenarios[0].caption = "x".repeat(MAX_CAPTION_LENGTH);
  validateManifest(manifest);

  manifest.screenshots.scenarios[0].caption = "x".repeat(MAX_CAPTION_LENGTH + 1);
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);

  manifest.screenshots.scenarios[0].caption = "Line one\nLine two";
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);

  manifest.screenshots.scenarios[0].caption = "";
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
});

// ---------------------------------------------------------------------------------------------
// Slide HTML: legible with/without a caption, and honest about confirmation status.
// ---------------------------------------------------------------------------------------------

function baseEntry(overrides: Partial<Parameters<typeof renderSlideHtml>[0]> = {}) {
  return {
    id: "home", title: "Home screen", confirmed: true, family: "iphone" as const, device: "iPhone 16 Pro Max", locale: "en-US",
    width: 1320, height: 2868, screenshotPngHref: "../../../../../../release/raw-screenshots/iphone/en-US/home.png",
    screenshotJpgHref: "../../../../../../release/raw-screenshots/iphone/en-US/home.jpg", frameHref: "../../../assets/iphone-frame.png",
    htmlRelativePath: "slides/iphone/en-US/home.html", outputRelativePath: "../final/iphone/en-US/home.png",
    ...overrides
  };
}

// Note: the stylesheet always defines a `.caption-placeholder { ... }` rule regardless of whether
// any element on the slide uses it, so these assertions check the actual class ATTRIBUTE on the
// caption div (`class="caption caption-placeholder"` vs `class="caption"`), never a bare substring
// match against the whole document — a bare match would be trivially true either way.
test("a slide with no caption still renders legibly, using the scenario title as a visibly-marked placeholder", () => {
  const html = renderSlideHtml(baseEntry({ caption: undefined }));
  assert.ok(html.includes('class="caption caption-placeholder"'));
  assert.ok(html.includes("Home screen"));
  assert.ok(!html.includes("Draft"), "a confirmed scenario must not show the draft badge");
});

test("a drafted caption renders as the headline, escaped, without the placeholder styling", () => {
  const html = renderSlideHtml(baseEntry({ caption: "Track every workout <fast>" }));
  assert.ok(!html.includes('class="caption caption-placeholder"'));
  assert.ok(html.includes('class="caption"'));
  assert.ok(html.includes("Track every workout &lt;fast&gt;"));
});

test("an unconfirmed scenario always shows a draft badge, whether or not it has a caption yet — never laundered as confirmed", () => {
  const withCaption = renderSlideHtml(baseEntry({ confirmed: false, caption: "Real headline" }));
  assert.ok(withCaption.includes("Draft") && withCaption.includes("needs confirmation"));
  const withoutCaption = renderSlideHtml(baseEntry({ confirmed: false, caption: undefined }));
  assert.ok(withoutCaption.includes("Draft") && withoutCaption.includes("needs confirmation"));
});

test("a slide never references a remote resource: no network access is needed to render it", () => {
  const html = renderSlideHtml(baseEntry({ caption: "Ship faster" }));
  assert.ok(!/https?:\/\//i.test(html), "slide HTML must not reference any remote URL");
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/i.test(html));
  assert.ok(!/<link\b/i.test(html), "no external stylesheet/font link");
  assert.ok(!/<script\b[^>]*\ssrc=/i.test(html), "no external script");
});

// ---------------------------------------------------------------------------------------------
// buildMarketingSlideEntries: pure path arithmetic, independent of family/locale nesting depth.
// ---------------------------------------------------------------------------------------------

test("buildMarketingSlideEntries computes correct relative hrefs for every configuration x scenario pair", () => {
  const entries = buildMarketingSlideEntries({
    outputDirectory: "shiplayer-release",
    rawOutputDir: "release/raw-screenshots",
    finalOutputDir: "shiplayer-release/screenshots/final",
    configurations: [
      { device: "iPhone 16 Pro Max", family: "iphone", locale: "en-US", requiredDimensions: { width: 1320, height: 2868 } },
      { device: "iPad Pro 13-inch (M4)", family: "ipad", locale: "en-US", requiredDimensions: { width: 2064, height: 2752 } }
    ],
    scenarios: [{ id: "home", title: "Home", confirmation: "confirmed" }, { id: "detail", title: "Detail" }]
  });
  assert.equal(entries.length, 4);
  const home = entries.find((entry) => entry.family === "iphone" && entry.id === "home")!;
  assert.equal(home.confirmed, true);
  assert.equal(home.htmlRelativePath, "slides/iphone/en-US/home.html");
  assert.equal(home.screenshotPngHref, "../../../../../../release/raw-screenshots/iphone/en-US/home.png");
  assert.equal(home.frameHref, "../../../assets/iphone-frame.png");
  assert.equal(home.outputRelativePath, "../final/iphone/en-US/home.png");
  const detail = entries.find((entry) => entry.id === "detail" && entry.family === "ipad")!;
  assert.equal(detail.confirmed, false); // no confirmation field at all -> not confirmed
  assert.equal(detail.htmlRelativePath, "slides/ipad/en-US/detail.html");
  assert.equal(detail.screenshotPngHref, "../../../../../../release/raw-screenshots/ipad/en-US/detail.png");
  assert.equal(detail.frameHref, "../../../assets/ipad-frame.png");
});

// ---------------------------------------------------------------------------------------------
// Generated project shape: playwright as the only dependency, per-family frame assets only,
// deterministic slide count.
// ---------------------------------------------------------------------------------------------

test("prepare emits a self-contained marketing composition project with playwright as its only dependency", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-project-"));
  const manifest = readyManifest();
  manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"], confirmation: "confirmed", caption: "See everything at a glance" }, { id: "detail", title: "Detail", steps: ["Open"], confirmation: "needs-human-confirmation" }];
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US/detail.png"), png(1320, 2868));
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");

  const packageJson = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/marketing/package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.dependencies), ["playwright"]);
  assert.equal(packageJson.devDependencies, undefined);

  const slidesJson = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/marketing/slides.json"), "utf8"));
  assert.equal(slidesJson.slides.length, 2); // 1 configuration (iphone/en-US) x 2 scenarios

  // Only iphone is a declared device family here, so only the iPhone frame asset is emitted —
  // no dead/unused ipad-frame.png.
  const assetFiles = await readdir(path.join(pkg.directory, "screenshots/marketing/assets"));
  assert.deepEqual(assetFiles, ["iphone-frame.png"]);

  const homeHtml = await readFile(path.join(pkg.directory, "screenshots/marketing/slides/iphone/en-US/home.html"), "utf8");
  assert.ok(homeHtml.includes("See everything at a glance"));
  assert.ok(!homeHtml.includes("Draft"));
  const detailHtml = await readFile(path.join(pkg.directory, "screenshots/marketing/slides/iphone/en-US/detail.html"), "utf8");
  assert.ok(detailHtml.includes("Draft"));

  assert.ok(pkg.files.includes("screenshots/marketing/export.mjs"));
  assert.ok(pkg.files.includes("screenshots/marketing/strip-alpha.mjs"));
  assert.ok(pkg.files.includes("screenshots/marketing/README.md"));
});

test("prepare emits no marketing slides and an empty assets directory when there are no screenshot scenarios yet", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-empty-"));
  const manifest = readyManifest();
  manifest.screenshots.scenarios = [];
  await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  const slidesJson = JSON.parse(await readFile(path.join(pkg.directory, "screenshots/marketing/slides.json"), "utf8"));
  assert.deepEqual(slidesJson.slides, []);
});

// ---------------------------------------------------------------------------------------------
// The alpha-stripping module actually shipped inside export.mjs: run the EXACT generated source
// (byte for byte, via a temp file + dynamic import — no Playwright involved, it has zero
// dependencies of its own) over a synthetic RGBA PNG, then verify with ShipLayer's own
// inspectImage that the result genuinely has no alpha channel.
// ---------------------------------------------------------------------------------------------

async function loadStripAlpha(): Promise<(buffer: Buffer) => Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "shiplayer-strip-alpha-"));
  const file = path.join(dir, "strip-alpha.mjs");
  await writeFile(file, STRIP_ALPHA_MJS);
  const module = await import(pathToFileURL(file).href) as { stripAlphaPng: (buffer: Buffer) => Buffer };
  return module.stripAlphaPng;
}

test("the shipped alpha-stripping module turns a synthetic RGBA PNG into a genuinely alpha-free PNG of the same dimensions", async () => {
  const stripAlphaPng = await loadStripAlpha();
  const rgba = png(40, 30, true);
  const before = await inspectImage(await writeTempFile(rgba));
  assert.equal(before?.alpha, true);
  const flattened = stripAlphaPng(rgba);
  const outPath = await writeTempFile(flattened);
  const after = await inspectImage(outPath);
  assert.ok(after, "flattened output must still be a valid, decodable PNG");
  assert.equal(after?.alpha, false);
  assert.equal(after?.width, 40);
  assert.equal(after?.height, 30);
  assert.equal(after?.format, "png");
});

test("the shipped alpha-stripping module leaves an already alpha-free PNG genuinely alpha-free", async () => {
  const stripAlphaPng = await loadStripAlpha();
  const rgb = png(24, 18, false);
  const flattened = stripAlphaPng(rgb);
  const outPath = await writeTempFile(flattened);
  const after = await inspectImage(outPath);
  assert.equal(after?.alpha, false);
  assert.equal(after?.width, 24);
  assert.equal(after?.height, 18);
});

async function writeTempFile(contents: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "shiplayer-png-"));
  const file = path.join(dir, "image.png");
  await writeFile(file, contents);
  return file;
}

// ---------------------------------------------------------------------------------------------
// preflight validates rendered marketing PNGs the same way raw captures are validated: exact
// per-display-class dimensions, uniform size per set, at most 10 per set, no alpha — but staying
// silent (non-blocking) when nothing has been rendered yet, since export is an optional step.
// ---------------------------------------------------------------------------------------------

test("preflight is silent about marketing screenshots when nothing has been rendered yet", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-absent-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id.startsWith("marketing.")).length, 0);
  assert.equal(report.summary.block, 0);
});

test("preflight accepts a valid rendered marketing screenshot set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-valid-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const finalDir = path.join(root, "shiplayer-release/screenshots/final/iphone/en-US");
  await mkdir(finalDir, { recursive: true });
  await writeFile(path.join(finalDir, "home.png"), png(1320, 2868));
  const report = await preflight(root, manifest);
  assert.equal(report.summary.block, 0);
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.home.png.dimensions" && item.severity === "pass"));
});

test("preflight rejects a rendered marketing screenshot with an alpha channel", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-alpha-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const finalDir = path.join(root, "shiplayer-release/screenshots/final/iphone/en-US");
  await mkdir(finalDir, { recursive: true });
  await writeFile(path.join(finalDir, "home.png"), png(1320, 2868, true));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.home.png.alpha" && item.severity === "block"));
});

test("preflight rejects a rendered marketing screenshot outside the configured display class", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-wrong-dimension-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const finalDir = path.join(root, "shiplayer-release/screenshots/final/iphone/en-US");
  await mkdir(finalDir, { recursive: true });
  await writeFile(path.join(finalDir, "home.png"), png(1242, 2688)); // valid 6.5" size, not 6.9"
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.home.png.accepted-dimensions" && item.severity === "block"));
});

test("preflight rejects a non-uniform rendered marketing screenshot set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-nonuniform-"));
  const manifest = readyManifest(); manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"], confirmation: "confirmed" }, { id: "detail", title: "Detail", steps: ["Open"], confirmation: "confirmed" }]; await writeReadyAssets(root, manifest);
  const finalDir = path.join(root, "shiplayer-release/screenshots/final/iphone/en-US");
  await mkdir(finalDir, { recursive: true });
  await writeFile(path.join(finalDir, "home.png"), png(1320, 2868));
  await writeFile(path.join(finalDir, "detail.png"), png(1290, 2796));
  const report = await preflight(root, manifest);
  // Files are inspected in alphabetical order, so "detail.png" sorts before "home.png" and sets
  // the reference size; "home.png" is the one that differs and gets blocked.
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.home.png.dimensions" && item.severity === "block" && item.message.includes("differs from")));
});

test("preflight rejects more than 10 rendered marketing screenshots in one set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-toomany-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const finalDir = path.join(root, "shiplayer-release/screenshots/final/iphone/en-US");
  await mkdir(finalDir, { recursive: true });
  for (let i = 0; i < 11; i++) await writeFile(path.join(finalDir, `slide-${i}.png`), png(1320, 2868));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.count" && item.severity === "block"));
});

// ---------------------------------------------------------------------------------------------
// PR #4 review findings F1-F8: regression coverage.
// ---------------------------------------------------------------------------------------------

// --- F1/F2: no redundant/broken postinstall; export.mjs fails with actionable advice ----------

test("F1: the generated package.json has no postinstall script (current Playwright has none of its own; a redundant one only breaks npm install)", () => {
  const packageJson = JSON.parse(renderPackageJson()) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts.postinstall, undefined);
  assert.equal(packageJson.scripts.export, "node export.mjs");
  assert.deepEqual(Object.keys(packageJson.dependencies || {}), ["playwright"]);
});

test("F1: the generated README documents an explicit playwright install step, not a nonexistent postinstall hook", () => {
  const readme = renderReadme([], DEFAULT_MARKETING_FINAL_DIR);
  assert.ok(readme.includes("npx playwright install chromium"));
  assert.ok(!readme.includes("postinstall"));
});

test("F2: export.mjs wraps the browser launch in try/catch and prints the SHIPLAYER_PW_CHANNEL escape hatch, never bare Playwright install advice", () => {
  assert.ok(EXPORT_MJS.includes("try {\n  browser = await chromium.launch"));
  assert.ok(EXPORT_MJS.includes("catch (error)"));
  assert.ok(EXPORT_MJS.includes("SHIPLAYER_PW_CHANNEL=chrome npm run export"));
  assert.ok(EXPORT_MJS.includes("process.exit(1)"));
});

// --- F3: re-running prepare must not destroy a prior render or npm install --------------------

test("F3: prepare preserves a prior render (screenshots/final) and npm install (marketing/node_modules) across a second prepare", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-preserve-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const first = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");

  // Simulate what a human/agent does between two `prepare` runs: `npm install` inside the
  // marketing project, and running `npm run export` to render a final PNG.
  const nodeModulesMarker = path.join(first.directory, "screenshots/marketing/node_modules/playwright/package.json");
  await mkdir(path.dirname(nodeModulesMarker), { recursive: true });
  await writeFile(nodeModulesMarker, JSON.stringify({ name: "playwright", version: "1.48.0" }));
  const lockFile = path.join(first.directory, "screenshots/marketing/package-lock.json");
  await writeFile(lockFile, "{}");
  const renderedFinal = path.join(first.directory, "screenshots/final/iphone/en-US/home.png");
  await mkdir(path.dirname(renderedFinal), { recursive: true });
  await writeFile(renderedFinal, png(1320, 2868));

  // Re-run prepare exactly as the generated README instructs after confirming a scenario.
  const second = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  assert.equal(second.directory, first.directory);

  assert.equal((await readFile(nodeModulesMarker, "utf8")).includes("playwright"), true, "node_modules must survive a second prepare");
  assert.equal(await readFile(lockFile, "utf8"), "{}", "package-lock.json must survive a second prepare");
  const finalBytes = await readFile(renderedFinal);
  assert.ok(finalBytes.length > 0, "a previously rendered final PNG must survive a second prepare");
  const details = await inspectImage(renderedFinal);
  assert.equal(details?.width, 1320);
  assert.equal(details?.height, 2868);
});

test("F3: a first-ever prepare (nothing to preserve) is unaffected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-preserve-first-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  const pkg = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  assert.ok(pkg.files.includes("screenshots/marketing/export.mjs"));
});

// --- F4: a non-default finalOutputDir must not make check silently skip -----------------------

test("F4: check reads screenshots.finalOutputDir, not a hardcoded convention — a custom location is actually validated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-custom-final-"));
  const manifest = readyManifest(); manifest.screenshots.finalOutputDir = "custom-release/screens"; await writeReadyAssets(root, manifest);
  const customDir = path.join(root, "custom-release/screens/iphone/en-US");
  await mkdir(customDir, { recursive: true });
  // Deliberately bad on two axes at once (wrong display class AND alpha), matching the reviewer's repro.
  await writeFile(path.join(customDir, "home.png"), png(640, 480, true));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.home.png.alpha" && item.severity === "block"), "a bad image at the CONFIGURED finalOutputDir must be caught, not silently skipped");
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.home.png.accepted-dimensions" && item.severity === "block"));
  // The old hardcoded default location must NOT be consulted once finalOutputDir is set explicitly.
  const staleDefaultDir = path.join(root, "shiplayer-release/screenshots/final/iphone/en-US");
  await mkdir(staleDefaultDir, { recursive: true });
  await writeFile(path.join(staleDefaultDir, "home.png"), png(1320, 2868)); // a perfectly valid image at the OLD default
  const secondReport = await preflight(root, manifest);
  // Still exactly the same two blockers from the configured location — the valid image sitting at
  // the stale default must not silently launder the result into a pass.
  assert.ok(secondReport.results.some((item) => item.id === "marketing.iphone.en-US.home.png.alpha" && item.severity === "block"));
});

test("F4: an absent finalOutputDir (a manifest predating the field) still falls back to the documented default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-legacy-final-"));
  const manifest = readyManifest(); delete (manifest.screenshots as { finalOutputDir?: string }).finalOutputDir; await writeReadyAssets(root, manifest);
  const defaultDir = path.join(root, DEFAULT_MARKETING_FINAL_DIR, "iphone/en-US");
  await mkdir(defaultDir, { recursive: true });
  await writeFile(path.join(defaultDir, "home.png"), png(1320, 2868, true));
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "marketing.iphone.en-US.home.png.alpha" && item.severity === "block"));
});

test("F4: generation and validation agree on where a custom finalOutputDir actually renders to", () => {
  const entries = buildMarketingSlideEntries({
    outputDirectory: "shiplayer-release",
    rawOutputDir: "release/raw-screenshots",
    finalOutputDir: "custom-release/screens",
    configurations: [{ device: "iPhone 16 Pro Max", family: "iphone", locale: "en-US", requiredDimensions: { width: 1320, height: 2868 } }],
    scenarios: [{ id: "home", title: "Home", confirmation: "confirmed" }]
  });
  // Marketing project root is shiplayer-release/screenshots/marketing; a custom finalOutputDir
  // that lives entirely outside --out must still resolve to a correct (if longer) relative path.
  assert.equal(entries[0].outputRelativePath, "../../../custom-release/screens/iphone/en-US/home.png");
});

// --- F5: more than 10 scenarios warns at prepare time, not only after a wasted render ----------

test("F5: preflight warns (does not block) when more than 10 scenarios are declared", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-oversized-"));
  const manifest = readyManifest();
  manifest.screenshots.scenarios = Array.from({ length: 12 }, (_, index) => ({ id: `scenario-${index}`, title: `Scenario ${index}`, steps: ["Launch"], confirmation: "confirmed" as const }));
  await writeReadyAssets(root, manifest);
  await rm(path.join(root, "release/raw-screenshots/iphone/en-US/home.png"), { force: true });
  for (const scenario of manifest.screenshots.scenarios) await writeFile(path.join(root, "release/raw-screenshots/iphone/en-US", `${scenario.id}.png`), png(1320, 2868));
  const report = await preflight(root, manifest);
  const warning = report.results.find((item) => item.id === "screenshots.scenarios.count");
  assert.equal(warning?.severity, "warn");
  assert.ok(warning?.message.includes("12"));
});

test("F5: the generated README warns about an oversized set instead of silently reporting the slide count", () => {
  const entries = buildMarketingSlideEntries({
    outputDirectory: "shiplayer-release",
    rawOutputDir: "release/raw-screenshots",
    finalOutputDir: DEFAULT_MARKETING_FINAL_DIR,
    configurations: [{ device: "iPhone 16 Pro Max", family: "iphone", locale: "en-US", requiredDimensions: { width: 1320, height: 2868 } }],
    scenarios: Array.from({ length: 12 }, (_, index) => ({ id: `scenario-${index}`, title: `Scenario ${index}` }))
  });
  const readme = renderReadme(entries, DEFAULT_MARKETING_FINAL_DIR);
  assert.ok(readme.includes("Warning"));
  assert.ok(readme.includes("iphone/en-US has 12"));
});

test("F5: 10 or fewer scenarios triggers no warning, at preflight or in the README", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-marketing-not-oversized-"));
  const manifest = readyManifest(); await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "screenshots.scenarios.count"), false);
  const entries = buildMarketingSlideEntries({ outputDirectory: "shiplayer-release", rawOutputDir: "release/raw-screenshots", finalOutputDir: DEFAULT_MARKETING_FINAL_DIR, configurations: [{ device: "iPhone 16 Pro Max", family: "iphone", locale: "en-US", requiredDimensions: { width: 1320, height: 2868 } }], scenarios: [{ id: "home", title: "Home" }] });
  assert.ok(!renderReadme(entries, DEFAULT_MARKETING_FINAL_DIR).includes("Warning"));
});

// --- F6: alpha must be composited against the known background, never dropped ------------------

function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type: string, data: Buffer): Buffer { const name = Buffer.from(type); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length); return out; }
/** Builds a 1x1 PNG of a specific color. colorType 6 = RGBA (4-tuple), colorType 4 = grayscale+alpha (2-tuple: [gray, alpha]). */
function solidPixelPng(pixel: number[]): Buffer {
  const colorType = pixel.length === 4 ? 6 : 4;
  const row = Buffer.from([0, ...pixel]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(row)), pngChunk("IEND", Buffer.alloc(0))]);
}
/** Reads pixel (0,0) of a PNG stripAlphaPng produced: guaranteed non-interlaced RGB/8-bit/filter-None. */
function firstPixelOfStrippedPng(buffer: Buffer): [number, number, number] {
  let offset = 8; let idat = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat = Buffer.concat([idat, data]);
    if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(idat);
  return [raw[1], raw[2], raw[3]];
}
function compositeOver(src: number, alpha: number, bg: number): number { return Math.round((src * alpha + bg * (255 - alpha)) / 255); }

test("F6: a half-transparent RGBA pixel is composited against the slide background, not left as its own un-blended color", async () => {
  const stripAlphaPng = await loadStripAlpha();
  const input = solidPixelPng([255, 0, 0, 128]); // half-transparent red
  const output = stripAlphaPng(input);
  const [r, g, b] = firstPixelOfStrippedPng(output);
  const [bgR, bgG, bgB] = SLIDE_BACKGROUND_RGB;
  assert.notDeepEqual([r, g, b], [255, 0, 0], "must not be the naive drop-alpha result (pure red)");
  assert.equal(r, compositeOver(255, 128, bgR));
  assert.equal(g, compositeOver(0, 128, bgG));
  assert.equal(b, compositeOver(0, 128, bgB));
});

test("F6: a fully transparent grayscale+alpha pixel becomes exactly the slide background, not opaque gray", async () => {
  const stripAlphaPng = await loadStripAlpha();
  const input = solidPixelPng([200, 0]); // gray=200, alpha=0 (fully transparent)
  const output = stripAlphaPng(input);
  const [r, g, b] = firstPixelOfStrippedPng(output);
  assert.deepEqual([r, g, b], SLIDE_BACKGROUND_RGB, "fully transparent must become the background color, not opaque (200,200,200)");
});

test("F6: a fully opaque RGBA pixel is unaffected by compositing", async () => {
  const stripAlphaPng = await loadStripAlpha();
  const input = solidPixelPng([10, 20, 30, 255]);
  const output = stripAlphaPng(input);
  assert.deepEqual(firstPixelOfStrippedPng(output), [10, 20, 30]);
});

// --- F7: a truncated/short pixel stream must throw, never silently zero-fill -------------------

test("F7: a decompressed pixel stream shorter than expected throws a clear error instead of silently zero-filling the tail", async () => {
  const stripAlphaPng = await loadStripAlpha();
  // Build a structurally valid PNG (correct IHDR, correct CRCs) whose IDAT decompresses to fewer
  // bytes than IHDR's width/height promise -- a corrupt-but-not-obviously-broken file.
  const width = 4; const height = 4; const channels = 4;
  const shortRaw = Buffer.alloc((1 + width * channels) * height - 5); // 5 bytes short of the last row
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const truncated = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(shortRaw)), pngChunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => stripAlphaPng(truncated), /Corrupt PNG/);
});

// --- F8: a caption at the documented max length must not be silently clipped -------------------

test("F8: a long caption at the documented max length gets a smaller font than a short one, not the same size clipped by line-clamp", () => {
  const fontSizeOf = (html: string): number => Number(/\.caption \{[\s\S]*?font-size: (\d+)px;/.exec(html)?.[1]);
  const shortHtml = renderSlideHtml({ id: "home", title: "Home", caption: "Ship faster", confirmed: true, family: "iphone", device: "iPhone 16 Pro Max", locale: "en-US", width: 1320, height: 2868, screenshotPngHref: "x.png", screenshotJpgHref: "x.jpg", frameHref: "f.png", htmlRelativePath: "h.html", outputRelativePath: "o.png" });
  const longHtml = renderSlideHtml({ id: "home", title: "Home", caption: "M".repeat(MAX_CAPTION_LENGTH), confirmed: true, family: "iphone", device: "iPhone 16 Pro Max", locale: "en-US", width: 1320, height: 2868, screenshotPngHref: "x.png", screenshotJpgHref: "x.jpg", frameHref: "f.png", htmlRelativePath: "h.html", outputRelativePath: "o.png" });
  const shortFontSize = fontSizeOf(shortHtml);
  const longFontSize = fontSizeOf(longHtml);
  assert.ok(shortFontSize > 0 && longFontSize > 0);
  assert.ok(longFontSize < shortFontSize, `expected the ${MAX_CAPTION_LENGTH}-char caption (${longFontSize}px) to auto-shrink below the short caption's size (${shortFontSize}px)`);
  assert.ok(longHtml.includes(`M`.repeat(MAX_CAPTION_LENGTH)), "the full caption text must still be present in the DOM (line-clamp is a CSS ellipsis fallback, not truncation of the source text)");
});

// ---------------------------------------------------------------------------------------------
// Found while re-verifying F2 end-to-end: an embedded double-quote inside a nested console.error
// string produced syntactically invalid generated JS (a real "SyntaxError: missing ) after
// argument list" at actual `npm run export` time, not caught by any string-content assertion
// above). Both generated modules are Node ESM syntax-checked directly, permanently, so a future
// edit that reintroduces broken quoting/escaping fails the test suite instead of only surfacing
// when a human/agent actually runs `npm run export`.
// ---------------------------------------------------------------------------------------------

test("EXPORT_MJS and STRIP_ALPHA_MJS are syntactically valid Node ESM (node --check)", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  for (const [name, source] of [["export.mjs", EXPORT_MJS], ["strip-alpha.mjs", STRIP_ALPHA_MJS]] as const) {
    const dir = await mkdtemp(path.join(tmpdir(), "shiplayer-syntax-check-"));
    const file = path.join(dir, name);
    await writeFile(file, source);
    await assert.doesNotReject(execFileAsync(process.execPath, ["--check", file]), `${name} must be syntactically valid`);
  }
});
