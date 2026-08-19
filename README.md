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
| `capture <repo>` | Reports the detected/missing screenshot UI-test harness and hand-off steps. `--from DIR --family iphone\|ipad --locale LOCALE` ingests and validates already-exported PNGs. v0.1 never fabricates navigation or runs a generic simulator/build command. |
| `apply <repo>` | Dry-run by default. `--apply --yes-i-understand` reports the manual handoff and exits 3 because v0.1 has no tested write adapter. |
| `submit <repo>` | Separate final gate. `--submit --yes-submit` reports the manual handoff and exits 3 because v0.1 deliberately does not submit. |

ShipLayer itself never creates, installs, commits, or dispatches a GitHub Action, and it never triggers cloud CI. `prepare` can *emit* a `workflow_dispatch`-only screenshot capture workflow as a file inside the generated `shiplayer-release/` package (see "Screenshots" below) — that file is not wired into anything until a human manually copies it into the target app repository's own `.github/workflows/` and presses "Run workflow" themselves.

## Release package

`prepare` writes a managed `shiplayer-release/` package (or a safe relative `--out`) containing a normalized manifest, analysis/preflight reports, per-locale metadata drafts, App Privacy draft and evidence matrix, privacy/support/Terms-of-Use drafts, App Review notes, physical-device recording script, a screenshot capture plan, a screenshot UI-test harness template and its contract, a manually-installed capture workflow, a neutral marketing-composition hand-off, StoreKit checklist, dry-run ASC plan, and remaining human actions. It refuses traversal, symlinks, the repository root, VCS/vendor/build paths, manifest-input collisions, and unmanaged output directories; managed packages regenerate atomically from staging.

## Screenshots

ShipLayer never invents app navigation, but it does real, verifiable work around it:

