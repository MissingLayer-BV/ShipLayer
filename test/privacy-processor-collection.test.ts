// A not-collection determination is safety-critical: prose is audit-only, while readiness rests
// on an explicit human attestation of Apple's observable real-time-service fact and evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../src/preflight.js";
import { generateReleasePackage } from "../src/generator.js";
import { validateManifest } from "../src/manifest.js";
import { analyzeRepository } from "../src/scanner.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";
import type { NotCollectionAttestation, ShipLayerManifest } from "../src/types.js";

function attestation(overrides: Partial<NotCollectionAttestation> = {}): NotCollectionAttestation {
  return {
    dataNotRetainedBeyondRealTimeService: true,
    basis: "first-party-implementation",
    evidence: { kind: "repo-path", path: "Sources/CdnClient.swift" },
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
  const firstParty = item.notCollectionAttestation?.basis === "first-party-implementation";
  await writeFile(path.join(root, "Sources/CdnClient.swift"), firstParty ? `let processorEndpoint = "${endpointForProcessor(item)}"\n` : "struct CdnClient { func fetch() {} }\n");
  if (setup) await setup(root);
  manifest.externalProcessors.push(item);
  if (firstParty) linkScannerEndpoint(manifest, item, "Sources/CdnClient.swift");
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

test("first-party implementation evidence must be scanner-correlated rather than manifest-self-certified", async () => {
  const cases: Array<{ label: string; path: string; processorEvidence: string[]; setup?: (root: string) => Promise<void> }> = [
    { label: "generic project manifest", path: "project.yml", processorEvidence: ["project.yml"] },
    { label: "README", path: "README.md", processorEvidence: ["README.md"], setup: async (root) => { await writeFile(path.join(root, "README.md"), "Vendor integration notes\n"); } },
    { label: "dotenv credential file", path: ".env", processorEvidence: [".env"], setup: async (root) => { await writeFile(path.join(root, ".env"), "API_TOKEN=not-for-manifest\n"); } },
    { label: "self-listed unrelated source", path: "Sources/Unrelated.swift", processorEvidence: ["Sources/Unrelated.swift"], setup: async (root) => { await writeFile(path.join(root, "Sources/Unrelated.swift"), "let unrelatedEndpoint = \"https://other.vendor-a.com/v1/events\"\n"); } },
    { label: "nonexistent source", path: "Sources/Missing.swift", processorEvidence: ["Sources/Missing.swift"] },
    { label: "symlink source", path: "Sources/Linked.swift", processorEvidence: ["Sources/Linked.swift"], setup: async (root) => { await symlink("CdnClient.swift", path.join(root, "Sources/Linked.swift")); } }
  ];
  for (const entry of cases) {
    const { report } = await configuredNotCollectionProcessor({ evidence: entry.processorEvidence }, { evidence: { kind: "repo-path", path: entry.path } }, entry.setup);
    assert.ok(collectionDeterminationBlocked(report), entry.label);
    assert.equal(report.canSubmit, false, entry.label);
  }

  const traversal = readyManifest();
  traversal.externalProcessors.push(processor({ evidence: ["../outside.swift"], collectionDetermination: "not-collection", notCollectionAttestation: attestation({ evidence: { kind: "repo-path", path: "../outside.swift" } }) }));
  assert.throws(() => validateManifest(traversal), /Invalid shiplayer/);
});

test("first-party evidence needs a scanner endpoint match, rejects secrets, and can use an exact human decision for a display-name processor", async () => {
  const selfListed = await configuredNotCollectionProcessor(
    { evidence: ["Sources/Unrelated.swift"] },
    { evidence: { kind: "repo-path", path: "Sources/Unrelated.swift" } },
    async (root) => { await writeFile(path.join(root, "Sources/Unrelated.swift"), "let unrelatedEndpoint = \"https://other.vendor-a.com/v1/events\"\n"); }
  );
  assert.ok(collectionDeterminationBlocked(selfListed.report), "adding the same unrelated path to both manifest fields cannot self-certify it");

  const secretBearing = await configuredNotCollectionProcessor(
    {},
    {},
    async (root) => { await writeFile(path.join(root, "Sources/CdnClient.swift"), "let apiToken = \"sekrit-value\"\nlet endpoint = \"https://cdn.vendor-a.com/v1/realtime\"\n"); }
  );
  assert.ok(collectionDeterminationBlocked(secretBearing.report));
  assert.doesNotMatch(JSON.stringify(secretBearing.report), /sekrit-value/i);

  const unrelatedSecret = await configuredNotCollectionProcessor(
    { evidence: ["Sources/Unrelated.swift"] },
    { evidence: { kind: "repo-path", path: "Sources/Unrelated.swift" } },
    async (root) => { await writeFile(path.join(root, "Sources/Unrelated.swift"), "let apiToken = \"unrelated-sekrit\"\nlet unrelatedEndpoint = \"https://other.vendor-a.com/v1/events\"\n"); }
  );
  assert.ok(collectionDeterminationBlocked(unrelatedSecret.report));
  assert.doesNotMatch(JSON.stringify(unrelatedSecret.report), /unrelated-sekrit/i);

  const displayName = await configuredNotCollectionProcessor(
    { name: "Vendor Edge", privacyPolicyUrl: "https://edge.vendor-a.com/privacy", evidence: ["Sources/CdnClient.swift"] },
    {}
  );
  assert.equal(displayName.report.canSubmit, true, "a confirmed externalServiceDecision can exactly map scanner evidence to a display-name processor");
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
  credentialedOrdinaryUrl.contacts.supportUrl = "https://support.vendor-a.com/help?token=sekrit";
  assert.throws(() => validateManifest(credentialedOrdinaryUrl), (error: unknown) => {
    assert.doesNotMatch(String(error), /sekrit/i);
    return true;
  });
  credentialedOrdinaryUrl.contacts.supportUrl = "https://support.vendor-a.com/help#access_token=sekrit";
  assert.throws(() => validateManifest(credentialedOrdinaryUrl), (error: unknown) => {
    assert.doesNotMatch(String(error), /sekrit/i);
    return true;
  });

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
