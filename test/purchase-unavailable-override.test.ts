// Regression tests for extending the sourceContradictionOverrides mechanism to cover the
// purchase.unavailable-source heuristic gate. Found by the second cold dogfood run: BackYet's
// real paywall keeps payment unavailable while price is loading, but does so through a custom
// button component reached via an enum case (LifetimePaywallManager.ProductState) rather than a
// literal Button with a recognized .disabled predicate, and the heuristic in preflight.ts cannot
// see that. Before this change there was no honest way to resolve a wrong call on this gate —
// these tests exercise the override path that closes that dead end, with the exact same rigor
// (evidence must intersect the flagged finding's own source paths, confirmed + non-empty reason
// required, downgrades to a warning rather than clearing) as the existing monetization/AI
// overrides.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../src/preflight.js";
import { validateManifest } from "../src/manifest.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

// Mirrors BackYet's actual paywall shape (PaywallSheet.swift + LifetimePaywallManager.swift):
// the purchase-capable control is a custom component (not a literal `Button`) that only renders
// inside the `.available` case of a state enum, and the real `.purchase(` call lives in a
// different type entirely, reached through a closure. No `if let product/price { Button ... }`
// nesting and no literal `Button` whose own core contains `.purchase(` — the two shapes
// hasUnavailablePurchaseState (src/preflight.ts) can currently recognize.
const BACKYET_SHAPED_PAYWALL_SOURCE = `import StoreKit
enum ProductState { case loading; case available(displayPrice: String); case unavailable }
struct Paywall {
  let productState: ProductState
  var body: some View {
    switch productState {
    case .loading:
      ProgressView("Loading price")
    case .available(let displayPrice):
      Text("Buy for \\(displayPrice)").accessibilityIdentifier("paywall.price")
      PrimaryActionButton(title: "Buy for \\(displayPrice)", action: { Task { await onPurchase() } })
        .accessibilityIdentifier("paywall.purchase")
    case .unavailable:
      Text("Price unavailable").accessibilityIdentifier("paywall.price-unavailable")
    }
  }
}
final class PaywallManager {
  func purchase() async throws {
    try await product.purchase()
  }
}
`;

async function backyetShapedRoot(): Promise<{ root: string; manifest: ReturnType<typeof readyManifest> }> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-purchase-unavailable-override-"));
  const manifest = readyManifest("non-consumables");
  await writeReadyAssets(root, manifest);
  // writeReadyAssets seeds a clean Sources/Paywall.swift (if-let product { Button ... .purchase( } })
  // that already satisfies the heuristic; overwrite it with BackYet's real shape so only
  // purchase.unavailable-source is affected.
  await writeFile(path.join(root, "Sources/Paywall.swift"), BACKYET_SHAPED_PAYWALL_SOURCE);
  return { root, manifest };
}

test("purchase.unavailable-source blocks a paywall whose purchase control is a custom component reached via an enum case (BackYet's real shape), with no override present", async () => {
  const { root, manifest } = await backyetShapedRoot();
  assert.equal(manifest.sourceContradictionOverrides.length, 0);
  const report = await preflight(root, manifest);
  const finding = report.results.find((item) => item.id === "purchase.unavailable-source");
  assert.ok(finding && finding.severity === "block");
});

test("a confirmed sourceContradictionOverride naming purchase.unavailable-source and citing its own source evidence downgrades it to a warning, never clears it", async () => {
  const { root, manifest } = await backyetShapedRoot();
  manifest.sourceContradictionOverrides = [{
    finding: "purchase.unavailable-source",
    reason: "The purchase button only renders inside ProductState.available, which is populated exclusively from a real StoreKit Product after it resolves; .loading/.unavailable render no purchase control.",
    evidence: ["Sources/Paywall.swift"],
    confirmation: "confirmed"
  }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.filter((item) => item.id === "purchase.unavailable-source" && item.severity === "block").length, 0);
  const warned = report.results.find((item) => item.id === "purchase.unavailable-source" && item.severity === "warn");
  assert.ok(warned);
  assert.ok(warned.message.includes("human-overridden"));
  assert.ok(warned.message.includes("ProductState.available"));
});

test("an override for purchase.unavailable-source citing evidence outside its own source paths does not suppress the block (intersection requirement holds)", async () => {
  const { root, manifest } = await backyetShapedRoot();
  // Tests/PaywallUITests.swift is real, contained, non-symlinked evidence (writeReadyAssets wrote
  // it) — it is simply not among purchasePresentation.sourceEvidence's own paths, which is
  // exactly the "unrelated file" shape the intersection requirement exists to refuse.
  manifest.sourceContradictionOverrides = [{
    finding: "purchase.unavailable-source",
    reason: "Citing an unrelated file on purpose to prove the intersection requirement holds.",
    evidence: ["Tests/PaywallUITests.swift"],
    confirmation: "confirmed"
  }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.unavailable-source" && item.severity === "block"));
  assert.equal(report.results.filter((item) => item.id === "purchase.unavailable-source" && item.severity === "warn").length, 0);
});

test("a purchase.unavailable-source override with an empty reason cannot be expressed", () => {
  const manifest = readyManifest("non-consumables");
  manifest.sourceContradictionOverrides = [{ finding: "purchase.unavailable-source", reason: "", evidence: ["Sources/Paywall.swift"], confirmation: "confirmed" }];
  assert.throws(() => validateManifest(manifest), /Invalid shiplayer/);
});

test("a purchase.unavailable-source override that is not human-confirmed does not suppress the block", async () => {
  const { root, manifest } = await backyetShapedRoot();
  manifest.sourceContradictionOverrides = [{
    finding: "purchase.unavailable-source",
    reason: "pending review",
    evidence: ["Sources/Paywall.swift"],
    confirmation: "needs-human-confirmation"
  }];
  validateManifest(manifest);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "purchase.unavailable-source" && item.severity === "block"));
});
