import type { NotCollectionAttestation } from "./types.js";

const NOT_COLLECTION_ATTESTATION_BASES = new Set<string>(["first-party-implementation", "vendor-documentation", "contract-dpa", "written-vendor-confirmation"]);
// These are special-use/reserved namespaces, not a substitute for the public suffix list. The
// vendor-evidence contract below intentionally avoids registrable-domain inference altogether.
const SPECIAL_USE_HOST_SUFFIXES = [".example", ".test", ".invalid", ".localhost", ".local", ".localdomain", ".internal", ".home", ".corp", ".onion", ".alt", ".example.com", ".example.net", ".example.org", ".home.arpa"];

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

/**
 * A scanner-derived endpoint and a processor host must match byte-for-byte after URL hostname
 * normalization. Deliberately do not use registrable-domain guessing: it is unsafe for tenants
 * such as github.io, pages.dev, appspot.com, or an unlisted country suffix.
 */
export function normalizedSafeHost(value: string): string | undefined {
  const normalized = normalizedHost(value);
  if (!normalized || normalized.split(".").some((label) => label.startsWith("xn--")) || isIpAddress(normalized) || isNonPublicHost(normalized)) return undefined;
  return normalized;
}

/**
 * Canonical host identity for structural source/processor comparisons. This deliberately has no
 * public-policy eligibility rules: an internal, special-use, IDN, or IP host can still be the
 * *same* host in source and a declared processor, and that contradiction must never disappear
 * merely because the host is ineligible as public attestation evidence. URL parsing supplies
 * IDN-to-punycode and IPv4/IPv6 canonicalization; comparisons remain exact, never suffix-based.
 */
export function canonicalHostForComparison(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  try {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
    let authority = candidate;
    if (!isUrl && authority.includes(":") && !authority.startsWith("[") && authority.split(":").length > 2) authority = `[${authority}]`;
    const url = new URL(isUrl ? candidate : `https://${authority}`);
    if (!isUrl && (url.username || url.password || url.pathname !== "/" || url.search || url.hash)) return undefined;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return host || undefined;
  } catch { return undefined; }
}

/** A vendor policy must use a canonical privacy/data-protection/retention/DPA route, not a ZDR,
 * marketing, generic docs, root, or arbitrary page. This checks route shape only, never content. */
export function hasCanonicalPrivacyEvidencePath(url: URL): boolean {
  const pathname = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return /^\/(?:legal\/)?(?:privacy(?:[-_](?:policy|notice|statement))?|data[-_](?:protection|privacy|collection|retention)(?:[-_](?:policy|notice|statement))?|retention(?:[-_](?:policy|notice|statement))?|dpa|data[-_]processing(?:[-_]addendum)?)(?:\.[a-z0-9]+)?$/.test(pathname);
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

function normalizedHost(value: string): string { return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""); }

function isNonPublicHost(host: string): boolean {
  if (host === "localhost" || SPECIAL_USE_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return true;
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
