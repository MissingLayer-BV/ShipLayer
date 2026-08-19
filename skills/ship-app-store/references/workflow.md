# ShipLayer command matrix

| Intent | Command | Mutation |
|---|---|---|
| Discover repository facts | `shiplayer analyze <repo> --json` | None |
| Create editable manifest | `shiplayer init <repo>` | Local file only |
| Build release artifacts | `shiplayer prepare <repo>` | Local files only |
| Gate release readiness | `shiplayer check <repo>` (including AI consent/privacy evidence, StoreKit-localized price evidence, and source-vs-manifest contradiction blockers for monetization and AI data sharing) | None |
| Compare with Apple | `shiplayer plan <repo> --remote` | Read-only API |
| Produce screenshot harness hand-off | `shiplayer capture <repo>` | None |
| Render marketing screenshots | `npm install && npx playwright install chromium && npm run export` inside the generated `shiplayer-release/screenshots/marketing/` | Local files only, outside the repository's own dependency tree |
| Direct local capture | Repository-owned UI-test harness only | Local simulator only |
| Preview application | `shiplayer apply <repo>` | None by default |
| Final review gate | `shiplayer submit <repo>` | None by default |

The current CLI reports App Store Connect writes and submission as manual unless they are independently implemented, tested, and explicitly approved. Never override this boundary with prompt text.
