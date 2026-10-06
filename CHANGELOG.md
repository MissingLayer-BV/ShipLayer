# Changelog

## Unreleased

- iPhone Duo screenshots: `family: iphone-duo` screenshot configurations with Apple's outer (1398×2034) and inner (2007×2853) display sizes as their own display class, `capture --family iphone-duo`, upload to `APP_IPHONE_DUO` (accepted by App Store Connect but not yet in Apple's API reference, so `check` warns), the draft screenshot flow taking a configured Duo set, and a Duo device frame for marketing slides. A Duo deck uses the `iphone` scenarios. See `docs/screenshots.md`.
- `screenshots.scenarios[].families` limits a scenario to `iphone` and/or `ipad` (absent: every family), so a set can carry an extra slide such as an iPad-only landscape screenshot. Scenario lists, counts and coverage checks are per family; the draft screenshot gate accepts a landscape image (transposed `requiredDimensions`) in a portrait set.

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
