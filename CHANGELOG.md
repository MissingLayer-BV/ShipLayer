# Changelog

## Unreleased

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
