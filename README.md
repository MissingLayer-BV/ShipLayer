# ShipLayer

**From repo to review.** ShipLayer is a local-first, safety-first release-preparation CLI and Codex skill for native Swift/SwiftUI iPhone and iPad apps.

It scans a repository, captures evidence rather than guesses, and generates the assets and checklists between a build and an App Store submission. It supports free apps, paid apps, non-consumable lifetime unlocks, and auto-renewable subscriptions.

## Quick start

```bash
npm install
npm run build
./dist/index.js init /path/to/MySwiftApp
# Review shiplayer.yml; confirm privacy/legal facts yourself.
./dist/index.js analyze /path/to/MySwiftApp
./dist/index.js prepare /path/to/MySwiftApp
./dist/index.js check /path/to/MySwiftApp
./dist/index.js plan /path/to/MySwiftApp
```

Use `npx shiplayer ...` after publishing the package or link the local executable with `npm link` during development. ShipLayer targets Node 22+; this repository keeps syntax compatible with the current local environment for tests.

## Commands

| Command | Effect |
|---|---|
| `init <repo>` | Creates `shiplayer.yml` from detected facts. Refuses to overwrite without `--force`. |
| `analyze <repo> [--json]` | Read-only Swift/Xcode scan with evidence, confidence, contradictions, and questions. |
| `prepare <repo> [--out DIR]` | Generates a deterministic release package. Does not upload or submit. |
| `check <repo> [--json]` | Preflight. Returns exit status 2 when blockers remain. |
| `plan <repo> [--remote]` | Offline App Store Connect plan, or explicit authenticated read/compare only. |
| `capture <repo>` | Prints exact simulator capture commands; use `--execute --yes-execute` to run them. |
| `apply <repo>` | Dry-run by default. `--apply --yes-i-understand` remains manual-only in v0.1. |
| `submit <repo>` | Separate final gate. v0.1 deliberately keeps final submission manual. |

No command creates a GitHub Action, triggers cloud CI, or uses a paid service.

## Release package

`prepare` writes `shiplayer-release/` (or `--out`) containing a normalized manifest, analysis/preflight reports, per-locale metadata drafts, App Privacy draft and evidence matrix, privacy/support page drafts, App Review notes, physical-device recording script, screenshot capture plan, app-store-screenshots compatible project JSON, StoreKit checklist, dry-run ASC plan, and remaining human actions.

## Safety model

- `shiplayer.yml` contains environment-variable names, never credentials or `.p8` contents.
- Heuristics are proposals. Privacy, legal, tax, agreements, trader status, and regulated-content declarations require human confirmation.
- Remote mode uses an App Store Connect ES256 JWT from `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, and `APP_STORE_CONNECT_PRIVATE_KEY_PATH`. It never logs private key material.
- v0.1 implements authenticated discovery/read comparison only. It does not claim it created an app, uploaded an asset, or submitted for review.
- Apple UI/human actions remain required for initial app-record creation, agreements, tax/banking, trader declarations, privacy/legal confirmation, final asset review, and final App Review submission.

## Manifest

The checked-in [JSON Schema](src/schema.json) and runtime validation cover identity, metadata, permissions, processors, review access, screenshot matrices, signing, release settings, and monetization. For subscriptions, provide a group, base territory, monthly/yearly (or supported custom) durations, levels, product IDs, localizations, price references, introductory offers, family sharing, review assets, paywall navigation, restore path, and explicit confirmation.

See [fixtures/subscription-shiplayer.yml](fixtures/subscription-shiplayer.yml) for a complete fictional subscription example.

## Architecture and development

Read [docs/architecture.md](docs/architecture.md) and [docs/automation-boundaries.md](docs/automation-boundaries.md). The Codex skill is at [skills/ship-app-store](skills/ship-app-store); it orchestrates the CLI instead of hiding nondeterministic behavior in prompt text.

```bash
npm install
make check
```

There is intentionally no automatic GitHub Actions workflow. A future workflow must be manually dispatched and must never run macOS/TestFlight jobs on each pull request without a documented cost guardrail.
