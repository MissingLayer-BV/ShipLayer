# Changelog

## Unreleased

- `screenshots.scenarios[].families` limits a scenario to `iphone` and/or `ipad` (absent: every family), so a set can carry an extra slide such as an iPad-only landscape screenshot. Scenario lists, counts and coverage checks are per family; the draft screenshot gate accepts a landscape image (transposed `requiredDimensions`) in a portrait set.
App Store creative assets (iOS 27):

- New optional `creativeAssets` manifest section (`outputDir`, `wordmark`,
  `style`, `locales`, `placements` of `header` / `searchResults` /
  `universal`, per-locale `localizations` with `confirmation`). `prepare`
  adds exact-size Header (3840×1646), Search results (3840×2560) and
  Universal (5244×2950) pages to the marketing project; `npm run export`
  renders them into `outputDir/<placement>/<locale>.png`. Each page fits its
  own text inside Apple's art safe area; a page that cannot fit is not
  written and the export exits 1. Search results and Universal may show a raw
  capture in a device frame (RTL locales mirror the layout); beside it the
  text column takes 57% of the safe width and the subline keeps a legible
  floor (7% of the safe height, up to three lines). Hyphenated words stay on
  one line unless that costs the headline more than 20% of its size.
- New `creative.*` gates: forbidden copy (prices/discounts, URLs and
  domains, ©/®/™, Apple recognitions, other platforms block; award claims
  warn), unconfirmed locale copy, a missing raw capture, and rendered PNGs of
  the wrong size or with alpha block; not rendered yet warns.
- Upload stays manual (no App Store Connect API yet): `plan` lists
  `manual.creative-assets`. See docs/creative-assets.md.
- export.mjs now refuses any slide whose page reports
  `data-shiplayer-overflow`, removing a stale PNG for it.
- `screenshots.scenarios[].locales` / `excludeLocales` limit a scenario to some App Store locales (one or the other; values from `app.locales`). Caption confirmation, capture plans, marketing slides, preflight coverage and the draft/apply deck counts are per family and locale, so a locale without a slide can still upload its smaller deck.

Gates learned from LinkVoice 1.0 (2), rejected on 2026-09-23:

- `ai-sharing.consent` overrides no longer downgrade consent blockers to
  warnings; declaring one blocks (`ai-sharing.consent-override`). App Review
  rejected a sign-in agreement line as AI consent (5.1.1(i)/5.1.2(i)).
- New `signing.*` gates: a build script that archives with
  `CODE_SIGNING_ALLOWED=NO` while the project declares entitlements blocks
  (export re-signs with the archived binary's entitlements, so Sign in with
  Apple broke on device); Sign in with Apple needs its entitlement and a
  confirmed `build.deviceSignInTest` of the exact build on every shipped
  device family (2.1(a)).
- `plan --remote` reports in-app purchases and subscriptions App Review has
  not received as a `manual.submit-products` step (2.1(b)).

## v0.1.0 — 2026-09-18

Public beta. Install from a git checkout (`npm ci && npm run build`); the
package is not published to npm.

Added:

- Public packaging: MIT license, security policy, contributing guide, CI
  (`npm run check` on every push/PR), issue/PR templates, package metadata,
  and a landing-page README with detail moved to `docs/`.
- Apple readiness gates: required-reason API vs `PrivacyInfo.xcprivacy`
  cross-check, Info.plist purpose-string blocks, duplicate secondary-category
  block — on top of the existing permission-flow, AI-consent, purchase
  presentation, copy-rule, icon, and screenshot gates.
Not in v0.1, by design: final App Review submission, IAP/subscription product
configuration and pricing, App Privacy/age-rating/tax/banking answers, and the
two deferred gaps listed in `docs/automation-boundaries.md`.
