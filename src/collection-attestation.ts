import type { NotCollectionAttestation } from "./types.js";

const NOT_COLLECTION_ATTESTATION_BASES = new Set<string>(["first-party-implementation", "vendor-documentation", "contract-dpa", "written-vendor-confirmation"]);

/**
 * Structural readiness for a processor's App Privacy real-time-service exception.
 *
 * This intentionally evaluates only explicit fields a human has attested to. It never reads the
 * processor's free-form audit note: natural-language parsing cannot establish (or disprove) a
 * retention fact reliably across languages, phrasing, or negation scope.
 */
export type NotCollectionAttestationIssue = "missing" | "unconfirmed" | "retention-not-attested" | "basis-unanswered" | "evidence-missing" | "evidence-invalid";

export function assessNotCollectionAttestation(attestation: NotCollectionAttestation | undefined): { issue?: NotCollectionAttestationIssue } {
  if (!attestation) return { issue: "missing" };
  if (attestation.confirmation !== "confirmed") return { issue: "unconfirmed" };
  if (attestation.dataNotRetainedBeyondRealTimeService !== true) return { issue: "retention-not-attested" };
  if (!NOT_COLLECTION_ATTESTATION_BASES.has(attestation.basis)) return { issue: "basis-unanswered" };
  if (!attestation.evidence) return { issue: "evidence-missing" };
  if (attestation.evidence.kind === "repo-path" && !attestation.evidence.path) return { issue: "evidence-invalid" };
  if (attestation.evidence.kind === "public-url" && !attestation.evidence.url) return { issue: "evidence-invalid" };
  if (attestation.evidence.kind !== "repo-path" && attestation.evidence.kind !== "public-url" && attestation.evidence.kind !== "processor-privacy-policy") return { issue: "evidence-invalid" };
  return {};
}

export function notCollectionAttestationIssueMessage(issue: NotCollectionAttestationIssue): string {
  if (issue === "missing") return "the required structured real-time-service attestation is missing";
  if (issue === "unconfirmed") return "the structured real-time-service attestation is not human-confirmed";
  if (issue === "retention-not-attested") return "the attestation does not explicitly confirm that transmitted data is not retained beyond servicing the request in real time";
  if (issue === "basis-unanswered") return "the attestation's evidence basis is still needs-human-confirmation";
  if (issue === "evidence-missing") return "the attestation has no evidence reference";
  return "the attestation's evidence reference is invalid";
}
