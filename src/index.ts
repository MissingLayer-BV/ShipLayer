#!/usr/bin/env node
import path from "node:path";
import { draftScreenshots } from "./asc-screenshot-draft.js";
import { draftDescriptions } from "./asc-description-draft.js";
import { draftListing } from "./asc-listing-draft.js";
import { existsSync } from "node:fs";
import { analyzeRepository, detectScreenshotHarness, findValue } from "./scanner.js";
import { appStorePlan } from "./asc.js";
import { applyAppStoreChanges, planAppStoreChanges } from "./asc-apply.js";
import { createCapturePlan, executeCapturePlan, ingestCaptures } from "./capture.js";
import { generateReleasePackage } from "./generator.js";
import { DEFAULT_OUTPUT_DIRECTORY } from "./marketing.js";
import { defaultManifest, manifestPath, readManifest, writeManifest } from "./manifest.js";
import { preflight } from "./preflight.js";
import { stableJson } from "./fs.js";
import { classifyAiEndpoint, externalServiceFindings, storekitPurchaseEvidence } from "./evidence.js";
import type { AnalysisReport, Finding, ShipLayerManifest } from "./types.js";
import type { DetectedScreenshotHarness } from "./scanner.js";

const VERSION = "0.1.0";
class BlockerError extends Error {}
async function main(args: string[]): Promise<void> {
  const [command, repositoryArgument, ...options] = args;
  if (!command || command === "--help" || command === "help") return printHelp();
  if (command === "--version" || command === "version") return write(`${VERSION}\n`);
  if (!new Set(["init", "analyze", "prepare", "check", "plan", "capture", "apply", "submit", "draft-descriptions", "draft-listing", "draft-screenshots"]).has(command)) throw new Error(`Unknown command '${command}'.\n\n${helpText()}`);
  if (!repositoryArgument) throw new Error(`Missing <repo>.\n\n${helpText()}`);
  const repository = path.resolve(repositoryArgument); if (!existsSync(repository)) throw new Error(`Repository does not exist: ${repository}`);
  validateOptions(command, options);
  const json = options.includes("--json");
  if (command === "draft-screenshots") {
    const locales = optionValue(options, "--locales")?.split(",").filter(Boolean);
    const result = await draftScreenshots(repository, await readManifest(repository), options.includes("--apply"), options.includes("--yes-i-understand"), undefined, locales);
    output(result, json, JSON.stringify(result, null, 2));
    return;
  }
  if (command === "draft-descriptions") {
    const result = await draftDescriptions(await readManifest(repository), options.includes("--apply"), options.includes("--yes-i-understand"));
    output(result, json, JSON.stringify(result, null, 2));
    return;
  }
  if (command === "draft-listing") {
    const locales = optionValue(options, "--locales")?.split(",").filter(Boolean) ?? [];
    const result = await draftListing(await readManifest(repository), locales, options.includes("--apply"), options.includes("--yes-i-understand"));
    output(result, json, JSON.stringify(result, null, 2));
    return;
  }
  if (command === "init") return init(repository, options, json);
  if (command === "analyze") return analyze(repository, json);
  if (command === "prepare") return prepare(repository, options, json);
  if (command === "check") return check(repository, json, options.includes("--remote"));
  if (command === "plan") return plan(repository, json, options.includes("--remote"));
  if (command === "capture") return capture(repository, options, json);
  if (command === "apply") return apply(repository, options, json);
  if (command === "submit") return submit(repository, options, json);
  throw new Error(`Unknown command '${command}'.\n\n${helpText()}`);
}
async function init(repository: string, options: string[], json: boolean): Promise<void> { const file = manifestPath(repository); if (existsSync(file) && !options.includes("--force")) throw new Error(`${file} already exists. Refusing to overwrite it. Use --force only after reviewing the existing manifest.`); const analysis = await analyzeRepository(repository); const harness = await detectScreenshotHarness(repository); const manifest = manifestFromAnalysis(analysis, harness); await writeManifest(repository, manifest); output({ manifest: file, detected: analysis.findings.filter((finding) => ["bundleId", "version", "build", "deploymentTarget", "deviceFamily"].includes(finding.key)).map((finding) => ({ key: finding.key, value: finding.value, confidence: finding.confidence })), detectedScreenshotScenarios: harness.scenarios.length, unresolvedQuestions: analysis.unresolvedQuestions }, json, `Created ${file}\n\nReview all fields marked needs-human-confirmation before running prepare.`); }
async function analyze(repository: string, json: boolean): Promise<void> { const report = await analyzeRepository(repository); output(report, json, humanAnalysis(report)); }
async function prepare(repository: string, options: string[], json: boolean): Promise<void> { const manifest = await readManifest(repository); const analysis = await analyzeRepository(repository); const report = await preflight(repository, manifest, false, analysis); const outputDirectory = optionValue(options, "--out") || DEFAULT_OUTPUT_DIRECTORY; const generated = await generateReleasePackage(repository, manifest, analysis, report, outputDirectory); output({ releasePackage: generated, preflight: report.summary, remainingBlockers: report.results.filter((item) => item.severity === "block") }, json, `Prepared ${generated.files.length} deterministic release artifacts in ${generated.directory}.\nPreflight: ${report.summary.pass} pass, ${report.summary.warn} warnings, ${report.summary.block} blockers.\n\nPreparation does not approve legal/privacy declarations or mutate App Store Connect.`); if (report.summary.block) process.exitCode = 2; }
async function check(repository: string, json: boolean, remote: boolean): Promise<void> { const report = await preflight(repository, await readManifest(repository), remote); output(report, json, report.results.map((item) => `${item.severity === "pass" ? "✓" : item.severity === "warn" ? "!" : "✗"} ${item.id}: ${item.message}${item.remediation ? ` (${item.remediation})` : ""}`).join("\n") + `\n\n${report.summary.pass} pass, ${report.summary.warn} warnings, ${report.summary.block} blockers.`); if (report.summary.block || !report.canSubmit) process.exitCode = 2; }
async function plan(repository: string, json: boolean, remote: boolean): Promise<void> { const manifest = await readManifest(repository); const changePlan = remote ? await planAppStoreChanges(repository, manifest) : await appStorePlan(manifest, false); output(changePlan, json, `${changePlan.mode === "remote" ? "Remote read-only change plan" : "Offline dry-run plan"}\n\n${changePlan.operations.map((item) => `- [${item.safety}] ${item.action} ${item.resource}: ${item.description} (${item.status})`).join("\n")}\n\n${changePlan.warnings.map((warning) => `! ${warning}`).join("\n")}`); if (remote && !changePlan.credentialsPresent) process.exitCode = 2; }
async function capture(repository: string, options: string[], json: boolean): Promise<void> {
  const manifest = await readManifest(repository); const plan = await createCapturePlan(repository, manifest);
  const from = optionValue(options, "--from");
  if (from) {
    const family = optionValue(options, "--family"); const locale = optionValue(options, "--locale");
    if (family !== "iphone" && family !== "ipad") throw new Error("--from requires --family iphone|ipad.");
    if (!locale) throw new Error("--from requires --locale <locale>.");
    const result = await ingestCaptures(repository, manifest, { from, family, locale });
    output({ plan, ingest: result }, json, `Ingested ${result.ingested.length} screenshot(s) into ${result.destinationDirectory}.${result.skipped.length ? `\nSkipped ${result.skipped.length}:\n${result.skipped.map((item) => `- ${item.sourceFile}: ${item.reason}`).join("\n")}` : ""}\n\nRun shiplayer check to validate the full screenshot set.`);
    return;
  }
  if (options.includes("--execute")) { if (!options.includes("--yes-execute")) throw new Error("Refusing capture execution without --yes-execute. Run without --execute to inspect the missing harness requirements."); const results = await executeCapturePlan(plan); output({ plan, results }, json, "No generic capture command was run."); return; }
  output(plan, json, `${plan.prerequisites.length ? `${plan.prerequisites.map((item) => `- ${item}`).join("\n")}\n\n` : ""}${plan.instructions.join("\n")}`);
}
async function apply(repository: string, options: string[], json: boolean): Promise<void> {
  const manifest = await readManifest(repository); const report = await preflight(repository, manifest, true); const changePlan = await planAppStoreChanges(repository, manifest);
  if (!options.includes("--apply")) { output({ mode: "dry-run", report, plan: changePlan, applied: false }, json, `DRY RUN: ShipLayer made no App Store Connect changes.\n\n${changePlan.operations.map((item) => `- [${item.status}] ${item.action} ${item.resource}: ${item.description}`).join("\n")}\n\nTo apply this reviewed plan, set sync.mode: apply and run with --apply --yes-i-understand.`); if (!changePlan.credentialsPresent) process.exitCode = 2; return; }
  if (!options.includes("--yes-i-understand")) throw new Error("Production mutation gate not satisfied. Pass --apply --yes-i-understand only after reviewing the remote dry-run plan.");
  if (manifest.sync.mode !== "apply") throw new BlockerError("Apply blocked because sync.mode is dry-run. Change it to apply only after the user explicitly authorizes App Store Connect writes.");
  if (!report.canApply) throw new BlockerError("Apply blocked by preflight. Resolve every blocker before requesting production operations.");
  const result = await applyAppStoreChanges(repository, manifest, { userConfirmed: true, reviewedPlan: changePlan });
  output({ mode: "apply", report, plan: changePlan, result }, json, `App Store Connect synchronization completed.\n\n${result.operations.map((item) => `- [${item.status}] ${item.action} ${item.resource}: ${item.description}`).join("\n")}\n\nNo App Review submission was made.\n${result.warnings.map((warning) => `! ${warning}`).join("\n")}`);
}
async function submit(repository: string, options: string[], json: boolean): Promise<void> { const manifest = await readManifest(repository); const report = await preflight(repository, manifest, false); if (!options.includes("--submit") || !options.includes("--yes-submit")) { output({ mode: "final-gate-preview", report, submitted: false }, json, "FINAL GATE PREVIEW: no submission occurred. A future submission requires --submit --yes-submit and a blocker-free preflight."); return; } if (!report.canSubmit) throw new BlockerError("Submission blocked by final readiness checks. Resolve every blocker and required human declaration before retrying."); output({ mode: "manual-only", submitted: false, unsupported: true, exitCode: 3 }, json, "UNSUPPORTED: No submission was made. ShipLayer v0.1 deliberately keeps final App Review submission human-controlled; use the generated App Store Connect plan and confirm the approved build in the UI."); process.exitCode = 3; }
function manifestFromAnalysis(report: AnalysisReport, harness: DetectedScreenshotHarness): ShipLayerManifest { const device = findValue(report, "deviceFamily"); const tokens = new Set((device || "").split(",").map((item) => item.trim())); const families: Array<"iphone" | "ipad"> = [tokens.has("1") ? "iphone" : undefined, tokens.has("2") ? "ipad" : undefined].filter((item): item is "iphone" | "ipad" => Boolean(item)); if (!families.length) report.unresolvedQuestions.push("Confirm supported iPhone/iPad device families; scanner could not parse TARGETED_DEVICE_FAMILY."); const manifest = defaultManifest({ name: findValue(report, "appName") || "", bundleId: findValue(report, "bundleId") || "", version: findValue(report, "version"), build: findValue(report, "build"), deploymentTarget: findValue(report, "deploymentTarget"), deviceFamilies: families.length ? families : ["iphone", "ipad"] }); for (const finding of report.findings.filter((item) => item.key.startsWith("permission:"))) manifest.permissions.push({ key: finding.key.slice("permission:".length), purpose: typeof finding.value === "string" ? finding.value : undefined, confirmation: "needs-human-confirmation", evidence: finding.evidence.map((item) => item.source) });
  // Every detected runtime permission-request category becomes a needs-human-confirmation
  // permissionFlows proposal — never confirmed, and never a guessed dismissibleScreenBeforePrompt
  // or deniedPathOffersSettingsLink value (both booleans here are only ShipLayer's inert starting
  // point; neither carries any trust until a human sets confirmation: confirmed themselves).
  // `init`/an agent must ask a human both questions — see App Review guideline 5.1.1(iv) — never
  // answer either from source alone, and never treat a "yes, it's dismissible" or "no Settings
  // link" answer as acceptable just because it was confirmed: preflight.ts blocks on those exact
  // confirmed answers too.
  for (const finding of report.findings.filter((item) => item.key.startsWith("permissionFlow:"))) {
    const category = finding.key.slice("permissionFlow:".length);
    const evidence = finding.evidence.map((item) => item.source);
    manifest.permissionFlows.push({ category, dismissibleScreenBeforePrompt: false, deniedPathOffersSettingsLink: false, confirmation: "needs-human-confirmation", evidence });
    report.unresolvedQuestions.push(`Detected a runtime ${category} permission request in ${evidence.join(", ")}. Two questions, both required (App Review guideline 5.1.1(iv)): (1) Can the user dismiss a custom screen (sheet/confirmationDialog/alert/popover) between requesting this feature and the system permission prompt? Apple requires the system prompt to always follow. (2) Does the denied-access path offer a link to Settings? Verify the real on-device flow, then set permissionFlows[].dismissibleScreenBeforePrompt, deniedPathOffersSettingsLink, and confirmation: confirmed for '${category}'.`);
  }
  // Screenshot scenarios found in an existing UI-test harness are proposals, exactly like every
  // other detected fact here: always needs-human-confirmation, never silently promoted, and kept
  // strictly separate from privacy/purchase/AI production evidence (see isXCUITestSourcePath).
  if (harness.scenarios.length) {
    // `caption` is deliberately left unset here: ShipLayer never invents marketing copy. The
    // unresolved question below is the only place a human/agent is told captions are missing —
    // `shiplayer prepare`'s generated marketing slides also render a visible placeholder (the
    // scenario title, styled distinctly) instead of silently shipping a blank or fabricated one.
    manifest.screenshots.scenarios = harness.scenarios.map((scenario) => ({ id: scenario.id, title: scenario.title, launchArguments: scenario.launchArgumentsDetermined && scenario.launchArguments.length ? scenario.launchArguments : undefined, steps: [`Detected via existing UI test${scenario.testFunction ? ` '${scenario.testFunction}'` : ""} in ${scenario.sourceFile}. Confirm on a real device/simulator that this exact navigation reaches "${scenario.title}" before use.`, ...(scenario.launchArgumentsDetermined ? [] : ["Launch arguments could not be determined from source (set via a helper/computed value, or a mix of literal and non-literal elements) — verify and fill them in manually before use."])], confirmation: "needs-human-confirmation" as const }));
    report.unresolvedQuestions.push(`Detected ${harness.scenarios.length} screenshot scenario(s) in ${harness.sourceFiles.join(", ")}. Each is needs-human-confirmation; verify the real on-screen navigation and set confirmation: confirmed before check will pass.`);
    report.unresolvedQuestions.push(`No marketing screenshot captions have been drafted for these ${harness.scenarios.length} scenario(s). ShipLayer does not invent captions. Add a concise, human-reviewed screenshots.scenarios[].caption (max 100 characters, no line breaks) that sells one outcome per slide — not a feature list — then run shiplayer prepare and render the marketing project at screenshots/marketing before submission.`);
  } else {
    report.unresolvedQuestions.push("No screenshot UI-test harness (a keepScreenshot(named:)-shaped XCTAttachment(screenshot:)/XCUIScreen.main.screenshot() call in a *UITests source) was detected. `shiplayer prepare` emits a fillable template and contract at screenshots/ui-test-harness-template.swift and screenshots/ui-test-harness-contract.md; add real navigation, then re-run `shiplayer init --force` or hand-edit shiplayer.yml. `check` blocks on screenshots.scenarios until at least one confirmed scenario exists.");
  }
  const encryption = findValue(report, "encryption"); if (encryption === "false") manifest.build.exportCompliance = "exempt";
  // Detected, never confirmed: a real signing style is direct project-setting evidence (the same
  // trust level bundleId/version already get above), but it still requires a human to run `check`
  // before it can gate submission the way exportCompliance does.
  const codeSignStyle = findValue(report, "codeSignStyle"); if (codeSignStyle) manifest.build.signing = /^automatic$/i.test(codeSignStyle) ? "automatic" : /^manual$/i.test(codeSignStyle) ? "manual" : "unknown";
  // Detected external endpoints/SDKs become needs-human-confirmation processor proposals — never a
  // confirmed disposition — so `check` still blocks until a human fills in the real purpose, data
  // categories, and privacy-policy URL (or records this finding is not an external processor).
  const processorProposals = externalProcessorProposals(report);
  manifest.externalProcessors.push(...processorProposals);
  for (const finding of externalServiceFindings(report)) report.unresolvedQuestions.push(`Review external source finding '${finding.key}' in ${finding.evidence.map((item) => item.source).join(", ") || "the scanned source"}. Record a confirmed externalServiceDecision only after human review: use declared-processor for actual processing, reference-only only when the human confirms this literal is policy/docs/support/marketing/reference, or not-an-external-processor only for a real endpoint that is not third-party processing. If the finding's exact host is declared by an external processor, not-an-external-processor is contradictory and check will require deliberate migration; ShipLayer does not infer reachability from source syntax.`);
  if (externalServiceFindings(report).length) report.unresolvedQuestions.push("Use reference-only only for a scanner HTTP(S) endpoint literal a human reviewed as documentation/privacy/marketing/reference. It cannot classify an SDK import, entitlement, or other non-link finding; its evidence must cite the exact scanner source.");
  for (const processor of processorProposals) report.unresolvedQuestions.push(`Detected possible external processor '${processor.name}' (${(processor.evidence || []).join(", ") || "source evidence path unavailable"}). Confirm whether it is actually used; then confirm its purpose, categories, policy URL, and protection. For the separate App Privacy collection determination, do not infer retention from the endpoint, source text, or a vendor claim: if a human determines it is not collection, they must personally attest that transmitted data is not retained beyond servicing the request in real time. Set notCollectionAttestation.dataNotRetainedBeyondRealTimeService: true and basis: vendor-documentation only after that human review, with evidence.kind: processor-privacy-policy and this processor's exact, canonical, credential-free privacy/data-protection/data-collection/retention/DPA policy URL. Repository paths, private contracts, and written confirmations cannot automatically clear this determination because ShipLayer cannot prove runtime reachability or retention from them. Never paste access links, credentials, query strings, or generic ZDR/no-training links into structured attestation evidence. Set both the attestation and processor confirmation to confirmed only after that human review. Otherwise record collection or leave the proposal pending.`);
  // The monetization schema cannot represent "possibly has IAP" without fabricating product IDs
  // and price points a human hasn't chosen, so `monetization.type` stays "free" here. The
  // `monetization.source-contradiction` preflight blocker (see src/preflight.ts) is the real
  // guardrail: it fires loudly on `check` whenever this default disagrees with StoreKit evidence.
  const storekitEvidence = storekitPurchaseEvidence(report);
  if (storekitEvidence.length) report.unresolvedQuestions.push(`StoreKit purchase evidence was found (${[...new Set(storekitEvidence.flatMap((finding) => finding.evidence.map((item) => item.source)))].sort().join(", ")}) but monetization.type defaults to 'free' here. Declare the real IAP/subscription model in shiplayer.yml; \`check\` blocks on this contradiction until it is resolved.`);
  // A repository version number cannot establish whether the target is the first App Store
  // version or an update. Keep the lifecycle pending until an agent checks the read-only remote
  // plan (or a human confirms the actual store history); apply independently verifies this value
  // against every discovered iOS version before making any write.
  report.unresolvedQuestions.push("Determine whether the target is the app's first iOS App Store release or an update. Do not infer this from the version number. Run shiplayer plan <repo> --remote to inspect App Store version history, then set app.releaseKind to first-release or update; apply verifies the declaration again before any write.");
  // ShipLayer never drafts App Store copy — see metadata.localizations in src/types.ts and
  // metadataChecks/metadataContradictionChecks in src/preflight.ts. `init` always leaves every
  // locale's name/subtitle/description/keywords/promotionalText/whatsNew absent and records this
  // question instead, naming exactly what an agent/human must write: read the app's real source
  // and screenshots, describe only what it actually does, and never state pricing, never
  // reference another platform, never leave placeholder text. `shiplayer check` blocks until the
  // drafted copy is filled in AND metadata.localizations[locale].confirmation is explicitly
  // "confirmed" by a human — see skills/ship-app-store/SKILL.md for the full drafting guidance.
  for (const locale of manifest.app.locales) report.unresolvedQuestions.push(`No App Store copy has been drafted for locale ${locale}. Draft metadata.localizations.${locale}.name (max 30 chars), subtitle (max 30), description (max 4000), keywords (max 100 chars total incl. commas), and promotionalText (max 170) from the app's real source/screenshots. If app.releaseKind is update, also draft localized whatsNew (max 4000) from this version's real changes; omit it for first-release. Then set metadata.localizations.${locale}.confirmation: confirmed after human review. After every update locale has been reviewed, separately bind that approval to this exact version with metadata.whatsNewConfirmation. ShipLayer never writes this copy itself.`);
  return manifest; }
