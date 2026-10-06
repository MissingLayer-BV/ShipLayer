import path from "node:path";
import type { CreativeAssets, CreativePlacement, CreativeScreenshot } from "./types.js";
import { escapeAttr, escapeHtml, frameForFamily, MARKETING_PROJECT_ROOT, SLIDE_BACKGROUND_HEX, textDirection } from "./marketing.js";

// App Store creative assets (iOS 27): the product page Header image, the Search results image,
// and the optional Universal 16:9 master Apple crops for both. App Store Connect takes them in
// its Header and Search Results tab / Asset Library; its API has no endpoint for them yet, so
// ShipLayer only builds exact-size HTML pages for the marketing project's export.mjs and checks
// the rendered PNGs. Like src/marketing.ts, everything here is a pure string/path builder.
//
// Sizes and art safe areas were measured from Apple's official PSD templates
// (developer.apple.com/app-store/asset-best-practices). Text and the wordmark must stay inside
// the safe area; background and device art may run past it and be cropped.

// Must match src/schema.json's $defs/creativeCopy and creativeAssets.wordmark maxLength exactly
// (schema.json is plain JSON, not importable here), the way MAX_CAPTION_LENGTH mirrors the
// scenario caption limit.
export const MAX_CREATIVE_HEADLINE_LENGTH = 60;
export const MAX_CREATIVE_SUBLINE_LENGTH = 120;
export const MAX_CREATIVE_WORDMARK_LENGTH = 40;

export interface CreativeSafeArea { left: number; top: number; right: number; bottom: number }
export interface CreativePlacementSpec { label: string; width: number; height: number; safeArea: CreativeSafeArea }
export const CREATIVE_PLACEMENTS: CreativePlacement[] = ["header", "searchResults", "universal"];
export const CREATIVE_PLACEMENT_SPECS: Record<CreativePlacement, CreativePlacementSpec> = {
  header: { label: "Header", width: 3840, height: 1646, safeArea: { left: 1097, top: 493, right: 2743, bottom: 1154 } },
  searchResults: { label: "Search results", width: 3840, height: 2560, safeArea: { left: 836, top: 765, right: 3004, bottom: 1795 } },
  universal: { label: "Universal", width: 5244, height: 2950, safeArea: { left: 1921, top: 660, right: 3323, bottom: 1622 } }
};
export const DEFAULT_CREATIVE_STYLE = { background: SLIDE_BACKGROUND_HEX, text: "#1c1b19", secondaryText: "#5f5b55", accent: "#0a7cff" };
/** Relative to the marketing project root (where export.mjs lives). */
export const CREATIVE_PROJECT_DIR = "creative";

// Text sizes as fractions of the safe area's height, per layout. The headline starts at
// headlineMax and the page's own script shrinks it until the whole text block fits; below
// headlineMin it gives up and marks the page.
// - Centred (no device): a short headline fills the space at up to 48% of the safe height.
// - Beside a device: the iPhone search card shows the 3840 px Search results image about 385 pt
//   wide, so the subline keeps at least 7% of the safe height (about 7 pt there) and may take a
//   third line, and the headline never drops below 9.5%, which keeps it at least 1.35x the
//   subline. A 44–60 character headline needs three lines in the text column (Kannada's 46
//   characters fit at 9.9%).
export interface CreativeTextFit { headlineMax: number; headlineMin: number; headlineLines: number; sublineMax: number; sublineMin: number; sublineLines: number }
const CENTERED_TEXT: CreativeTextFit = { headlineMax: 0.48, headlineMin: 0.07, headlineLines: 2, sublineMax: 0.095, sublineMin: 0.045, sublineLines: 2 };
const SIDE_TEXT: CreativeTextFit = { headlineMax: 0.40, headlineMin: 0.095, headlineLines: 3, sublineMax: 0.10, sublineMin: 0.07, sublineLines: 3 };
const WORDMARK_MAX = 0.14;
const WORDMARK_MIN = 0.05;
// Words joined by hyphens ("tap-to-talk") are kept on one line unless that makes the headline
// more than 20% smaller than letting them break at the hyphen ("Tippen-und-Sprechen-Übersetzer").
const HYPHEN_KEEP_RATIO = 0.8;
// Beside a device the text column takes 57% of the safe width (a 3% gap included) and the device
// the rest: at 55% an 88-character Malay subline needed a fourth line at the 7% floor. The
// device is about 1.9x the safe height (never taller than the canvas less a margin above and
// below) and centred on the safe area's middle, so the whole device shows: run off the bottom
// edge, its home area was cropped and the screen read off-centre. It is centred in its column when it fits
// in 90% of it; a wider device keeps its inner edge clear of the text and runs past the safe
// area's outer edge, which Apple allows for device art, but stays a canvas margin from the edge.
const TEXT_COLUMN_OF_SAFE_WIDTH = 0.57;
const DEVICE_HEIGHT_TO_SAFE_HEIGHT = 1.9;
const DEVICE_MAX_WIDTH_OF_COLUMN = 0.9;
const DEVICE_CANVAS_MARGIN = 0.03;
const TEXT_GAP_OF_SAFE_WIDTH = 0.03;
const TEXT_INSET_OF_SAFE_WIDTH = 0.01;

