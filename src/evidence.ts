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
//
// Single, exported source of truth: preflight.ts's evidence-role checks (production source
// evidence for AI consent / purchase presentation) import isNonProductionSourcePath and
// isNonProductionEvidenceDirectory from here instead of keeping their own copies. Two
// independently-maintained copies of this exact predicate already drifted once (examples? was
// added here but not there, which meant preflight.ts would accept Examples/ConsentView.swift as
// valid production evidence for an in-app AI disclosure while this file correctly refused to
// treat an endpoint finding sourced only from Examples/ as production evidence) — accepting the
// wrong evidence for a disclosure screen is a false pass on the exact App Review surface
// (5.1.1(i)) this project exists to protect, so this must never have two answers.

export function isNonProductionSourcePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  return parts.includes("app-store-screenshots")
    || /\.d\.ts$/i.test(basename)
    || parts.some((component) => /(?:UI)?Tests$|^(?:scripts?|benchmarks?)$/i.test(component))
    || /(?:UI)?Tests?\.(?:swift|m|mm)$/i.test(basename)
    || /(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(basename)
    || /(?:UI)?Tests?\.xcconfig$/i.test(basename);
}
export function isNonProductionEvidenceDirectory(file: string): boolean {
  const parts = file.replace(/\\/g, "/").split("/");
  return parts.some((component) => /^(?:fixtures?|samples?|examples?|docs?|testdata)$/i.test(component));
}
export function isFixtureOrTestEvidencePath(file: string): boolean {
  return isNonProductionSourcePath(file) || isNonProductionEvidenceDirectory(file);
}

// --- screenshot UI-test harness path detection -----------------------------------------------
// Deliberately independent from isNonProductionSourcePath/isFixtureOrTestEvidencePath above:
// those two gate whether *production* evidence (privacy/purchase/AI disclosure proof) can be
// trusted, and must never be broadened or repurposed — that predicate pair was the subject of a
// four-round security review. A screenshot scenario legitimately only ever exists inside a UI
// test target, so this accessor exists purely to let the scanner look INTO XCUITest sources for
// one narrow, opposite purpose (proposing App Store screenshot scenarios), never as production
// evidence for privacy, purchases, or AI disclosure. Do not call this from any production-
// evidence code path, and do not fold its logic back into isNonProductionSourcePath.
export function isXCUITestSourcePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  if (!/\.(?:swift|m|mm)$/i.test(basename)) return false;
  return parts.some((component) => /UITests$/.test(component)) || /UITests?\.(?:swift|m|mm)$/.test(basename);
}

// --- comment stripping ------------------------------------------------------------------------
// Shared by preflight.ts (AI consent, purchase, and permission-flow evidence text must not let a
// commented-out disclosure/link satisfy a gate) and scanner.ts (permission-request-site detection
// should not propose a permission from dead, commented-out code). One implementation only: this
// used to live in preflight.ts alone, but the permission-flow gates need the identical Swift/ObjC
// comment-and-string-aware stripping from scanner.ts too, and scanner.ts cannot import from
// preflight.ts (preflight.ts already imports scanner.ts; that would be a cycle).
export function stripCodeComments(source: string): string {
  let output = "";
  let index = 0;
  let state: "normal" | "string" | "multiline-string" | "line-comment" | "block-comment" = "normal";
  let blockDepth = 0;
  while (index < source.length) {
    if (state === "normal") {
      if (source.startsWith("//", index)) { state = "line-comment"; index += 2; continue; }
      if (source.startsWith("/*", index)) { state = "block-comment"; blockDepth = 1; index += 2; continue; }
      if (source.startsWith('"""', index)) { output += '"""'; state = "multiline-string"; index += 3; continue; }
      if (source[index] === '"') { output += source[index]; state = "string"; index++; continue; }
      output += source[index++];
      continue;
    }
    if (state === "line-comment") {
      if (source[index] === "\n") { output += "\n"; state = "normal"; }
      index++;
      continue;
    }
    if (state === "block-comment") {
      if (source.startsWith("/*", index)) { blockDepth++; index += 2; continue; }
      if (source.startsWith("*/", index)) { blockDepth--; index += 2; if (blockDepth === 0) state = "normal"; continue; }
      if (source[index] === "\n") output += "\n";
      index++;
      continue;
    }
    if (state === "multiline-string") {
      if (source.startsWith('"""', index)) { output += '"""'; state = "normal"; index += 3; continue; }
      output += source[index++];
      continue;
    }
    output += source[index];
    if (source[index] === "\\" && index + 1 < source.length) output += source[++index];
    else if (source[index] === '"') state = "normal";
    index++;
  }
  return output;
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
// "api-" is not exclusively an API-only signal: api-docs.<provider>, api-reference.<provider>, and
// similar are a real documentation-hosting convention, not the API itself. Exclude those specific
// doc-ish labels rather than trusting every "api-" prefix.
const API_LABEL_DOC_EXCEPTIONS = new Set(["api-docs", "api-doc", "api-reference", "api-ref", "api-help"]);
function isApiLabeledSubdomain(host: string): boolean {
  const label = host.split(".")[0];
  if (API_LABEL_DOC_EXCEPTIONS.has(label)) return false;
  return label === "api" || label.startsWith("api-");
}
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
  // DNS (and URLSession) treat "api.openai.com" and "api.openai.com." as the same host; a
  // trailing root-label dot must not evade every apex/exact/pattern match below.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
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

// --- human overrides for a *.source-contradiction blocker, and for purchase.unavailable-source ---
// The same mechanism also resolves purchase.unavailable-source: that gate is a same-file source
// heuristic (does a literal Button whose action calls .purchase( sit behind a safe disabled
// predicate or an if-let product/price guard?), not a manifest-vs-source disagreement, so its
// finding id intentionally does not carry a ".source-contradiction" suffix. It belongs here
// anyway rather than behind a second, parallel override path: the heuristic can be wrong in
// exactly the same way (a real paywall shaped differently than the scanner expects), and a wrong
// heuristic deserves the exact same auditable, evidence-intersecting, warn-not-clear resolution —
// never a second mechanism with different rigor.

export const MONETIZATION_CONTRADICTION_FINDING = "monetization.source-contradiction";
export const PURCHASE_UNAVAILABLE_CONTRADICTION_FINDING = "purchase.unavailable-source";
export function aiContradictionFindingId(finding: Finding): string { return `ai-sharing.source-contradiction:${finding.key}`; }

export function findContradictionOverride(manifest: ShipLayerManifest, findingId: string): SourceContradictionOverride | undefined {
  return manifest.sourceContradictionOverrides.find((item) => item.finding === findingId);
}

/**
 * Resolves a *.source-contradiction blocker's (or purchase.unavailable-source's) override, or
 * undefined if none applies. A valid override must: name this exact finding; be explicitly
 * confirmed by a human with a non-empty reason; cite at least one evidence path that (a) actually
 * exists as a contained, non-symlinked file, and (b) intersects the flagged finding's own source
 * paths — an override cannot cite an unrelated file such as NOTES.md to wave away evidence it
 * never actually addresses.
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