/** Endpoint/SDK findings become needs-human-confirmation externalProcessors proposals, never a confirmed disposition. */
function externalProcessorProposals(report: AnalysisReport): ShipLayerManifest["externalProcessors"] {
  const byName = new Map<string, { evidence: Set<string>; kind: "ai" | "network" | "analytics" | "payments" | "other"; privacyPolicyUrl: string }>();
  const record = (name: string, kind: "ai" | "network" | "analytics" | "payments" | "other", privacyPolicyUrl: string, finding: Finding): void => {
    const entry = byName.get(name) || { evidence: new Set<string>(), kind, privacyPolicyUrl };
    for (const item of finding.evidence) entry.evidence.add(item.source);
    byName.set(name, entry);
  };
  // Route through the same fixture/sample/test-path exclusion used everywhere else (evidence.ts),
  // so a finding that only exists under fixtures/samples/examples/docs/testdata never becomes a
  // proposal at all.
  for (const finding of externalServiceFindings(report)) {
    if (finding.key.startsWith("endpoint:")) {
      const url = finding.key.slice("endpoint:".length);
      let host: string; try { host = new URL(url).hostname; } catch { continue; }
      // kind: "ai" is a real, load-bearing signal (it forces the ai-sharing.declaration gate on
      // its own once confirmed) — only assign it when the endpoint is strong provider evidence,
      // never for a policy/docs link on a known AI host, and never for the ambiguous path-shape
      // case on an unrecognized host (that one is resolved through the source-contradiction
      // override instead; forcing kind: "ai" there would make it unoverridable, since
      // sourceContradictionOverrides only resolves *.source-contradiction blockers, not this
      // separate declaration check).
      const kind = classifyAiEndpoint(url) === "provider" ? "ai" : "network";
      record(host, kind, placeholderPrivacyPolicyUrl(host), finding);
    } else if (finding.key.startsWith("thirdPartySdkCandidate:")) {
      const name = finding.key.slice("thirdPartySdkCandidate:".length);
      record(name, "other", `https://unconfirmed.invalid/${encodeURIComponent(name)}`, finding);
    }
  }
  return [...byName.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => ({ name, kind: entry.kind, aiPipelineRecipient: false, purpose: "Other Purposes", dataCategories: ["Other Data"], privacyPolicyUrl: entry.privacyPolicyUrl, protectionConfirmation: "needs-human-confirmation", confirmation: "needs-human-confirmation", collectionDetermination: "needs-human-confirmation", notCollectionAttestation: { dataNotRetainedBeyondRealTimeService: "needs-human-confirmation", basis: "needs-human-confirmation", evidence: { kind: "processor-privacy-policy" }, confirmation: "needs-human-confirmation" }, evidence: [...entry.evidence].sort() }));
}
/** A synthesized https://<host>/ guess is only usable when it is itself a schema-valid URL (the
 * schema's URL pattern requires a dotted hostname); a single-label host such as "localhost" or an
 * intranet/router hostname is not, so fall back to an explicit unconfirmed placeholder instead of
 * writing an invalid manifest that makes `init` itself crash. */
