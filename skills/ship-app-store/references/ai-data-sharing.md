# AI data sharing: matching rules and gotchas

`check`'s AI-sharing checks are string checks, not semantic ones. Draft the manifest so the
words match from the start — don't draft descriptive prose and then discover it fails.

## `dataSent`, `purpose`, `processorNames` must appear verbatim

Once `aiDataSharing.enabled: true`, `check` (`src/preflight.ts`) reads two pieces of evidence as
plain text and does a case-insensitive **substring** search — `text.includes(value)`, nothing
fuzzier:

- **Consent evidence** (`aiDataSharing.consent.evidence` — the production Swift source that
  renders the pre-transmission screen): every entry in `dataSent`, the exact `purpose` string,
  and every entry in `processorNames` must each appear as a literal substring of the visible
  UI text extracted from that source (`ai-sharing.consent-recipients`, `.consent-data`,
  `.consent-purpose`). The declared `consent.affirmativeAction` and `.declinePath` must each
  appear as a literal substring of a `Button` label in that same source
  (`.consent-action`, `.consent-decline`).
- **Privacy-policy evidence** (`aiDataSharing.privacyPolicy.evidence` — the public policy
  document): every `processorNames` entry, every `dataSent` entry, and the `purpose` string
  must each appear as a literal substring there too (`ai-sharing.policy-recipients`,
  `.policy-data`, `.policy-purpose`).

Consequence: **write `dataSent`/`purpose`/`processorNames` as the exact words that already
appear (or that you are about to add) in both the app's consent screen and its privacy policy** —
not a manifest-native paraphrase. If the consent screen says "your photo," `dataSent` should
contain `"photo"`, not `"image data"`. Do this once, correctly, up front:

1. Read the actual consent screen source and the actual policy text first.
2. Pick `dataSent`/`purpose`/`processorNames` values that are substrings of both, in their
   current wording.
3. Only edit the app/policy text if the current wording is genuinely inadequate (e.g. it never
   names the processor at all) — don't edit either one purely to manufacture string overlap with
   an arbitrary manifest value you already chose.

The purpose-visibility check on the consent side (`ai-sharing.consent-purpose`) and the
processing-purpose match on the policy side (`ai-sharing.policy-purpose`) both use
`aiDataSharing.purpose` — a free-text sentence describing *why* the AI feature needs the data
(e.g. "to generate a caption for your photo"). Do not confuse this with `externalProcessors[].purpose`
below — same field name, different meaning and different shape.

## `externalProcessors[].purpose` is Apple's fixed enum, not prose

Unlike `aiDataSharing.purpose`, a processor's `purpose` field is a closed enum matching Apple's
App Privacy "purpose" categories (`src/schema.json` `$defs/dataPurpose`; same enum backs
`dataProcessing[].purpose`). The only valid values are exactly:

- `Third-Party Advertising`
- `Developer’s Advertising or Marketing` (curly apostrophe — U+2019, not a straight `'`; a
  straight-quote copy of this value fails schema validation)
- `Analytics`
- `Product Personalization`
- `App Functionality`
- `Other Purposes`

Writing anything else (a descriptive sentence, a made-up category) fails schema validation before
`check` even runs. `init` proposes `"Other Purposes"` by default for every discovered processor —
treat that as a placeholder to correct, not a safe default to leave in place for every processor;
pick the value that actually matches why that processor receives data (an AI inference call that
directly powers a feature the user invoked is normally `App Functionality`).

The descriptive detail (what exactly is sent, why, in plain language) does **not** go in
`purpose`. It belongs in:
- `processor.dataCategories` — an array from Apple's fixed data-category enum (also in
  `schema.json`), naming *what* is sent per processor.
- The privacy-policy text itself (`aiDataSharing.privacyPolicy` for the AI pipeline, or the
  processor's own `privacyPolicyUrl` page) — free prose explaining the collection/use/retention
  story in full.

## A plain policy link still needs a disposition — it isn't fully "cleared"

SKILL.md's AI-sharing paragraph describes the **AI-contradiction gate**: a plain provider policy
or docs link (`openai.com/policies/privacy-policy`, a model-card page, a bare root path on a
mixed apex host) only **warns** (`ai-sharing.possible-processor-link`) rather than blocking, and
needs no override to clear that warning.

That is true, but it is not the whole story for that endpoint. Independently, **every**
`endpoint`/`thirdPartySdkCandidate` finding the scanner reports — AI-shaped or not, warning or
not — also needs a confirmed entry in `externalServiceDecisions` (`source.external.<findingId>`
in `src/preflight.ts`). A plain policy link is still a scanner finding; it still needs a human
disposition recorded (for a policy/docs-only literal, `disposition: "reference-only"` with a
reason and evidence citing the same file the finding points to). This is a human classification of
the literal, not a ShipLayer reachability proof. Skipping this step
because "the AI gate already passed" leaves `source.external.*` blocking on its own. See
[references/questions.md](questions.md) for the question template to use for each finding.

## The rest of the AI-sharing classification logic

For the endpoint classification rules themselves (API-only host vs. mixed apex host vs.
unrecognized-host-with-AI-shaped-path, and when `init` proposes `kind: "ai"`), see the "AI data
sharing" bullet under "App Review hard gates" in `SKILL.md` — that stays the authoritative,
concise version; this file only adds the matching/enum/disposition detail above it.
