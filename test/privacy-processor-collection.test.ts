// A not-collection determination is safety-critical: prose is audit-only, while readiness rests
// on an explicit human attestation of Apple's observable real-time-service fact and evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../src/preflight.js";
import { appReviewNotes, generateReleasePackage } from "../src/generator.js";
import { validateManifest } from "../src/manifest.js";
import { analyzeRepository } from "../src/scanner.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";
import type { NotCollectionAttestation, ShipLayerManifest } from "../src/types.js";

function attestation(overrides: Partial<NotCollectionAttestation> = {}): NotCollectionAttestation {
  return {
    dataNotRetainedBeyondRealTimeService: true,
    basis: "vendor-documentation",
    evidence: { kind: "processor-privacy-policy" },
    confirmation: "confirmed",
    ...overrides
  };
}

function processor(overrides: Partial<ShipLayerManifest["externalProcessors"][number]> = {}): ShipLayerManifest["externalProcessors"][number] {
  return {
    name: "cdn.vendor-a.com",
    kind: "network",
    aiPipelineRecipient: false,
    purpose: "App Functionality",
    dataCategories: ["Product Interaction"],
    privacyPolicyUrl: "https://cdn.vendor-a.com/privacy",
    protectionConfirmation: "confirmed",
    confirmation: "confirmed",
    evidence: ["Sources/CdnClient.swift"],
    ...overrides
  };
}

function endpointForProcessor(item: ShipLayerManifest["externalProcessors"][number]): string {
  try {
    const policyHost = new URL(item.privacyPolicyUrl).hostname;
    const host = /^[a-z0-9.-]+$/i.test(item.name) && item.name.includes(".") ? item.name : policyHost;
    return `https://${host}/v1/realtime`;
  } catch { return "https://cdn.vendor-a.com/v1/realtime"; }
}

function linkScannerEndpoint(manifest: ShipLayerManifest, item: ShipLayerManifest["externalProcessors"][number], source: string): void {
  const endpoint = endpointForProcessor(item);
  manifest.externalServiceDecisions.push({ finding: `endpoint:${endpoint}`, disposition: "declared-processor", processorName: item.name, reason: "Human confirmed this runtime endpoint belongs to the declared processor.", evidence: [source], confirmation: "confirmed" });
}

async function reportFor(overrides: Partial<ShipLayerManifest["externalProcessors"][number]>): Promise<Awaited<ReturnType<typeof preflight>>> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-attestation-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  const item = processor(overrides);
  await writeFile(path.join(root, "Sources/CdnClient.swift"), `let processorEndpoint = "${endpointForProcessor(item)}"\n`);
  manifest.externalProcessors.push(item);
  linkScannerEndpoint(manifest, item, "Sources/CdnClient.swift");
  return preflight(root, manifest);
}

function hasCollectionBlock(report: Awaited<ReturnType<typeof preflight>>): boolean {
  return report.results.some((item) => item.id === "privacy.processor.cdn.vendor-a.com.collection-determination" && item.severity === "block");
}

async function configuredNotCollectionProcessor(
  processorOverrides: Partial<ShipLayerManifest["externalProcessors"][number]> = {},
  attestationOverrides: Partial<NotCollectionAttestation> = {},
  setup?: (root: string) => Promise<void>
): Promise<{ root: string; manifest: ShipLayerManifest; report: Awaited<ReturnType<typeof preflight>> }> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-evidence-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  const item = processor({ collectionDetermination: "not-collection", notCollectionAttestation: attestation(attestationOverrides), ...processorOverrides });
  await writeFile(path.join(root, "Sources/CdnClient.swift"), "struct CdnClient { func fetch() {} }\n");
  if (setup) await setup(root);
  manifest.externalProcessors.push(item);
  return { root, manifest, report: await preflight(root, manifest) };
}

function collectionDeterminationBlocked(report: Awaited<ReturnType<typeof preflight>>): boolean {
  return report.results.some((item) => item.id.endsWith(".collection-determination") && item.severity === "block");
}

test("a confirmed external processor with no collectionDetermination blocks until answered, and does not also demand a dataProcessing row while unanswered", async () => {
  const report = await reportFor({});
  assert.ok(hasCollectionBlock(report));
  assert.equal(report.results.filter((item) => item.id === "privacy.processor.cdn.vendor-a.com.Product Interaction").length, 0);
});

test("collectionDetermination explicitly needs-human-confirmation blocks identically to absent", async () => {
  assert.ok(hasCollectionBlock(await reportFor({ collectionDetermination: "needs-human-confirmation" })));
});

test("a complete structured attestation clears the category blocker without a dataProcessing row", async () => {
  const report = await reportFor({ collectionDetermination: "not-collection", notCollectionAttestation: attestation() });
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.vendor-a.com.collection-determination" && item.severity === "pass"));
  assert.equal(report.results.filter((item) => item.id === "privacy.processor.cdn.vendor-a.com.Product Interaction").length, 0);
  assert.equal(report.canSubmit, true);
});

test("legacy not-collection notes remain schema-compatible but block safely without the new attestation", async () => {
  const contradictoryAndArbitraryNotes = [
    "The server logs every request.",
    "Logging is enabled.",
    "Request data is held for 30 days.",
    "A copy is maintained for 30 days.",
    "Request history is preserved indefinitely.",
    "The system records every request.",
    "Request data is written to disk.",
    "The storage period is 30 days.",
    "No cache, data stored for 30 days.",
    "Keine Anfrageprotokolle.",
    "Aucune journalisation des requêtes.",
    "ＴＯＤＯ request",
    "Vendor X has a policy.",
    "nothing to do with storage"
  ];
  for (const collectionDeterminationReason of contradictoryAndArbitraryNotes) {
    const manifest = readyManifest();
    manifest.externalProcessors.push(processor({ collectionDetermination: "not-collection", collectionDeterminationReason }));
    assert.doesNotThrow(() => validateManifest(manifest), collectionDeterminationReason);
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-legacy-note-"));
    await writeReadyAssets(root, manifest);
    const report = await preflight(root, manifest);
    assert.ok(hasCollectionBlock(report), collectionDeterminationReason);
    assert.equal(report.canSubmit, false, collectionDeterminationReason);
  }
});