function placeholderPrivacyPolicyUrl(host: string): string {
  const candidate = `https://${host}/`;
  const hostnamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
  return hostnamePattern.test(host) ? candidate : `https://unconfirmed.invalid/${encodeURIComponent(host)}`;
}
function humanAnalysis(report: Awaited<ReturnType<typeof analyzeRepository>>): string { return `Repository: ${report.repository}\nScanned ${report.ignored.filesScanned} bounded files.\n\n${report.findings.map((finding) => `- ${finding.key}: ${Array.isArray(finding.value) ? finding.value.join(", ") : String(finding.value)} [${finding.confidence}] (${finding.evidence.map((item) => item.source).join(", ")})${finding.proposal ? " — proposal; human confirmation required" : ""}`).join("\n")}\n\nUnresolved questions:\n${report.unresolvedQuestions.map((item) => `- ${item}`).join("\n")}${report.contradictions.length ? `\n\nContradictions:\n${report.contradictions.map((item) => `- ${item}`).join("\n")}` : ""}`; }
function optionValue(options: string[], name: string): string | undefined { const index = options.indexOf(name); return index >= 0 ? options[index + 1] : undefined; }
const VALUE_OPTIONS: Record<string, Set<string>> = { prepare: new Set(["--out"]), capture: new Set(["--from", "--family", "--locale"]), "draft-listing": new Set(["--locales"]), "draft-screenshots": new Set(["--locales"]) };
function validateOptions(command: string, options: string[]): void {
  const allowed: Record<string, Set<string>> = { "draft-screenshots": new Set(["--json", "--apply", "--yes-i-understand", "--locales"]), "draft-descriptions": new Set(["--json", "--apply", "--yes-i-understand"]), "draft-listing": new Set(["--json", "--apply", "--yes-i-understand", "--locales"]), init: new Set(["--force", "--json"]), analyze: new Set(["--json"]), prepare: new Set(["--out", "--json"]), check: new Set(["--json", "--remote"]), plan: new Set(["--json", "--remote"]), capture: new Set(["--json", "--execute", "--yes-execute", "--from", "--family", "--locale"]), apply: new Set(["--json", "--apply", "--yes-i-understand"]), submit: new Set(["--json", "--submit", "--yes-submit"]) };
  const known = allowed[command]; if (!known) return; const valueOptions = VALUE_OPTIONS[command] || new Set<string>();
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (!known.has(option)) { if (index && valueOptions.has(options[index - 1])) continue; throw new Error(`Unknown option '${option}' for ${command}.`); }
    if (valueOptions.has(option)) { const value = options[++index]; if (!value || value.startsWith("--")) throw new Error(option === "--out" ? "--out requires a relative output directory." : `${option} requires a value.`); }
  }
}
function output(value: unknown, json: boolean, text: string): void { write(json ? stableJson(value) : `${text}\n`); }
function write(value: string): void { process.stdout.write(value); }
function printHelp(): void { write(`${helpText()}\n`); }
function helpText(): string { return `ShipLayer ${VERSION} — The missing layer between your repo and the App Store.\n\nUsage: shiplayer <command> <repo> [options]\n\nCommands:\n  draft-screenshots <repo> [--apply --yes-i-understand]\n                            Synchronize reviewed screenshots in an existing unsubmitted draft.\n  draft-descriptions <repo> [--apply --yes-i-understand]\n                            Preview or save descriptions in an unsubmitted update draft.\n  init <repo> [--force]       Create shiplayer.yml from detected facts; never overwrites by default.\n  analyze <repo> [--json]     Read-only scan with evidence and unresolved questions.\n  prepare <repo> [--out DIR]  Generate a deterministic release package.\n  check <repo> [--json]       Run preflight; exits 2 for blockers.\n  plan <repo> [--remote]      Print an offline plan or read-only App Store Connect discovery.\n  capture <repo>               Print screenshot-harness/workflow hand-off requirements.\n  capture <repo> --from DIR --family iphone|ipad --locale LOCALE\n                              Ingest and validate already-exported PNG screenshots.\n  apply <repo> [--apply --yes-i-understand]\n                              Remote change preview by default; writes only through both explicit gates.\n  submit <repo> [--submit --yes-submit]\n                              Separate final gate; unsupported execution exits 3.\n\nNo command uses paid CI or creates/installs/dispatches a GitHub Action. \`prepare\` can emit a manually-installed, workflow_dispatch-only capture workflow into the release package for a human to copy and run themselves. Secrets come only from environment-variable references.`; }
main(process.argv.slice(2)).catch((error: unknown) => { const message = error instanceof Error ? error.message : String(error); const exitCode = error instanceof BlockerError ? 2 : 1; if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ error: message, exitCode })}\n`); else process.stderr.write(`ShipLayer error: ${message}\n`); process.exitCode = exitCode; });