export interface CreativeSlideEntry {
  /** The placement name; with family and locale it names the slide in export.mjs output. */
  id: CreativePlacement;
  placement: CreativePlacement;
  family: `creative-${CreativePlacement}`;
  locale: string;
  width: number;
  height: number;
  safeArea: CreativeSafeArea;
  /** True only when the locale's confirmation is the literal "confirmed". */
  confirmed: boolean;
  wordmark?: string;
  headline: string;
  subline?: string;
  style: typeof DEFAULT_CREATIVE_STYLE;
  screenshot?: { family: "iphone" | "ipad"; pngHref: string; jpgHref: string; frameHref: string };
  /** Relative to the marketing project root. */
  htmlRelativePath: string;
  outputRelativePath: string;
}

type Configurations = Array<{ family: "iphone" | "ipad"; locale: string; sourceLocale?: string }>;

/**
 * Repo-relative raw capture a screenshot placement reads for a locale (without extension): the
 * locale's own capture, or the configuration's sourceLocale when screenshots.configurations
 * declares one for that family/locale, exactly as marketing slides resolve their in-frame pixels.
 */
export function creativeCaptureBasePath(rawOutputDir: string, configurations: Configurations, screenshot: CreativeScreenshot, locale: string): string {
  const rawLocale = configurations.find((config) => config.family === screenshot.family && config.locale === locale)?.sourceLocale ?? locale;
  return path.posix.join(rawOutputDir, screenshot.family, rawLocale, screenshot.capture);
}

/** Repo-relative PNG path for one rendered placement/locale. */
export function creativeOutputPath(outputDir: string, placement: CreativePlacement, locale: string): string { return path.posix.join(outputDir, placement, `${locale}.png`); }

export function declaredCreativePlacements(creative: CreativeAssets): CreativePlacement[] { return CREATIVE_PLACEMENTS.filter((placement) => creative.placements[placement]); }

export function creativePlacementScreenshot(creative: CreativeAssets, placement: CreativePlacement): CreativeScreenshot | undefined {
  return placement === "header" ? undefined : creative.placements[placement]?.screenshot;
}

/**
 * One entry per (declared placement x locale), in placement order. Relative paths are computed
 * against a synthetic "/" root like buildMarketingSlideEntries, so the result does not depend on
 * process.cwd().
 */
