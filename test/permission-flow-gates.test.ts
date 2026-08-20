// Permission-flow gates (App Review 5.1.1(iv)): BackYet's real rejection — a dismissible custom
// sheet in front of the one-time system camera prompt, and a denied-state fallback with no
// Settings link. See src/preflight.ts's permission-flow section for the three gates this file
// exercises: permission-flow.<category>.settings-link (Gate 1, static), .confirmation (Gate 2,
// human-confirmed), and .sheet-gated (Gate 3, the owner's heuristic, clearable by Gate 2).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeRepository } from "../src/scanner.js";
import { generateReleasePackage } from "../src/generator.js";
import { preflight } from "../src/preflight.js";
import { readManifest } from "../src/manifest.js";
import { readyManifest, writeReadyAssets } from "./helpers.js";

const CAMERA_NO_SETTINGS_LINK = `import AVFoundation
struct CameraFlow {
  func begin() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      break
    case .denied, .restricted:
      break
    default:
      AVCaptureDevice.requestAccess(for: .video) { _ in }
    }
  }
}
`;

const CAMERA_WITH_SETTINGS_LINK = `import AVFoundation
import UIKit
struct CameraFlow {
  func begin() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      break
    case .denied, .restricted:
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      UIApplication.shared.open(url)
    default:
      AVCaptureDevice.requestAccess(for: .video) { _ in }
    }
  }
}
`;

async function writeCameraSwift(root: string, contents: string, relativePath = "Sources/CameraFlow.swift"): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

test("an app with no permissions at all is unaffected by the permission-flow gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-none-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id.startsWith("permission-flow.")), false);
  assert.equal(report.summary.block, 0);
});

test("the settings-link gate blocks a denied-state path with no Settings link, and passes once the same file reaches it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-settings-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_NO_SETTINGS_LINK);
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.settings-link" && item.severity === "block"));

  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.settings-link" && item.severity === "pass"));
});

test("a Settings link that exists only in a test file does not satisfy the static settings-link gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-testfile-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_NO_SETTINGS_LINK);
  await writeCameraSwift(root, `import XCTest
import UIKit
final class CameraFlowTests: XCTestCase {
  func testDeniedOpensSettings() {
    // .denied
    let url = URL(string: UIApplication.openSettingsURLString)!
    _ = url
  }
}
`, "Tests/CameraFlowTests.swift");
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.settings-link" && item.severity === "block"));
});

test("a commented-out Settings link does not satisfy the static settings-link gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-commented-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const commentedOut = `import AVFoundation
import UIKit
struct CameraFlow {
  func begin() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      break
    case .denied, .restricted:
      break
      // guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      // UIApplication.shared.open(url)
    default:
      AVCaptureDevice.requestAccess(for: .video) { _ in }
    }
  }
}
`;
  await writeCameraSwift(root, commentedOut);
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.settings-link" && item.severity === "block"));
});

test("the flow-declaration gate blocks by default and is not satisfiable by absence, an unconfirmed entry, or a default value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-declaration-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);

  // Absent entirely.
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.confirmation" && item.severity === "block"));

  // Present but explicitly needs-human-confirmation (init's own proposed shape).
  manifest.permissionFlows = [{ category: "camera", dismissibleScreenBeforePrompt: false, confirmation: "needs-human-confirmation", evidence: ["Sources/CameraFlow.swift"] }];
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.confirmation" && item.severity === "block"));

  // Only an explicit "confirmed" clears it.
  manifest.permissionFlows[0].confirmation = "confirmed";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.confirmation" && item.severity === "pass"));
});

test("the sheet-gated heuristic blocks a permission request only reachable from a dismissible sheet, and is cleared only by a confirmed no-dismiss-path declaration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-sheetgated-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  // Mirrors BackYet 780dcaf's exact rejected shape: the request is reachable only via a dismissible
  // .sheet's onDismiss callback (completeSelection), never directly from a button action.
  const sheetGated = `import SwiftUI
