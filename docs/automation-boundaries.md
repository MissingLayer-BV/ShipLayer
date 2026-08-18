# Automation boundaries

ShipLayer can prepare facts, drafts, asset plans, and an idempotent remote change plan. It cannot create legal truth from source code.

| Capability | v0.1 boundary |
|---|---|
| Swift/Xcode facts | Detect with evidence; report contradictions and unknowns. |
| Privacy and legal copy | Draft from confirmed facts; human reviews and publishes. |
| Screenshot capture | Produce a deterministic harness hand-off. A repository must declare and test its own UI-test capture adapter; v0.1 executes no generic capture command. |
| App Store Connect | JWT-based read/discovery. Writes are reported as manual until independently tested. |
| Subscriptions/IAP | Block readiness unless comment-stripped, role-checked production source visibly presents StoreKit pricing (or a StoreKit-owned merchandising view), handles unavailable/loading state, and conventional test assertions verify both. Custom subscription source and every subscription test must cover period, offers, and legal links; `SubscriptionStoreView` may own their automatic source presentation. Human verifies StoreKit/App Store Connect and sandbox behavior. |
| Third-party AI | Block readiness without explicit AI-pipeline roles for every recipient/intermediary, role-checked production consent source proving exact data/recipient/purpose/actions/privacy link, and policy evidence for method/uses/retention/protection. Human confirms legal truth and processor protection. |
| Initial app record, agreements, tax/banking, trader | Human/App Store Connect UI only. |
| Apply / final submission | Preview is safe. Explicit `--apply` / `--submit` flags report a manual handoff and exit 3 because v0.1 intentionally has no write or submission adapter. |

Never add secret keys to a manifest, fixture, generated package, or terminal output. Never browser-scrape App Store Connect.
