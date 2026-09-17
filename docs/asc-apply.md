# App Store Connect apply flow

Generation never opts an app into production writes. After `prepare`, `check`, and visual review, first run the remote plan:

```bash
shiplayer plan /path/to/MySwiftApp --remote
# or the same preview plus preflight report:
shiplayer apply /path/to/MySwiftApp
```

If the user explicitly asks ShipLayer to fill App Store Connect, review the listed creates, updates, uploads, and deletions with them. Only then set `sync.mode: apply` and run:

```bash
shiplayer apply /path/to/MySwiftApp --apply --yes-i-understand
```

This synchronizes the supported fields and screenshots but does **not** submit for review. If the user does not explicitly authorize the apply step, leave `sync.mode: dry-run` and stop after the preview.

For repositories whose App Store Connect credentials live in a protected GitHub environment, ShipLayer also exposes a composite action. Reference a pinned ShipLayer commit, map the three documented credential environment variables, and pass `command: plan` for the default GET-only preview. Set `render-screenshots: "true"` only in an explicitly configured workflow when the repository contains every declared raw screenshot input; the action then prepares and renders missing localized decks with the runner's installed Chrome before planning or applying, while preserving any already-complete reviewed final deck byte-for-byte. Use `command: apply` only from a manually dispatched, protected workflow after reviewing that preview; the manifest `sync.mode: apply` and ShipLayer's normal preflight gates still apply.

## Prepare descriptions before uploading a build

`shiplayer draft-descriptions <repo>` previews a description-only update draft.
After reviewing the preview, `sync.mode: apply` and
`--apply --yes-i-understand` authorize creating the requested iOS version and
saving confirmed descriptions for every configured locale. Existing versions
must be in `PREPARE_FOR_SUBMISSION`. The command verifies the app identity and
reads all descriptions back after writing. It never attaches a build, edits
release notes or screenshots, or submits for review. Full-release preflight and
release-note approval still apply when preparing the eventual release.

The composite action exposes `draft-descriptions-plan` and
`draft-descriptions-apply` with `render-screenshots: "false"`.
