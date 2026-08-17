---
name: ship-app-store
description: Prepare a native Swift/SwiftUI iPhone and iPad repository for App Store release using ShipLayer. Use when Codex must audit App Store readiness, generate metadata/privacy/support/review artifacts, plan screenshots, validate IAP or subscriptions, or safely compare an app with App Store Connect. Enforce a human-confirmed, no-surprises release workflow.
---

# Ship App Store

Use the repository's `shiplayer` CLI for all deterministic work. Do not recreate release logic in prose.

## Workflow

1. Run `shiplayer analyze <repo> --json`. Treat heuristic findings as proposals, never as privacy/legal truth.
2. Run `shiplayer init <repo>` only when no manifest exists. Do not overwrite a manifest without an explicit user request.
3. Ask for confirmation only for facts the scanner cannot prove: pricing, availability, privacy collection/third parties, legal/trader status, App Review contact, and paywall behavior.
4. Update and validate `shiplayer.yml`, then run `shiplayer prepare <repo>` and `shiplayer check <repo>`.
5. Preview every generated screenshot, metadata field, privacy/support page, review note, and preflight warning with the user.
6. Run `shiplayer plan <repo>` first. Use `--remote` only with the user's credentials configured as environment variables; it is read-only.
7. Treat `apply` and `submit` as separate explicit user-authorized gates. Do not pass their confirmation flags on the user's behalf. If ShipLayer marks an operation manual/unsupported, explain that it did not happen.

## Safety

- Never put credentials, `.p8` contents, login passwords, banking data, or tax details in `shiplayer.yml` or generated artifacts.
- Never make or imply legal/privacy compliance. Require explicit human confirmation.
- Do not create initial app records, accept agreements, alter tax/banking/trader declarations, or submit an app without direct user approval.
- Use `shiplayer capture` to inspect the deterministic harness hand-off. v0.1 does not execute generic Simulator capture commands; only run a repository-owned, reviewed UI-test harness on macOS/Xcode.

## Reference

Read [references/workflow.md](references/workflow.md) for the command and safety matrix.
