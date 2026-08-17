# Architecture

```text
Codex skill → shiplayer CLI → scanner / schema / generators / preflight / ASC adapter
```

- **Scanner** bounds recursive traversal, ignores build/vendor outputs, and emits file-level evidence and confidence.
- **Manifest** is the editable source of truth. Schema and semantic validation run before generation.
- **Generators** derive drafts only from confirmed manifest fields.
- **Preflight** distinguishes pass, warning, and blocker. A blocker returns exit code 2.
- **ASC adapter** separates auth/discovery from future write adapters. Discovery is read-only.
- **Capture** creates a deterministic hand-off for a repository-declared screenshot UI-test harness. It deliberately does not invent generic `xcodebuild` commands or fabricate screenshots.

The CLI supports local analysis/generation on macOS or Linux. Direct Simulator capture needs macOS/Xcode plus a repository-declared harness. Marketing composition is handed off as a neutral plan to a separately installed/scaffolded `app-store-screenshots` editor; ShipLayer does not claim the hand-off JSON is itself an editor project.
