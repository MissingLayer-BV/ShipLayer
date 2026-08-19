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
//
// Two different shapes of "known AI provider" exist in the wild:
//   - "mixed" apex hosts, where marketing/docs/legal/model-card pages and the actual API plausibly
//     coexist on the very same hostname (openrouter.ai serves both its docs and its API at the
//     same apex, distinguished only by path) — these need a path-shape check, and doc/legal/blog/
//     model-card paths are far too open-ended to enumerate, so the check is inverted: only an
//     API-shaped path is strong evidence here, everything else on that host is at most a warning.
//   - "API-only" hosts/subdomains, which never serve anything but the API (api.openai.com,
//     api.anthropic.com, generativelanguage.googleapis.com, a customer's <resource>.openai.azure.com,
//     ...) — any call to one of these is strong evidence regardless of path, because there is no
//     marketing/docs page living there to false-positive on.
// Getting this split wrong in either direction is real damage: too narrow blocks a provider's own
// real privacy-policy/model-card links (which ai-sharing.consent-privacy-link and
// externalProcessor.privacyPolicyUrl *require* the app to surface); too broad waves through a real
// API call as a "documentation" link.

// Apex hosts where the marketing/docs site and the API plausibly share one hostname.
const AI_PROVIDER_MIXED_APEX_HOSTS = ["openrouter.ai", "openai.com", "anthropic.com", "mistral.ai", "cohere.ai", "cohere.com", "replicate.com", "stability.ai", "huggingface.co", "perplexity.ai", "groq.com", "deepseek.com", "x.ai", "together.ai", "together.xyz", "fireworks.ai", "cerebras.ai", "deepinfra.com", "novita.ai"];
// Apex hosts that only ever serve the API itself — no marketing/docs page is ever served under
// this apex (or any subdomain of it), so a call here is strong evidence regardless of path.
const AI_PROVIDER_API_ONLY_APEX_HOSTS = ["openai.azure.com"];
// Hosts that must match exactly (not by apex+subdomain), because their own apex hosts many
// unrelated marketing/docs/other-API surfaces.
const AI_PROVIDER_EXACT_API_ONLY_HOSTS = new Set(["generativelanguage.googleapis.com", "aiplatform.googleapis.com", "router.huggingface.co", "api-inference.huggingface.co"]);
const AI_PROVIDER_API_ONLY_HOST_PATTERNS = [/(?:^|\.)aiplatform\.googleapis\.com$/i, /(?:^|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i];
// Path shapes typical of an actual inference/completion API call, as opposed to a docs/privacy page.
const AI_API_PATH_PATTERN = /\/(?:v\d+\/)?(?:chat\/completions|messages|generate|inference|completions|embeddings)(?:\/|$)/i;

function apexMatch(host: string, apex: string): boolean { return host === apex || host.endsWith(`.${apex}`); }
function isApiLabeledSubdomain(host: string): boolean { const label = host.split(".")[0]; return label === "api" || label.startsWith("api-"); }
function isMixedProviderApex(host: string): boolean { return AI_PROVIDER_MIXED_APEX_HOSTS.some((apex) => apexMatch(host, apex)); }
function isApiOnlyProviderHost(host: string): boolean {
  if (AI_PROVIDER_EXACT_API_ONLY_HOSTS.has(host)) return true;
  if (AI_PROVIDER_API_ONLY_HOST_PATTERNS.some((pattern) => pattern.test(host))) return true;
  if (AI_PROVIDER_API_ONLY_APEX_HOSTS.some((apex) => apexMatch(host, apex))) return true;
  // An "api."/"api-"-labeled subdomain of a known provider (mixed-apex or API-only) is itself
  // API-only, even when its parent apex also serves marketing/docs content.
  if (isApiLabeledSubdomain(host) && (isMixedProviderApex(host) || AI_PROVIDER_API_ONLY_APEX_HOSTS.some((apex) => apexMatch(host, apex)))) return true;
  return false;
}

/**
 * "provider" — an API-only known-provider host (any path), or a mixed-apex known-provider host
 * with an API-shaped path; treated as strong evidence that forces a block. "path-shape" — an
 * AI/inference-shaped API path (e.g. /chat/completions) on a host ShipLayer does not recognize as
 * any known provider; this is the proxied-endpoint case (an app's own backend that forwards to an
 * AI provider) and still forces a block, but under a distinct id so the message can name the
 * ambiguity. "policy" — a mixed-apex known-provider host whose path is not API-shaped (this
 * necessarily also covers docs/privacy/legal/pricing/blog/model-card pages, since those are far
 * too open-ended to enumerate); warn only, never block on this alone. "none" — no AI/inference
 * signal.
 */
export function classifyAiEndpoint(endpointUrl: string): "provider" | "path-shape" | "policy" | "none" {
  let url: URL;
  try { url = new URL(endpointUrl); } catch { return "none"; }
  const host = url.hostname.toLowerCase();
  if (isApiOnlyProviderHost(host)) return "provider";
  if (isMixedProviderApex(host)) return AI_API_PATH_PATTERN.test(url.pathname) ? "provider" : "policy";
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
