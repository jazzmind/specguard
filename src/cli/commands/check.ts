/**
 * `specguard check`: spec health in one command.
 */
import { runCheck, type CheckView } from '../../pipelines/check.js';
import { runStatus } from '../../pipelines/status.js';
import { isV2Repo } from '../../pipelines/check.js';
import { teamLines } from '../../pipelines/team.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface CheckCliOpts extends GlobalOpts {
  coverage?: boolean;
  gaps?: boolean;
  matrix?: boolean;
  csv?: boolean;
  drift?: boolean;
  align?: boolean;
  since?: string;
  spec?: string;
  out?: string;
  /** Show what the team's server knows next to this working tree's proofs. */
  team?: boolean;
}

export async function checkCommand(opts: CheckCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const view: CheckView = opts.coverage ? 'coverage' : opts.gaps ? 'gaps' : opts.matrix ? 'matrix' : opts.drift ? 'drift' : opts.align ? 'align' : 'summary';
  // A repo that has not moved to v2 specs gets the file-based status, with a pointer to the migration.
  if (view === 'summary' && !(await isV2Repo(config))) {
    const result = await runStatus(config);
    result.messages.push('This repo uses per-file specs. Run `specguard spec consolidate` to move to functional capability specs.');
    outputResult(result, opts);
  }
  const result = await runCheck(config, { view, csv: opts.csv, out: opts.out, since: opts.since, spec: opts.spec });
  if (opts.team) result.messages.push(...(await teamLines(config)));
  outputResult(result, opts);
}
