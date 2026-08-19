import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest } from "../src/manifest.js";
import { preflight } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { analyzeRepository } from "../src/scanner.js";
import { inspectImage } from "../src/image.js";
import { buildMarketingSlideEntries, renderSlideHtml, STRIP_ALPHA_MJS, MAX_CAPTION_LENGTH } from "../src/marketing.js";
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
