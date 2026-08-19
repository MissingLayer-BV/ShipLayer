import path from "node:path";

// Marketing screenshot composition: turns a raw device screenshot + an optional human-drafted
// caption into a self-contained, headless-renderable HTML "advertisement" slide (device frame +
// caption + background), and the small Playwright-based export project that turns those slides
// into final App Store PNGs. Nothing here touches the filesystem or the network — every function
// is a pure string builder; src/generator.ts resolves real paths and writes the files.
//
// Layout/asset conventions are adapted from the reference app-store-screenshots skill design
// (~/.codex/skills/app-store-screenshots, not read at runtime — its mockup.png and measured
// screen-overlay percentages are copied into this repo's assets/device-frames/ so ShipLayer works
// on a machine where that skill is not installed).

export interface FrameGeometry {
  /** The frame PNG's own pixel dimensions, used only to preserve its aspect ratio. */
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** Where the raw screenshot shows through the frame, as a fraction of the frame's own box. */
  screenLeftPct: number;
  screenTopPct: number;
  screenWidthPct: number;
  screenHeightPct: number;
  /** Elliptical corner radius of the screen cutout, as a fraction of the screen box's own width/height. */
  screenRadiusXPct: number;
  screenRadiusYPct: number;
  /** Filename under assets/device-frames/ (also the emitted assets/<name> filename). */
  assetFile: string;
}

// Measured directly from the reference skill's template/src/lib/constants.ts PHONE_SCREEN
// overlay against its 1022x2082 mockup.png (52,46)-(52+918,46+1990), corner radius 126.
export const IPHONE_FRAME: FrameGeometry = { canvasWidthPx: 1022, canvasHeightPx: 2082, screenLeftPct: 52 / 1022, screenTopPct: 46 / 2082, screenWidthPct: 918 / 1022, screenHeightPct: 1990 / 2082, screenRadiusXPct: 126 / 918, screenRadiusYPct: 126 / 1990, assetFile: "iphone-frame.png" };
// Generated geometric frame (no reference asset exists for iPad): a flat rounded bezel with a
// rounded transparent screen cutout, produced at assets/device-frames/ipad-frame.png. The pixel
// geometry below must match exactly what generated that file (see docs comment there / PR body).
export const IPAD_FRAME: FrameGeometry = { canvasWidthPx: 1600, canvasHeightPx: 2078, screenLeftPct: 70 / 1600, screenTopPct: 70 / 2078, screenWidthPct: 1460 / 1600, screenHeightPct: 1938 / 2078, screenRadiusXPct: 40 / 1460, screenRadiusYPct: 40 / 1938, assetFile: "ipad-frame.png" };

export function frameForFamily(family: "iphone" | "ipad"): FrameGeometry { return family === "iphone" ? IPHONE_FRAME : IPAD_FRAME; }

// Must match src/schema.json's $defs/scenario.caption maxLength exactly; kept as two literals
// (schema.json is plain JSON, not importable here) rather than one shared constant.
export const MAX_CAPTION_LENGTH = 100;

const DEVICE_HEIGHT_FRACTION = 0.72;
const DEVICE_WIDTH_CAP_FRACTION = 0.9;
const DEVICE_BOTTOM_MARGIN_FRACTION = 0.045;
const CAPTION_TOP_FRACTION = 0.055;
const CAPTION_SIDE_MARGIN_FRACTION = 0.08;
const CAPTION_FONT_SCALE = 0.062;
const CAPTION_MIN_FONT_SCALE = 0.028;
const CAPTION_MAX_LINES = 3;
// Node has no real text-measurement API, so this is an estimate (average glyph advance, as a
// fraction of font-size, for a bold system-sans headline) — not exact per-glyph shaping. It exists
// to keep the documented max-length caption (100 characters, see MAX_CAPTION_LENGTH) from visibly
// clipping under the CSS line-clamp below, by shrinking the font for a long caption rather than
// silently truncating it. Short captions are unaffected and keep the original, larger size.

