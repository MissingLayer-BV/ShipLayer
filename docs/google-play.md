# Google Play delivery

Google Play delivery uses `shiplayer-play.yml`, separate from the Apple-focused
`shiplayer.yml`. ShipLayer accepts a short-lived OAuth token in
`GOOGLE_PLAY_ACCESS_TOKEN` (or the uppercase variable named by `accessTokenEnv`).
GitHub Actions should generate this token with Workload Identity Federation so
no long-lived key is stored. A complete service-account JSON object in
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` remains available for environments that cannot
federate.

```yaml
schemaVersion: 1
packageName: com.example.app
metadata:
  directory: build/play-metadata
  confirmation: confirmed
policy:
  contentRating: confirmed
  targetAudience: confirmed
  dataSafety: confirmed
  adsDeclaration: confirmed
  privacyPolicy: confirmed # or not-applicable when no personal data is collected
  contactEmail: confirmed
release:
  versionCode: 6
  versionName: "1.3"
  bundle: app/build/outputs/bundle/release/app-release.aab
  track: production
  status: draft
  confirmation: confirmed
sync:
  mode: dry-run
  accessTokenEnv: GOOGLE_PLAY_ACCESS_TOKEN
```

The metadata directory follows the standard supply layout:

```text
build/play-metadata/
  en-US/
    title.txt
    short_description.txt
    full_description.txt
    changelogs/6.txt
    images/
      icon.png                  # required: exactly 512x512 PNG
      featureGraphic.png        # required: exactly 1024x500 PNG/JPEG, no transparency
      phoneScreenshots/01-reader.png   # at least two per locale
      sevenInchScreenshots/01-reader.png
      tenInchScreenshots/01-reader.png
```

ShipLayer validates required files, text limits, locale names, screenshot count
(at least two phone screenshots per locale, at most 8 per type), screenshot
dimensions (at least one side 320px or larger, neither side above 3840px, at most
8MB per file), the 512x512 icon, the 1024x500 feature graphic, contained paths,
and symlinks before authentication. Every image is decoded during validation so
a corrupt file fails here, not mid-apply. It changes only configured locales
and image types — including the icon and feature graphic, which synchronize
through the same images endpoints as screenshots; it never deletes an
unconfigured localization.

## Policy questionnaires

Google blocks releases until the content rating, target audience, data safety
section, and ads declaration are completed in Play Console, and listings that
collect sensitive data or need user contact require a privacy policy and contact
email. `shiplayer-play.yml` models these as six human confirmations under
`policy`. `play-plan` warns about each unconfirmed item (even without
credentials); `play-apply` refuses until the five questionnaires are
`confirmed` and `privacyPolicy` is `confirmed` or `not-applicable`.

```bash
# Creates and then deletes the temporary edit required by Google's read API.
# No edit is validated or committed.
shiplayer play-plan /path/to/AndroidApp --scope all

# After reviewing the plan and setting sync.mode: apply:
shiplayer play-apply /path/to/AndroidApp --scope all --apply --yes-i-understand
```

An apply re-runs the remote comparison and stops if it differs from the reviewed
preview. Listing text and screenshots are synchronized inside one edit. Release
scope uploads the configured AAB only when its version code is absent, preserves
other releases on the track, attaches localized release notes, validates the edit,
and commits it once. A production release must have `status: draft`; ShipLayer
rejects any configuration that could start a production rollout. Testing tracks
may use `draft` or `completed`.

The composite action accepts `command: play-plan` or `command: play-apply` and a
`scope` input (`listings`, `release`, or `all`). Keep apply in a protected,
manually dispatched environment. Grant the workflow `id-token: write`, use
`google-github-actions/auth` with `token_format: access_token` and the
`androidpublisher` scope, then map its `access_token` output to
`GOOGLE_PLAY_ACCESS_TOKEN`.
