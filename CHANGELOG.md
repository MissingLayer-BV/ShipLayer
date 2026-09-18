# Changelog

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
