// Shared source-vs-manifest contradiction detection, used by both preflight.ts (to block/warn)
// and generator.ts (to avoid printing a confident false negative in generated artifacts).
// Kept in its own module because preflight.ts imports appReviewNotes from generator.ts; putting
// this logic in either file would create an import cycle.
import { lstat } from "node:fs/promises";
import { resolveContained } from "./fs.js";
import type { AnalysisReport, Finding, ShipLayerManifest, SourceContradictionOverride } from "./types.js";

// --- evidence-path validity (existence, containment, not-a-symlink) -------------------------
// Single source of truth: both preflight.ts (blockers) and generator.ts (generated text) must
// agree on what counts as a real, checkable evidence path, and a valid override predicate must
// itself refuse a path that does not exist rather than relying solely on a separate check.

export async function validEvidencePaths(repository: string, evidence: string[]): Promise<Set<string>> {
  const valid = new Set<string>();
  for (const value of evidence) {
    try { const target = await resolveContained(repository, value, "evidence path"); const details = await lstat(target); if (details.isFile() && !details.isSymbolicLink()) valid.add(value); } catch { /* invalid evidence is intentionally excluded */ }
  }
  return valid;
}

function intersects(left: Iterable<string>, right: Set<string>): boolean { for (const item of left) if (right.has(item)) return true; return false; }

// --- fixture/sample/test path exclusion --------------------------------------------------
// A finding whose only evidence lives under a fixtures/samples/examples/docs/testdata directory,
// or a conventional test-only path, is not production evidence: it must not by itself force a
// contradiction block, and it must not be counted as an unresolved production finding either.

export function isFixtureOrTestEvidencePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  const testOnly = parts.includes("app-store-screenshots")
    || /\.d\.ts$/i.test(basename)
    || parts.some((component) => /(?:UI)?Tests$|^(?:scripts?|benchmarks?)$/i.test(component))
    || /(?:UI)?Tests?\.(?:swift|m|mm)$/i.test(basename)
    || /(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(basename)
    || /(?:UI)?Tests?\.xcconfig$/i.test(basename);
  const nonProductionDirectory = parts.some((component) => /^(?:fixtures?|samples?|examples?|docs?|testdata)$/i.test(component));
  return testOnly || nonProductionDirectory;
}

/** Drops fixture/sample/example/docs/test-only evidence entries; drops a finding entirely if nothing production-relevant is left. */
export function productionEvidenceOnly(findings: Finding[]): Finding[] {
  return findings
    .map((finding) => ({ ...finding, evidence: finding.evidence.filter((item) => !isFixtureOrTestEvidencePath(item.source)) }))
    .filter((finding) => finding.evidence.length > 0);
}

export function evidenceSources(findings: Finding[]): string[] {
  return [...new Set(findings.flatMap((finding) => finding.evidence.map((item) => item.source)))].sort();
}

// --- StoreKit purchase evidence -------------------------------------------------------------
// A bare `.purchase(` call is not, by itself, distinctive of StoreKit — plenty of unrelated
// `Cart.purchase(item:)`-shaped APIs exist. Require corroboration from the same file (a StoreKit
// framework import/usage, or `.displayPrice`/`ProductView` evidence) before trusting it. A
// `.storekit` product-catalog entry, a legacy StoreKit-1 payment-queue signal, or displayPrice/
// ProductView evidence are distinctive enough to stand alone.
const STOREKIT_STANDALONE_EVIDENCE_KEYS = new Set(["storekitProductId", "storekitLocalizedPrice", "storekitLegacyPaymentQueue"]);
const STOREKIT_CORROBORATING_KEYS = new Set(["framework:StoreKit", "storekitLocalizedPrice", "storekitLegacyPaymentQueue"]);

export function storekitPurchaseEvidence(analysis: AnalysisReport): Finding[] {
  const corroboratedFiles = new Set(analysis.findings.filter((finding) => STOREKIT_CORROBORATING_KEYS.has(finding.key)).flatMap((finding) => finding.evidence.map((item) => item.source)));
  const findings = analysis.findings.filter((finding) => {
    if (STOREKIT_STANDALONE_EVIDENCE_KEYS.has(finding.key)) return true;
    if (finding.key === "storekitPurchaseCall") return finding.evidence.some((item) => corroboratedFiles.has(item.source));
    return false;
  });
  return productionEvidenceOnly(findings);
}

// --- AI/inference endpoint classification -------------------------------------------------

