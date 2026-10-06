# App Store creative assets

iOS 27's App Store adds creative assets to the product page: a **Header** image shown behind the top of the page, a **Search results** image shown with the app in search, and an optional **Universal** 16:9 master Apple crops for both. App Store Connect takes them in the version's Header and Search Results tab (or the Asset Library).

ShipLayer renders and checks the PNGs. It does not upload them: the App Store Connect API has no creative-asset endpoint (checked through API release notes 4.5), so upload stays a manual step, listed as `manual.creative-assets` in `shiplayer plan`.

## Sizes and safe areas

Measured from Apple's official templates ([asset best practices](https://developer.apple.com/app-store/asset-best-practices/)). The safe area is (left, top, right, bottom) in pixels.

| Placement | Manifest key | Size | Art safe area |
|---|---|---|---|
| Header | `header` | 3840×1646 | (1097, 493, 2743, 1154) |
| Search results | `searchResults` | 3840×2560 | (836, 765, 3004, 1795) |
| Universal (16:9 master for both) | `universal` | 5244×2950 | (1921, 660, 3323, 1622) |

Key elements (all text, the wordmark) must sit inside the safe area; the background and device art may run past it and be cropped. On iPhone the Search results image shows almost whole; the Header shows a center crop under the status bar.

## Content rules

Apple's rules for creative assets, and what `shiplayer check` does about each:

- No specific pricing or discounts: currency symbols or ISO codes with numbers, "% off", "save 30%" block (`…pricing`).
- No website URLs: URLs, `www.`, domain names and email addresses block (`…url`).
- No copyright or trademark symbols: ©, ®, ™, ℗, ℠ and (c)/(r)/(tm) block (`…symbol`).
- No Apple recognitions: Editor's Choice, App/Game of the Day, Apple Design Award, App Store Award, "featured by Apple" block (`…apple-recognition`).
- No logos or references to other platforms or marketplaces: Android, Google Play, Play Store, Galaxy Store, AppGallery, Huawei, Microsoft Store, Amazon Appstore, Xbox, PlayStation, Nintendo, Chrome Web Store, and capitalized Windows/Steam block (`…other-platform`).
- No unverifiable awards: "award", "award-winning", "winner", "#1", "number one", "best app", "top-rated" warn (`…award`); keep only claims you can verify.
- Suitable for a 4+ rating; short text; localized for every supported language. These are judgment calls ShipLayer cannot check: review every rendered image.

The patterns are heuristics over copy (mostly English and Latin script); a clean result is not an approval.

## Manifest

```yaml
creativeAssets:
  outputDir: app-store-assets/creative     # repo-relative; PNGs at <outputDir>/<placement>/<locale>.png
  wordmark: LinkVoice                      # optional, drawn in the accent colour above the headline
  style:                                   # optional, six-digit hex; defaults shown
    background: "#f4efe7"
    text: "#1c1b19"
    secondaryText: "#5f5b55"
    accent: "#0a7cff"
  locales: [en-US, tr]                     # non-empty, unique, each in app.locales
  placements:                              # at least one of header | searchResults | universal
    header: {}
    searchResults:
      screenshot: { family: iphone, capture: listening }
  localizations:                           # one entry per locale, copy for every declared placement
    en-US:
      confirmation: confirmed
      header: { headline: "Just talk." }
      searchResults: { headline: "An interpreter, not a tap-to-talk translator", subline: "Speak naturally and hear the other language." }
    tr:
      confirmation: needs-human-confirmation
      header: { headline: "Sadece konuşun." }
      searchResults: { headline: "Bas-konuş çevirmen değil, tercüman" }
```