export function buildCreativeSlideEntries(params: { outputDirectory: string; rawOutputDir: string; configurations: Configurations; creativeAssets: CreativeAssets }): CreativeSlideEntry[] {
  const creative = params.creativeAssets;
  const abs = (relative: string): string => path.posix.join("/", relative);
  const relativeFrom = (fromDir: string, to: string): string => path.posix.relative(abs(fromDir), abs(to));
  const marketingRoot = path.posix.join(params.outputDirectory, MARKETING_PROJECT_ROOT);
  const style = { ...DEFAULT_CREATIVE_STYLE, ...creative.style };
  const entries: CreativeSlideEntry[] = [];
  for (const placement of declaredCreativePlacements(creative)) {
    const spec = CREATIVE_PLACEMENT_SPECS[placement];
    const slideDir = path.posix.join(marketingRoot, CREATIVE_PROJECT_DIR, placement);
    const screenshot = creativePlacementScreenshot(creative, placement);
    for (const locale of creative.locales) {
      const localized = creative.localizations[locale];
      const copy = localized?.[placement];
      if (!copy) throw new Error(`creativeAssets.localizations.${locale} has no ${placement} copy.`);
      const htmlAbsolute = path.posix.join(slideDir, `${locale}.html`);
      const capture = screenshot ? creativeCaptureBasePath(params.rawOutputDir, params.configurations, screenshot, locale) : undefined;
      entries.push({
        id: placement, placement, family: `creative-${placement}`, locale,
        width: spec.width, height: spec.height, safeArea: spec.safeArea,
        confirmed: localized?.confirmation === "confirmed",
        wordmark: creative.wordmark, headline: copy.headline, subline: copy.subline, style,
        screenshot: screenshot && capture ? {
          family: screenshot.family,
          pngHref: relativeFrom(slideDir, `${capture}.png`),
          jpgHref: relativeFrom(slideDir, `${capture}.jpg`),
          frameHref: relativeFrom(slideDir, path.posix.join(marketingRoot, "assets", `${screenshot.family}-frame.png`))
        } : undefined,
        htmlRelativePath: path.posix.relative(abs(marketingRoot), abs(htmlAbsolute)),
        outputRelativePath: relativeFrom(marketingRoot, creativeOutputPath(creative.outputDir, placement, locale))
      });
    }
  }
  return entries;
}

/** slides.json rows for export.mjs. `textFit` makes export refuse a page whose fitting script did not run. */
export function creativeSlideManifestRows(entries: CreativeSlideEntry[]): object[] {
  return entries.map((entry) => ({ id: entry.id, family: entry.family, device: "App Store creative asset", locale: entry.locale, width: entry.width, height: entry.height, confirmed: entry.confirmed, textFit: true, html: entry.htmlRelativePath, output: entry.outputRelativePath }));
}

interface Box { left: number; top: number; width: number; height: number }

export function creativeLayout(entry: Pick<CreativeSlideEntry, "width" | "height" | "safeArea" | "locale" | "screenshot">): { text: Box; device?: Box; fit: CreativeTextFit } {
  const safe = entry.safeArea;
  const safeWidth = safe.right - safe.left;
  const safeHeight = safe.bottom - safe.top;
  // Glyph ink can overhang its advance box (Arabic initial forms, a bold J), so the text box keeps
  // a small inset from the safe area's edges; the fit script measures against this box.
  const inset = safeWidth * TEXT_INSET_OF_SAFE_WIDTH;
  if (!entry.screenshot) return { text: { left: safe.left + inset, top: safe.top, width: safeWidth - 2 * inset, height: safeHeight }, fit: CENTERED_TEXT };
  const rtl = textDirection(entry.locale) === "rtl";
  const column = safeWidth * TEXT_COLUMN_OF_SAFE_WIDTH;
  const deviceColumn = safeWidth - column;
  const gap = safeWidth * TEXT_GAP_OF_SAFE_WIDTH;
  // Where the text column meets the device column.
  const boundary = rtl ? safe.right - column : safe.left + column;
  const frame = frameForFamily(entry.screenshot.family);
  const aspect = frame.canvasWidthPx / frame.canvasHeightPx;
  const verticalMargin = entry.height * DEVICE_CANVAS_MARGIN;
  let height = Math.min(safeHeight * DEVICE_HEIGHT_TO_SAFE_HEIGHT, entry.height - 2 * verticalMargin);
  let width = height * aspect;
  let left: number;
  if (width <= deviceColumn * DEVICE_MAX_WIDTH_OF_COLUMN) left = (rtl ? safe.left : boundary) + (deviceColumn - width) / 2;
  else {
    const margin = entry.width * DEVICE_CANVAS_MARGIN;
    const room = rtl ? boundary - gap / 2 - margin : entry.width - margin - (boundary + gap / 2);
    if (width > room) { width = room; height = width / aspect; }
    left = rtl ? boundary - gap / 2 - width : boundary + gap / 2;
  }
  return {
    text: { left: rtl ? boundary + gap : safe.left + inset, top: safe.top, width: column - gap - inset, height: safeHeight },
    device: { left, top: safe.top + (safeHeight - height) / 2, width, height },
    fit: SIDE_TEXT
  };
}

