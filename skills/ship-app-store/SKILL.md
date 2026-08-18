---
name: ship-app-store
description: Prepare a native Swift/SwiftUI iPhone and iPad repository for App Store release using ShipLayer. Use when Codex must audit App Store readiness, generate metadata/privacy/support/review artifacts, plan screenshots, validate IAP or subscriptions, or safely discover an app's state in App Store Connect. Enforce a human-confirmed, no-surprises release workflow.
---

# Ship App Store

Use the repository's `shiplayer` CLI for all deterministic work. Do not recreate release logic in prose. Before starting, run `command -v shiplayer` or use the reviewed local checkout's `./dist/index.js`; this private v0.1 package is not assumed to be globally installed or published to npm.

## Workflow

1. Run `shiplayer analyze <repo> --json`. Treat heuristic findings as proposals, never as privacy/legal truth.
2. Run `shiplayer init <repo>` only when no manifest exists. Do not overwrite a manifest without an explicit user request.
3. Ask for confirmation only for facts the scanner cannot prove: pricing, availability, privacy collection/third parties, legal/trader status, App Review contact, and paywall behavior. Never infer that Zero Data Retention, no-training, or disabled provider collection means user data was not shared with the processors that received it.
4. Update and validate `shiplayer.yml`, then run `shiplayer prepare <repo>` and `shiplayer check <repo>`.
5. Preview every generated screenshot, metadata field, privacy/support page, review note, and preflight warning with the user.
6. Run `shiplayer plan <repo>` first. Use `--remote` only with the user's credentials configured as environment variables; it is read-only.
7. Treat `apply` and `submit` as separate explicit user-authorized gates. Do not pass their confirmation flags on the user's behalf. In v0.1 explicit execution reports a manual/unsupported handoff and exits 3; explain that no operation happened.

## App Review hard gates

- For any third-party AI feature, require `aiDataSharing.enabled: true`, exact data sent, purpose, and every intermediary/provider recipient. Mark every processor in that feature pipeline `aiPipelineRecipient: true` while keeping unrelated analytics/payments `false`. Production consent source—not test/fixture/docs text—must render the declared affirmative action, non-AI decline path, and Privacy Policy link before transmission. The affirmative action must explicitly say data is sent/shared/uploaded/transmitted.
- Require a matching public `.md`, `.markdown`, `.html`, `.htm`, or `.txt` privacy-policy artifact that explains how data is obtained/transmitted, every use and recipient, retention/deletion, and same-or-equal processor protection. Do not treat terms-only disclosure, unused code constants, or manifest booleans as sufficient.
- For every non-consumable or subscription, require production evidence that StoreKit `Product.displayPrice` reaches visible release UI and that a custom purchase Button is structurally withheld in the available-product branch or uses a direct safe disabled predicate while product/price is unavailable. Rendered `ProductView`/`SubscriptionStoreView`, and rendered `StoreView` for non-consumables, may own the purchase action when they do not use an unverified custom `ProductViewStyle`. Require direct, non-compound assertions inside credible XCTest or Swift Testing methods for both visible pricing and the unavailable state. Never approve hard-coded, release-excluded, or unused prices/views.
- For subscriptions, also require production and assertion-backed test evidence that the billing period, applicable offer terms, and Terms/Privacy links are visible before purchase. `SubscriptionStoreView` may own the automatic production presentation, but tests and human confirmation must still verify those disclosures.

## Safety

- Never put credentials, `.p8` contents, login passwords, banking data, or tax details in `shiplayer.yml` or generated artifacts.
- Never make or imply legal/privacy compliance. Require explicit human confirmation.
- Do not create initial app records, accept agreements, alter tax/banking/trader declarations, or submit an app without direct user approval.
- Use `shiplayer capture` to inspect the deterministic harness hand-off. v0.1 does not execute generic Simulator capture commands; only run a repository-owned, reviewed UI-test harness on macOS/Xcode.

## Reference

Read [references/workflow.md](references/workflow.md) for the command and safety matrix.
