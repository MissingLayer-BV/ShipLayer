# Asking the human

ShipLayer's schema field names (`dismissibleScreenBeforePrompt`, `aiPipelineRecipient`,
`baseTerritoryConfirmation`...) are for you and the manifest. They are not questions a person can
answer. Every human-input field needs translating into a question about **what the owner can
actually observe**: what they tap, what appears next, what a screenshot shows. This file gives
verbatim-usable templates for the fields most often asked about and hardest to phrase — it does
not enumerate every human-input field in the schema. When `shiplayer check` blocks on a field with
no template here, apply the same shape yourself: find the concrete, on-screen or in-repo fact
behind the field name, and ask about that.

## The rule that matters most

A confirmed manifest field is treated as ground truth — `check` never re-verifies a human
confirmation against the source. That makes a guessed or arbitrary answer worse than an
unanswered question: it becomes false confidence baked into the release.

- **If the owner says they don't understand the question, or answers in a way that sounds
  unsure, hedged, or guessed — do not record it.** Do not set `confirmation: confirmed` on
  anything backed by that answer.
- Re-ask in plainer terms, grounded in the running app: what screen, what button, what happens
  when you tap it. Use the templates below verbatim or adapt their shape.
- Only write `confirmed` once the owner has described something they actually observed (or
  actually did, for a step like activating an agreement) — not something they inferred, assumed,
  or agreed to because the question was too abstract to push back on.
- If you cannot phrase a field as an observable question (it's an internal detail, not something
  a screen shows), that is a signal you're asking the wrong person, or asking too early — go
  find the answer in source/config yourself first, and only fall back to the human for the part
  that genuinely requires judgment.

## Permission flow (5.1.1(iv)) — one template per category

For each detected permission category (camera, microphone, photo-library, location,
notifications, contacts, calendar, reminders, media-library, speech-recognition, motion,
tracking), you need two answers. Ask them together, framed around the real trigger you found in
source (swap in the actual button/screen name):

> In the build you're shipping now: a user on **[screen]** taps **[button/action]**. What's the
> very next thing on screen?
> - If it's the iOS system dialog itself (e.g. "**[App name]** Would Like to Access the
>   **[Camera/Microphone/...]**" — Allow / Don't Allow), that's compliant.
> - If anything of the app's own appears first that the user can dismiss, cancel, or back out of
>   before that system dialog — a sheet, an alert, a "How would you like to..." picker — that's
>   the 5.1.1(iv) violation.
>
> Second: if the user has already said no (denied the permission earlier), what happens now when
> they try the same action? Do they see anything — an alert, a banner, disabled state — that
> offers a way to open Settings and turn it back on?

Map the answers directly:
- "System dialog appears first, nothing dismissible in front of it" → `dismissibleScreenBeforePrompt: false`.
- "Yes, there's a screen/sheet with Cancel or a back gesture before the system dialog" →
  `dismissibleScreenBeforePrompt: true` — this **blocks** on its own (`permission-flow.<category>.dismissible-screen`);
  say so, then help fix the flow (make the request reachable directly, or strip the
  cancel/dismiss option) rather than just recording the admission.
- "Yes, there's a Settings link when denied" → `deniedPathOffersSettingsLink: true`.
- "No, nothing offers a way to Settings when denied" → `deniedPathOffersSettingsLink: false` —
  this **blocks** (`permission-flow.<category>.denied-path-settings-link`); help add a
  denied-state link to Settings (`UIApplication.openSettingsURLString`).
- "Not sure / never tried it denied" → **do not record either value.** This falls under the
  golden rule above: ask the owner to actually deny the permission once and retry the action, or
  walk the denied-state code path with them, and only record what they then observed.

Never accept "I think so" or "probably" for either half — ask them to actually trigger the flow
(or check the code path with you) and describe what they saw.

## Monetization