// Runs in the page (export.mjs waits for it): finds the largest headline that keeps the whole text
// block inside its box within the line limits, with no word wider than the box. "Inside" is
// measured on each text run's own glyph content box (a Range over its text), not its line box:
// a font's ascent and descent reach past a tight line-height. Hyphenated words are fitted whole
// first (.nobr), then with breaks allowed; breaks win only when keeping them whole costs more than
// HYPHEN_KEEP_RATIO of the headline size, or does not fit at all. If nothing fits at the minimum
// sizes it sets data-shiplayer-overflow, and export.mjs refuses to write the PNG. Nothing is ever
// clipped: the text elements have no overflow:hidden or line-clamp.
const FIT_SCRIPT = `(function () {
  var root = document.documentElement;
  var C = JSON.parse(root.dataset.shiplayerFitConfig);
  var OUTSIDE = "text runs outside the safe area";
  function set(el, size, lineHeight) { el.style.fontSize = size + "px"; el.style.lineHeight = (size * lineHeight) + "px"; }
  function lines(el) { return Math.round(el.getBoundingClientRect().height / parseFloat(el.style.lineHeight)); }
  function wide(el) { return el.scrollWidth > el.clientWidth + 1; }
  function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
  function pass() {
    var box = document.querySelector(".text-box");
    var head = document.querySelector(".headline"), sub = document.querySelector(".subline"), mark = document.querySelector(".wordmark");
    var subSize = C.sublineMax;
    if (sub) for (;;) {
      set(sub, subSize, 1.25);
      if ((lines(sub) <= C.sublineLines && !wide(sub)) || subSize <= C.sublineMin) break;
      subSize = Math.max(C.sublineMin, subSize * 0.96);
    }
    var size = C.headlineMax, problems;
    for (;;) {
      set(head, size, 1.06);
      if (mark) { set(mark, clamp(size * 0.34, C.wordmarkMin, C.wordmarkMax), 1.1); mark.style.marginBottom = (size * 0.14) + "px"; }
      if (sub) { set(sub, Math.min(subSize, Math.max(C.sublineMin, size * 0.5)), 1.25); sub.style.marginTop = (size * 0.18) + "px"; }
      problems = [];
      if (lines(head) > C.headlineLines) problems.push("headline needs more than " + C.headlineLines + " lines");
      if (wide(head)) problems.push("a headline word is wider than the safe area");
      if (sub && lines(sub) > C.sublineLines) problems.push("subline needs more than " + C.sublineLines + " lines");
      if (sub && wide(sub)) problems.push("a subline word is wider than the safe area");
      if (mark && wide(mark)) problems.push("wordmark is wider than the safe area");
      var bounds = box.getBoundingClientRect();
      [mark, head, sub].forEach(function (el) {
        if (!el) return;
        var range = document.createRange(); range.selectNodeContents(el);
        var r = range.getBoundingClientRect();
        if ((r.top < bounds.top - 0.5 || r.bottom > bounds.bottom + 0.5 || r.left < bounds.left - 0.5 || r.right > bounds.right + 0.5) && problems.indexOf(OUTSIDE) < 0) problems.push(OUTSIDE);
      });
      if (!problems.length || size <= C.headlineMin) break;
      size = Math.max(C.headlineMin, size * 0.97);
    }
    return { size: size, problems: problems };
  }
  function fit() {
    var result;
    root.classList.remove("hyphen-breaks");
    if (document.querySelector(".nobr")) {
      root.classList.add("hyphen-breaks");
      var broken = pass();
      root.classList.remove("hyphen-breaks");
      result = pass();
      if (result.problems.length || result.size < C.hyphenKeepRatio * broken.size) { root.classList.add("hyphen-breaks"); result = pass(); }
    } else result = pass();
    if (result.problems.length) root.dataset.shiplayerOverflow = result.problems.join("; ");
    else delete root.dataset.shiplayerOverflow;
    root.dataset.shiplayerFit = "done";
  }
  fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
})();`;