import AVFoundation
struct CaptureHome: View {
  @State private var isShowingSources = false
  @State private var pendingSource: String?

  var body: some View {
    Text("Home")
      .sheet(isPresented: $isShowingSources, onDismiss: completeSelection) {
        VStack {
          Button("Take a photo") {
            pendingSource = "camera"
          }
          Button("Cancel") {}
        }
      }
  }

  private func completeSelection() {
    if pendingSource == "camera" {
      beginCamera()
    }
  }

  private func beginCamera() {
    AVCaptureDevice.requestAccess(for: .video) { granted in
      _ = granted
    }
  }
}
`;
  await writeCameraSwift(root, sheetGated);
  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated" && item.severity === "block"));

  // A confirmed declaration that the screen IS dismissible must not clear it.
  manifest.permissionFlows = [{ category: "camera", dismissibleScreenBeforePrompt: true, confirmation: "confirmed", evidence: ["Sources/CameraFlow.swift"] }];
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated" && item.severity === "block"));

  // An unconfirmed declaration, even with the "right" boolean, must not clear it either.
  manifest.permissionFlows[0].confirmation = "needs-human-confirmation";
  manifest.permissionFlows[0].dismissibleScreenBeforePrompt = false;
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated" && item.severity === "block"));

  // Only confirmed + no-dismiss-path clears it.
  manifest.permissionFlows[0].confirmation = "confirmed";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated" && item.severity === "pass"));
});

test("a direct button action calling the permission request does not trigger the sheet-gated heuristic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-direct-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const direct = `import SwiftUI
import AVFoundation
import UIKit
struct CaptureHome: View {
  var body: some View {
    Button("Take a photo") {
      beginCamera()
    }
  }

  private func beginCamera() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .denied, .restricted:
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      UIApplication.shared.open(url)
    default:
      AVCaptureDevice.requestAccess(for: .video) { _ in }
    }
  }
}
`;
  await writeCameraSwift(root, direct);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated"), false);
});

test("init proposes permissionFlows as needs-human-confirmation and never self-confirms", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-init-"));
  await writeFile(path.join(root, "project.yml"), `name: Example
settings:
  base:
    PRODUCT_BUNDLE_IDENTIFIER: com.example.camera
    MARKETING_VERSION: "1.0"
    CURRENT_PROJECT_VERSION: "1"
    IPHONEOS_DEPLOYMENT_TARGET: "17.0"
    TARGETED_DEVICE_FAMILY: "1"
    ITSAppUsesNonExemptEncryption: false
`);
  await writeCameraSwift(root, CAMERA_NO_SETTINGS_LINK);
  const run = spawnSync("./node_modules/.bin/tsx", ["src/index.ts", "init", root, "--json"], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const manifest = await readManifest(root);
  const flow = manifest.permissionFlows.find((item) => item.category === "camera");
  assert.ok(flow, "expected a proposed camera permissionFlows entry");
  assert.equal(flow?.confirmation, "needs-human-confirmation");
});

test("the generated privacy questionnaire draft and evidence matrix carry the real permissionFlows confirmation status, never laundering it into 'confirmed'", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-generator-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);
  manifest.permissionFlows = [{ category: "camera", dismissibleScreenBeforePrompt: false, confirmation: "needs-human-confirmation", evidence: ["Sources/CameraFlow.swift"] }];
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  manifest.screenshots.finalOutputDir = "release-permflow/screenshots/final";
  const generated = await generateReleasePackage(root, manifest, analysis, report, "release-permflow");
  const draft = await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8");
  assert.ok(draft.includes("camera"));
  assert.ok(draft.includes("confirmation: needs-human-confirmation"));
  assert.equal(draft.includes("confirmation: confirmed"), false);
  const matrix = JSON.parse(await readFile(path.join(generated.directory, "privacy/evidence-matrix.json"), "utf8")) as { permissionFlows: Array<{ category: string; confirmation: string }> };
  assert.deepEqual(matrix.permissionFlows, manifest.permissionFlows);
});