test("every incomplete, false, unconfirmed, or unusable structured attestation blocks", async () => {
  const cases: Array<{ label: string; value?: NotCollectionAttestation }> = [
    { label: "absent" },
    { label: "pending observable fact", value: attestation({ dataNotRetainedBeyondRealTimeService: "needs-human-confirmation" }) },
    { label: "false observable fact", value: attestation({ dataNotRetainedBeyondRealTimeService: false }) },
    { label: "pending evidence basis", value: attestation({ basis: "needs-human-confirmation" }) },
    { label: "needs-human-confirmation attestation", value: attestation({ confirmation: "needs-human-confirmation" }) },
    { label: "not-applicable attestation", value: attestation({ confirmation: "not-applicable" }) },
    { label: "missing repository evidence", value: attestation({ evidence: { kind: "repo-path", path: "missing-proof.md" } }) }
  ];
  for (const entry of cases) {
    const report = await reportFor({ collectionDetermination: "not-collection", notCollectionAttestation: entry.value });
    assert.ok(hasCollectionBlock(report), entry.label);
    assert.equal(report.canSubmit, false, entry.label);
  }
});

test("vendor documentation clears only through a domain-linked canonical processor privacy-policy URL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-vendor-doc-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({
    name: "api.vendor-a.com",
    privacyPolicyUrl: "https://api.vendor-a.com/privacy",
    evidence: [],
    collectionDetermination: "not-collection",
    notCollectionAttestation: attestation({ basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } })
  }));
  const report = await preflight(root, manifest);
  assert.equal(report.canSubmit, true);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.api.vendor-a.com.collection-determination" && item.severity === "pass"));
});

test("legacy repository evidence always fails closed, including unused and dead source literals", async () => {
  const cases: Array<{ label: string; source: string }> = [
    { label: "bare unused URL", source: "let unused = \"https://cdn.vendor-a.com/v1/realtime\"\n" },
    { label: "DEBUG-only URL", source: "#if DEBUG\nlet endpoint = \"https://cdn.vendor-a.com/v1/realtime\"\n#endif\n" },
    { label: "if false URL", source: "if false { let endpoint = \"https://cdn.vendor-a.com/v1/realtime\" }\n" },
    { label: "self-listed source", source: "let endpoint = \"https://cdn.vendor-a.com/v1/realtime\"\n" }
  ];
  for (const entry of cases) {
    const { report } = await configuredNotCollectionProcessor(
      { evidence: ["Sources/CdnClient.swift"] },
      { basis: "first-party-implementation", evidence: { kind: "repo-path", path: "Sources/CdnClient.swift" } },
      async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), entry.source); }
    );
    assert.ok(collectionDeterminationBlocked(report), entry.label);
    assert.equal(report.canSubmit, false, entry.label);
    assert.match(report.results.find((item) => item.id.endsWith("collection-determination"))?.message || "", /repository\/source evidence is legacy/i, entry.label);
  }

  const traversal = readyManifest();
  traversal.externalProcessors.push(processor({ evidence: ["../outside.swift"], collectionDetermination: "not-collection", notCollectionAttestation: attestation({ basis: "first-party-implementation", evidence: { kind: "repo-path", path: "../outside.swift" } }) }));
  assert.throws(() => validateManifest(traversal), /Invalid shiplayer/);
});

