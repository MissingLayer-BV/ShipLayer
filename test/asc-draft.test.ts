import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultManifest } from '../src/manifest.js';
import { draft, parseDraftStages, DEFAULT_DRAFT_STAGES } from '../src/asc-draft.js';

function manifest() {
  const value = defaultManifest({ name: 'Example', bundleId: 'com.example.app', version: '1.0' });
  value.sync.mode = 'apply';
  return value;
}

test('parses stages into the fixed order and rejects unknown or repeated ones', () => {
  assert.deepEqual(parseDraftStages(undefined), DEFAULT_DRAFT_STAGES);
  assert.deepEqual(parseDraftStages('version, listing'), ['listing', 'version']);
  assert.deepEqual(parseDraftStages('descriptions'), ['descriptions']);
  assert.throws(() => parseDraftStages('listing,listing'), /unique/);
  assert.throws(() => parseDraftStages('pricing'), /Unknown draft stage 'pricing'/);
  assert.throws(() => parseDraftStages(''), /one or more/);
});

test('a preview runs every stage and reports each failure', async () => {
  const seen: string[] = [];
  const result = await draft('/repo', manifest(), {}, false, false, async stage => {
    seen.push(stage);
    if (stage === 'version') throw new Error('no valid build yet');
    return { stage };
  });
  assert.deepEqual(seen, ['listing', 'screenshots', 'review', 'version']);
  assert.equal(result.mode, 'preview');
  assert.equal(result.failed, true);
  assert.deepEqual(result.stages.map(item => item.status), ['ok', 'ok', 'ok', 'failed']);
  assert.equal(result.stages[3].error, 'no valid build yet');
});

test('an apply needs both gates and stops writing after the first failed stage', async () => {
  await assert.rejects(draft('/repo', manifest(), {}, true, false, async () => ({})), /--apply --yes-i-understand/);
  const dryRun = manifest(); dryRun.sync.mode = 'dry-run';
  await assert.rejects(draft('/repo', dryRun, {}, true, true, async () => ({})), /sync.mode: apply/);
  const seen: string[] = [];
  const result = await draft('/repo', manifest(), { stages: ['listing', 'review', 'version'] }, true, true, async stage => {
    seen.push(stage);
    if (stage === 'review') throw new Error('boom');
    return {};
  });
  assert.deepEqual(seen, ['listing', 'review']);
  assert.deepEqual(result.stages.map(item => item.status), ['ok', 'failed', 'skipped']);
  assert.equal(result.submitted, false);
});
