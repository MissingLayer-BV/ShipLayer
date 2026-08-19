// Shared source-vs-manifest contradiction detection, used by both preflight.ts (to block/warn)
// and generator.ts (to avoid printing a confident false negative in generated artifacts).
// Kept in its own module because preflight.ts imports appReviewNotes from generator.ts; putting
// this logic in either file would create an import cycle.
import type { AnalysisReport, Finding, ShipLayerManifest, SourceContradictionOverride } from "./types.js";

/** Source-code signals strong enough that a real StoreKit purchase flow almost certainly exists. */
const STOREKIT_PURCHASE_EVIDENCE_KEYS = new Set(["storekitPurchaseCall", "storekitLocalizedPrice", "storekitProductId"]);

export function storekitPurchaseEvidence(analysis: AnalysisReport): Finding[] {
  return analysis.findings.filter((finding) => STOREKIT_PURCHASE_EVIDENCE_KEYS.has(finding.key));
}

export function evidenceSources(findings: Finding[]): string[] {
  return [...new Set(findings.flatMap((finding) => finding.evidence.map((item) => item.source)))].sort();
}

// --- AI/inference endpoint classification -------------------------------------------------

// Apex hosts for known third-party AI/LLM providers. Matched by exact host or any subdomain, so
// e.g. "api.openai.com" matches the "openai.com" entry.
const AI_PROVIDER_APEX_HOSTS = ["openrouter.ai", "openai.com", "anthropic.com", "mistral.ai", "cohere.ai", "cohere.com", "replicate.com", "stability.ai", "huggingface.co", "perplexity.ai", "groq.com", "deepseek.com", "x.ai", "together.ai", "together.xyz", "openai.azure.com", "fireworks.ai", "cerebras.ai"];
// Hosts that must match exactly (their apex domain hosts many unrelated Google APIs).
const AI_PROVIDER_EXACT_HOSTS = new Set(["generativelanguage.googleapis.com", "aiplatform.googleapis.com"]);
// Path shapes typical of an actual inference/completion API call, as opposed to a docs/privacy page.
const AI_API_PATH_PATTERN = /\/(?:v\d+\/)?(?:chat\/completions|messages|generate|inference|completions|embeddings)(?:\/|$|\?)/i;

export function isKnownAiProviderHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (AI_PROVIDER_EXACT_HOSTS.has(normalized)) return true;
  return AI_PROVIDER_APEX_HOSTS.some((apex) => normalized === apex || normalized.endsWith(`.${apex}`));
}

/**
 * "strong" — an AI/inference-shaped API path (regardless of host); this is treated as strong
 * enough evidence to force a block. "weak" — a known AI-provider host whose path does not look
 * like an API call (e.g. a bare privacy-policy or docs link); warn only, never block on this
 * alone. "none" — no AI/inference signal.
 */
export function classifyAiEndpoint(endpointUrl: string): "strong" | "weak" | "none" {
  let url: URL;
  try { url = new URL(endpointUrl); } catch { return "none"; }
  if (AI_API_PATH_PATTERN.test(url.pathname)) return "strong";
  return isKnownAiProviderHost(url.hostname) ? "weak" : "none";
}

export function endpointFindingUrl(finding: Finding): string { return finding.key.slice("endpoint:".length); }

export function classifiedAiEndpointFindings(analysis: AnalysisReport): { strong: Finding[]; weak: Finding[] } {
  const strong: Finding[] = []; const weak: Finding[] = [];
  for (const finding of analysis.findings.filter((item) => item.key.startsWith("endpoint:"))) {
    const classification = classifyAiEndpoint(endpointFindingUrl(finding));
    if (classification === "strong") strong.push(finding);
    else if (classification === "weak") weak.push(finding);
  }
  return { strong, weak };
}

// --- generic external-service (endpoint/SDK) findings, matching sourceConsistencyChecks -----

export function externalFindingId(finding: Finding): string {
  return finding.key.startsWith("endpoint:") ? finding.key : `${finding.key}:${Array.isArray(finding.value) ? finding.value.join(",") : String(finding.value)}`;
}

export function externalServiceFindings(analysis: AnalysisReport): Finding[] {
  return analysis.findings.filter((finding) => finding.key.startsWith("thirdPartySdkCandidate:") || finding.key.startsWith("endpoint:"));
}

// --- human overrides for a *.source-contradiction blocker -----------------------------------

export const MONETIZATION_CONTRADICTION_FINDING = "monetization.source-contradiction";
export function aiContradictionFindingId(finding: Finding): string { return `ai-sharing.source-contradiction:${finding.key}`; }

export function findContradictionOverride(manifest: ShipLayerManifest, findingId: string): SourceContradictionOverride | undefined {
  return manifest.sourceContradictionOverrides.find((item) => item.finding === findingId);
}

export function contradictionOverrideValid(override: SourceContradictionOverride | undefined): override is SourceContradictionOverride {
  return Boolean(override && override.confirmation === "confirmed" && override.reason.trim().length > 0 && override.evidence.length > 0);
}
