# ShipLayer

**From repo to review.** ShipLayer is a local-first, safety-first release-preparation CLI and Codex skill for native Swift/SwiftUI iPhone and iPad apps.

It scans a repository, captures evidence rather than guesses, and generates the assets and checklists between a build and an App Store submission. It supports free apps, paid apps, non-consumable lifetime unlocks, and auto-renewable subscriptions.

## Quick start

```bash
npm ci
npm run build
./dist/index.js analyze /path/to/MySwiftApp
# If no manifest exists, create a deliberately incomplete editable draft.
./dist/index.js init /path/to/MySwiftApp
# Confirm privacy/legal and other unresolved facts yourself.
./dist/index.js prepare /path/to/MySwiftApp
./dist/index.js check /path/to/MySwiftApp
./dist/index.js plan /path/to/MySwiftApp
```

This package is intentionally private in v0.1; it is not published to npm. Run `./dist/index.js`, use `npm link` from this checkout, or install from a reviewed local/Git checkout before using `shiplayer` in another repository. ShipLayer targets Node 22+.

## Commands

| Command | Effect |
|---|---|
| `init <repo>` | Creates `shiplayer.yml` from detected facts. Refuses to overwrite without `--force`. |
| `analyze <repo> [--json]` | Read-only Swift/Xcode scan with evidence, confidence, contradictions, and questions. |
| `prepare <repo> [--out DIR]` | Generates a deterministic release package. Does not upload or submit. |
| `check <repo> [--json]` | Preflight. Returns exit status 2 when blockers remain. |
| `plan <repo> [--remote]` | Offline App Store Connect plan, or explicit authenticated read/discovery only. |
| `capture <repo>` | Produces a deterministic screenshot-harness hand-off; v0.1 never fabricates or runs a generic capture command. |
| `apply <repo>` | Dry-run by default. `--apply --yes-i-understand` reports the manual handoff and exits 3 because v0.1 has no tested write adapter. |
| `submit <repo>` | Separate final gate. `--submit --yes-submit` reports the manual handoff and exits 3 because v0.1 deliberately does not submit. |

No command creates a GitHub Action, triggers cloud CI, or uses a paid service.

## Release package

`prepare` writes a managed `shiplayer-release/` package (or a safe relative `--out`) containing a normalized manifest, analysis/preflight reports, per-locale metadata drafts, App Privacy draft and evidence matrix, privacy/support/Terms-of-Use drafts, App Review notes, physical-device recording script, screenshot capture plan, neutral marketing-composition hand-off, StoreKit checklist, dry-run ASC plan, and remaining human actions. It refuses traversal, symlinks, the repository root, VCS/vendor/build paths, manifest-input collisions, and unmanaged output directories; managed packages regenerate atomically from staging.

## Safety model

- `shiplayer.yml` contains environment-variable names, never credentials or `.p8` contents. It rejects clear private-key/token/password assignment material in free text as a defense-in-depth guard.
- Heuristics are proposals. Privacy, legal, tax, agreements, trader status, and regulated-content declarations require human confirmation. Zero Data Retention, no-training, and provider data-collection controls do not mean personal data was not shared with the service that received it.
- Remote mode uses an App Store Connect ES256 JWT from `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, and `APP_STORE_CONNECT_PRIVATE_KEY_PATH`. It never logs private key material.
- v0.1 implements authenticated discovery reads only. It selects the requested iOS version/build when supplied, follows bounded official-API pagination, validates EC P-256 JWT keys, and does not claim it computed a full diff, created an app, uploaded an asset, or submitted for review. Modern Xcode Icon Composer `.icon` files are supported as a selected asset with an explicit human Xcode/archive verification gate; their private internal format is not parsed.
- Apple UI/human actions remain required for initial app-record creation, agreements, tax/banking, trader declarations, privacy/legal confirmation, final asset review, and final App Review submission.

## Manifest

The checked-in [JSON Schema](src/schema.json) and runtime validation cover identity, metadata, permissions, processors, review access, screenshot matrices, signing, release settings, and monetization.

Third-party AI features require an `aiDataSharing` declaration that names the exact data, purpose, and every recipient. Mark each provider/intermediary that actually receives the AI feature data with `aiPipelineRecipient: true`; unrelated analytics or payment processors remain `false`. Production consent evidence must visibly substantiate every recipient, the exact declared send/share/upload action, the non-AI decline path, and a Privacy Policy link. Matching policy evidence must cover collection/transmission method, all uses, recipients, retention/deletion, and same-or-equal protection. Test, fixture, script, or documentation text cannot stand in for production consent source. Declaring AI-pipeline recipients while disabling this section is a submission blocker.

Every non-consumable or subscription requires role-checked `purchasePresentation` evidence. Production paywall source must visibly render StoreKit `Product.displayPrice` (an unused/commented read is insufficient), or use `ProductView`/`SubscriptionStoreView`; custom purchase UI must remain disabled/withheld while product/price is loading or unavailable. Conventional UI/unit/snapshot test assertions must cover both visible localized pricing and the unavailable purchase state. Hard-coded prices are blocked. Custom subscription paywalls additionally require source and test evidence for the visible billing period, applicable offer terms, and Terms/Privacy links before purchase; `SubscriptionStoreView` may own the automatic source presentation, but tests and human confirmation must still verify those disclosures.

For subscriptions, provide a group with localized display names, base territory, monthly/yearly (or supported custom) durations, levels, Apple-safe product IDs, product localizations, price references, introductory offers, family sharing, review assets, paywall navigation, restore path, and explicit confirmation. Introductory offers model free trials, pay up front, and pay as you go (including the required number of periods); ShipLayer rejects combinations that do not match Apple's current duration rules.

See [fixtures/subscription-shiplayer.yml](fixtures/subscription-shiplayer.yml) for a complete fictional subscription example. Subscription output also includes a clearly marked Terms of Use/EULA handoff for either Apple's Standard EULA or human-reviewed custom terms.

## Architecture and development

Read [docs/architecture.md](docs/architecture.md) and [docs/automation-boundaries.md](docs/automation-boundaries.md). The Codex skill is at [skills/ship-app-store](skills/ship-app-store); it orchestrates the CLI instead of hiding nondeterministic behavior in prompt text. The separate `app-store-screenshots` editor must be installed/scaffolded independently; ShipLayer emits only a neutral asset hand-off plan.

```bash
npm install
make check
```

There is intentionally no automatic GitHub Actions workflow. A future workflow must be manually dispatched and must never run macOS/TestFlight jobs on each pull request without a documented cost guardrail.