// The one background color every slide uses. A single canonical constant so the CSS below and
// strip-alpha.mjs's alpha-compositing (see stripAlphaPng) can never drift out of sync with each
// other — compositing against the wrong background would produce a visibly wrong-colored PNG.
export const SLIDE_BACKGROUND_RGB: [number, number, number] = [244, 239, 231];
export const SLIDE_BACKGROUND_HEX = `#${SLIDE_BACKGROUND_RGB.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

interface DeviceBox { left: number; top: number; width: number; height: number }
// A rough average glyph-advance ratio (fraction of font-size) for a bold system-sans headline —
// Node has no real text-shaping API to measure exactly. Used only to shrink the font for a long
// caption so it does not visibly clip under the fixed CAPTION_MAX_LINES CSS line-clamp.
const CAPTION_AVG_CHAR_WIDTH_EM = 0.58;
function fitCaptionFontSize(canvasWidth: number, areaWidth: number, text: string): number {
  const minFontSize = Math.max(1, Math.round(canvasWidth * CAPTION_MIN_FONT_SCALE));
  let fontSize = Math.round(canvasWidth * CAPTION_FONT_SCALE);
  while (fontSize > minFontSize) {
    const charsPerLine = Math.floor(areaWidth / (fontSize * CAPTION_AVG_CHAR_WIDTH_EM));
    if (text.length <= charsPerLine * CAPTION_MAX_LINES) break;
    fontSize -= 2;
  }
  return fontSize;
}
function computeDeviceBox(canvasWidth: number, canvasHeight: number, frame: FrameGeometry): DeviceBox {
  const aspect = frame.canvasWidthPx / frame.canvasHeightPx;
  let height = canvasHeight * DEVICE_HEIGHT_FRACTION;
  let width = height * aspect;
  const maxWidth = canvasWidth * DEVICE_WIDTH_CAP_FRACTION;
  if (width > maxWidth) { width = maxWidth; height = width / aspect; }
  const left = (canvasWidth - width) / 2;
  const bottom = canvasHeight * DEVICE_BOTTOM_MARGIN_FRACTION;
  const top = canvasHeight - bottom - height;
  return { left, top, width, height };
}

export interface MarketingSlideEntry {
  id: string;
  title: string;
  caption?: string;
  /** True only when the owning scenario's confirmation is the literal string "confirmed" —
   * mirrors preflight.ts's screenshots.scenarios.<id>.confirmation gate exactly (see round-2/3
   * review history in generator.ts: an absent field is NOT confirmed). */
  confirmed: boolean;
  family: "iphone" | "ipad";
  device: string;
  locale: string;
  width: number;
  height: number;
  /** Relative to the slide's own HTML file. */
  screenshotPngHref: string;
  screenshotJpgHref: string;
  frameHref: string;
  /** Relative to the marketing project root (where export.mjs lives). */
  htmlRelativePath: string;
  outputRelativePath: string;
}

/** Relative to the emitted release package's own output directory (e.g. "shiplayer-release"). */
export const MARKETING_PROJECT_ROOT = "screenshots/marketing";
/**
 * Default, repo-root-relative location for rendered final PNGs, used only when a manifest
 * predates screenshots.finalOutputDir or leaves it unset. Once a manifest has run through
 * `shiplayer prepare`, the ACTUAL location is always screenshots.finalOutputDir — an explicit,
 * persisted field, deliberately independent of whatever --out was used at generation time,
 * exactly like screenshots.rawOutputDir already is. This is what lets `shiplayer check`, which
 * receives no --out, find the same directory export.mjs actually wrote to instead of guessing a
 * hardcoded convention that silently stops matching reality under a custom --out (see PR review
 * finding F4: a custom --out previously made preflight's marketing checks silently report
 * nothing, no different from "validated and fine").
 */
export const DEFAULT_MARKETING_FINAL_DIR = "shiplayer-release/screenshots/final";

/**
 * Pure path arithmetic (no filesystem access): computes every relative href/output path a slide
 * needs, one entry per (configuration x scenario) pair, so a single scenario id used across
 * multiple device families/locales gets its own correctly-sized, correctly-linked slide. All
 * relative-path math is done against a shared synthetic "/" root so it is independent of
 * process.cwd() and stays deterministic/testable without touching disk.
 */
export function buildMarketingSlideEntries(params: { outputDirectory: string; rawOutputDir: string; finalOutputDir: string; configurations: Array<{ device: string; family: "iphone" | "ipad"; locale: string; requiredDimensions: { width: number; height: number } }>; scenarios: Array<{ id: string; title: string; caption?: string; confirmation?: string }> }): MarketingSlideEntry[] {
  const abs = (relative: string): string => path.posix.join("/", relative);
  const relativeFrom = (fromDir: string, to: string): string => path.posix.relative(abs(fromDir), abs(to));
  const marketingRoot = path.posix.join(params.outputDirectory, MARKETING_PROJECT_ROOT);
  const entries: MarketingSlideEntry[] = [];
  for (const config of params.configurations) {
    const slideDir = path.posix.join(marketingRoot, "slides", config.family, config.locale);
    for (const scenario of params.scenarios) {
      const htmlAbsolute = path.posix.join(slideDir, `${scenario.id}.html`);
      const screenshotPngAbsolute = path.posix.join(params.rawOutputDir, config.family, config.locale, `${scenario.id}.png`);
      const screenshotJpgAbsolute = path.posix.join(params.rawOutputDir, config.family, config.locale, `${scenario.id}.jpg`);
      const frameAbsolute = path.posix.join(marketingRoot, "assets", `${config.family}-frame.png`);
      const outputAbsolute = path.posix.join(params.finalOutputDir, config.family, config.locale, `${scenario.id}.png`);
      entries.push({
        id: scenario.id, title: scenario.title, caption: scenario.caption, confirmed: scenario.confirmation === "confirmed",
        family: config.family, device: config.device, locale: config.locale,
        width: config.requiredDimensions.width, height: config.requiredDimensions.height,
        screenshotPngHref: relativeFrom(slideDir, screenshotPngAbsolute),
        screenshotJpgHref: relativeFrom(slideDir, screenshotJpgAbsolute),
        frameHref: relativeFrom(slideDir, frameAbsolute),
        htmlRelativePath: path.posix.relative(abs(marketingRoot), abs(htmlAbsolute)),
        outputRelativePath: relativeFrom(marketingRoot, outputAbsolute)
      });
    }
  }
  return entries;
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function escapeAttr(value: string): string { return escapeHtml(value).replaceAll("'", "&#39;"); }

export function renderSlideHtml(entry: MarketingSlideEntry): string {
  const frame = frameForFamily(entry.family);
  const box = computeDeviceBox(entry.width, entry.height, frame);
  const screenLeft = box.left + box.width * frame.screenLeftPct;
  const screenTop = box.top + box.height * frame.screenTopPct;
  const screenWidth = box.width * frame.screenWidthPct;
  const screenHeight = box.height * frame.screenHeightPct;
  const radiusX = screenWidth * frame.screenRadiusXPct;
  const radiusY = screenHeight * frame.screenRadiusYPct;
  const captionTop = Math.round(entry.height * CAPTION_TOP_FRACTION) + (entry.confirmed ? 0 : 70);
  const captionSide = Math.round(entry.width * CAPTION_SIDE_MARGIN_FRACTION);
  const hasCaption = Boolean(entry.caption && entry.caption.trim());
  const captionText = hasCaption ? entry.caption!.trim() : entry.title;
  const captionClass = hasCaption ? "caption" : "caption caption-placeholder";
  const fontSize = fitCaptionFontSize(entry.width, entry.width - 2 * captionSide, captionText);
  const round = (value: number): number => Math.round(value * 100) / 100;
  return `<!doctype html>
