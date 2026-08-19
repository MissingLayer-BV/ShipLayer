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

interface DeviceBox { left: number; top: number; width: number; height: number }
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
export const MARKETING_FINAL_ROOT = "screenshots/final";

/**
 * Pure path arithmetic (no filesystem access): computes every relative href/output path a slide
 * needs, one entry per (configuration x scenario) pair, so a single scenario id used across
 * multiple device families/locales gets its own correctly-sized, correctly-linked slide. All
 * relative-path math is done against a shared synthetic "/" root so it is independent of
 * process.cwd() and stays deterministic/testable without touching disk.
 */
export function buildMarketingSlideEntries(params: { outputDirectory: string; rawOutputDir: string; configurations: Array<{ device: string; family: "iphone" | "ipad"; locale: string; requiredDimensions: { width: number; height: number } }>; scenarios: Array<{ id: string; title: string; caption?: string; confirmation?: string }> }): MarketingSlideEntry[] {
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
      const outputAbsolute = path.posix.join(params.outputDirectory, MARKETING_FINAL_ROOT, config.family, config.locale, `${scenario.id}.png`);
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
  const fontSize = Math.round(entry.width * CAPTION_FONT_SCALE);
  const captionTop = Math.round(entry.height * CAPTION_TOP_FRACTION) + (entry.confirmed ? 0 : 70);
  const captionSide = Math.round(entry.width * CAPTION_SIDE_MARGIN_FRACTION);
  const hasCaption = Boolean(entry.caption && entry.caption.trim());
  const captionText = hasCaption ? entry.caption!.trim() : entry.title;
  const captionClass = hasCaption ? "caption" : "caption caption-placeholder";
  const round = (value: number): number => Math.round(value * 100) / 100;
  return `<!doctype html>
<html lang="en">
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
    background: #F4EFE7;
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
    -webkit-line-clamp: 3;
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
    scripts: { postinstall: "playwright install chromium", export: "node export.mjs" },
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
import { inflateSync, deflateSync } from "node:zlib";

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
  // Drop alpha (and expand grayscale to RGB) to build RGB raw scanlines, each prefixed with a
  // "None" filter byte.
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
      else if (samplesPerPixel === 2) { r = g = b = reconstructed[inOffset]; }
      else { r = reconstructed[inOffset]; g = reconstructed[inOffset + 1]; b = reconstructed[inOffset + 2]; }
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

const browser = await chromium.launch({ channel: process.env.SHIPLAYER_PW_CHANNEL || undefined });
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

export function renderReadme(entries: MarketingSlideEntry[]): string {
  const families = [...new Set(entries.map((entry) => entry.family))].sort();
  const unconfirmed = entries.filter((entry) => !entry.confirmed).length;
  return `# ShipLayer marketing screenshot composition

Generated by \`shiplayer prepare\`. This is a self-contained, offline-renderable project — the
only dependency is Playwright, and it belongs to this generated project, not to ShipLayer itself.

## Render the final PNGs

\`\`\`
npm install
npm run export
\`\`\`

\`npm install\` also downloads Playwright's bundled Chromium (via its own \`postinstall\` script,
\`playwright install chromium\`) — a one-time, possibly large download. If that download is blocked
or unsupported on your machine/OS, install a browser yourself (\`npx playwright install chromium\`,
or point \`SHIPLAYER_PW_CHANNEL\` at an already-installed browser, e.g. \`SHIPLAYER_PW_CHANNEL=chrome
npm run export\` to use a system-installed Google Chrome instead of downloading one).

This renders every slide in \`slides/\` to \`../final/{family}/{locale}/<scenario-id>.png\`
(i.e. \`shiplayer-release/screenshots/final/...\`, a sibling of this \`marketing/\` directory).
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
