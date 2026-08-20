// Permission-flow gates (App Review 5.1.1(iv)): BackYet's real rejection — a dismissible custom
// sheet in front of the one-time system camera prompt, and a denied-state fallback with no
// Settings link. Design (see src/preflight.ts's module comment): DECLARATIONS BLOCK, HEURISTICS
// WARN AND CORROBORATE. permission-flow.<category>.confirmation/.dismissible-screen/.denied-path-
// settings-link are the blocking gates, driven entirely by a human-confirmed permissionFlows
// declaration; permission-flow.<category>.settings-link-heuristic is advisory only (warn/pass,
// never block); permission-flow.<category>.sheet-gated is the owner's heuristic block, clearable
// by the declaration.
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
import type { PermissionFlowDeclaration } from "../src/types.js";
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

function declaration(overrides: Partial<PermissionFlowDeclaration> & { category: string }): PermissionFlowDeclaration {
  return { dismissibleScreenBeforePrompt: false, deniedPathOffersSettingsLink: true, confirmation: "needs-human-confirmation", evidence: ["Sources/CameraFlow.swift"], ...overrides };
}

test("an app with no permissions at all is unaffected by the permission-flow gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-none-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id.startsWith("permission-flow.")), false);
  assert.equal(report.summary.block, 0);
});

test("the confirmation gate blocks by default and is not satisfiable by absence, an unconfirmed entry, or a default value; a fully confirmed, compliant declaration passes everything", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-declaration-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);

  let report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.confirmation" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "permission-flow.camera.dismissible-screen"), false);
  assert.equal(report.results.some((item) => item.id === "permission-flow.camera.denied-path-settings-link"), false);

  manifest.permissionFlows = [declaration({ category: "camera", confirmation: "needs-human-confirmation" })];
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.confirmation" && item.severity === "block"));

  manifest.permissionFlows[0].confirmation = "confirmed";
  report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.confirmation" && item.severity === "pass"));
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.dismissible-screen" && item.severity === "pass"));
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.denied-path-settings-link" && item.severity === "pass"));
  assert.equal(report.results.some((item) => item.id.startsWith("permission-flow.") && item.severity === "block"), false);
});

test("F2: a confirmed admission that the screen IS dismissible blocks on its own, independent of any heuristic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-f2-dismissible-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  // Manager/view split (see the F3 test below): sheet-gated CANNOT fire here because the request
  // is a plain, directly-reachable function with no sheet/dialog anywhere in this file.
  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);
  manifest.permissionFlows = [declaration({ category: "camera", confirmation: "confirmed", dismissibleScreenBeforePrompt: true })];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.dismissible-screen" && item.severity === "block"));
  assert.equal(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated"), false, "sheet-gated heuristic should not have fired for this direct-call fixture");
});

test("F2: a confirmed admission that the denied path offers NO Settings link blocks on its own", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-f2-settingslink-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);
  manifest.permissionFlows = [declaration({ category: "camera", confirmation: "confirmed", deniedPathOffersSettingsLink: false })];
  const report = await preflight(root, manifest);
  assert.ok(report.results.some((item) => item.id === "permission-flow.camera.denied-path-settings-link" && item.severity === "block"));
});

test("the settings-link-heuristic is advisory only: it corroborates same-file correlation and never blocks either way", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-heuristic-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);

  await writeCameraSwift(root, CAMERA_NO_SETTINGS_LINK);
  let report = await preflight(root, manifest);
  let result = report.results.find((item) => item.id === "permission-flow.camera.settings-link-heuristic");
  assert.ok(result);
  assert.equal(result?.severity, "warn");

  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);
  report = await preflight(root, manifest);
  result = report.results.find((item) => item.id === "permission-flow.camera.settings-link-heuristic");
  assert.ok(result);
  assert.equal(result?.severity, "pass");
  assert.equal(report.results.some((item) => item.id.startsWith("permission-flow.") && item.severity === "block" && item.id.includes("settings-link")), false);
});

test("a Settings link that exists only in a test file does not corroborate the heuristic", async () => {
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
  const result = report.results.find((item) => item.id === "permission-flow.camera.settings-link-heuristic");
  assert.equal(result?.severity, "warn");
});

test("a commented-out Settings link does not corroborate the heuristic", async () => {
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
  const result = report.results.find((item) => item.id === "permission-flow.camera.settings-link-heuristic");
  assert.equal(result?.severity, "warn");
});

test("F1(a): one file handling two permissions does not let one category's real denied+Settings-link handling corroborate an unrelated category with no handling of its own", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-f1a-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const coordinator = `import AVFoundation
import UserNotifications
import UIKit

struct PermissionCoordinator {
  func beginCamera() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .denied, .restricted:
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      UIApplication.shared.open(url)
    default:
      AVCaptureDevice.requestAccess(for: .video) { _ in }
    }
  }

  func beginNotifications() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
      _ = granted
    }
  }
}
`;
  await writeCameraSwift(root, coordinator, "Sources/Coordinator.swift");
  const report = await preflight(root, manifest);
  const camera = report.results.find((item) => item.id === "permission-flow.camera.settings-link-heuristic");
  const notifications = report.results.find((item) => item.id === "permission-flow.notifications.settings-link-heuristic");
  assert.equal(camera?.severity, "pass", "camera has real, local denied+Settings-link handling");
  assert.equal(notifications?.severity, "warn", "notifications has no denied handling of its own and must not borrow camera's");
});

