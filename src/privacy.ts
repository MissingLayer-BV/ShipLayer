/**
 * A collection-determination reason is a human assertion, not legal proof. This intentionally
 * narrow guard only rejects values that cannot responsibly serve as that assertion: empty text,
 * obvious placeholders, hedging, or high-confidence affirmative retention claims. It does not
 * prove that a reason is true or impose an English vocabulary requirement: human confirmation and
 * the underlying vendor documentation/code remain the source of truth.
 */
export interface CollectionDeterminationReasonAssessment {
  normalized: string;
  issue?: "missing" | "placeholder" | "uncertain" | "contradictory";
}

export function assessCollectionDeterminationReason(reason: string | undefined): CollectionDeterminationReasonAssessment {
  // NFKC makes compatibility forms (for example full-width TODO) comparable with ordinary
  // text. Default-ignorable code points such as zero-width spaces must disappear before the
  // placeholder check, otherwise invisible punctuation can turn a known placeholder into a
  // passing not-collection assertion.
  const normalized = reason?.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").trim().replace(/\s+/g, " ") || "";
  if (!normalized) return { normalized, issue: "missing" };
  const terms = canonicalTerms(normalized);
  const canonical = terms.join(" ");
  if (hasPlaceholder(terms, canonical)) return { normalized, issue: "placeholder" };
  if (/(?:^|\s)i think(?: so)?(?:\s|$)|(?:^|\s)i (?:guess|assume|believe)(?:\s|$)|(?:^|\s)(?:maybe|perhaps|probably|not sure|unsure|uncertain|likely)(?:\s|$)/.test(canonical)) return { normalized, issue: "uncertain" };
  if (hasAffirmativeRetentionClaim(canonicalClaimText(normalized))) return { normalized, issue: "contradictory" };
  return { normalized };
}

function canonicalTerms(value: string): string[] {
  return value.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
}

/** Preserve clause boundaries for local negation, while treating joining punctuation as spaces. */
function canonicalClaimText(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}.!?;:]+/gu, " ").replace(/\s+/g, " ").trim();
}

function hasPlaceholder(terms: string[], canonical: string): boolean {
  if (/(?:^|\s)(?:todo|tbd|tba|fixme|placeholder|unknown|none)(?:\s|$)/.test(canonical)) return true;
  if (terms.includes("x")) return true;
  return hasSeparatedToken(terms, "todo") || hasSeparatedToken(terms, "tbd") || hasSeparatedToken(terms, "tba") || hasSeparatedToken(terms, "fixme") || hasSeparatedToken(terms, "na");
}

/** Detect punctuation/spaces between placeholder letters after canonicalizing separators. */
function hasSeparatedToken(terms: string[], target: string): boolean {
  for (let start = 0; start < terms.length; start++) {
    let compact = "";
    for (let index = start; index < terms.length && compact.length < target.length; index++) {
      compact += terms[index];
      if (compact === target) return true;
      if (!target.startsWith(compact)) break;
    }
  }
  return false;
}

function hasAffirmativeRetentionClaim(canonical: string): boolean {
  const action = /\b(?:retain(?:ed|s|ing)?|store(?:d|s|ing)?|persist(?:ed|s|ing)?|keep(?:s|ing|t)?|log(?:ged|ging)?|sav(?:ed|es|ing)|archiv(?:ed|es|ing)|cach(?:ed|es|ing))\b/g;
  for (const match of canonical.matchAll(action)) {
    const before = canonical.slice(Math.max(0, (match.index || 0) - 72), match.index || 0);
    const context = `${before} ${canonical.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 48)}`;
    if (isNegated(before) || !/(?:\b(?:request|requests|data|response|responses|record|records|logs?|payload|payloads|information)\b|\b(?:processor|service|vendor|system|server|backend)\b)/.test(context)) continue;
    return true;
  }
  for (const match of canonical.matchAll(/\blogs?\s+(?:(?:are|is)\s+)?enabled\b/g)) if (!isNegated(canonical.slice(Math.max(0, (match.index || 0) - 36), match.index || 0))) return true;
  return false;
}

/** A negator must be local to the affirmative verb; an earlier clause must not mask a later claim. */
function isNegated(before: string): boolean {
  return /(?:^|\s)(?:no|not|nothing|never|without|none)(?:\s+\p{L}+){0,3}\s*$/u.test(before);
}

export function collectionDeterminationReasonIssueMessage(issue: NonNullable<CollectionDeterminationReasonAssessment["issue"]>): string {
  if (issue === "missing") return "no non-blank human reason is recorded";
  if (issue === "placeholder") return "the reason is a placeholder rather than a checked basis";
  if (issue === "uncertain") return "the reason is uncertain rather than a checked basis";
  return "the reason affirmatively describes retention, storage, or logging that conflicts with not-collection";
}