> Does this app charge anything, anywhere? Walk through the three cases:
> 1. The app itself — is it free to download, or does the App Store charge to install it?
> 2. Inside the app — is there anything a user can buy: unlock a feature, remove ads, get more
>    of something, or a subscription that renews?
> 3. If yes to #2 — is it a one-time unlock (buy once, keep forever) or a subscription (renews
>    on a schedule until cancelled)?

Map to `monetization.type`: pure download-and-use with nothing purchasable → `free` (still
needs its own `confirmation: confirmed` even though nothing else is declared). Paid to download,
nothing further to buy → `paid-app`. One-time unlock(s) → `non-consumables`. Renewing → 
`subscriptions`. If ShipLayer's scan found StoreKit purchase code but the answer says "free," stop
— that's `monetization.source-contradiction`; show them the exact file/line the scan found and
ask them to reconcile it, don't silently pick a side.

For price and paywall behavior specifically:

> When you open the paywall/purchase screen in the current build, what price is shown, and does
> it match a real StoreKit product you configured in App Store Connect — not a number typed into
> the SwiftUI code? If the price hasn't loaded yet, is the buy button disabled, or can it still be
> tapped?

For a non-consumable or subscription, three more things `check` requires and a scanner can't see
(`iap.paywall`/`subscriptions.paywall`, `iap.restore`/`subscriptions.restore`, and, for
subscriptions, `purchase.subscription-disclosures`/`.offer-disclosures`):

> - Walk me from the app's main screen to the actual purchase button, step by step — what do you
>   tap, in order? (This becomes `paywallNavigation`.)
> - Is there a "Restore Purchases" button or link visible on or near that same screen? Exactly
>   where? (This becomes `restorePath` — it must exist somewhere reachable, not buried.)
> - [Subscriptions only] Before you're able to tap buy: is the renewal period shown (e.g.
>   "$X.XX/month")? Are Terms of Use and Privacy Policy links visible on that same screen? If
>   there's a free trial or introductory price, are its exact terms (length, price after trial)
>   shown before purchase, not only after?

Only set the corresponding `purchasePresentation` booleans to `true` once the owner confirms they
saw those specific things on that specific screen — SKILL.md's App Review hard gates already say
human confirmation must still verify these disclosures; this is the question that gets you there.

## AI data sharing

Ask these in order; each maps to one manifest field. Use the app's own screens, not abstractions:

> 1. Does any feature in this app send user data (text, a photo, audio, location, anything) to a
>    server that isn't your own — OpenAI, Anthropic, Google, a hosted model, or your own backend
>    that then calls one of those? Walk me through one concrete example: what does the user type
>    or capture, and where does it go?
> 2. Right before that data is sent the first time, what does the user see on screen? Is there a
>    button or screen that appears before anything leaves the device?
> 3. What does that button actually say, word for word? (Not "yes/allow" — the exact label.)
> 4. If the user says no on that screen, what happens instead — is there a way to keep using the
>    feature locally, or without sending data?
> 5. Is there a Privacy Policy link visible on that same screen, before they tap the button?

Record `aiDataSharing.dataSent`, `.purpose`, `.processorNames`, and `consent.affirmativeAction` /
`.declinePath` using **the app's own on-screen wording**, not a paraphrase — see
[references/ai-data-sharing.md](ai-data-sharing.md) for why the exact words matter and how the
check verifies them.

## Third-party endpoints / external services found by the scan

For every `thirdPartySdkCandidate`/`endpoint` finding the scan reports (including ones that
turned out to be a plain provider policy or docs link, not an API call — see
[references/ai-data-sharing.md](ai-data-sharing.md) for why those still need a decision), ask:

> ShipLayer found a reference to `<host/path>` in `<file>`. What is it — is this code that
> actually sends data there, or is it just a link (e.g. to a policy page) that never fires an
> API call? If it sends data, what does it send and why?