test("secret-bearing Swift source is never attestation evidence and never leaks", async () => {
  for (const source of ["let header = \"Authorization: Bearer bearer-sekrit\"\n", "let header = \"Bearer bare-sekrit\"\n"]) {
    const { root, manifest, report } = await configuredNotCollectionProcessor(
      { evidence: ["Sources/CdnClient.swift"] },
      { basis: "first-party-implementation", evidence: { kind: "repo-path", path: "Sources/CdnClient.swift" } },
      async (directory) => { await writeFile(path.join(directory, "Sources/CdnClient.swift"), source); }
    );
    assert.ok(collectionDeterminationBlocked(report));
    assert.doesNotMatch(JSON.stringify(report), /(?:bearer|bare)-sekrit/i);
    const analysis = await analyzeRepository(root);
    const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
    assert.doesNotMatch(await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8"), /(?:bearer|bare)-sekrit/i);
  }
});

test("basis and evidence compatibility fails closed, including arbitrary public links and confidential bases", async () => {
  const cases: Array<{ label: string; processor: Partial<ShipLayerManifest["externalProcessors"][number]>; attestation: Partial<NotCollectionAttestation> }> = [
    { label: "vendor documentation with project file", processor: { evidence: ["project.yml"] }, attestation: { basis: "vendor-documentation", evidence: { kind: "repo-path", path: "project.yml" } } },
    { label: "vendor documentation with unrelated public URL", processor: {}, attestation: { basis: "vendor-documentation", evidence: { kind: "public-url", url: "https://unrelated.example/cat-picture" } } },
    { label: "vendor generic ZDR link", processor: { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/privacy", evidence: [] }, attestation: { basis: "vendor-documentation", evidence: { kind: "public-url", url: "https://api.vendor-a.com/zdr" } } },
    { label: "first-party with policy URL", processor: {}, attestation: { basis: "first-party-implementation", evidence: { kind: "processor-privacy-policy" } } },
    { label: "contract DPA with policy URL", processor: { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/privacy", evidence: [] }, attestation: { basis: "contract-dpa", evidence: { kind: "processor-privacy-policy" } } },
    { label: "contract DPA with dotenv file", processor: { evidence: [".env"] }, attestation: { basis: "contract-dpa", evidence: { kind: "repo-path", path: ".env" } } },
    { label: "written vendor confirmation with repository path", processor: {}, attestation: { basis: "written-vendor-confirmation", evidence: { kind: "repo-path", path: "Sources/CdnClient.swift" } } },
    { label: "unrelated processor policy", processor: { name: "api.vendor-a.com", privacyPolicyUrl: "https://unrelated.example/cats", evidence: [] }, attestation: { basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } } }
  ];
  for (const entry of cases) {
    const { report } = await configuredNotCollectionProcessor(entry.processor, entry.attestation);
    assert.ok(collectionDeterminationBlocked(report), entry.label);
    assert.equal(report.canSubmit, false, entry.label);
  }
});

test("vendor policy clearance is exact-host only and rejects shared-host tenants, special-use hosts, and arbitrary paths", async () => {
  const passing = [
    { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/privacy" },
    { name: "api.vendor-a.co.in", privacyPolicyUrl: "https://api.vendor-a.co.in/data-protection" },
    { name: "vendor.github.io", privacyPolicyUrl: "https://vendor.github.io/privacy-policy" },
    { name: "tenant.pages.dev", privacyPolicyUrl: "https://tenant.pages.dev/retention" }
  ];
  for (const entry of passing) {
    const { report } = await configuredNotCollectionProcessor({ ...entry, evidence: [] }, { basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } });
    assert.equal(report.canSubmit, true, entry.name);
  }
  const failing = [
    { name: "api.vendor.co.in", privacyPolicyUrl: "https://docs.attacker.co.in/privacy" },
    { name: "vendor.github.io", privacyPolicyUrl: "https://attacker.github.io/privacy" },
    { name: "tenant.appspot.com", privacyPolicyUrl: "https://attacker.appspot.com/privacy" },
    { name: "tenant.pages.dev", privacyPolicyUrl: "https://attacker.pages.dev/privacy" },
    { name: "tenant.vercel.app", privacyPolicyUrl: "https://attacker.vercel.app/privacy" },
    { name: "tenant.cloudfront.net", privacyPolicyUrl: "https://attacker.cloudfront.net/privacy" },
    { name: "vendor.onion", privacyPolicyUrl: "https://vendor.onion/privacy" },
    { name: "vendor.home.arpa", privacyPolicyUrl: "https://vendor.home.arpa/privacy" },
    { name: "vendor.alt", privacyPolicyUrl: "https://vendor.alt/privacy" },
    { name: "vendor.local", privacyPolicyUrl: "https://vendor.local/privacy" },
    { name: "vendor.internal", privacyPolicyUrl: "https://vendor.internal/privacy" },
    { name: "vendor.corp", privacyPolicyUrl: "https://vendor.corp/privacy" },
    { name: "vendor.localdomain", privacyPolicyUrl: "https://vendor.localdomain/privacy" },
    { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/" },
    { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/zdr" },
    { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/cats" },
    { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/docs/privacy" },
    { name: "api.vendor-a.com", privacyPolicyUrl: "https://api.vendor-a.com/marketing/privacy" }
  ];
  for (const entry of failing) {
    const { report } = await configuredNotCollectionProcessor({ ...entry, evidence: [] }, { basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } });
    assert.ok(collectionDeterminationBlocked(report), entry.privacyPolicyUrl);
  }

  const namedVendor = await configuredNotCollectionProcessor({ name: "Vendor A", privacyPolicyUrl: "https://vendor-a.com/privacy", evidence: [] }, { basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } });
  assert.ok(collectionDeterminationBlocked(namedVendor.report), "a display name requires scanner-linked evidence rather than a domain-name guess");
  const lookalikeName = await configuredNotCollectionProcessor({ name: "Vendor", privacyPolicyUrl: "https://notvendor.com/privacy", evidence: [] }, { basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } });
  assert.ok(collectionDeterminationBlocked(lookalikeName.report), "a display-name substring must not authenticate a lookalike domain");

  const mappedVendor = await configuredNotCollectionProcessor(
    { name: "Vendor Edge", privacyPolicyUrl: "https://edge.vendor-a.com/privacy", evidence: ["Sources/CdnClient.swift"] },
    { basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } }
  );
  await writeFile(path.join(mappedVendor.root, "Sources/CdnClient.swift"), "let endpoint = \"https://edge.vendor-a.com/v1/realtime\"\n");
  linkScannerEndpoint(mappedVendor.manifest, mappedVendor.manifest.externalProcessors[0], "Sources/CdnClient.swift");
  const mappedVendorReport = await preflight(mappedVendor.root, mappedVendor.manifest);
  assert.equal(mappedVendorReport.canSubmit, true, "a display-name vendor can use an exact scanner endpoint plus a named human processor decision");
});

test("same-host non-processor decisions block structurally, while a human-confirmed reference-only policy link can coexist", async () => {
  const contradictory = await configuredNotCollectionProcessor(
    { evidence: ["Sources/CdnClient.swift"] },
    {},
    async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), "let endpoint = \"https://cdn.vendor-a.com/v1/realtime\"\n"); }
  );
  contradictory.manifest.externalServiceDecisions.push({ finding: "endpoint:https://cdn.vendor-a.com/v1/realtime", disposition: "not-an-external-processor", reason: "Incorrectly marked as a non-processor.", evidence: ["Sources/CdnClient.swift"], confirmation: "confirmed" });
  assert.doesNotThrow(() => validateManifest(contradictory.manifest), "legacy same-host non-processor manifests remain readable for migration");
  const contradictoryAnalysis = await analyzeRepository(contradictory.root);
  const contradictoryReport = await preflight(contradictory.root, contradictory.manifest, false, contradictoryAnalysis);
  assert.ok(collectionDeterminationBlocked(contradictoryReport));
  assert.equal(contradictoryReport.canSubmit, false);
  assert.match(contradictoryReport.results.find((item) => item.id === "source.external.endpoint:https://cdn.vendor-a.com/v1/realtime")?.remediation || "", /reference-only/i);
  const contradictoryPackage = await generateReleasePackage(contradictory.root, contradictory.manifest, contradictoryAnalysis, contradictoryReport, "shiplayer-release");
  const contradictoryDraft = await readFile(path.join(contradictoryPackage.directory, "privacy/questionnaire-draft.md"), "utf8");
  assert.match(contradictoryDraft, /UNVERIFIED: marked not-collection/i);
  assert.doesNotMatch(contradictoryDraft, /Human-confirmed not to be App Privacy collection for this processor/i);

  const policyLink = await configuredNotCollectionProcessor(
    { evidence: ["Sources/CdnClient.swift"] },
    {},
    async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), "let policy = \"https://cdn.vendor-a.com/privacy\"\nlet docs = \"https://cdn.vendor-a.com/docs/v1/reference\"\n"); }
  );
  policyLink.manifest.externalServiceDecisions.push({ finding: "endpoint:https://cdn.vendor-a.com/privacy", disposition: "reference-only", reason: "Human confirmed this literal is the public policy link only.", evidence: ["Sources/CdnClient.swift"], confirmation: "confirmed" });
  policyLink.manifest.externalServiceDecisions.push({ finding: "endpoint:https://cdn.vendor-a.com/docs/v1/reference", disposition: "reference-only", reason: "Human confirmed this literal is public documentation only.", evidence: ["Sources/CdnClient.swift"], confirmation: "confirmed" });
  const policyAnalysis = await analyzeRepository(policyLink.root);
  assert.equal(policyAnalysis.findings.find((finding) => finding.key === "endpoint:https://cdn.vendor-a.com/privacy")?.evidence.some((item) => item.runtimeNetworkRequest), false);
  assert.equal(policyAnalysis.findings.find((finding) => finding.key === "endpoint:https://cdn.vendor-a.com/docs/v1/reference")?.evidence.some((item) => item.runtimeNetworkRequest), false);
  const policyReport = await preflight(policyLink.root, policyLink.manifest);
  assert.equal(policyReport.canSubmit, true, "a human-confirmed reference-only docs/privacy literal can coexist with its processor");
});

