# ShipLayer command matrix

| Intent | Command | Mutation |
|---|---|---|
| Discover repository facts | `shiplayer analyze <repo> --json` | None |
| Create editable manifest | `shiplayer init <repo>` | Local file only |
| Build release artifacts | `shiplayer prepare <repo>` | Local files only |
| Gate release readiness | `shiplayer check <repo>` (including AI consent/privacy evidence, StoreKit-localized price evidence, source-vs-manifest contradiction blockers for monetization and AI data sharing, and App Store copy validation — character limits, placeholder text, other-platform references, keyword hygiene, and copy-vs-manifest monetization/device-family/AI-mention contradictions) | None |
| Compare with Apple | `shiplayer plan <repo> --remote` | Read-only API |
| Produce screenshot harness hand-off | `shiplayer capture <repo>` | None |
| Render marketing screenshots | `npm install && npx playwright install chromium && npm run export` inside the generated `shiplayer-release/screenshots/marketing/` | Local files only, outside the repository's own dependency tree — but `npx playwright install chromium` is a real network download (a full browser binary, often 100+ MB) and the only row in this table that fetches anything; if it is blocked or unsupported, set `SHIPLAYER_PW_CHANNEL` to an already-installed browser instead |
| Direct local capture | Repository-owned UI-test harness only | Local simulator only |
| Preview application | `shiplayer apply <repo>` | None by default |
| Final review gate | `shiplayer submit <repo>` | None by default |

The current CLI reports App Store Connect writes and submission as manual unless they are independently implemented, tested, and explicitly approved. Never override this boundary with prompt text.

See [screenshots.md](screenshots.md) for the full, ordered screenshot contract (harness → CI hand-off → ingestion → marketing composition) — the "Direct local capture" and "Render marketing screenshots" rows above are summaries, not the whole procedure.