// Wraps each run of words joined by hyphens in a no-wrap span, after escaping (escaping adds no
// whitespace or hyphens). The fit script lifts the no-wrap when keeping them whole costs too much.
function keepHyphenatedWordsWhole(text: string): string { return escapeHtml(text).replace(/\S+[-\u2010\u2011]\S+/gu, (word) => `<span class="nobr">${word}</span>`); }

const UNTRACKED_LANGUAGES = new Set(["ar", "ur", "fa", "hi", "bn", "gu", "kn", "ml", "mr", "or", "pa", "ta", "te", "th", "ja", "ko", "zh"]);

export function renderCreativeHtml(entry: CreativeSlideEntry): string {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const safeHeight = entry.safeArea.bottom - entry.safeArea.top;
  const layout = creativeLayout(entry);
  const centered = !layout.device;
  // Explicit left/right rather than "start", so the Latin wordmark (dir="auto") lines up with an
  // Arabic or Hebrew headline instead of resolving "start" against its own direction.
  const align = centered ? "center" : textDirection(entry.locale) === "rtl" ? "right" : "left";
  // Tight tracking suits Latin, Cyrillic and Greek display type; it breaks Arabic joining and
  // Indic conjuncts and makes CJK glyphs collide, so those scripts keep the font's own spacing.
  const tracking = UNTRACKED_LANGUAGES.has(entry.locale.split("-")[0]) ? "0" : "-0.03em";
  const fitConfig = {
    headlineMax: round(safeHeight * layout.fit.headlineMax), headlineMin: round(safeHeight * layout.fit.headlineMin), headlineLines: layout.fit.headlineLines,
    sublineMax: round(safeHeight * layout.fit.sublineMax), sublineMin: round(safeHeight * layout.fit.sublineMin), sublineLines: layout.fit.sublineLines,
    wordmarkMax: round(safeHeight * WORDMARK_MAX), wordmarkMin: round(safeHeight * WORDMARK_MIN), hyphenKeepRatio: HYPHEN_KEEP_RATIO
  };
  let deviceCss = "";
  let deviceHtml = "";
  if (layout.device && entry.screenshot) {
    const box = layout.device;
    const frame = frameForFamily(entry.screenshot.family);
    const screenWidth = box.width * frame.screenWidthPct;
    const screenHeight = box.height * frame.screenHeightPct;
    deviceCss = `
  .device { position: absolute; left: ${round(box.left)}px; top: ${round(box.top)}px; width: ${round(box.width)}px; height: ${round(box.height)}px; }
  .screenshot-wrap { position: absolute; left: ${round(box.width * frame.screenLeftPct)}px; top: ${round(box.height * frame.screenTopPct)}px; width: ${round(screenWidth)}px; height: ${round(screenHeight)}px; border-radius: ${round(screenWidth * frame.screenRadiusXPct)}px / ${round(screenHeight * frame.screenRadiusYPct)}px; overflow: hidden; background: #D9D2C4; }
  .screenshot-wrap img.screenshot { display: block; width: 100%; height: 100%; object-fit: cover; }
  .device img.frame { position: absolute; inset: 0; width: 100%; height: 100%; }`;
    // A missing capture (PNG, then JPEG) leaves the image undecoded, which export.mjs reports as a
    // failure: a creative asset never renders with a placeholder where the app should be.
    deviceHtml = `
  <div class="device">
    <img class="frame" alt="" src="${escapeAttr(entry.screenshot.frameHref)}">
    <div class="screenshot-wrap">
      <img class="screenshot" alt="" src="${escapeAttr(entry.screenshot.pngHref)}" data-fallback-src="${escapeAttr(entry.screenshot.jpgHref)}"
        onerror="if(!this.dataset.triedFallback){this.dataset.triedFallback='1';this.src=this.dataset.fallbackSrc;}">
    </div>
  </div>`;
  }
  const text = layout.text;
  const badgeSize = Math.round(safeHeight * 0.05);
  return `<!doctype html>
<html lang="${escapeAttr(entry.locale)}" dir="${textDirection(entry.locale)}" data-shiplayer-fit-config="${escapeAttr(JSON.stringify(fitConfig))}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(`${entry.family} ${entry.locale}`)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  * { box-sizing: border-box; }
  body { width: ${entry.width}px; height: ${entry.height}px; overflow: hidden; }
  .canvas {
    position: relative;
    width: ${entry.width}px;
    height: ${entry.height}px;
    overflow: hidden;
    background: ${entry.style.background};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .badge {
    position: absolute;
    top: ${Math.round(entry.safeArea.top * 0.3)}px;
    left: 50%;
    transform: translateX(-50%);
    background: #DC2626;
    color: #FFFFFF;
    font-weight: 700;
    font-size: ${badgeSize}px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: ${Math.round(badgeSize * 0.6)}px ${Math.round(badgeSize * 1.6)}px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .text-box {
    position: absolute;
    left: ${round(text.left)}px;
    top: ${round(text.top)}px;
    width: ${round(text.width)}px;
    height: ${round(text.height)}px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .text { width: 100%; text-align: ${align}; }
  .wordmark { display: block; color: ${entry.style.accent}; font-weight: 800; letter-spacing: -0.02em; white-space: nowrap; }
  .headline { margin: 0; color: ${entry.style.text}; font-weight: 800; letter-spacing: ${tracking}; overflow-wrap: normal; word-break: normal; text-wrap: balance; }
  .subline { margin: 0; color: ${entry.style.secondaryText}; font-weight: 600; overflow-wrap: normal; word-break: normal; text-wrap: balance; }
  .nobr { white-space: nowrap; }
  .hyphen-breaks .nobr { white-space: normal; }${deviceCss}
</style>
</head>
<body>
<div class="canvas">${deviceHtml}
  <div class="text-box">
    <div class="text">
      ${entry.wordmark ? `<div class="wordmark" dir="auto">${escapeHtml(entry.wordmark)}</div>` : ""}
      <h1 class="headline">${keepHyphenatedWordsWhole(entry.headline)}</h1>
      ${entry.subline ? `<p class="subline">${keepHyphenatedWordsWhole(entry.subline)}</p>` : ""}
    </div>
  </div>
  ${entry.confirmed ? "" : `<div class="badge">Draft — needs confirmation</div>`}
</div>
<script>
${FIT_SCRIPT}
</script>
</body>
</html>
`;
}