test("same-host legacy non-processor decisions block regardless of source syntax or path", async () => {
  const requests = [
    { path: "/support/tickets", call: (url: string) => `URLSession.shared.dataTask(with: URL(string: \"${url}\")!).resume()` },
    { path: "/help/chat", call: (url: string) => `Task { _ = try? await URLSession.shared.data(from: URL(string: \"${url}\")!) }` },
    { path: "/docs/v1/upload", call: (url: string) => `URLSession.shared.uploadTask(with: URL(string: \"${url}\")!, from: Data()).resume()` },
    { path: "/legal/submit", call: (url: string) => `URLSession.shared.downloadTask(with: URL(string: \"${url}\")!).resume()` },
    { path: "/privacy", call: (url: string) => `URLSession.shared.dataTask(with: URL(string: \"${url}\")!).resume()` },
    { path: "/indirect", call: (url: string) => `let endpoint = \"${url}\"; sendThroughWrapper(endpoint)` },
    { path: "/collision", call: (url: string) => `let endpoint = \"${url}\"; struct URLSession { static func dataTask(_ value: String) {} }; URLSession.dataTask(endpoint)` },
    { path: "/shadow", call: (url: string) => `const endpoint = \"${url}\"; function fetch(value: string) {}; fetch(endpoint);` },
    { path: "/debug", call: (url: string) => `#if DEBUG\nlet endpoint = \"${url}\"\n#endif` },
    { path: "/dead", call: (url: string) => `if false { let endpoint = \"${url}\" }` }
  ];
  for (const request of requests) {
    const endpoint = `https://cdn.vendor-a.com${request.path}`;
    const state = await configuredNotCollectionProcessor(
      { evidence: ["Sources/CdnClient.swift"] },
      {},
      async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), `import Foundation\nfunc request() { ${request.call(endpoint)} }\n`); }
    );
    state.manifest.externalServiceDecisions.push({ finding: `endpoint:${endpoint}`, disposition: "not-an-external-processor", reason: "Incorrectly classified despite direct request syntax.", evidence: ["Sources/CdnClient.swift"], confirmation: "confirmed" });
    const analysis = await analyzeRepository(state.root);
    const finding = analysis.findings.find((item) => item.key === `endpoint:${endpoint}`);
    assert.ok(finding, `${endpoint}: ${analysis.findings.filter((item) => item.key.startsWith("endpoint:")).map((item) => item.key).join(", ")}`);
    const report = await preflight(state.root, state.manifest, false, analysis);
    assert.ok(collectionDeterminationBlocked(report), endpoint);
    assert.equal(report.canSubmit, false, endpoint);
    const generated = await generateReleasePackage(state.root, state.manifest, analysis, report, "shiplayer-release");
    const draft = await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8");
    assert.match(draft, /UNVERIFIED: marked not-collection/i, endpoint);
    assert.doesNotMatch(draft, /Human-confirmed not to be App Privacy collection for this processor/i, endpoint);
  }
});