"It's just a link, nothing is ever sent there" → an `externalServiceDecisions` entry with
`disposition: "not-an-external-processor"` and a `reason` saying so — **that exact string**;
`"not-a-processor"` is not a valid value and fails schema validation. "It sends data" → declare
the processor (name, purpose from Apple's fixed list, data categories, policy URL) and link the
decision to it (`disposition: "declared-processor"`). Never leave the finding undeclared — it
blocks either way until there's a confirmed disposition.

**Declaring the processor is not the last question about it.** A confirmed `externalProcessors[]`
row with `dataCategories` set immediately needs its own `collectionDetermination` answer (next
section) — confirming a processor and stopping there just trades one blocker
(`source.external.<findingId>`) for a new one (`privacy.processor.<name>.collection-determination`)
that has no forward pointer anywhere else, so don't stop at "declared."

## Is this processor's receipt of data "collection" — `externalProcessors[].collectionDetermination`

Every confirmed `externalProcessors[]` row needs one more human answer before it's done: whether
*receiving* data through it counts as "collection" under Apple's own App Privacy definition. This
is a different, narrower, and earlier question than the `dataProcessing[]` category/tracking
questions further below — those only come into play once this one is answered `collection`.

Apple's own wording: "collect" means "transmitting data off the device in a way that allows you
and/or your third-party partners to access it for a period longer than what is necessary to
service the transmitted request in real time" — with Apple's own examples of what falls *outside*
that definition: "if an authentication token or IP address is sent on a server call and not
retained, or if data is sent to your servers then immediately discarded after servicing the
request, you do not need to disclose this" (developer.apple.com/app-store/app-privacy-details/).
Ask, grounded in what actually happens to the request after it leaves the device, not the vendor's
marketing description:

> For **[processor name]**, which this app sends [data] to at `<host/path>`:
> 1. Does this processor — or its logs, its database, anyone downstream of it — keep a copy of
>    what was sent, or of the response tied back to this user or request, for longer than it
>    takes to answer that one request? Or does it just do its job (serve a file, answer a lookup,
>    proxy a call through) and nothing sent there is ever retained afterward?
> 2. If you don't know for certain, check the vendor's own documentation or data-processing
>    agreement for a stated retention/logging policy, or ask them directly. "I assume not" does
>    not count as an answer here.

"Nothing is retained past servicing the request" only after a human has checked a real source →
`collectionDetermination: "not-collection"` **and** one of these explicit structured
attestations:

```yaml
# First-party implementation: cite the exact existing processor evidence path, not a README,
# project manifest, .env file, test, or credential/config secret.
notCollectionAttestation:
  dataNotRetainedBeyondRealTimeService: true
  basis: first-party-implementation
  evidence:
    kind: repo-path
    path: Sources/VendorClient.swift
  confirmation: confirmed
```

The `repo-path` must be an existing contained regular production source/config file that exactly
overlaps `externalProcessors[].evidence` for this processor. ShipLayer verifies that linkage and
existence, not what the file means; the human still owns the retention fact. An arbitrary README,
project manifest, `.env`, test, docs file, or a path from another processor does not clear this.

```yaml
# Vendor documentation: use the row's canonical public privacy policy, not a generic vendor link.
notCollectionAttestation:
  dataNotRetainedBeyondRealTimeService: true
  basis: vendor-documentation
  evidence:
    kind: processor-privacy-policy
  confirmation: confirmed
```

For that second form, the processor's `privacyPolicyUrl` must be public HTTPS with no userinfo,
query string, or fragment; it cannot be loopback/private/reserved/IDN and must be on the
processor's exact or registrable domain. ShipLayer verifies only that URL safety/linkage; it does
not fetch, read, or prove the policy's retention terms. Do not use an arbitrary `public-url`, a
generic no-training/ZDR link, or another vendor's policy as evidence. Contracts/DPAs and written
vendor confirmations are confidential and cannot safely clear this v0.1 gate: keep them outside
the release manifest and leave the row pending or record `collection` until a safe evidence model
exists.

The exact observable fact is deliberately a literal field: **does this processor and every
downstream recipient avoid retaining the transmitted data beyond real-time servicing of the
request?** Do not set it to `true` on an assumption, from a generic no-training/ZDR claim, or to
clear a blocker. `collectionDeterminationReason`, if retained, is an optional audit note only;
ShipLayer does not parse or validate it as semantic proof in any language. A missing, pending,
false, unconfirmed, mismatched, or unsupported attestation blocks safely.

"Yes, it's retained" (or you cannot find and personally confirm the observable no-retention
fact) → `collectionDetermination: "collection"` — this now requires a matching confirmed
`dataProcessing[]` row for every one of that processor's `dataCategories` (see "Data collection
and tracking" below).

**Never record either answer to make the blocker disappear rather than because it's true.**
Guessing `not-collection` when you don't actually know is the exact failure this field exists to
prevent — a false "not collection" is itself grounds for an App Review 5.1.1(i) rejection if
Apple's questionnaire ends up wrong. If you genuinely don't know, leave it
`needs-human-confirmation` (or absent — both block identically) and tell the owner it stays
blocked until they find out.

**This is not the same question as Zero Data Retention (ZDR) or "no training on this data."** A
processor can promise ZDR/no-training and still retain the data itself for a window (for abuse
monitoring, for billing, for the ZDR retention period itself) — that is still "collection" under
Apple's definition. Only "nothing is kept past answering the request" clears this one; see
SKILL.md's App Review hard gates section for why ShipLayer never infers this from ZDR/no-training
language alone.

## Privacy, legal, trader status, agreements, age rating, content rights

These map to `confirmations.*` and are yes/no facts about steps the owner (not you) must
actually take in App Store Connect or with their legal counsel. Ask directly, one at a time, and
don't accept "should be fine":

> - Have you actually filled out and confirmed the App Store Connect Privacy questionnaire to
>   match what we just declared in this manifest? (`confirmations.privacy`)
> - Have you reviewed the legal requirements for this app/region (age restrictions, required
>   disclosures, licensing) and confirmed you meet them? (`confirmations.legal`)
> - Have you completed your Trader status declaration in App Store Connect (required in the EU)?
>   (`confirmations.trader`)
> - If this app charges money anywhere: have you activated the Paid Apps agreement and entered
>   your tax/banking information in App Store Connect? (`confirmations.paidAgreements`)
> - Have you completed the current App Store Connect age-rating questionnaire for this exact
>   build? (`confirmations.ageRating`)
> - Do you own or have licensed every asset (images, sounds, fonts, third-party content) shipped
>   in this build? (`confirmations.contentRights`)

Only `confirmed` once they say yes to the actual action, not the intention to do it later.

`not-applicable` is a valid value, but only for `trader`, `paidAgreements`, and `contentRights` —
e.g. a genuinely free app with no paid agreement to activate should record
`confirmations.paidAgreements: not-applicable`, not leave it as
`needs-human-confirmation` (which blocks). `privacy`, `legal`, and `ageRating` must be a literal
`confirmed` — `check` rejects `not-applicable` for those three even if it seems like it should
qualify; every app still needs a completed age-rating questionnaire and privacy/legal review.

## Data collection and tracking (App Privacy questionnaire — `dataProcessing[]`)

This is separate from `confirmations.privacy` above: that confirms the owner *filled out* the App
Store Connect questionnaire; `dataProcessing[]` is what the questionnaire's actual answers should
be, and `check` cross-checks it against `PrivacyInfo.xcprivacy`/Info.plist evidence where present.
It is also connected to `externalProcessors[]`, not independent of it: every confirmed processor
row whose `collectionDetermination` is `"collection"` needs a matching confirmed `dataProcessing`
row for each of its `dataCategories`, or `privacy.processor.<name>.<category>` blocks — see "Is
this processor's receipt of data 'collection'" above before you get here, since a processor
correctly confirmed `"not-collection"` needs no `dataProcessing` row for its data at all.
Do the easy part yourself first — the scanner proposes categories from source/manifest evidence —
then ask the owner only the two genuinely judgment-based questions, once per data category (e.g.
once for "Email Address", once for "Precise Location"):

> For **[data category]**, which this app collects/uses:
> 1. Can this data be traced back to this specific person — e.g. it's tied to their account,
>    email, or a device ID that identifies them — or is it collected in a way nobody (including
>    you) could connect back to an individual? (→ `linkedToIdentity`)
> 2. Is this data — or anything derived from it — ever used to track the user across *other*
>    companies' apps or websites for advertising, or shared with a data broker? (This is Apple's
>    specific definition of "tracking," not a synonym for "collected" or "used internally.")
>    (→ `usedForTracking`)

