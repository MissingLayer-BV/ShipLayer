import { assessNotCollectionAttestation, assessPublicEvidenceUrl, hasCanonicalPrivacyEvidencePath, normalizedSafeHost, notCollectionAttestationIssueMessage } from "./collection-attestation.js";
import { endpointFindingUrl, externalFindingId, externalServiceFindings } from "./evidence.js";
import type { AnalysisReport, ExternalProcessor, ShipLayerManifest } from "./types.js";

export interface NotCollectionEvidenceAssessment {
  issue?: string;
  remediation: string;
  verified: string;
  /** Scanner endpoint decisions which must remain clear for this processor-specific guidance. */
  relevantFindingIds: string[];
}

/**
 * This is intentionally a linkage assessment, not a retention analyzer. A human attests to the
 * Apple-definition fact; ShipLayer verifies only the narrowly supported public-policy reference
 * and any source-disposition consistency which is relevant to the named processor.
 *
 * Repository paths are retained in the manifest type only as a migration shape. Source text,
 * reachability, and a file's apparent contents cannot prove runtime retention, so they never
 * clear a not-collection determination.
 */
export function assessNotCollectionEvidence(manifest: ShipLayerManifest, analysis: AnalysisReport, processor: ExternalProcessor): NotCollectionEvidenceAssessment {
  const attestation = processor.notCollectionAttestation;
  const blocked = (issue: string, remediation: string, relevantFindingIds: string[] = []): NotCollectionEvidenceAssessment => ({ issue, remediation, verified: "nothing", relevantFindingIds });
  const basic = assessNotCollectionAttestation(attestation);
  if (basic.issue || !attestation) return blocked(notCollectionAttestationIssueMessage(basic.issue || "missing"), "Record a literal human-confirmed real-time-service attestation, then use the processor's exact canonical public privacy/data-protection/data-collection/retention/DPA policy URL. Free-form notes and repository files cannot clear this blocker.");
  const evidence = attestation.evidence;
  if (evidence.kind === "repo-path" || attestation.basis === "first-party-implementation") return blocked("repository/source evidence is legacy and cannot automatically establish real-time service or no retention", "Migrate this row to vendor-documentation with evidence.kind: processor-privacy-policy and this processor's exact canonical public privacy/data-protection/data-collection/retention/DPA policy URL. Keep private first-party records outside the manifest and leave the row pending if no safe public policy reference exists.");
  if (evidence.kind === "public-url") {
    if (assessPublicEvidenceUrl(evidence.url).issue) return blocked("the public evidence URL is not a credential-safe public HTTPS URL", "Do not place credentials, query strings, fragments, private/reserved hosts, or IDN hostnames in structured evidence.");
    return blocked("generic public-url evidence is not a supported not-collection clearance", "Use vendor-documentation with the processor's exact canonical privacy-policy URL, or leave the determination pending.");
  }
  if (attestation.basis === "contract-dpa" || attestation.basis === "written-vendor-confirmation") return blocked(`${attestation.basis} is not a safely verifiable v0.1 evidence basis`, "Keep confidential contracts or written confirmations outside the release manifest. Do not paste or link them here; record collection or leave the determination pending until a safely verifiable evidence model exists.");
  if (attestation.basis !== "vendor-documentation" || evidence.kind !== "processor-privacy-policy") return blocked("the evidence basis is unsupported", "Use vendor-documentation with evidence.kind: processor-privacy-policy and this processor's exact canonical public privacy-policy URL, or leave the determination pending.");

  const policy = assessPublicEvidenceUrl(processor.privacyPolicyUrl).url;
  const policyHost = policy ? normalizedSafeHost(policy.hostname) : undefined;
  if (!policy || !policyHost) return blocked("the processor privacy-policy URL is not a credential-safe public HTTPS URL", "Record a canonical public HTTPS policy URL without userinfo, query strings, fragments, private/reserved hosts, IP literals, or IDN hostnames.");
  if (!hasCanonicalPrivacyEvidencePath(policy)) return blocked("the privacy-policy URL does not use a canonical privacy/data-protection/retention/DPA route", "Use the processor's canonical privacy, data-protection, data-collection, retention, or DPA page; root, marketing, docs, ZDR/no-training, and arbitrary pages cannot clear this gate.");

  const relevant = relevantProcessorFindings(manifest, analysis, processor, policyHost);
  const relevantFindingIds = relevant.map(externalFindingId);
  for (const finding of relevant) {
    const decisions = manifest.externalServiceDecisions.filter((decision) => decision.finding === externalFindingId(finding) && decision.confirmation === "confirmed");
    if (!decisions.length) return blocked("a source finding on this processor's exact host is not reconciled", "For each scanner endpoint on this processor's exact host (or explicitly mapped to this display-name processor), add one confirmed declared-processor or reference-only decision with matching source evidence. A reference-only decision means the human confirmed that literal is only documentation/privacy/marketing/reference; ShipLayer does not prove reachability.", relevantFindingIds);
    if (decisions.some((decision) => decision.disposition === "not-an-external-processor")) return blocked("a source finding on this declared processor host uses the legacy not-an-external-processor disposition", "Migrate this same-host decision to reference-only only if a human confirms the literal is solely documentation/privacy/marketing/reference, or to declared-processor if it represents processing. Do not use not-an-external-processor for any finding on a declared processor host.", relevantFindingIds);
  }

  const structuredHost = normalizedSafeHost(processor.name);
  if (structuredHost === policyHost) return { remediation: "", verified: "the canonical policy hostname exactly matches the structured processor host and uses a privacy/data-protection/data-collection/retention/DPA route", relevantFindingIds };
  if (relevant.some((finding) => manifest.externalServiceDecisions.some((decision) => decision.finding === externalFindingId(finding) && isExactDeclaredProcessorDecision(decision, finding, processor)))) return { remediation: "", verified: "a scanner endpoint and an exact declared-processor decision link the canonical policy hostname to this display-name processor; ShipLayer did not read or verify policy content", relevantFindingIds };
  return blocked("the privacy-policy host is not exactly linked to the declared processor", "Use a policy URL on the exact processor hostname, or provide an exact scanner runtime endpoint plus a confirmed declared-processor decision naming this processor. Shared-host tenants and parent-domain guesses never clear this gate.");
}

