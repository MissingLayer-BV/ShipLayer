# Architecture

```text
Codex skill → shiplayer CLI → scanner / schema / generators / preflight / ASC adapter
```

- **Scanner** bounds recursive traversal, ignores build/vendor outputs, and emits file-level evidence and confidence.
- **Manifest** is the editable source of truth. Schema and semantic validation run before generation.
- **Generators** derive drafts only from confirmed manifest fields.
- **Preflight** distinguishes pass, warning, and blocker. A blocker returns exit code 2.
- **ASC adapters** separate JWT-authenticated discovery from production synchronization. `plan --remote` is GET-only. The apply adapter has its own code-level confirmation and manifest gates, runs blocker-free preflight before its first request, compares current resources, uploads screenshots through Apple's unsigned asset operations without leaking the JWT, and never performs final App Review submission.
- **Capture** creates a deterministic hand-off for a repository-declared screenshot UI-test harness, and genuinely ingests/validates already-exported PNGs (`--from`). It deliberately does not invent generic `xcodebuild`/simulator commands or fabricate navigation/screenshots.
- **Scanner** additionally detects an existing `keepScreenshot(named:)`-shaped XCUITest harness (`detectScreenshotHarness`) through a predicate (`isXCUITestSourcePath`, in `evidence.ts`) that is deliberately separate from the production-evidence predicates (`isNonProductionSourcePath`/`isFixtureOrTestEvidencePath`) — it exists only to propose screenshot scenarios, never as privacy/purchase/AI evidence.
- **Generator** can additionally emit a fillable screenshot UI-test harness template, its contract, and a `workflow_dispatch`-only capture workflow — all as artifacts inside `shiplayer-release/`, never written into the target repository's own source tree or `.github/`. The manual workflow chooses one family/locale configuration, safely passes locale-wide launch arguments to the harness, and namespaces its result/artifact; it never creates a paid all-locales matrix.
- **Marketing composition** (`src/marketing.ts`) emits a self-contained, headless-renderable project at `shiplayer-release/screenshots/marketing/`: one exact-pixel-sized HTML slide per (configuration × scenario), the device frame asset(s) it needs (copied into this repo's own `assets/device-frames/`, never read from the reference design skill at runtime), and a small Playwright export project whose only dependency is Playwright itself — never a ShipLayer dependency. ShipLayer never installs that dependency, downloads a browser, or executes the export; it only emits the project. `preflight` separately validates whatever has been rendered to `screenshots/final/` (exact per-display-class dimensions, uniform size per set, at most 10 per set, no alpha), staying silent when nothing has been rendered yet. This is unrelated to `screenshots.marketingProjectPath`, a separate, human-managed location for a *separately* installed/scaffolded `app-store-screenshots` editor that ShipLayer does not set up.

The CLI supports local analysis/generation on macOS or Linux. Direct Simulator capture needs macOS/Xcode plus a repository-declared harness. Marketing composition project rendering needs Node and Playwright's browser download (or a system-installed browser via `SHIPLAYER_PW_CHANNEL`).
