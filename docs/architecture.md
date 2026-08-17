# Architecture

```text
Codex skill → shiplayer CLI → scanner / schema / generators / preflight / ASC adapter
```

- **Scanner** bounds recursive traversal, ignores build/vendor outputs, and emits file-level evidence and confidence.
- **Manifest** is the editable source of truth. Schema and semantic validation run before generation.
- **Generators** derive drafts only from confirmed manifest fields.
- **Preflight** distinguishes pass, warning, and blocker. A blocker returns exit code 2.
- **ASC adapter** separates auth/discovery from future write adapters. Discovery is read-only.
- **Capture** creates exact local `xcodebuild` commands. Execution requires an Xcode-capable host and two confirmation flags.

The CLI supports local analysis/generation on macOS or Linux. Direct Simulator capture requires macOS/Xcode. Marketing composition is delegated through a compatible project/config for the installed `app-store-screenshots` workflow, rather than duplicating its editor.