// Apex hosts for known third-party AI/LLM providers. Matched by exact host or any subdomain, so
// e.g. "api.openai.com" matches the "openai.com" entry.
const AI_PROVIDER_APEX_HOSTS = ["openrouter.ai", "openai.com", "anthropic.com", "mistral.ai", "cohere.ai", "cohere.com", "replicate.com", "stability.ai", "huggingface.co", "perplexity.ai", "groq.com", "deepseek.com", "x.ai", "together.ai", "together.xyz", "openai.azure.com", "fireworks.ai", "cerebras.ai", "deepinfra.com", "novita.ai"];
// Hosts that must match exactly, or by a specific known subdomain shape (their apex domain hosts
// many unrelated APIs, so a bare apex/subdomain match would be too broad).
const AI_PROVIDER_EXACT_HOSTS = new Set(["generativelanguage.googleapis.com", "aiplatform.googleapis.com"]);
const AI_PROVIDER_HOST_PATTERNS = [/(?:^|\.)aiplatform\.googleapis\.com$/i, /(?:^|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i];
// Path shapes typical of an actual inference/completion API call, as opposed to a docs/privacy page.
const AI_API_PATH_PATTERN = /\/(?:v\d+\/)?(?:chat\/completions|messages|generate|inference|completions|embeddings)(?:\/|$)/i;
// Path shapes typical of documentation/policy/marketing pages rather than an API call, plus a
// bare root path. Only used to *downgrade* a known-provider host to a warning.
const AI_DOC_PATH_PATTERN = /^\/?(?:$|(?:privacy|terms|docs?|documentation|pricing|blog|about)(?:\/|$))/i;

function isKnownAiProviderHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (AI_PROVIDER_EXACT_HOSTS.has(normalized)) return true;
  if (AI_PROVIDER_HOST_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return AI_PROVIDER_APEX_HOSTS.some((apex) => normalized === apex || normalized.endsWith(`.${apex}`));
}

/**
 * "provider" — a known AI-provider host with a path that is not recognizably documentation/
 * policy/marketing; treated as strong evidence that forces a block. "path-shape" — an
 * AI/inference-shaped API path (e.g. /chat/completions) on a host ShipLayer does not recognize;
 * this is the proxied-endpoint case (an app's own backend that forwards to an AI provider) and
 * still forces a block, but under a distinct id so the message can name the ambiguity. "policy" —
 * a known AI-provider host whose path looks like docs/privacy/terms/pricing/marketing, or a bare
 * root path; warn only, never block on this alone. "none" — no AI/inference signal.
 */
export function classifyAiEndpoint(endpointUrl: string): "provider" | "path-shape" | "policy" | "none" {
  let url: URL;
  try { url = new URL(endpointUrl); } catch { return "none"; }
  const knownProvider = isKnownAiProviderHost(url.hostname);
  if (knownProvider) return AI_DOC_PATH_PATTERN.test(url.pathname) ? "policy" : "provider";
  return AI_API_PATH_PATTERN.test(url.pathname) ? "path-shape" : "none";
}

export function endpointFindingUrl(finding: Finding): string { return finding.key.slice("endpoint:".length); }

export interface ClassifiedAiEndpoint { finding: Finding; kind: "provider" | "path-shape"; }

export function classifiedAiEndpointFindings(analysis: AnalysisReport): { strong: ClassifiedAiEndpoint[]; weak: Finding[] } {
  const strong: ClassifiedAiEndpoint[] = []; const weak: Finding[] = [];
  for (const finding of productionEvidenceOnly(analysis.findings.filter((item) => item.key.startsWith("endpoint:")))) {
    const classification = classifyAiEndpoint(endpointFindingUrl(finding));
    if (classification === "provider" || classification === "path-shape") strong.push({ finding, kind: classification });
    else if (classification === "policy") weak.push(finding);
  }
  return { strong, weak };
}

// --- generic external-service (endpoint/SDK) findings, matching sourceConsistencyChecks -----

export function externalFindingId(finding: Finding): string {
  return finding.key.startsWith("endpoint:") ? finding.key : `${finding.key}:${Array.isArray(finding.value) ? finding.value.join(",") : String(finding.value)}`;
}

export function externalServiceFindings(analysis: AnalysisReport): Finding[] {
  return productionEvidenceOnly(analysis.findings.filter((finding) => finding.key.startsWith("thirdPartySdkCandidate:") || finding.key.startsWith("endpoint:")));
}

// --- human overrides for a *.source-contradiction blocker -----------------------------------

export const MONETIZATION_CONTRADICTION_FINDING = "monetization.source-contradiction";
export function aiContradictionFindingId(finding: Finding): string { return `ai-sharing.source-contradiction:${finding.key}`; }

export function findContradictionOverride(manifest: ShipLayerManifest, findingId: string): SourceContradictionOverride | undefined {
  return manifest.sourceContradictionOverrides.find((item) => item.finding === findingId);
}

/**
 * Resolves a *.source-contradiction blocker's override, or undefined if none applies. A valid
 * override must: name this exact finding; be explicitly confirmed by a human with a non-empty
 * reason; cite at least one evidence path that (a) actually exists as a contained, non-symlinked
 * file, and (b) intersects the flagged finding's own source paths — an override cannot cite an
 * unrelated file such as NOTES.md to wave away evidence it never actually addresses.
 */
export async function resolveContradictionOverride(repository: string, manifest: ShipLayerManifest, findingId: string, findingSourcePaths: Iterable<string>): Promise<SourceContradictionOverride | undefined> {
  const override = findContradictionOverride(manifest, findingId);
  if (!override) return undefined;
  if (override.confirmation !== "confirmed") return undefined;
  if (!override.reason.trim().length) return undefined;
  if (!override.evidence.length) return undefined;
  const sourcePaths = new Set(findingSourcePaths);
  if (!intersects(override.evidence, sourcePaths)) return undefined;
  const valid = await validEvidencePaths(repository, override.evidence);
  if (valid.size !== override.evidence.length) return undefined;
  return override;
}