Both answers must be an explicit `true`/`false` before `confirmation: confirmed` is valid —
`privacy.<category>.details` blocks a confirmed row that still leaves either one as `"unknown"`.
Don't let "I'm not sure" become a guessed `false`; if the owner doesn't know, that's a real answer
("unknown") and the row stays unconfirmed until they find out.

## Build configuration (export compliance, signing)

Check the repository first — `check` already cross-verifies `build.signing` against
`CODE_SIGN_STYLE` in the production target (`consistency.signing`) and `build.exportCompliance`
against a declared `ITSAppUsesNonExemptEncryption` value (`consistency.encryption`). Only ask the
owner when the repository is silent or ambiguous, since `init` otherwise leaves both as
`"unknown"`, which hard-blocks (`build.signing`, `export-compliance`) on its own:

> - In Xcode, on this target's Signing & Capabilities tab: is "Automatically manage signing"
>   checked, or is a specific certificate/provisioning profile chosen manually? (→
>   `build.signing`: `automatic` or `manual`.)
> - Does this app use any encryption beyond standard HTTPS/TLS network calls — a custom cipher,
>   an encryption library, end-to-end encrypted messaging, anything you wrote or added yourself
>   for cryptography? Most apps that only call `https://` URLs qualify as exempt. If the answer is
>   genuinely "just HTTPS" → `build.exportCompliance`: `exempt`. If there's custom crypto, or the
>   owner isn't sure → `documentation-required`, and tell them this is Apple's export-compliance
>   questionnaire (the one Xcode/App Store Connect asks at every submission) — point them at it
>   rather than guessing on their behalf.

