import { canonicalHostForComparison } from "./collection-attestation.js";
import { endpointFindingUrl, externalFindingId, validEvidencePaths } from "./evidence.js";
import type { ExternalProcessor, Finding, ShipLayerManifest } from "./types.js";

export interface ExternalServiceDecisionAssessment {
  issue?: string;
  remediation: string;
  decision?: ShipLayerManifest["externalServiceDecisions"][number];
  /** True only when the selected decision can support source readiness and generated prose. */
  usable: boolean;
}

/**
 * The one source-decision readiness predicate shared by preflight and generated artifacts.
 * It verifies manifest/source linkage and disposition shape; it never proves runtime reachability
 * or privacy/legal truth. `reference-only` is intentionally narrow: a human may classify an URL
 * literal as documentation/reference, but cannot use it to waive an SDK import or another
 * non-link source finding.
 */
export async function assessExternalServiceDecision(repository: string, manifest: ShipLayerManifest, finding: Finding): Promise<ExternalServiceDecisionAssessment> {
  const findingId = externalFindingId(finding);
  const decisions = manifest.externalServiceDecisions.filter((item) => item.finding === findingId);
  const blocked = (issue: string, remediation: string, decision?: ShipLayerManifest["externalServiceDecisions"][number]): ExternalServiceDecisionAssessment => ({ issue, remediation, decision, usable: false });
  if (decisions.length !== 1) return blocked("the source finding has no single unambiguous processor/disposition decision", "Keep one confirmed decision: declared-processor for actual processing, reference-only only for a human-confirmed URL/documentation literal, or not-an-external-processor only for a real non-processing endpoint.");
  const decision = decisions[0];
  if (decision.confirmation !== "confirmed" || !decision.reason || !decision.evidence.length) return blocked("the source finding has no confirmed processor/disposition decision", "Declare the processor or record the confirmed disposition with a human-authored reason and matching source evidence.", decision);

  const decisionEvidence = await validEvidencePaths(repository, decision.evidence);
  if (decisionEvidence.size !== decision.evidence.length) return blocked("the decision cites missing, symlinked, or out-of-repository evidence", "Use only existing, contained, regular source files as decision evidence.", decision);
  const sourceEvidence = new Set(finding.evidence.map((item) => item.source));
  if (!intersects(decisionEvidence, sourceEvidence)) return blocked("the decision evidence does not intersect this scanner finding's source evidence", "Cite an existing source file that the scanner recorded for this exact finding; an unrelated existing file cannot support this disposition.", decision);

  if (decision.disposition === "reference-only" && !isUrlEndpointFinding(finding)) return blocked("reference-only is valid only for a scanner URL/endpoint literal, not an SDK, import, entitlement, or other non-link finding", "Use declared-processor for actual processing or not-an-external-processor for a real non-processing endpoint. Do not use reference-only to clear non-link source findings.", decision);
  const sameHostProcessors = declaredProcessorsForFinding(manifest, finding);
  if (decision.disposition === "not-an-external-processor" && sameHostProcessors.length) return blocked(`not-an-external-processor contradicts declared processor host ${sameHostProcessors.map((processor) => processor.name).join(", ")}`, "Migrate this same-host decision to reference-only only if a human confirms this URL literal is documentation/privacy/marketing/reference, or to declared-processor if it represents processing. Host equality is structural and does not depend on public-policy eligibility.", decision);

  if (decision.disposition === "declared-processor") {
    const processor = manifest.externalProcessors.find((item) => item.confirmation === "confirmed" && (!decision.processorName || item.name === decision.processorName) && intersects(new Set(item.evidence || []), decisionEvidence));
    if (!processor) return blocked("the declared-processor decision is not linked to a confirmed processor evidence record", "Add the matching confirmed external processor with the same source evidence, and set processorName when linking a display-name processor.", decision);
    const processorEvidence = await validEvidencePaths(repository, processor.evidence || []);
    if (!intersects(processorEvidence, decisionEvidence)) return blocked("the declared processor's evidence is missing or does not intersect the decision evidence", "Use the same existing contained source evidence on the declared processor and this decision.", decision);
  }
  return { remediation: "", decision, usable: true };
}

/** True only for scanner endpoint findings containing an HTTP(S) URL literal. */
export function isUrlEndpointFinding(finding: Finding): boolean {
  if (!finding.key.startsWith("endpoint:")) return false;
  try { const url = new URL(endpointFindingUrl(finding)); return url.protocol === "https:" || url.protocol === "http:"; }
  catch { return false; }
}

/** Exact structural host identity only. Public-policy URL safety is intentionally evaluated by
 * the attestation gate separately, so this catches equivalence for IDN/punycode, IPv4/IPv6, and
 * special-use hosts without opening any public-evidence path. */
export function declaredProcessorsForFinding(manifest: ShipLayerManifest, finding: Finding): ExternalProcessor[] {
  if (!isUrlEndpointFinding(finding)) return [];
  let endpointHost: string | undefined;
  try { endpointHost = canonicalHostForComparison(new URL(endpointFindingUrl(finding)).hostname); } catch { return []; }
  if (!endpointHost) return [];
  return manifest.externalProcessors.filter((processor) => declaredProcessorHosts(processor).has(endpointHost));
}

export function declaredProcessorHosts(processor: ExternalProcessor): Set<string> {
  const hosts = new Set<string>();
  const structuredHost = canonicalHostForComparison(processor.name);
  if (structuredHost) hosts.add(structuredHost);
  const policyHost = canonicalHostForComparison(processor.privacyPolicyUrl);
  if (policyHost) hosts.add(policyHost);
  return hosts;
}

function intersects(left: Iterable<string>, right: Set<string>): boolean { for (const item of left) if (right.has(item)) return true; return false; }
