import { draftDescriptions } from './asc-description-draft.js';
import { draftListing } from './asc-listing-draft.js';
import { draftReview } from './asc-review-draft.js';
import { draftScreenshots } from './asc-screenshot-draft.js';
import { draftVersion } from './asc-version-draft.js';
import type { ShipLayerManifest } from './types.js';

export const DRAFT_STAGES = ['descriptions', 'listing', 'screenshots', 'review', 'version'] as const;
export type DraftStage = (typeof DRAFT_STAGES)[number];
/** `descriptions` can create the version record, so it only runs when asked for by name. */
export const DEFAULT_DRAFT_STAGES: DraftStage[] = ['listing', 'screenshots', 'review', 'version'];

export interface DraftOptions { stages?: DraftStage[]; locales?: string[]; replaceIncompleteScreenshots?: boolean }
type StageRunner = (stage: DraftStage) => Promise<unknown>;

export function parseDraftStages(value: string | undefined): DraftStage[] {
  if (value === undefined) return DEFAULT_DRAFT_STAGES;
  const names = value.split(',').map(name => name.trim()).filter(Boolean);
  if (!names.length || new Set(names).size !== names.length) throw new Error('--only needs one or more unique stages.');
  for (const name of names) if (!(DRAFT_STAGES as readonly string[]).includes(name)) throw new Error(`Unknown draft stage '${name}'. Stages: ${DRAFT_STAGES.join(', ')}.`);
  // Always run in the fixed order, whatever order they were named in.
  return DRAFT_STAGES.filter(stage => names.includes(stage));
}

/** Fill an existing editable App Store draft, stage by stage. A preview runs
 * every stage and reports each failure; an apply stops at the first failure so
 * nothing is written on top of a broken step. Never submits. */
export async function draft(
  repository: string,
  manifest: ShipLayerManifest,
  options: DraftOptions = {},
  apply = false,
  confirmed = false,
  suppliedRunner?: StageRunner,
) {
  if (apply && (!confirmed || manifest.sync.mode !== 'apply')) throw new Error('Draft writes require sync.mode: apply and --apply --yes-i-understand.');
  const stages = options.stages ?? DEFAULT_DRAFT_STAGES;
  const locales = options.locales?.length ? options.locales : manifest.app.locales;
  const run: StageRunner = suppliedRunner ?? (stage => {
    if (stage === 'descriptions') return draftDescriptions(manifest, apply, confirmed);
    if (stage === 'listing') return draftListing(manifest, locales, apply, confirmed);
    if (stage === 'screenshots') return draftScreenshots(repository, manifest, apply, confirmed, undefined, options.locales, Boolean(options.replaceIncompleteScreenshots));
    if (stage === 'review') return draftReview(manifest, repository, apply, confirmed);
    return draftVersion(manifest, apply, confirmed);
  });

  const results: Array<{ stage: DraftStage; status: 'ok' | 'failed' | 'skipped'; result?: unknown; error?: string }> = [];
  let failed = false;
  for (const stage of stages) {
    if (failed && apply) { results.push({ stage, status: 'skipped' }); continue; }
    try { results.push({ stage, status: 'ok', result: await run(stage) }); }
    catch (error) { failed = true; results.push({ stage, status: 'failed', error: error instanceof Error ? error.message : String(error) }); }
  }
  return { mode: apply ? 'apply' : 'preview', version: manifest.app.version, stages: results, failed, submitted: false };
}
