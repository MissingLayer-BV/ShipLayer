/**
 * A collection-determination reason is a human assertion, not legal proof. This intentionally
 * narrow guard only rejects values that cannot responsibly serve as that assertion: empty text,
 * obvious placeholders, hedging, or text with no concrete retention/request-handling fact. It
 * accepts concise checked bases such as "No request logs"; humans must still ensure the statement
 * is true before marking the processor confirmed.
 */
export interface CollectionDeterminationReasonAssessment {
  normalized: string;
  issue?: "missing" | "placeholder" | "uncertain" | "not-concrete";
}

export function assessCollectionDeterminationReason(reason: string | undefined): CollectionDeterminationReasonAssessment {
  const normalized = reason?.trim().replace(/\s+/g, " ") || "";
  if (!normalized) return { normalized, issue: "missing" };
  if (/\b(?:todo|tbd|tba|fixme|placeholder)\b/i.test(normalized) || /^(?:x|n\/?a|none|unknown)$/i.test(normalized)) return { normalized, issue: "placeholder" };
  if (/\b(?:i\s+(?:think|guess|assume|believe)|maybe|perhaps|probably|not\s+sure|unsure|uncertain|likely|seems?|appears?)\b/i.test(normalized)) return { normalized, issue: "uncertain" };
  if (!/\b(?:retain(?:ed|s|ing|ion)?|store(?:d|s|age|ing)?|discard(?:ed|s|ing)?|delet(?:e|ed|es|ing|ion)|log(?:s|ged|ging)?|cache(?:d|s|ing)?|request|response|real[ -]?time|transmi(?:t|tted|ssion)|forward(?:ed|s|ing)?|serv(?:e|ed|es|ing))\b/i.test(normalized)) return { normalized, issue: "not-concrete" };
  return { normalized };
}

export function collectionDeterminationReasonIssueMessage(issue: NonNullable<CollectionDeterminationReasonAssessment["issue"]>): string {
  if (issue === "missing") return "no non-blank human reason is recorded";
  if (issue === "placeholder") return "the reason is a placeholder rather than a checked basis";
  if (issue === "uncertain") return "the reason is uncertain rather than a checked basis";
  return "the reason does not state a concrete retention or request-handling fact";
}
