import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRepository } from '../src/scanner.js';

test('maps Apple\'s AudioData and PurchaseHistory collected-data types instead of reporting them unparsed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiplayer-privacy-types-'));
  await mkdir(join(root, 'App'));
  const entry = (type: string) => `<dict><key>NSPrivacyCollectedDataType</key><string>${type}</string><key>NSPrivacyCollectedDataTypeLinked</key><false/><key>NSPrivacyCollectedDataTypeTracking</key><false/><key>NSPrivacyCollectedDataTypePurposes</key><array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array></dict>`;
  await writeFile(join(root, 'App/PrivacyInfo.xcprivacy'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>NSPrivacyTracking</key><false/><key>NSPrivacyCollectedDataTypes</key><array>${entry('NSPrivacyCollectedDataTypeAudioData')}${entry('NSPrivacyCollectedDataTypePurchaseHistory')}</array></dict></plist>
`);
  const report = await analyzeRepository(root);
  const keys = report.findings.map(finding => finding.key);
  assert.ok(keys.includes('privacyManifestData:Audio Data'), keys.join(', '));
  assert.ok(keys.includes('privacyManifestData:Purchases'));
  assert.ok(!keys.includes('privacyManifestUnparsed'));
});