- `headline` is required, at most 60 characters; `subline` is optional, at most 120; the wordmark at most 40. No line breaks.
- `screenshot` (Search results and Universal only) puts a raw capture in a device frame: `<screenshots.rawOutputDir>/<family>/<locale>/<capture>.png` (or `.jpg`), or the configuration's `sourceLocale` deck when `screenshots.configurations` declares one for that family/locale, exactly as marketing slides do. The Header never shows a device.
- `confirmation` works like a localized screenshot caption's: anything but `confirmed`, including absent, blocks check and renders a "Draft — needs confirmation" badge.
- `outputDir` must stay outside `--out` (the next `prepare` replaces that directory), must not overlap `screenshots.rawOutputDir` or `screenshots.finalOutputDir`, and cannot use a reserved path such as `.github` or `node_modules`.

## Layout

Every image is full-bleed `style.background` with the slides' system font stack. The headline is weight 800 in `text` with tight tracking (−0.03em; Arabic, Urdu, Persian, Indic, Thai and CJK keep the font's own spacing), the subline weight 600 in `secondaryText`, the wordmark weight 800 in `accent`. Lines are balanced (`text-wrap: balance`).

- **No screenshot** (the Header always; the others without `screenshot`): wordmark, headline and subline stacked and centred inside the safe area. The headline starts at 48% of the safe height, so a short one fills the space, and takes at most two lines; the subline at most two.
- **With a screenshot**: the text column takes 57% of the safe width (gap included), vertically centred and leading-aligned; the device takes the rest, about 1.9× the safe height tall (never taller than the canvas less a 3% margin above and below) and centred on the safe area's middle, so the whole device shows. The headline may take three lines and never drops below 9.5% of the safe height; the subline may take three lines and never drops below 7% (about 72 px in Search results, which the iPhone search card shows about 385 pt wide), so the headline stays at least 1.35× the subline. A device too wide for its column (an iPhone at full size here, an iPad, or any device in the narrow Universal safe area) keeps its inner edge clear of the text and runs past the safe area's outer edge, which Apple allows for device art, instead of shrinking. Arabic, Hebrew and Urdu mirror the layout: text on the right, device on the left.

Fitting happens in the page: a script shrinks the headline (and, if needed, the subline) until every text run's own glyph box lies inside the safe area, within the line limits, with no word wider than the box. Words joined by hyphens ("tap-to-talk", "paina-ja-puhu-kääntäjä") are kept on one line first; the script fits again with breaks at the hyphens allowed and uses that only when keeping them whole would make the headline more than 20% smaller (a long compound such as "Tippen-und-Sprechen-Übersetzer") or not fit at all. Text is never clipped. When it still does not fit at the minimum size, the page sets `data-shiplayer-overflow`; `export.mjs` then writes no PNG for that slide (removing an older one), names it with the reason, and exits 1.

## Workflow

```
shiplayer prepare <repo>
cd shiplayer-release/screenshots/marketing
npm install
npm run export            # or SHIPLAYER_PW_CHANNEL=chrome npm run export
shiplayer check <repo>
```

`prepare` adds one exact-size page per placement and locale at `screenshots/marketing/creative/<placement>/<locale>.html` to the marketing project, with `slides.json` rows of family `creative-<placement>` whose output is the PNG under `outputDir`. The same `export.mjs` renders them with the screenshot slides and strips any alpha channel.

`check` then reports:

| Gate | Severity |
|---|---|
| `creative.<locale>.confirmation` | block unless `confirmed` |
| `creative.<placement>.<locale>.headline.<kind>`, `….subline.<kind>`, `creative.wordmark.<kind>` | block for `url`, `pricing`, `symbol`, `apple-recognition`, `other-platform`; warn for `award` |
| `creative.<locale>.copy` | pass when a locale's copy is clean |
| `creative.<placement>.<locale>.capture` | block when the raw capture is missing (names the path) or unreadable |
| `creative.<placement>.<locale>.render` | warn when not rendered yet; block when unreadable |
| `creative.<placement>.<locale>.render.alpha` | block |
| `creative.<placement>.<locale>.render.dimensions` | block unless the exact placement size |

Finally, upload each PNG by hand in App Store Connect: the version's Header and Search Results tab, or the Asset Library. ShipLayer will automate this when Apple ships an API for it.