test("same-host migration contradictions use structural URL host equality, including IDN, IP, and special-use hosts", async () => {
  const cases = [
    { label: "special-use onion", sourceHost: "vendor.onion", processorName: "vendor.onion", policyUrl: "https://vendor.onion/privacy" },
    { label: "Unicode IDN to punycode", sourceHost: "bücher.example", processorName: "xn--bcher-kva.example", policyUrl: "https://xn--bcher-kva.example/privacy" },
    { label: "loopback IPv4", sourceHost: "127.0.0.1", processorName: "127.0.0.1", policyUrl: "https://127.0.0.1/privacy" },
    { label: "routable IPv4", sourceHost: "8.8.8.8", processorName: "8.8.8.8", policyUrl: "https://8.8.8.8/privacy" },
    { label: "IPv6", sourceHost: "[2606:4700:4700::1111]", processorName: "2606:4700:4700::1111", policyUrl: "https://[2606:4700:4700::1111]/privacy" }
  ];
  for (const entry of cases) {
    const endpoint = `https://${entry.sourceHost}/v1/realtime`;
    const state = await configuredNotCollectionProcessor(
      { name: entry.processorName, privacyPolicyUrl: entry.policyUrl, evidence: ["Sources/CdnClient.swift"] },
      {},
      async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), `let endpoint = "${endpoint}"\n`); }
    );
    const analysis = await analyzeRepository(state.root);
    const finding = analysis.findings.find((item) => item.key.startsWith("endpoint:") && String(item.value).includes("/v1/realtime"));
    assert.ok(finding, entry.label);
    state.manifest.externalServiceDecisions.push({ finding: finding.key, disposition: "not-an-external-processor", reason: "Legacy disposition requires migration.", evidence: ["Sources/CdnClient.swift"], confirmation: "confirmed" });
    const report = await preflight(state.root, state.manifest, false, analysis);
    assert.equal(report.canSubmit, false, entry.label);
    assert.match(report.results.find((item) => item.id === `source.external.${finding.key}`)?.message || "", /contradicts declared processor host/i, entry.label);
  }
});

test("reference-only cannot clear SDK/import or another non-URL finding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-reference-only-sdk-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/App.swift"), "import Sentry\n");
  const analysis = await analyzeRepository(root);
  const finding = analysis.findings.find((item) => item.key === "thirdPartySdkCandidate:Sentry");
  assert.ok(finding);
  manifest.externalServiceDecisions.push({ finding: `thirdPartySdkCandidate:Sentry:${String(finding.value)}`, disposition: "reference-only", reason: "Incorrectly calls an SDK import a documentation link.", evidence: ["Sources/App.swift"], confirmation: "confirmed" });
  assert.throws(() => validateManifest(manifest), /endpoint:https/i, "schema communicates the narrow reference-only shape");
  const report = await preflight(root, manifest, false, analysis);
  assert.equal(report.canSubmit, false);
  assert.match(report.results.find((item) => item.id.includes("thirdPartySdkCandidate:Sentry"))?.message || "", /reference-only is valid only/i);
});

test("a direct request marked reference-only warns but remains a human-authoritative disposition", async () => {
  const endpoint = "https://cdn.vendor-a.com/privacy";
  const state = await configuredNotCollectionProcessor(
    { evidence: ["Sources/CdnClient.swift"] },
    {},
    async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), `import Foundation\nURLSession.shared.dataTask(with: URL(string: \"${endpoint}\")!).resume()\n`); }
  );
  state.manifest.externalServiceDecisions.push({ finding: `endpoint:${endpoint}`, disposition: "reference-only", reason: "Human reviewed this literal as a reference-only link.", evidence: ["Sources/CdnClient.swift"], confirmation: "confirmed" });
  const analysis = await analyzeRepository(state.root);
  const report = await preflight(state.root, state.manifest, false, analysis);
  assert.equal(report.canSubmit, true);
  assert.ok(report.results.some((item) => item.id === `source.external.endpoint:${endpoint}.runtime-reference` && item.severity === "warn"));
});

test("scanner distinguishes common JS/TS request syntax from bare policy constants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-runtime-call-syntax-"));
  await writeFile(path.join(root, "worker.ts"), [
    "const policy = 'https://cdn.vendor-a.com/privacy';",
    "fetch('https://cdn.vendor-a.com/support/tickets');",
    "axios.get('https://cdn.vendor-a.com/help/chat');",
    "request('https://cdn.vendor-a.com/docs/v1/upload');",
    "axios({ url: 'https://cdn.vendor-a.com/legal/submit' });"
  ].join("\n"));
  const analysis = await analyzeRepository(root);
  for (const endpoint of ["/support/tickets", "/help/chat", "/docs/v1/upload", "/legal/submit"]) {
    assert.ok(analysis.findings.find((finding) => finding.key === `endpoint:https://cdn.vendor-a.com${endpoint}`)?.evidence.some((item) => item.runtimeNetworkRequest), endpoint);
  }
  assert.equal(analysis.findings.find((finding) => finding.key === "endpoint:https://cdn.vendor-a.com/privacy")?.evidence.some((item) => item.runtimeNetworkRequest), false);
});

