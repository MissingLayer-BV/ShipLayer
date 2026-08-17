# Automation boundaries

ShipLayer can prepare facts, drafts, asset plans, and an idempotent remote change plan. It cannot create legal truth from source code.

| Capability | v0.1 boundary |
|---|---|
| Swift/Xcode facts | Detect with evidence; report contradictions and unknowns. |
| Privacy and legal copy | Draft from confirmed facts; human reviews and publishes. |
| Screenshot capture | Produce a deterministic harness hand-off. A repository must declare and test its own UI-test capture adapter; v0.1 executes no generic capture command. |
| App Store Connect | JWT-based read/compare. Writes are reported as manual until independently tested. |
| Subscriptions/IAP | Validate manifest and generate checklist/review notes; human verifies StoreKit/App Store Connect state. |
| Initial app record, agreements, tax/banking, trader | Human/App Store Connect UI only. |
| Final submission | Separate human-controlled gate; v0.1 intentionally does not submit. |

Never add secret keys to a manifest, fixture, generated package, or terminal output. Never browser-scrape App Store Connect.