<html lang="${escapeAttr(entry.locale)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(entry.id)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  * { box-sizing: border-box; }
  body { width: ${entry.width}px; height: ${entry.height}px; overflow: hidden; }
  .canvas {
    position: relative;
    width: ${entry.width}px;
    height: ${entry.height}px;
    background: ${SLIDE_BACKGROUND_HEX};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .badge {
    position: absolute;
    top: ${Math.round(entry.height * CAPTION_TOP_FRACTION)}px;
    left: 50%;
    transform: translateX(-50%);
    background: #DC2626;
    color: #FFFFFF;
    font-weight: 700;
    font-size: ${Math.round(fontSize * 0.28)}px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: ${Math.round(fontSize * 0.18)}px ${Math.round(fontSize * 0.5)}px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .caption {
    position: absolute;
    top: ${captionTop}px;
    left: ${captionSide}px;
    right: ${captionSide}px;
    text-align: center;
    color: #171717;
    font-weight: 800;
    font-size: ${fontSize}px;
    line-height: 1.08;
    letter-spacing: -0.02em;
    display: -webkit-box;
    -webkit-line-clamp: ${CAPTION_MAX_LINES};
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-wrap: break-word;
  }
  .caption-placeholder { color: #8A8A8A; font-weight: 700; font-style: italic; }
  .device {
    position: absolute;
    left: ${round(box.left)}px;
    top: ${round(box.top)}px;
    width: ${round(box.width)}px;
    height: ${round(box.height)}px;
  }
  .screenshot-wrap {
    position: absolute;
    left: ${round(screenLeft - box.left)}px;
    top: ${round(screenTop - box.top)}px;
    width: ${round(screenWidth)}px;
    height: ${round(screenHeight)}px;
    border-radius: ${round(radiusX)}px / ${round(radiusY)}px;
    overflow: hidden;
    background: #D9D2C4;
  }
  .screenshot-wrap img.screenshot {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .screenshot-wrap .missing {
    display: none;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    text-align: center;
    color: #6B6B6B;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: ${Math.round(fontSize * 0.3)}px;
    padding: 8%;
  }
  .device img.frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
</style>
</head>
<body>
<div class="canvas">
  ${entry.confirmed ? "" : `<div class="badge">Draft — needs confirmation</div>`}
  <div class="${captionClass}">${escapeHtml(captionText)}</div>
  <div class="device">
    <img class="frame" alt="" src="${escapeAttr(entry.frameHref)}">
    <div class="screenshot-wrap">
      <img class="screenshot" alt="" src="${escapeAttr(entry.screenshotPngHref)}" data-fallback-src="${escapeAttr(entry.screenshotJpgHref)}"
        onerror="if(!this.dataset.triedFallback){this.dataset.triedFallback='1';this.src=this.dataset.fallbackSrc;}else{this.style.display='none';this.nextElementSibling.style.display='flex';}">
      <div class="missing">Screenshot pending for scenario '${escapeHtml(entry.id)}' — run shiplayer capture, then re-run export.</div>
    </div>
  </div>
</div>
</body>
</html>
`;
}

export function renderPackageJson(): string {
  return `${JSON.stringify({
    name: "shiplayer-marketing-screenshots",
    private: true,
    version: "1.0.0",
    type: "module",
    description: "Generated by ShipLayer. Renders shiplayer-release/screenshots/marketing/slides/**/*.html to final PNGs with Playwright. Not part of the ShipLayer CLI itself.",
    scripts: { export: "node export.mjs" },
    dependencies: { playwright: "^1.48.0" }
  }, null, 2)}\n`;
}

// The alpha-stripping algorithm below is deliberately unconditional: Playwright/Chromium's PNG
// screenshot encoder already omits the alpha channel for a fully opaque page in current versions,
// but that is an implementation detail we do not control and must not silently rely on — a future
// Chromium/Playwright version, or a slide whose CSS ends up translucent, could reintroduce an
// alpha channel, producing exactly the file shiplayer's own inspectImage()/preflight rejects. This
// function decodes the raw PNG (any of Chromium's plausible 8-bit outputs: grayscale, grayscale
// +alpha, RGB, RGBA) and re-encodes it as a true color-type-2 RGB PNG with no alpha channel and no
// tRNS chunk at all, so the invariant holds regardless of what the browser produced.
//
// This is its own zero-import module (only node:zlib/node:buffer builtins) so it can run, and be
// unit-tested against ShipLayer's own inspectImage(), completely independent of Playwright, which
// is never a ShipLayer dependency (see test/marketing.test.ts).
export const STRIP_ALPHA_MJS = `// Generated by ShipLayer. Decodes a PNG (any 8-bit, non-interlaced color type Chromium's
// screenshot encoder plausibly emits) and re-encodes it as a true color-type-2 RGB PNG with no
// alpha channel. Zero imports beyond Node builtins — see src/marketing.ts for why this must never
// depend on Playwright being installed to be tested.
//
// Any pixel with partial/full transparency is composited (the standard "over" operator) against
// the exact background color every generated slide uses, never simply dropped — dropping alpha
// silently turns e.g. a fully transparent pixel into an opaque, wrong-colored one. Kept in sync
// with the slide CSS by construction: both come from SLIDE_BACKGROUND_RGB in src/marketing.ts.
import { inflateSync, deflateSync } from "node:zlib";

const BG_R = 244;
const BG_G = 239;
const BG_B = 231;
function compositeOver(src, alpha, bg) {
  return Math.round((src * alpha + bg * (255 - alpha)) / 255);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
export function stripAlphaPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("Not a PNG file.");
  let offset = 8;
  let width, height, bitDepth, colorType, interlace;
  const idatParts = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") { idatParts.push(data); }
    else if (type === "IEND") { break; }
    offset += 12 + length;
  }
  if (!width || !height) throw new Error("Malformed PNG: missing IHDR.");
  if (bitDepth !== 8) throw new Error(\`Unsupported PNG bit depth \${bitDepth}; expected 8.\`);
  if (interlace !== 0) throw new Error("Unsupported interlaced PNG.");
  const samplesPerPixel = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!samplesPerPixel) throw new Error(\`Unsupported PNG color type \${colorType}.\`);
  const raw = inflateSync(Buffer.concat(idatParts));
  const rowBytes = width * samplesPerPixel;
  if (raw.length !== height * (1 + rowBytes)) throw new Error(\`Corrupt PNG: decompressed pixel data is \${raw.length} bytes, expected \${height * (1 + rowBytes)} for \${width}x\${height} at \${samplesPerPixel} samples/pixel.\`);
  const reconstructed = Buffer.alloc(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[src++];
    const rowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[src++];
      const a = x >= samplesPerPixel ? reconstructed[rowStart + x - samplesPerPixel] : 0;
      const b = y > 0 ? reconstructed[rowStart - rowBytes + x] : 0;
      const c = y > 0 && x >= samplesPerPixel ? reconstructed[rowStart - rowBytes + x - samplesPerPixel] : 0;
      let value;
      if (filterType === 0) value = rawByte;
      else if (filterType === 1) value = rawByte + a;
      else if (filterType === 2) value = rawByte + b;
      else if (filterType === 3) value = rawByte + Math.floor((a + b) / 2);
      else if (filterType === 4) value = rawByte + paeth(a, b, c);
      else throw new Error(\`Unsupported PNG filter type \${filterType}.\`);
      reconstructed[rowStart + x] = value & 0xff;
    }
  }
  // Composite any alpha channel against the known slide background (the standard "over"
  // operator) rather than dropping it — a dropped alpha channel silently turns e.g. a fully
  // transparent pixel into an opaque, wrong-colored one, which check's alpha gate would no longer
  // catch. Opaque inputs (no alpha channel at all: colorType 0/2) pass through unchanged.
  const outRowBytes = width * 3;
  const outRaw = Buffer.alloc(height * (1 + outRowBytes));
  for (let y = 0; y < height; y++) {
    let outOffset = y * (1 + outRowBytes);
    outRaw[outOffset++] = 0; // filter: None
    const inRowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const inOffset = inRowStart + x * samplesPerPixel;
      let r, g, b;
      if (samplesPerPixel === 1) { r = g = b = reconstructed[inOffset]; }
      else if (samplesPerPixel === 3) { r = reconstructed[inOffset]; g = reconstructed[inOffset + 1]; b = reconstructed[inOffset + 2]; }
      else if (samplesPerPixel === 2) {
        const gray = reconstructed[inOffset]; const alpha = reconstructed[inOffset + 1];
        r = compositeOver(gray, alpha, BG_R); g = compositeOver(gray, alpha, BG_G); b = compositeOver(gray, alpha, BG_B);
      } else {
        const alpha = reconstructed[inOffset + 3];
        r = compositeOver(reconstructed[inOffset], alpha, BG_R);
        g = compositeOver(reconstructed[inOffset + 1], alpha, BG_G);
        b = compositeOver(reconstructed[inOffset + 2], alpha, BG_B);
      }
      outRaw[outOffset++] = r; outRaw[outOffset++] = g; outRaw[outOffset++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = deflateSync(outRaw, { level: 9 });
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}
`;

export const EXPORT_MJS = `#!/usr/bin/env node
// Generated by ShipLayer. Renders every slide under slides/**/*.html to a final PNG using
// Playwright. This script has no network dependency at render time: every slide references only
// local files by relative path. Playwright itself is installed from npm by "npm install" (a
// one-time setup step a human runs; ShipLayer itself never runs it).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { stripAlphaPng } from "./strip-alpha.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(scriptDir, "slides.json"), "utf8"));

if (!manifest.slides.length) {
  console.log("No slides declared in slides.json (no screenshot scenarios yet). Nothing to export.");
  process.exit(0);
}

let browser;
try {
  browser = await chromium.launch({ channel: process.env.SHIPLAYER_PW_CHANNEL || undefined });
} catch (error) {
  console.error("Failed to launch a browser for rendering.");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error("If Playwright's bundled Chromium download failed or is unsupported on your OS,");
  console.error("point SHIPLAYER_PW_CHANNEL at a browser you already have installed instead of");
  console.error("downloading one, e.g.:");
  console.error("");
  console.error("    SHIPLAYER_PW_CHANNEL=chrome npm run export");
  console.error("");
  console.error("(chrome/chromium/msedge are common channel values; see Playwright's docs for the");
  console.error("full list.) Do not follow generic Playwright 'npx playwright install' advice from");
  console.error("here without first trying the channel override above.");
  process.exit(1);
}
try {
  for (const slide of manifest.slides) {
    const htmlPath = path.join(scriptDir, slide.html);
    const outputPath = path.join(scriptDir, slide.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const context = await browser.newContext({ viewport: { width: slide.width, height: slide.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href);
    // See strip-alpha.mjs for why the raw Chromium PNG is always re-encoded, unconditionally,
    // before being written to disk: this is the one invariant App Store submission depends on.
    const raw = await page.screenshot({ type: "png" });
    const flattened = stripAlphaPng(raw);
    await writeFile(outputPath, flattened);
    await context.close();
    console.log(\`\${slide.id} (\${slide.family}/\${slide.locale}) -> \${path.relative(scriptDir, outputPath)} [\${slide.width}x\${slide.height}]\`);
  }
} finally {
  await browser.close();
}
`;

export function renderSlidesManifestJson(entries: MarketingSlideEntry[]): string {
  return `${JSON.stringify({ version: 1, slides: entries.map((entry) => ({ id: entry.id, family: entry.family, device: entry.device, locale: entry.locale, width: entry.width, height: entry.height, confirmed: entry.confirmed, html: entry.htmlRelativePath, output: entry.outputRelativePath })) }, null, 2)}\n`;
}

export function renderReadme(entries: MarketingSlideEntry[], finalOutputDir: string): string {
  const families = [...new Set(entries.map((entry) => entry.family))].sort();
  const unconfirmed = entries.filter((entry) => !entry.confirmed).length;
  const perSetCounts = new Map<string, number>();
  for (const entry of entries) { const key = `${entry.family}/${entry.locale}`; perSetCounts.set(key, (perSetCounts.get(key) || 0) + 1); }
  const oversizedSets = [...perSetCounts.entries()].filter(([, count]) => count > 10);
  const oversizedWarning = oversizedSets.length ? `\n> **Warning:** App Store allows at most 10 screenshots per family/locale set. ${oversizedSets.map(([key, count]) => `${key} has ${count}`).join(", ")}. Reduce screenshots.scenarios in shiplayer.yml to 10 or fewer, or \`shiplayer check\` will block the resulting set(s) after you render them.\n` : "";
  return `# ShipLayer marketing screenshot composition
${oversizedWarning}
Generated by \`shiplayer prepare\`. This is a self-contained, offline-renderable project — the
only dependency is Playwright, and it belongs to this generated project, not to ShipLayer itself.

## Render the final PNGs

\`\`\`
npm install
npx playwright install chromium   # one-time browser download; Playwright does not do this for you
npm run export
\`\`\`

If the bundled Chromium download is blocked or unsupported on your machine/OS (Playwright drops
support for old OS versions over time), point \`SHIPLAYER_PW_CHANNEL\` at an already-installed
browser instead of downloading one, e.g. \`SHIPLAYER_PW_CHANNEL=chrome npm run export\` to use a
system-installed Google Chrome. \`export.mjs\` also prints this exact suggestion if the browser
launch fails.

This renders every slide in \`slides/\` to \`${finalOutputDir}/{family}/{locale}/<scenario-id>.png\`
(each slide's exact output path is also in \`slides.json\`, relative to this \`marketing/\`
directory). This is \`screenshots.finalOutputDir\` in shiplayer.yml — \`shiplayer check <repo>\`
reads the same field, so it always looks in the same place export.mjs actually wrote to, even
after a custom \`--out\`.
Then run \`shiplayer check <repo>\` from the app repository to validate the rendered PNGs the same
way raw captures are validated: exact per-display-class dimensions, one uniform size per
family/locale set, at most 10 per set, and no alpha channel (Apple rejects screenshots with
transparency — every exported PNG here is re-encoded without an alpha channel regardless of what
the browser produced; see export.mjs).

## What to check before submitting

- Every slide with a "Draft — needs confirmation" badge belongs to a screenshot scenario whose
  \`confirmation\` in shiplayer.yml is not \`confirmed\`. Verify the real on-screen navigation, set
  \`confirmation: confirmed\`, then re-run \`shiplayer prepare\` and re-export.
- A slide with an italic gray headline has no drafted \`caption\` yet (it falls back to the
  scenario title so the slide still renders legibly) — write a real, human-reviewed caption in
  \`screenshots.scenarios[].caption\` in shiplayer.yml. One idea per slide; sell an outcome, not a
  feature list. Max ${MAX_CAPTION_LENGTH} characters, no line breaks.
- A "Screenshot pending" placeholder means no raw screenshot has been ingested yet for that
  scenario/family/locale. Run \`shiplayer capture <repo> --from <dir> --family <family> --locale
  <locale>\`, then re-run export.
- This project renders offline: every slide references only local files (the raw screenshot and
  the device frame image) by relative path. Do not add a remote font, script, or image reference —
  it will render differently (or not at all) without network access, and differently between your
  machine and any other machine that renders this project.

## Contents

- \`slides/<family>/<locale>/<scenario-id>.html\` — ${entries.length} slide(s) across ${families.length ? families.join(", ") : "no"} device famil${families.length === 1 ? "y" : "ies"}${unconfirmed ? ` (${unconfirmed} still draft/unconfirmed)` : ""}.
- \`assets/\` — device frame image(s) copied into this project so it has no external dependency.
- \`slides.json\` — the manifest export.mjs reads; do not hand-edit, it is regenerated by \`shiplayer prepare\`.
- \`export.mjs\` / \`strip-alpha.mjs\` / \`package.json\` — the render step. strip-alpha.mjs has no
  dependency of its own; it re-encodes every rendered PNG without an alpha channel.
`;
}