test("questionnaire guidance agrees with source linkage blocks for display-name processors", async () => {
  const state = await configuredNotCollectionProcessor(
    { name: "Vendor Edge", privacyPolicyUrl: "https://edge.vendor-a.com/privacy", evidence: [] },
    {},
    async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), "let endpoint = \"https://edge.vendor-a.com/v1/realtime\"\n"); }
  );
  state.manifest.externalServiceDecisions.push({ finding: "endpoint:https://edge.vendor-a.com/v1/realtime", disposition: "declared-processor", processorName: "Vendor Edge", reason: "Human mapped the runtime endpoint.", evidence: ["Sources/CdnClient.swift"], confirmation: "confirmed" });
  const analysis = await analyzeRepository(state.root);
  const report = await preflight(state.root, state.manifest, false, analysis);
  assert.ok(report.results.some((item) => item.id === "source.external.endpoint:https://edge.vendor-a.com/v1/realtime" && item.severity === "block"));
  assert.ok(collectionDeterminationBlocked(report));
  const generated = await generateReleasePackage(state.root, state.manifest, analysis, report, "shiplayer-release");
  const draft = await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8");
  assert.match(draft, /UNVERIFIED: marked not-collection/i);
  assert.doesNotMatch(draft, /This processor alone adds no category disclosure requirement/i);
  const privacyPolicy = await readFile(path.join(generated.directory, "legal/privacy-policy-draft.html"), "utf8");
  assert.match(privacyPolicy, /UNVERIFIED: the scanner detected/i);
  assert.doesNotMatch(privacyPolicy, /No confirmed third-party processors are listed/i);
});

test("ordinary manifest URLs may use benign query strings or fragments while structured evidence remains strict", () => {
  const manifest = readyManifest();
  manifest.contacts.supportUrl = "https://support.vendor-a.com/help?lang=en";
  manifest.contacts.privacyUrl = "https://vendor-a.com/privacy#retention";
  manifest.externalProcessors.push(processor({
    collectionDetermination: "collection",
    privacyPolicyUrl: "https://cdn.vendor-a.com/privacy?lang=en#retention",
    evidence: []
  }));
  assert.doesNotThrow(() => validateManifest(manifest));

  const credentialedOrdinaryUrl = readyManifest();
  credentialedOrdinaryUrl.contacts.supportUrl = "https://support.vendor-a.com/help?token=abc123";
  assert.throws(() => validateManifest(credentialedOrdinaryUrl), (error: unknown) => {
    assert.doesNotMatch(String(error), /abc123/i);
    return true;
  });
  credentialedOrdinaryUrl.contacts.supportUrl = "https://support.vendor-a.com/help#access_token=abc123";
  assert.throws(() => validateManifest(credentialedOrdinaryUrl), (error: unknown) => {
    assert.doesNotMatch(String(error), /abc123/i);
    return true;
  });

  const pathSecretCases: Array<(candidate: ShipLayerManifest) => void> = [
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/token/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/token/login/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/tokens/abc123"; },
    (candidate) => { candidate.contacts.privacyUrl = "https://vendor-a.com/access-token/abc123"; },
    (candidate) => { candidate.externalProcessors.push(processor({ collectionDetermination: "collection", privacyPolicyUrl: "https://cdn.vendor-a.com/api-key/abc123", evidence: [] })); },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/secret/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/credentials/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/signature/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/sig/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/bearer/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/TOKENS/%2E/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/%74okens/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/%2574oken/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/%2525252574oken/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/to%E2%80%8Bken/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/%2561ccess%2Dtoken/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/api_key//abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/auth-token/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/client-secret/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/private-key/abc123"; },
    (candidate) => { candidate.contacts.supportUrl = "https://support.vendor-a.com/oauth/code/abc123"; }
  ];
  for (const setPathSecret of pathSecretCases) {
    const pathSecret = readyManifest();
    setPathSecret(pathSecret);
    assert.throws(() => validateManifest(pathSecret), (error: unknown) => {
      assert.doesNotMatch(String(error), /abc123/i);
      return true;
    });
  }

  const benignPaths = readyManifest();
  benignPaths.contacts.supportUrl = "https://support.vendor-a.com/help/token";
  benignPaths.contacts.privacyUrl = "https://vendor-a.com/auth/logout?lang=en#retention";
  benignPaths.externalProcessors.push(processor({ collectionDetermination: "collection", privacyPolicyUrl: "https://cdn.vendor-a.com/docs/auth/guide", evidence: [] }));
  assert.doesNotThrow(() => validateManifest(benignPaths));

  const longPublicRoute = readyManifest();
  longPublicRoute.contacts.supportUrl = "https://support.vendor-a.com/docs/a-very-long-public-navigation-article";
  assert.doesNotThrow(() => validateManifest(longPublicRoute));

  for (const url of ["https://vendor-a.com/password/reset", "https://vendor-a.com/password/change", "https://vendor-a.com/key/faq", "https://vendor-a.com/key/reference", "https://vendor-a.com/auth/guide", "https://vendor-a.com/auth/login", "https://vendor-a.com/auth/login/callback", "https://vendor-a.com/auth/logout"]) {
    const benignTerminalPath = readyManifest();
    benignTerminalPath.contacts.supportUrl = url;
    assert.doesNotThrow(() => validateManifest(benignTerminalPath), url);
  }

  const strict = readyManifest();
  strict.externalProcessors.push(processor({
    name: "api.vendor-a.com",
    privacyPolicyUrl: "https://api.vendor-a.com/privacy?lang=en",
    evidence: [],
    collectionDetermination: "not-collection",
    notCollectionAttestation: attestation({ basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } })
  }));
  assert.throws(() => validateManifest(strict), /credential-safe public HTTPS URL/);
});