## App Review contact and demo account

> Who should Apple's reviewer contact if they have a question about this submission — first
> name, last name, email, phone? And does the app require signing in to review it? If so, what
> account should the reviewer use, and does anything need to be set up first (seed data, a
> specific account state)?

**The manifest never stores a literal username or password.** `demoAccount.usernameEnv` and
`.passwordEnv` are the *names* of environment variables (e.g. `DEMO_USERNAME`, `DEMO_PASSWORD`)
that hold the real credentials outside the repo — never write the actual username/password
anywhere in `shiplayer.yml`, including free-text fields like `setupInstructions`. If the owner
gives you literal credentials, tell them where those values actually need to live (their own
secrets store / CI environment) and only record the *variable name* in the manifest. Confirm the
credentials actually work in the current build — ask the owner to log in with them — before
setting `credentialsEnteredConfirmation: confirmed`; don't take their word that they "should"
work.

## Availability and subscription territory

> Do you want this app available in every App Store territory, or only specific ones? (v0.1 only
> models "all" — if they want a subset, tell them to configure it directly in App Store Connect
> and record that decision outside the manifest.)

For a subscription's base territory, `monetization.baseTerritory` is a **three-letter ISO
3166-1 alpha-3 code** (`USA`, `GBR`, `NLD`, ... — not the two-letter form, and a two-letter value
fails schema validation with a confusing error that names neither the field nor the real problem,
since the `monetization` union just falls through to a sibling branch). App Store Connect's
pricing screen shows territory *names*, not codes, so don't ask the owner to "read off the code":

> Open the subscription pricing/availability screen in App Store Connect — what territory name is
> set as the base for this subscription group right now (e.g. "United States", "United Kingdom",
> "Netherlands")? Tell me the name; I'll map it to the three-letter code myself.
