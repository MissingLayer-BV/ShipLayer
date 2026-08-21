# Asking the human

ShipLayer's schema field names (`dismissibleScreenBeforePrompt`, `aiPipelineRecipient`,
`baseTerritoryConfirmation`...) are for you and the manifest. They are not questions a person can
answer. Every one of the human-input fields listed in SKILL.md step 3 needs translating into a
question about **what the owner can actually observe**: what they tap, what appears next, what a
screenshot shows. This file gives verbatim-usable templates for that translation, one per field
group.

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
> offers a way to open Settings and turn it back on? Or does nothing visible happen / does the
> feature just silently fail?

Map the answers directly:
- "System dialog appears first, nothing dismissible in front of it" → `dismissibleScreenBeforePrompt: false`.
- "Yes, there's a screen/sheet with Cancel or a back gesture before the system dialog" →
  `dismissibleScreenBeforePrompt: true` — this **blocks** on its own (`permission-flow.<category>.dismissible-screen`);
  say so, then help fix the flow (make the request reachable directly, or strip the
  cancel/dismiss option) rather than just recording the admission.
- "Yes, there's a Settings link when denied" → `deniedPathOffersSettingsLink: true`.
- "No / not sure / nothing happens" → `deniedPathOffersSettingsLink: false` — this **blocks**
  (`permission-flow.<category>.denied-path-settings-link`); help add a denied-state link to
  Settings (`UIApplication.openSettingsURLString`) rather than recording a guess either way.

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
`disposition: "not-a-processor"` and a `reason` saying so. "It sends data" → declare the
processor (name, purpose from Apple's fixed list, data categories, policy URL) and link the
decision to it. Never leave the finding undeclared — it blocks either way until there's a
confirmed disposition.

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

## App Review contact and demo account

> Who should Apple's reviewer contact if they have a question about this submission — first
> name, last name, email, phone? And does the app require signing in to review it? If so, what
> username/password should the reviewer use, and does anything need to be set up first (seed
> data, a specific account state)?

If a demo account is required, confirm the credentials actually work in the current build before
setting `credentialsEnteredConfirmation: confirmed` — ask the owner to log in with them, don't
take their word that they "should" work.

## Availability and subscription territory

> Do you want this app available in every App Store territory, or only specific ones? (v0.1 only
> models "all" — if they want a subset, tell them to configure it directly in App Store Connect
> and record that decision outside the manifest.)

For a subscription's base territory:

> Open the subscription pricing screen in App Store Connect — what territory is set as the base
> for this subscription group right now? Confirm the two-letter/ISO code matches what's actually
> configured, not just a country you assume is correct.
