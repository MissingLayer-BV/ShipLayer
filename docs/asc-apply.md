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

## Fill an existing draft: `shiplayer draft`

`shiplayer draft <repo>` fills an existing editable App Store draft stage by
stage. It previews by default, writes only with `sync.mode: apply` and
`--apply --yes-i-understand`, reads everything back, and never submits.

| Stage | What it synchronizes |
|---|---|
| `listing` | Confirmed version copy (description, promotional text, keywords, support and marketing URLs, What's New on an update) and, on an existing localization of the editable App Info, the declared name, subtitle, and Privacy Policy URL. It never creates a localization and reports a live app's read-only App Info as `not-editable`. |
| `screenshots` | The reviewed final screenshot decks and their order. |
| `review` | `review.contact` and `review.notes`, plus the private review note and review screenshot of every product in `monetization.products` and `monetization.consumables`. Products must already exist; prices and localizations are not touched. A manifest with `review.demoAccount.required: true` is refused, because credentials only travel through the fully gated `apply`. |
| `version` | Copyright and release mode, the declared categories on the editable App Info, and the single valid, unexpired build with the declared number. |
| `descriptions` | Descriptions only; can create the version record. Runs only when named. |

`--only listing,review` selects stages (they always run in the order above);
without it, every stage except `descriptions` runs. `--locales a,b` scopes the
listing and screenshot stages. A preview runs every stage and reports each
failure, for example a `version` stage that has no processed build yet; an
apply stops at the first failed stage and marks the rest `skipped`.

`draft` does not run preflight: it is for filling a draft while declarations
are still being confirmed. The fully gated `apply` remains the path that
checks everything. The older `draft-descriptions`, `draft-listing`,
`draft-screenshots`, `draft-review`, and `draft-version` spellings still work.
The composite action exposes `draft-plan` and `draft-apply` with the optional
`only` and `locales` inputs.

## Owner-decided AI consent flow

ShipLayer's consent checks look for a dedicated pre-transmission screen. An
owner who obtains consent another way, for example by having the user accept
the Privacy Policy at sign-in, records that as a `sourceContradictionOverrides`
entry with `finding: ai-sharing.consent`, a human-authored `reason`, `evidence`
citing the same file as `aiDataSharing.consent.evidence`, and
`confirmation: confirmed`. Every consent-flow blocker then becomes a visible
warning that quotes the reason. The privacy-policy checks are not covered: the
policy must still name the processors, the data, the purpose, retention, and
equal protection.