test("credential URL grammar redacts exact marker/value paths and rejects normalized query and fragment names", async () => {
  const invalidPaths = [
    "/api/key/abc123",
    "/docs/api/key/abc123",
    "/token/abc123",
    "/credentials/deadbeef",
    "/private/key/0123456789abcdef0123456789abcdef",
    "/authorization/code/0123456789abcdef0123456789abcdef",
    "/oauth2/code/0123456789abcdef0123456789abcdef",
    "/signature/abc123",
    "/sig/abc123",
    "/bearer/abc123",
    "/api%2Bkey/abc123",
    "/api‐key/abc123",
    "/client:secret/abc123",
    "/access~token/abc123"
  ];
  for (const pathname of invalidPaths) {
    const manifest = readyManifest();
    manifest.contacts.supportUrl = `https://support.vendor-a.com${pathname}`;
    assert.throws(() => validateManifest(manifest), /credential material/i, pathname);
  }
  for (const suffix of ["?code=abc123", "?auth_code=abc123", "?to%E2%80%8Bken=abc123", "?%2574oken=abc123", "?authorization%2Fcode=abc123", "#CODE=abc123", "#api%2Bkey=abc123", "#client%2Dsecret=abc123"]) {
    const manifest = readyManifest();
    manifest.contacts.supportUrl = `https://support.vendor-a.com/help${suffix}`;
    assert.throws(() => validateManifest(manifest), /credential material/i, suffix);
  }
  for (const pathname of [
    "/docs/how-to-rotate-client-secret",
    "/docs/api-key/rotation",
    "/signature/verification",
    "/oauth/code/examples",
    "/events/secret-santa-2026",
    "/docs/client-secret-rotation",
    "/docs/github-pat-configuration",
    "/security/secret-management-guide",
    "/auth/login/callback",
    "/password/change",
    "/password/reset",
    "/key/reference",
    "/key/faq",
    "/auth/logout"
  ]) {
    const manifest = readyManifest();
    manifest.contacts.supportUrl = `https://support.vendor-a.com${pathname}?lang=en#retention`;
    assert.doesNotThrow(() => validateManifest(manifest), pathname);
  }

  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-neutral-url-redaction-"));
  await writeFile(path.join(root, "worker.ts"), [
    "fetch('HTTPS://api.vendor-a.com/api/key/abc123');",
    "fetch('https://api.vendor-a.com/oauth2/code/deadbeef');",
    "fetch('https://api.vendor-a.com/path?to%E2%80%8Bken=abc123');"
  ].join("\n"));
  const analysis = await analyzeRepository(root);
  const serialized = JSON.stringify(analysis);
  assert.doesNotMatch(serialized, /(?:api\/key\/abc123|oauth2\/code\/deadbeef|to%E2%80%8Bken=abc123)/i);
  assert.ok(analysis.findings.some((finding) => finding.key === "endpoint:https://api.vendor-a.com/:redacted"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  for (const file of generated.files) assert.doesNotMatch(await readFile(path.join(generated.directory, file), "utf8"), /(?:abc123|deadbeef)/i, file);
});

test("mixed-case embedded credential URLs are rejected before manifest or App Review notes can echo them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-embedded-credential-url-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const analysis = await analyzeRepository(root);
  const cleanReport = await preflight(root, manifest, false, analysis);
  manifest.review.notes = "Reviewer context: HTTPS://support.vendor-a.com/api/key/abc123 is not a public support link.";
  assert.throws(() => validateManifest(manifest), (error: unknown) => {
    assert.doesNotMatch(String(error), /abc123/i);
    return true;
  });
  await assert.rejects(() => appReviewNotes(root, manifest, analysis), (error: unknown) => {
    assert.doesNotMatch(String(error), /abc123/i);
    return true;
  });
  await assert.rejects(() => generateReleasePackage(root, manifest, analysis, cleanReport, "shiplayer-release"), (error: unknown) => {
    assert.doesNotMatch(String(error), /abc123/i);
    return true;
  });
});

test("reference-only decisions must bind to a current scanner endpoint and duplicate bindings remain unresolved", async () => {
  for (const finding of ["endpoint:https://docs.vendor.com/privacy", "endpoint:https://"]) {
    const root = await mkdtemp(path.join(tmpdir(), "shiplayer-stale-reference-only-"));
    const manifest = readyManifest();
    await writeReadyAssets(root, manifest);
    await mkdir(path.join(root, "Sources"), { recursive: true });
    await writeFile(path.join(root, "Sources/Docs.swift"), "let label = \"Privacy\"\n");
    manifest.externalServiceDecisions.push({ finding, disposition: "reference-only", reason: "Human reviewed a former documentation URL.", evidence: ["Sources/Docs.swift"], confirmation: "confirmed" });
    assert.doesNotThrow(() => validateManifest(manifest), finding);
    const analysis = await analyzeRepository(root);
    const report = await preflight(root, manifest, false, analysis);
    assert.equal(report.canSubmit, false, finding);
    assert.ok(report.results.some((item) => item.id === "source.external.stale-reference-only" && item.severity === "block"), finding);
    assert.match(report.results.find((item) => item.id === "source.external.stale-reference-only")?.remediation || "", /Remove the stale|update it/i);
    const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
    const draft = await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8");
    const privacyPolicy = await readFile(path.join(generated.directory, "legal/privacy-policy-draft.html"), "utf8");
    for (const artifact of [draft, privacyPolicy]) {
      assert.match(artifact, /UNVERIFIED:/i, finding);
      assert.doesNotMatch(artifact, /No confirmed third-party processors are listed/i, finding);
    }
  }

  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-duplicate-reference-only-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await mkdir(path.join(root, "Sources"), { recursive: true });
  await writeFile(path.join(root, "Sources/Docs.swift"), "let docs = \"https://docs.vendor.com/privacy\"\n");
  const decision = { finding: "endpoint:https://docs.vendor.com/privacy", disposition: "reference-only" as const, reason: "Human confirmed this is a documentation literal.", evidence: ["Sources/Docs.swift"], confirmation: "confirmed" as const };
  manifest.externalServiceDecisions.push(decision, { ...decision });
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  assert.equal(report.canSubmit, false);
  assert.match(report.results.find((item) => item.id === "source.external.endpoint:https://docs.vendor.com/privacy")?.message || "", /single unambiguous/i);
});

test("scanner and generated artifacts redact chained credential-shaped endpoint paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-path-redaction-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const sentinel = "abc123";
  await writeFile(path.join(root, "worker.ts"), `fetch(\"https://api.vendor-a.com/token/login/${sentinel}\");`);
  const analysis = await analyzeRepository(root);
  assert.doesNotMatch(JSON.stringify(analysis), new RegExp(sentinel, "i"));
  assert.ok(analysis.findings.some((finding) => finding.key === "endpoint:https://api.vendor-a.com/:redacted"));
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  for (const file of generated.files) assert.doesNotMatch(await readFile(path.join(generated.directory, file), "utf8"), new RegExp(sentinel, "i"), file);
});

