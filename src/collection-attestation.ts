import type { NotCollectionAttestation } from "./types.js";

const NOT_COLLECTION_ATTESTATION_BASES = new Set<string>(["first-party-implementation", "vendor-documentation", "contract-dpa", "written-vendor-confirmation"]);
const RESERVED_HOST_SUFFIXES = [".example", ".test", ".invalid", ".localhost", ".local", ".localdomain", ".internal", ".home", ".corp", ".example.com", ".example.net", ".example.org"];
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set(["ac.uk", "co.uk", "gov.uk", "ltd.uk", "me.uk", "net.uk", "org.uk", "plc.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.jp", "ne.jp", "or.jp", "com.br", "com.cn", "com.mx", "co.nz", "co.za", "com.sg", "com.tr"]);

/**
 * Structural readiness for a processor's App Privacy real-time-service exception.
 *
 * This intentionally evaluates only explicit fields a human has attested to. It never reads the
 * processor's free-form audit note: natural-language parsing cannot establish (or disprove) a
 * retention fact reliably across languages, phrasing, or negation scope.
 */
export type NotCollectionAttestationIssue = "missing" | "unconfirmed" | "retention-not-attested" | "basis-unanswered" | "evidence-missing" | "evidence-invalid";

export type PublicEvidenceUrlIssue = "invalid" | "not-https" | "credentials" | "query-or-fragment" | "non-public-host" | "idn-host";

/**
 * Evidence URLs are intentionally much stricter than ordinary links. A release manifest is
 * copied into generated artifacts, so this forbids all credential-bearing or stateful URL forms
 * before they can be echoed. It does not fetch or validate document content.
 */
export function assessPublicEvidenceUrl(value: string): { issue?: PublicEvidenceUrlIssue; url?: URL } {
  let url: URL;
  try { url = new URL(value); } catch { return { issue: "invalid" }; }
  if (url.protocol !== "https:") return { issue: "not-https" };
  if (url.username || url.password) return { issue: "credentials" };
  if (url.search || url.hash) return { issue: "query-or-fragment" };
  const host = normalizedHost(url.hostname);
  if (!host || host.split(".").some((label) => label.startsWith("xn--"))) return { issue: "idn-host" };
  // A canonical vendor policy should have a public DNS name. Reject every IP literal, including
  // globally routed ones, rather than trying to distinguish harmless documentation from an
  // internal endpoint hidden behind alternate IPv4/IPv6 notation.
  if (isIpAddress(host)) return { issue: "non-public-host" };
  if (isNonPublicHost(host)) return { issue: "non-public-host" };
  return { url };
}

/** A deliberately conservative registrable-domain comparison for processor/document linkage. */
export function processorNameLinksToDocumentation(processorName: string, documentationUrl: string): boolean {
  const assessed = assessPublicEvidenceUrl(documentationUrl);
  if (!assessed.url) return false;
  const documentDomain = registrableDomain(normalizedHost(assessed.url.hostname));
  if (!documentDomain) return false;
  const nameHost = hostFromProcessorName(processorName);
  if (nameHost) return registrableDomain(nameHost) === documentDomain;
  // A display name has less provenance than a network host.  Permit only a strict match to the
  // registrable-domain label (after harmless company-suffix normalization), not a substring:
  // "Vendor" must not authenticate notvendor.example.  A false negative leaves the row pending;
  // a false positive would let one vendor's policy clear another processor.
  const normalizedName = processorName.toLowerCase().trim().replace(/(?:[\s,.-]+(?:inc(?:orporated)?|llc|ltd|limited|gmbh|bv|corp(?:oration)?))$/i, "");
  const compactName = normalizedName.replace(/[^a-z0-9]+/g, "");
  const compactDomainLabel = documentDomain.split(".")[0].replace(/[^a-z0-9]+/g, "");
  return compactName.length >= 3 && compactName === compactDomainLabel;
}

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

function hostFromProcessorName(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(trimmed) || !trimmed.includes(".")) return undefined;
  if (trimmed.split(".").some((label) => !label || label.startsWith("xn--"))) return undefined;
  return isNonPublicHost(trimmed) ? undefined : trimmed;
}

function normalizedHost(value: string): string { return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""); }

function registrableDomain(host: string): string | undefined {
  if (!host || isIpAddress(host) || isNonPublicHost(host)) return undefined;
  const labels = host.split(".");
  if (labels.some((label) => !label || label.startsWith("xn--"))) return undefined;
  const suffixLength = MULTI_LABEL_PUBLIC_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  if (labels.length <= suffixLength) return undefined;
  return labels.slice(-(suffixLength + 1)).join(".");
}

function isNonPublicHost(host: string): boolean {
  if (host === "localhost" || RESERVED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return true;
  if (isIPv4Address(host)) return isNonPublicIPv4(host);
  if (host.includes(":")) return isNonPublicIPv6(host);
  return false;
}

function isIpAddress(host: string): boolean { return isIPv4Address(host) || host.includes(":"); }

function isIPv4Address(host: string): boolean { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255); }

function isNonPublicIPv4(host: string): boolean {
  const [first, second] = host.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 || first >= 224 || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168)) || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0);
}

function isNonPublicIPv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "::" || normalized === "::1" || /^fe[89ab][0-9a-f]:/.test(normalized)
    || /^f[cd][0-9a-f]{2}:/.test(normalized) || /^2001:0?db8:/.test(normalized);
}
