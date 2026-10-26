/**
 * `specguard spec ...`: the spec-authoring command group.
 */
import { approvalStatus, runSpecApprovals, runSpecApprove } from '../../pipelines/approve.js';
import { runSpecConsolidate, type SpecConsolidateOpts } from '../../pipelines/spec-consolidate.js';
import { runSpecDraft, type SpecDraftOpts } from '../../pipelines/spec-draft.js';
import { runSpecIndex } from '../../pipelines/spec-index.js';
import { runSpecGraph } from '../../pipelines/spec-graph-report.js';
import { runSpecTag, type SpecTagOpts } from '../../pipelines/spec-tag.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export async function specGraphCommand(opts: GlobalOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSpecGraph(config), opts);
}

export async function specIndexCommand(opts: GlobalOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSpecIndex(config), opts);
}

export async function specDraftCommand(opts: GlobalOpts & SpecDraftOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSpecDraft(config, opts), opts);
}

export async function specConsolidateCommand(opts: GlobalOpts & SpecConsolidateOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSpecConsolidate(config, opts), opts);
}

export async function specTagCommand(opts: GlobalOpts & SpecTagOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSpecTag(config, opts), opts);
}

export async function specApproveCommand(opts: GlobalOpts & { targets: string[]; all?: boolean; asBuilt?: boolean; by?: string; note?: string; yes?: boolean }): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSpecApprove(config, opts), opts);
}

export async function specApprovalsCommand(opts: GlobalOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  if (opts.json) {
    const { claims, byCapability } = await approvalStatus(config);
    process.stdout.write(`${JSON.stringify({ byCapability, claims: claims.map(({ claimHash: _h, ...c }) => c) })}\n`);
    process.exit(0);
  }
  outputResult(await runSpecApprovals(config), opts);
}

export async function startCommand(opts: GlobalOpts & { skipTests?: boolean }): Promise<void> {
  const { runStart } = await import('../../pipelines/start.js');
  outputResult(await runStart({ skipTests: opts.skipTests }), opts);
}