/** Findings are relevant by exact declared host or explicit human mapping—not pathname, call
 * syntax, or an attempt to derive reachability from source. A reference-only decision is a
 * human-confirmed literal classification, while the scanner's runtimeNetworkRequest field is only
 * advisory elsewhere in preflight. */
function relevantProcessorFindings(manifest: ShipLayerManifest, analysis: AnalysisReport, processor: ExternalProcessor, policyHost: string) {
  return externalServiceFindings(analysis).filter((finding) => {
    const url = endpointUrl(finding);
    const endpointHost = url ? normalizedSafeHost(url.hostname) : undefined;
    if (endpointHost && endpointHost === policyHost) return true;
    return manifest.externalServiceDecisions.some((decision) => decision.finding === externalFindingId(finding) && decision.processorName === processor.name);
  });
}

/** Exact host matching for the global source-disposition migration gate. A display-name processor
 * declares the hostname in its canonical privacyPolicyUrl; a structured host may declare it in
 * name as well. Never infer parent/registrable-domain ownership. */
export function declaredProcessorsForFinding(manifest: ShipLayerManifest, finding: AnalysisReport["findings"][number]): ExternalProcessor[] {
  const endpoint = endpointUrl(finding);
  const endpointHost = endpoint ? normalizedSafeHost(endpoint.hostname) : undefined;
  if (!endpointHost) return [];
  return manifest.externalProcessors.filter((processor) => declaredProcessorHosts(processor).has(endpointHost));
}

function declaredProcessorHosts(processor: ExternalProcessor): Set<string> {
  const hosts = new Set<string>();
  const structuredHost = normalizedSafeHost(processor.name);
  if (structuredHost) hosts.add(structuredHost);
  try {
    const policyHost = normalizedSafeHost(new URL(processor.privacyPolicyUrl).hostname);
    if (policyHost) hosts.add(policyHost);
  } catch { /* schema/preflight handles invalid URLs separately */ }
  return hosts;
}

function isExactDeclaredProcessorDecision(decision: ShipLayerManifest["externalServiceDecisions"][number], finding: AnalysisReport["findings"][number], processor: ExternalProcessor): boolean {
  if (decision.disposition !== "declared-processor" || decision.processorName !== processor.name) return false;
  const findingSources = new Set(finding.evidence.map((item) => item.source));
  const processorSources = new Set(processor.evidence || []);
  return decision.evidence.some((path) => findingSources.has(path) && processorSources.has(path));
}

function endpointUrl(finding: AnalysisReport["findings"][number]): URL | undefined { try { return new URL(endpointFindingUrl(finding)); } catch { return undefined; } }
