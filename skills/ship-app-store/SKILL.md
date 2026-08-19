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

- `monetization` and `aiDataSharing` are cross-checked against the scan, not trusted at face value.
  - **Monetization.** The check runs for `free` **and** `paid-app` alike (neither models an in-app purchase). If `analyze`/`check` shows StoreKit purchase evidence (a `.purchase(` call corroborated by a StoreKit import or `.displayPrice` in the same file, `.displayPrice`/`ProductView` alone, a `.storekit` product ID, or a legacy `SKPaymentQueue`/`SKPaymentTransactionObserver` signal) while `monetization.type` is `free` or `paid-app`, `check` blocks loudly with `monetization.source-contradiction` (and `purchase.presentation`, since it cannot be verified for an undeclared model). A `free` declaration also needs its own `confirmation: confirmed` — an unconfirmed free declaration blocks on its own, evidence or not.
  - **AI data sharing.** A known AI-provider host is treated as strong evidence **by default**, for any path that is not recognizably documentation/pricing/marketing (`/privacy`, `/terms`, `/docs`, `/pricing`, `/blog`, `/about`, or bare root) — this covers real API paths beyond `/chat/completions`, e.g. `/v1/responses`, `/v1/images/generations`, `:generateContent`. An **unrecognized** host whose path is still inference-API-shaped also blocks, but under a distinct id, `ai-sharing.source-contradiction-ambiguous-endpoint` (the proxied-endpoint case: an app's own backend forwarding to an AI provider) — treat this exactly like the named-provider case when helping the user, but do not claim ShipLayer identified a specific provider when it only matched a path shape. A doc/policy-shaped path on a known host only warns (`ai-sharing.possible-processor-link`); no override is needed to clear a warning.
  - **Known gap:** these checks only see literal URLs actually present in the repository (source code, Info.plist string values, `.xcconfig`/`.pbxproj`/`project.yml` build settings, including arbitrary user-defined URL-valued settings). A base URL injected only via a build/CI environment variable or secret, with a `$(VARIABLE)` indirection and no literal value anywhere in the tracked repo, will not be detected. If you know (from the user, from a Cloudflare Worker or backend in the same repo, from CI config) that the app proxies to a third-party AI provider even though ShipLayer found no direct endpoint, say so and help the user declare `aiDataSharing` anyway — do not treat a clean scan as proof there is no AI data sharing.
  - Never resolve a contradiction blocker by leaving the manifest blank or guessing at the missing fields — either help the user declare the real IAP/subscription model or AI data-sharing disclosure, or, only when the user confirms the finding is not real (e.g. dead code, a docs-only link, sandbox-only scaffolding), add a `sourceContradictionOverrides` entry naming the exact blocker id with a human-authored `reason`, real `evidence` paths, and `confirmation: confirmed`. The evidence path(s) must actually exist and must cite the same file(s) the flagged finding itself points to — citing an unrelated file (e.g. `NOTES.md`) does not and must not resolve the block; ShipLayer verifies the overlap itself, but never construct or suggest an override that doesn't genuinely address the flagged evidence. Never fabricate that reason yourself or set `confirmation: confirmed` without the user's explicit say-so — an override is a human decision, not a heuristic one.
- For any third-party AI feature, require `aiDataSharing.enabled: true`, exact data sent, purpose, and every intermediary/provider recipient. Mark every processor in that feature pipeline `aiPipelineRecipient: true` while keeping unrelated analytics/payments `false`. Production consent source—not test/fixture/docs text—must render the declared affirmative action, non-AI decline path, and Privacy Policy link before transmission. The affirmative action must explicitly say data is sent/shared/uploaded/transmitted.
- Require a matching public `.md`, `.markdown`, `.html`, `.htm`, or `.txt` privacy-policy artifact that explains how data is obtained/transmitted, every use and recipient, retention/deletion, and same-or-equal processor protection. Do not treat terms-only disclosure, unused code constants, or manifest booleans as sufficient.
- For every non-consumable or subscription, require production evidence that StoreKit `Product.displayPrice` reaches visible iOS release UI and that a custom purchase Button is structurally withheld in the available-product branch or uses a direct safe disabled predicate while product/price is unavailable. Rendered `ProductView`/`SubscriptionStoreView`, and rendered `StoreView` for non-consumables, may own the purchase action when they use verified built-in styles. Known iOS, StoreKit, and SwiftUI compilation guards are eligible; arbitrary module guards are not. Require direct, non-compound assertions inside credible XCTest or Swift Testing methods for both visible pricing and the unavailable state. Never approve hard-coded, debug-only, simulator-only, other-platform-only, unknown-conditional, or unused prices/views.
- For subscriptions, also require production and assertion-backed test evidence that the billing period, applicable offer terms, and Terms/Privacy links are visible before purchase. `SubscriptionStoreView` with a built-in `SubscriptionStoreControlStyle` may own the automatic production presentation; an unverified custom control style cannot. Tests and human confirmation must still verify those disclosures.

## Safety

- Never put credentials, `.p8` contents, login passwords, banking data, or tax details in `shiplayer.yml` or generated artifacts.
- Never make or imply legal/privacy compliance. Require explicit human confirmation.
- Do not create initial app records, accept agreements, alter tax/banking/trader declarations, or submit an app without direct user approval.
- Use `shiplayer capture` to inspect the deterministic harness hand-off. v0.1 does not execute generic Simulator capture commands; only run a repository-owned, reviewed UI-test harness on macOS/Xcode.

## Reference

Read [references/workflow.md](references/workflow.md) for the command and safety matrix.