export function renderCreativeReadmeSection(entries: CreativeSlideEntry[], outputDir: string): string {
  if (!entries.length) return "";
  const unconfirmed = entries.filter((entry) => !entry.confirmed).length;
  const sizes = [...new Set(entries.map((entry) => entry.placement))].map((placement) => { const spec = CREATIVE_PLACEMENT_SPECS[placement]; return `${spec.label} ${spec.width}×${spec.height}`; }).join(", ");
  return `
## App Store creative assets

\`creative/<placement>/<locale>.html\` — ${entries.length} page(s) (${sizes})${unconfirmed ? `, ${unconfirmed} still draft/unconfirmed` : ""}.
\`npm run export\` renders them with the slides to \`${outputDir}/<placement>/<locale>.png\`. Each page fits
its own text inside Apple's art safe area; when a headline or subline cannot fit at the minimum
size, export.mjs writes no PNG for it, names it, and exits non-zero — shorten the copy in
\`creativeAssets.localizations\` and run \`shiplayer prepare\` again. App Store Connect has no API for
creative assets yet: upload the PNGs by hand in its Header and Search Results tab (Asset Library).
`;
}

export type CreativeCopyIssueKind = "url" | "pricing" | "symbol" | "apple-recognition" | "other-platform" | "award";
export interface CreativeCopyIssue { kind: CreativeCopyIssueKind; severity: "block" | "warn"; label: string }