- `init` scans XCUITest sources (`*UITests` targets) for the `keepScreenshot(named:)` contract — an `XCTAttachment(screenshot: XCUIScreen.main.screenshot())` kept with `.lifetime = .keepAlways` — and proposes each detected call as a `screenshots.scenarios` entry (id, title, launch arguments), always `confirmation: needs-human-confirmation`, never silently confirmed. This is a separate, narrowly-scoped scan (`isXCUITestSourcePath` in `src/evidence.ts`) from the privacy/purchase/AI production-evidence predicates and must never be conflated with them.
- If no harness is detected, `prepare` emits a fillable template (`screenshots/ui-test-harness-template.swift`) and its written contract (`screenshots/ui-test-harness-contract.md`) into the release package. An agent or human with real knowledge of the app fills in the TODO navigation; ShipLayer only defines and later verifies the contract.
- `prepare` also emits `screenshots/capture-workflow.yml`: a `workflow_dispatch`-only, single-simulator, concurrency-guarded, timeout-bounded GitHub Actions workflow that runs the screenshot UI tests and uploads the exported `.xcresult` attachments as an artifact. It carries a header comment stating that macOS runners bill at roughly 10x and that this must never be made automatic. It is not installed anywhere; a human copies it into the app repository's `.github/workflows/` and dispatches it manually.
- `shiplayer capture <repo> --from <dir> --family iphone|ipad --locale <locale>` ingests the exported PNGs (from that workflow's artifact, or a local export): it validates format, rejects an alpha channel, requires an Apple-accepted dimension for the family, and requires every image in one family/locale set to be internally consistent with what has already been ingested, then copies matching files into `screenshots.rawOutputDir/{family}/{locale}/<scenario-id>.png`. This is a genuine local file operation, not a plan; `shiplayer check` remains the authoritative gate.
- The per-image `check` gate accepts any of Apple's currently accepted dimensions for the configured device family (e.g. a 6.9" iPhone capture may be 1320×2868, 1290×2796, or 1260×2736 depending on which simulator produced it) rather than only the exact `requiredDimensions` value `init` proposed, while still requiring one uniform size across every image in a given family/locale set, because App Store Connect only accepts a single uniform size per screenshot slot.

## Safety model

- `shiplayer.yml` contains environment-variable names, never credentials or `.p8` contents. It rejects clear private-key/token/password assignment material in free text as a defense-in-depth guard.
- Heuristics are proposals. Privacy, legal, tax, agreements, trader status, and regulated-content declarations require human confirmation. Zero Data Retention, no-training, and provider data-collection controls do not mean personal data was not shared with the service that received it.
- Remote mode uses an App Store Connect ES256 JWT from `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, and `APP_STORE_CONNECT_PRIVATE_KEY_PATH`. It never logs private key material.
- v0.1 implements authenticated discovery reads only. It selects the requested iOS version/build when supplied, follows bounded official-API pagination, validates EC P-256 JWT keys, and does not claim it computed a full diff, created an app, uploaded an asset, or submitted for review. Modern Xcode Icon Composer `.icon` files are supported as a selected asset with an explicit human Xcode/archive verification gate; their private internal format is not parsed.
- Apple UI/human actions remain required for initial app-record creation, agreements, tax/banking, trader declarations, privacy/legal confirmation, final asset review, and final App Review submission.

## Manifest

The checked-in [JSON Schema](src/schema.json) and runtime validation cover identity, metadata, permissions, processors, review access, screenshot matrices, signing, release settings, monetization, and evidence-contradiction overrides.

Third-party AI features require an `aiDataSharing` declaration that names the exact data, purpose, and every recipient. Mark each provider/intermediary that actually receives the AI feature data with `aiPipelineRecipient: true`; unrelated analytics or payment processors remain `false`. Production consent evidence must visibly substantiate every recipient, the exact declared send/share/upload action, the non-AI decline path, and a Privacy Policy link. Matching public policy evidence must be a contained `.md`, `.markdown`, `.html`, `.htm`, or `.txt` artifact and cover collection/transmission method, all uses, recipients, retention/deletion, and same-or-equal protection. Code constants, tests, fixtures, scripts, or documentation text cannot stand in for rendered consent or published policy content. Declaring AI-pipeline recipients while disabling this section is a submission blocker.

### Evidence-backed contradiction blockers

`monetization` and `aiDataSharing` are opt-in declarations, but they are no longer trusted blindly: `check`/`prepare` cross-check them against the scan.

- **Monetization.** The StoreKit cross-check runs for *any* declaration that models no in-app purchase — `free` and `paid-app` alike (a paid download is not itself an IAP). If the scan finds StoreKit purchase evidence (`Product.purchase()` corroborated by a StoreKit import or `.displayPrice` in the same file, `.displayPrice`/`ProductView` alone, a `.storekit` product ID, or a legacy `SKPaymentQueue`/`SKPaymentTransactionObserver` signal) while `monetization.type` is `free` or `paid-app`, that is a loud `monetization.source-contradiction` blocker naming the evidence files, and it also blocks `purchase.presentation` since presentation cannot be verified for an undeclared model. `monetization: { type: "free" }` additionally requires its own `confirmation: confirmed` — an unconfirmed free declaration blocks too, the same as every other self-declared fact ShipLayer will not assume for you.
- **AI data sharing.** Known AI providers come in two shapes, classified differently to avoid both under- and over-blocking: **API-only hosts/subdomains** that never serve anything but the API itself (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, a customer's `<resource>.openai.azure.com`, any `api.`/`api-`-labeled subdomain of a known provider, and similar) are strong evidence **regardless of path** — there is no marketing/docs page living there to false-positive on, so `/v1/responses`, `/v1/images/generations`, `/v1/audio/transcriptions`, `:generateContent`, and any other real API path all block. **Mixed apex hosts**, where a provider's marketing/docs/legal/model-card pages and its API plausibly coexist on the very same bare hostname (`openai.com`, `anthropic.com`, `huggingface.co`, `openrouter.ai`, `x.ai`, and similar), are the inverse: only a path shaped like an actual inference call (`/chat/completions`, `/v1/messages`, `/generate`, `/inference`, `/completions`, `/embeddings`) is strong evidence there; everything else — including a provider's real privacy-policy page such as `openai.com/policies/privacy-policy` or `anthropic.com/legal/privacy`, a model card, a blog post, or a bare root path — only warns (`ai-sharing.possible-processor-link`), never hard-blocks by itself, precisely because those legitimate links are exactly what `ai-sharing.consent-privacy-link` and `externalProcessor.privacyPolicyUrl` require the app to surface. Separately, an **unrecognized** host whose path is still shaped like an inference API blocks under a distinct id, `ai-sharing.source-contradiction-ambiguous-endpoint` — the proxied-endpoint case (an app's own backend forwarding to a provider), named differently so the message says the host is unrecognized rather than implying a confirmed provider match. This is a deliberate trade-off, not a fully-solved classification: ShipLayer cannot both catch a same-shaped proxy call and let an unrelated `/v1/messages`-shaped API through, so it blocks the ambiguous case and leaves resolution to a human via the override below.

The only way to resolve one of these blockers, short of fixing the declaration, is a **`sourceContradictionOverrides`** entry — the same shape as `externalServiceDecisions`: a `finding` naming the exact blocker id (`monetization.source-contradiction`, or `ai-sharing.source-contradiction:endpoint:<url>` for a specific endpoint — the same finding id whether the endpoint classified as a known provider or as an ambiguous unrecognized host), a non-empty human `reason`, at least one contained `evidence` path, and `confirmation: confirmed`. An override cannot be expressed as an empty/default value — schema validation requires the reason and evidence to be present — **and its evidence must intersect the flagged finding's own source paths and actually exist on disk**, so an override cannot wave away a real finding by citing an unrelated file. A valid override downgrades the blocker to a visible warning rather than silently clearing it. `init` never invents these declarations for you: it carries detected endpoints forward into `externalProcessors` as `needs-human-confirmation` proposals — **only an endpoint that classifies as a known API-only or mixed-apex provider (not a policy/docs link, and not the ambiguous unrecognized-host case) is proposed with `kind: "ai"`**, which by itself is enough to require an AI disclosure even before a human sets `aiPipelineRecipient`; every other detected endpoint is proposed as `kind: "network"` instead, so a policy link or an ambiguous proxy endpoint is resolvable purely through `sourceContradictionOverrides` rather than producing a second, unrelated block with no override path. `init` leaves `monetization.type` as `free` with a prominent unresolved question when StoreKit evidence disagrees, so `check` blocks immediately until a human resolves it one way or the other.

**Known limitation.** These checks only see literal evidence present in the scanned repository: URL literals in Swift/TS/JS source, Info.plist string values, and `.xcconfig`/`.pbxproj`/`project.yml` build settings (including a user-defined setting whose value is itself a URL, not only Apple's own named keys). A base URL that is only ever injected at build/CI time via an environment variable or secret — with no literal value anywhere in the tracked repository, only a `$(VARIABLE)` indirection — cannot be found by static scanning and will not be caught. If your app proxies to an AI provider through your own backend and the backend's URL is never a literal in the repo, declare `aiDataSharing` yourself; ShipLayer cannot detect it for you in that shape.

Every non-consumable or subscription requires role-checked `purchasePresentation` evidence. Production paywall source must visibly render StoreKit `Product.displayPrice` (an unused/commented/non-iOS conditional read is insufficient), or render `ProductView`/`SubscriptionStoreView` (`StoreView` is also supported for non-consumables); known iOS, StoreKit, and SwiftUI compilation guards are accepted, while arbitrary module guards cannot independently prove release evidence. Custom purchase UI must withhold its purchase Button inside the product-available branch or use a direct safe disabled predicate such as `product == nil`, `isLoading`, or `!canPurchase`. Assertions inside credible XCTest or Swift Testing methods must directly prove both visible localized pricing and the unavailable purchase state; compound boolean assertions do not count. Hard-coded prices, unused merchandising-view assignments, unverified custom `ProductViewStyle` implementations, and unverified custom `SubscriptionStoreControlStyle` implementations are blocked. Custom subscription paywalls additionally require source and test evidence for the visible billing period, applicable offer terms, and Terms/Privacy links before purchase; `SubscriptionStoreView` with a built-in control style may own the automatic source presentation, but tests and human confirmation must still verify those disclosures.

For subscriptions, provide a group with localized display names, base territory, monthly/yearly (or supported custom) durations, levels, Apple-safe product IDs, product localizations, price references, introductory offers, family sharing, review assets, paywall navigation, restore path, and explicit confirmation. Introductory offers model free trials, pay up front, and pay as you go (including the required number of periods); ShipLayer rejects combinations that do not match Apple's current duration rules.

See [fixtures/subscription-shiplayer.yml](fixtures/subscription-shiplayer.yml) for a complete fictional subscription example. Subscription output also includes a clearly marked Terms of Use/EULA handoff for either Apple's Standard EULA or human-reviewed custom terms.

## Architecture and development

Read [docs/architecture.md](docs/architecture.md) and [docs/automation-boundaries.md](docs/automation-boundaries.md). The Codex skill is at [skills/ship-app-store](skills/ship-app-store); it orchestrates the CLI instead of hiding nondeterministic behavior in prompt text. The separate `app-store-screenshots` editor must be installed/scaffolded independently; ShipLayer emits only a neutral asset hand-off plan.

```bash
npm install
make check
```

There is intentionally no automatic GitHub Actions workflow in this repository, and ShipLayer never adds one to itself. The only workflow file ShipLayer's code ever produces is the `workflow_dispatch`-only screenshot capture workflow described above, and it is written solely as a `shiplayer-release/` artifact for a human to review and install into a *target app repository* — never committed, installed, or dispatched by ShipLayer itself, and never wired to `push`/`pull_request`/`schedule`.
