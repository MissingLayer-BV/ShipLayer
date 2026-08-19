# Architecture

```text
Codex skill → shiplayer CLI → scanner / schema / generators / preflight / ASC adapter
```

- **Scanner** bounds recursive traversal, ignores build/vendor outputs, and emits file-level evidence and confidence.
- **Manifest** is the editable source of truth. Schema and semantic validation run before generation.
- **Generators** derive drafts only from confirmed manifest fields.
- **Preflight** distinguishes pass, warning, and blocker. A blocker returns exit code 2.
- **ASC adapter** separates auth/discovery from future write adapters. Discovery is read-only.
- **Capture** creates a deterministic hand-off for a repository-declared screenshot UI-test harness, and genuinely ingests/validates already-exported PNGs (`--from`). It deliberately does not invent generic `xcodebuild`/simulator commands or fabricate navigation/screenshots.
- **Scanner** additionally detects an existing `keepScreenshot(named:)`-shaped XCUITest harness (`detectScreenshotHarness`) through a predicate (`isXCUITestSourcePath`, in `evidence.ts`) that is deliberately separate from the production-evidence predicates (`isNonProductionSourcePath`/`isFixtureOrTestEvidencePath`) — it exists only to propose screenshot scenarios, never as privacy/purchase/AI evidence.
- **Generator** can additionally emit a fillable screenshot UI-test harness template, its contract, and a `workflow_dispatch`-only capture workflow — all as artifacts inside `shiplayer-release/`, never written into the target repository's own source tree or `.github/`.

The CLI supports local analysis/generation on macOS or Linux. Direct Simulator capture needs macOS/Xcode plus a repository-declared harness. Marketing composition is handed off as a neutral plan to a separately installed/scaffolded `app-store-screenshots` editor; ShipLayer does not claim the hand-off JSON is itself an editor project.
