# Screenshots: harness, CI hand-off, ingestion, marketing composition

ShipLayer never invents app navigation and never runs a simulator itself. This is the full, ordered contract for getting real App Store screenshots, start to finish. Run `shiplayer capture <repo>` at any point to see current state and next steps; it never mutates anything.

## 1. Detect or generate the UI-test harness

- `shiplayer init` scans `*UITests` sources for the `keepScreenshot(named:)` contract (an `XCTAttachment(screenshot: XCUIScreen.main.screenshot())` kept with `.lifetime = .keepAlways`) and proposes each call as a `screenshots.scenarios` entry, always `needs-human-confirmation`.
- If `shiplayer capture <repo>` reports no harness, run `shiplayer prepare <repo>`: it always emits a fillable `screenshots/ui-test-harness-template.swift` and its contract `screenshots/ui-test-harness-contract.md` in the release package, one TODO-navigation stub per declared scenario.
- Fill in the real navigation yourself, using actual knowledge of the app (you have this; ShipLayer does not). Add the file to a UI Testing target, then re-run `shiplayer init --force` (or hand-edit `shiplayer.yml`) so `screenshots.scenarios` reflects it.

## 2. Hand off simulator execution — do not run it yourself

`prepare` also emits `screenshots/capture-workflow.yml`: a `workflow_dispatch`-only, single-simulator, concurrency-guarded GitHub Actions workflow. Each manual run chooses one `screenshots.configurations` family/locale pair. It safely injects `screenshots.localizations.<locale>.launchArguments` through the generated harness helper and uploads namespaced output. It deliberately has no all-locales matrix. It is **not installed anywhere** — a human must copy it into the target app repository's own `.github/workflows/` and press "Run workflow" themselves. macOS CI runners bill roughly 10x; the generated file's header says so.

**If this environment has no macOS/Xcode simulator available (true on this machine as of this install), do not attempt `xcodebuild`, `xcrun simctl`, or any other simulator command.** Tell the user the workflow artifact is ready, ask them to run it (via that generated workflow on a macOS CI runner, or manually on their own Mac), and wait for exported PNGs before continuing. `shiplayer capture <repo>` reports this exact prerequisite gap itself — "Simulator capture requires macOS with Xcode" and/or a missing `xcodebuild`/`xcrun` — so check its output first rather than assuming.

## 3. Ingest exported screenshots

Once PNGs exist locally (from the workflow's downloaded artifact, or a human's local export):

```
shiplayer capture <repo> --from <dir> --family iphone|ipad --locale <locale>
```

This recursively finds image files under `<dir>`, validates format, rejects an alpha channel, requires a dimension accepted for the configuration's own required display class (a 6.5" capture never satisfies a 6.9"-configured slot), requires every image in one family/locale set to be pixel-identical to what's already ingested, then copies matching files into `screenshots.rawOutputDir/{family}/{locale}/<scenario-id>.png`. It is a real, safe local file operation — it never fabricates a screenshot. `shiplayer check` remains the authoritative gate afterward.

## 4. Draft captions

For the primary locale, draft `screenshots.scenarios[].caption`. For every localized deck, draft `screenshots.scenarios[].localizations.<locale>.caption` and leave its separate confirmation pending until a human reviews the rendered translation. ShipLayer never invents these. Once `screenshots.localizations.<locale>` opts a locale into localized capture, `check` blocks a missing or unconfirmed translated caption instead of silently shipping the primary caption.

- Max 100 characters, no line breaks. A wide-script caption (CJK, kana, hangul, fullwidth forms) should be noticeably shorter — those glyphs render close to full width.
- Sell one outcome per slide, not a feature list.
- A caption on an unconfirmed scenario or with an unconfirmed locale override still renders, but with a visible "Draft — needs confirmation" badge — both confirmations must be reviewed.

## 5. Render the marketing composition project

`prepare` emits a self-contained project at `shiplayer-release/screenshots/marketing/`: one exact-pixel HTML slide per (device configuration × scenario) — a device frame holding the raw screenshot from step 3, plus the caption from step 4 — and `package.json` (Playwright is its only dependency), `export.mjs`, `strip-alpha.mjs`, and its own `README.md`. Run the two commands that `README.md` documents:

```
npm install
npx playwright install chromium
npm run export
```

**On this machine, skip the Chromium download — it will not launch.** macOS here (12.7.6) is below Playwright's bundled-Chromium floor. Set the browser channel up front instead:

```
SHIPLAYER_PW_CHANNEL=chrome npm run export
```

(`export.mjs` prints this exact suggestion on failure too, but setting it up front avoids the failed attempt.) Any already-installed Chromium-based browser channel works, not only Chrome.

`export.mjs` renders to `screenshots/final/{family}/{locale}/<scenario-id>.png`; `strip-alpha.mjs` unconditionally re-encodes every PNG without an alpha channel, since Apple rejects transparency. A scenario missing its raw screenshot renders a "Screenshot pending" placeholder instead of failing — re-run `capture --from` (step 3) then re-run `npm run export`.

## 6. Validate

Re-run `shiplayer check <repo>`. It validates whatever exists at `screenshots/final/` the same way it validates raw captures (exact per-display-class dimensions, one uniform size per set, at most 10 per set, no alpha), staying silent only when nothing has been rendered yet.