const CURRENCY_SYMBOLS = "$€£¥₺₹₽₩₪₫฿₱₦₴₸₼₾";
const CURRENCY_CODES = "USD|EUR|GBP|JPY|CNY|RMB|TRY|TL|CHF|CAD|AUD|NZD|INR|RUB|KRW|BRL|MXN|SEK|NOK|DKK|PLN|CZK|HUF|ILS|AED|SAR|ZAR|SGD|HKD|TWD|THB|IDR|MYR|PHP|VND|UAH|RON";
// Apple's creative-asset rules: no specific pricing or discounts, no website URLs, no copyright
// symbols, no unverifiable awards, no logos or references to other platforms or marketplaces, no
// Apple recognitions. Regexes over copy are heuristics, so only literal, precise forms block;
// award and ranking claims, which may be true and verifiable, warn.
const CREATIVE_COPY_RULES: Array<CreativeCopyIssue & { pattern: RegExp }> = [
  { kind: "url", severity: "block", label: "a website address", pattern: /\bhttps?:\/\/|\bwww\./i },
  { kind: "url", severity: "block", label: "an email address", pattern: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i },
  { kind: "url", severity: "block", label: "a domain name", pattern: /(?<![\p{L}\p{N}@-])[\p{L}\p{N}][\p{L}\p{N}-]*\.(?:com|net|org|io|app|co|dev|ai|me|info|biz|tv|xyz|store|shop|site|online|link|page|[a-z]{2})(?:\/|(?![\p{L}\p{N}]))/iu },
  { kind: "pricing", severity: "block", label: "a price", pattern: new RegExp(`[${CURRENCY_SYMBOLS}]\\s?\\d|\\d(?:[.,]\\d+)?\\s?[${CURRENCY_SYMBOLS}]`, "u") },
  { kind: "pricing", severity: "block", label: "a price", pattern: new RegExp(`\\b(?:${CURRENCY_CODES})\\s?\\d|\\d(?:[.,]\\d+)?\\s?(?:${CURRENCY_CODES})\\b`) },
  { kind: "pricing", severity: "block", label: "a discount", pattern: /\d\s?%\s?(?:off|discount|rabatt|indirim|descuento|de descuento|de réduction|sconto|korting)(?![\p{L}])|%\s?\d+\s?(?:off|indirim)(?![\p{L}])|\bsave\s+\d+\s?%|\boff\s+\d+\s?%/iu },
  { kind: "symbol", severity: "block", label: "a copyright or trademark symbol", pattern: /[©®™℗℠]|\((?:c|r|tm)\)/i },
  { kind: "apple-recognition", severity: "block", label: "an Apple recognition", pattern: /editor[’']?s[’']?\s+choice|\b(?:app|game)\s+of\s+the\s+(?:day|year)\b|\bapple\s+design\s+awards?\b|\bapp\s+store\s+awards?\b|\bfeatured\s+by\s+apple\b|\bapps?\s+we\s+love\b/i },
  { kind: "other-platform", severity: "block", label: "another platform or marketplace", pattern: /\bandroid\b|\bgoogle\s+play\b|\bplay\s+store\b|\bgalaxy\s+store\b|\bappgallery\b|\bhuawei\b|\bmicrosoft\s+store\b|\bamazon\s+appstore\b|\bxbox\b|\bplaystation\b|\bnintendo\b|\bchrome\s+web\s+store\b/i },
  // Capitalized only: "steam" and "windows" are ordinary words in honest copy.
  { kind: "other-platform", severity: "block", label: "another platform or marketplace", pattern: /\bWindows\b|\bSteam\b/ },
  { kind: "award", severity: "warn", label: "an award or ranking claim", pattern: /\bawards?\b|\baward[-\s]winning\b|\bwinner\b|#\s?1\b|\bnumber\s+one\b|\bbest\s+app\b|\btop[\s-]rated\b/i }
];

/** Forbidden-content findings for one piece of creative-asset copy, at most one per kind. */
export function creativeCopyIssues(text: string): CreativeCopyIssue[] {
  const issues: CreativeCopyIssue[] = [];
  for (const { pattern, ...issue } of CREATIVE_COPY_RULES) {
    if (issues.some((found) => found.kind === issue.kind)) continue;
    // An Apple award ("Apple Design Award") is already blocked; do not also warn about it.
    if (issue.kind === "award" && issues.some((found) => found.kind === "apple-recognition")) continue;
    if (pattern.test(text)) issues.push(issue);
  }
  return issues;
}