test("recursive percent decoding and invisible-character normalization redact credential paths in every artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-recursive-path-redaction-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const sentinel = "abc123";
  await writeFile(path.join(root, "worker.ts"), [
    `fetch("https://api.vendor-a.com/%2574oken/${sentinel}");`,
    `fetch("https://api.vendor-a.com/%2525252574oken/${sentinel}");`,
    `fetch("https://api.vendor-a.com/to%E2%80%8Bken/${sentinel}");`,
    `fetch("https://api.vendor-a.com/client%2Dsecret/${sentinel}");`
  ].join("\n"));
  const analysis = await analyzeRepository(root);
  assert.equal(JSON.stringify(analysis).includes(sentinel), false);
  assert.equal(analysis.findings.filter((finding) => finding.key === "endpoint:https://api.vendor-a.com/:redacted").length, 1);
  const report = await preflight(root, manifest, false, analysis);
  const generated = await generateReleasePackage(root, manifest, analysis, report, "shiplayer-release");
  for (const file of generated.files) assert.doesNotMatch(await readFile(path.join(generated.directory, file), "utf8"), new RegExp(sentinel, "i"), file);
});

test("unsafe evidence URLs are rejected without leaking their value into diagnostics or generated artifacts", async () => {
  const unsafeUrls = [
    "https://127.0.0.1/private?token=sekrit",
    "https://8.8.8.8/private",
    "https://10.0.0.1/private",
    "https://169.254.1.1/private",
    "https://192.0.2.1/private",
    "https://[::1]/private",
    "https://[2606:4700:4700::1111]/private",
    "https://[fd00::1]/private",
    "https://[2001:db8::1]/private",
    "https://vendor-a.example/private",
    "https://vendor-a.test/private",
    "https://vendor-a.invalid/private",
    "https://vendor-a.localhost/private",
    "https://vendor-a.local/private",
    "https://example.com/private",
    "https://user:password@vendor-a.com/private",
    "https://vendor-a.com/private?opaque=sekrit",
    "https://vendor-a.com/private#sekrit",
    "http://vendor-a.com/private",
    "https://xn--pple-43d.com/private",
    "https://аpple.com/private"
  ];
  for (const url of unsafeUrls) {
    const manifest = readyManifest();
    manifest.externalProcessors.push(processor({ collectionDetermination: "not-collection", notCollectionAttestation: attestation({ evidence: { kind: "public-url", url } }) }));
    assert.throws(() => validateManifest(manifest), (error: unknown) => {
      const message = String(error);
      assert.doesNotMatch(message, /sekrit|127\.0\.0\.1|password/i, url);
      return true;
    }, url);
  }

  const unsafeVendorPolicy = readyManifest();
  unsafeVendorPolicy.externalProcessors.push(processor({
    name: "api.vendor-a.com",
    privacyPolicyUrl: "https://127.0.0.1/private?token=sekrit",
    evidence: [],
    collectionDetermination: "not-collection",
    notCollectionAttestation: attestation({ basis: "vendor-documentation", evidence: { kind: "processor-privacy-policy" } })
  }));
  assert.throws(() => validateManifest(unsafeVendorPolicy), (error: unknown) => {
    assert.doesNotMatch(String(error), /sekrit|127\.0\.0\.1/i);
    return true;
  });

  const { root, manifest, report } = await configuredNotCollectionProcessor({}, { evidence: { kind: "public-url", url: "https://127.0.0.1/private?token=sekrit" } });
  assert.ok(collectionDeterminationBlocked(report));
  assert.doesNotMatch(JSON.stringify(report), /sekrit|127\.0\.0\.1/i);
  const analysis = await analyzeRepository(root);
  await assert.rejects(() => generateReleasePackage(root, manifest, analysis, report, "shiplayer-release"), (error: unknown) => {
    assert.doesNotMatch(String(error), /sekrit|127\.0\.0\.1/i);
    return true;
  });
  assert.equal(existsSync(path.join(root, "shiplayer-release")), false);
});

test("a declared dataProcessing row requires literal confirmation and known identity/tracking answers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-data-processing-confirmation-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.dataProcessing.push({ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: "unknown", usedForTracking: "unknown", confirmation: "not-applicable" });

  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.Product Interaction" && item.severity === "block"));
  assert.equal(report.canSubmit, false);

  manifest.dataProcessing[0].confirmation = "confirmed";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.Product Interaction.details" && item.severity === "block"));
  assert.equal(report.canSubmit, false);
});

test("collection requires a matching confirmed dataProcessing row", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-collection-yes-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  manifest.externalProcessors.push(processor({ evidence: [], collectionDetermination: "collection" }));
  manifest.dataProcessing.push({ category: "Product Interaction", purpose: ["App Functionality"], linkedToIdentity: false, usedForTracking: false, confirmation: "confirmed" });
  let report = await preflight(root, manifest);
  assert.equal(report.canSubmit, true);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.vendor-a.com.Product Interaction" && item.severity === "pass"));

  manifest.dataProcessing = [];
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "privacy.processor.cdn.vendor-a.com.Product Interaction" && item.severity === "block"));
});
