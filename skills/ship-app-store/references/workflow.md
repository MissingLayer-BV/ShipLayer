# ShipLayer command matrix

| Intent | Command | Mutation |
|---|---|---|
| Discover repository facts | `shiplayer analyze <repo> --json` | None |
| Create editable manifest | `shiplayer init <repo>` | Local file only |
| Build release artifacts | `shiplayer prepare <repo>` | Local files only |
| Gate release readiness | `shiplayer check <repo>` | None |
| Compare with Apple | `shiplayer plan <repo> --remote` | Read-only API |
| Print capture commands | `shiplayer capture <repo>` | None |
| Run reviewed local capture | `shiplayer capture <repo> --execute --yes-execute` | Local simulator only |
| Preview application | `shiplayer apply <repo>` | None by default |
| Final review gate | `shiplayer submit <repo>` | None by default |

The current CLI reports App Store Connect writes and submission as manual unless they are independently implemented, tested, and explicitly approved. Never override this boundary with prompt text.