test("F1(b): an unrelated domain enum's .denied case and a generic Settings link elsewhere in the same file do not corroborate a real permission request with no denied handling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-f1b-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const settingsScreen = `import UserNotifications
import UIKit

enum SyncState {
  case pending
  case denied
  case synced
}

struct SettingsScreen {
  var syncState: SyncState = .pending

  func requestNotifications() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
      _ = granted
    }
  }

  func openGeneralSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }

  func describeSyncState() -> String {
    switch syncState {
    case .pending: return "Pending"
    case .denied: return "Sync turned off"
    case .synced: return "Synced"
    }
  }
}
`;
  await writeCameraSwift(root, settingsScreen, "Sources/SettingsScreen.swift");
  const report = await preflight(root, manifest);
  const notifications = report.results.find((item) => item.id === "permission-flow.notifications.settings-link-heuristic");
  assert.equal(notifications?.severity, "warn");
});

test("F3: the ordinary SwiftUI manager/view split corroborates via a one-hop type-name join, not a same-file requirement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-f3-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  // The manager owns the request and publishes status; it has NO local Settings-link handling.
  await writeCameraSwift(root, `import UserNotifications

enum NotificationAuthorization {
  case notDetermined
  case denied
  case authorized
}

final class NotificationManager: ObservableObject {
  @Published var authorizationStatus: NotificationAuthorization = .notDetermined

  func requestAuthorization() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
      _ = granted
    }
  }
}
`, "Sources/NotificationManager.swift");
  // A SEPARATE view references the manager's type and renders the denied-state Settings link.
  await writeCameraSwift(root, `import SwiftUI
import UIKit

struct SettingsRow: View {
  @EnvironmentObject private var notifications: NotificationManager

  var body: some View {
    if notifications.authorizationStatus == .denied {
      Button("Open Settings") {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
      }
    }
  }
}
`, "Sources/SettingsRow.swift");
  const report = await preflight(root, manifest);
  const result = report.results.find((item) => item.id === "permission-flow.notifications.settings-link-heuristic");
  assert.equal(result?.severity, "pass");
  assert.match(result?.message ?? "", /SettingsRow\.swift/);
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

  // A confirmed declaration that the screen IS dismissible must not clear it (and, per F2, blocks
  // on its own too).
  manifest.permissionFlows = [declaration({ category: "camera", confirmation: "confirmed", dismissibleScreenBeforePrompt: true })];
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

test("init proposes permissionFlows as needs-human-confirmation with inert default booleans and never self-confirms", async () => {
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
  assert.equal(flow?.dismissibleScreenBeforePrompt, false);
  assert.equal(flow?.deniedPathOffersSettingsLink, false);
});

test("the generated privacy questionnaire draft and evidence matrix carry the real permissionFlows confirmation status, never laundering it into 'confirmed'", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-generator-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK);
  manifest.permissionFlows = [declaration({ category: "camera", confirmation: "needs-human-confirmation" })];
  const analysis = await analyzeRepository(root);
  const report = await preflight(root, manifest, false, analysis);
  manifest.screenshots.finalOutputDir = "release-permflow/screenshots/final";
  const generated = await generateReleasePackage(root, manifest, analysis, report, "release-permflow");
  const draft = await readFile(path.join(generated.directory, "privacy/questionnaire-draft.md"), "utf8");
  assert.ok(draft.includes("camera"));
  assert.ok(draft.includes("confirmation: needs-human-confirmation"));
  assert.equal(draft.includes("confirmation: confirmed"), false);
  const matrix = JSON.parse(await readFile(path.join(generated.directory, "privacy/evidence-matrix.json"), "utf8")) as { permissionFlows: PermissionFlowDeclaration[] };
  assert.deepEqual(matrix.permissionFlows, manifest.permissionFlows);
});

test("a permission request that exists only in a Tests/ source file produces zero permission-flow checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-testonly-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeCameraSwift(root, CAMERA_WITH_SETTINGS_LINK, "Tests/CameraFlowTests.swift");
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id.startsWith("permission-flow.")), false);
});

test("an Info.plist usage-description key with no matching runtime request produces zero permission-flow checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-plistonly-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  await writeFile(path.join(root, "Info.plist"), "<key>NSCameraUsageDescription</key><string>Capture proof</string>");
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id.startsWith("permission-flow.")), false);
});

test("a request inside Task {} or behind if #available does not trigger the sheet-gated heuristic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-task-available-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const availableAndTask = `import SwiftUI
import AVFoundation
struct CaptureHome: View {
  var body: some View {
    Button("Take a photo") {
      Task {
        if #available(iOS 17, *) {
          beginCamera()
        } else {
          beginCamera()
        }
      }
    }
  }

  private func beginCamera() {
    AVCaptureDevice.requestAccess(for: .video) { _ in }
  }
}
`;
  await writeCameraSwift(root, availableAndTask);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated"), false);
});

test("a helper function called by a button, two indirection layers deep, does not trigger the sheet-gated heuristic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-permflow-indirect-button-"));
  const manifest = readyManifest();
  await writeReadyAssets(root, manifest);
  const indirect = `import SwiftUI
import AVFoundation
struct CaptureHome: View {
  var body: some View {
    Button("Take a photo") {
      handleTap()
    }
  }

  private func handleTap() {
    beginCamera()
  }

  private func beginCamera() {
    AVCaptureDevice.requestAccess(for: .video) { _ in }
  }
}
`;
  await writeCameraSwift(root, indirect);
  const report = await preflight(root, manifest);
  assert.equal(report.results.some((item) => item.id === "permission-flow.camera.sheet-gated"), false);
});
