/**
 * `specguard check`: spec health in one command.
 */
import { runCheck, type CheckView } from '../../pipelines/check.js';
import { runStatus } from '../../pipelines/status.js';
import { isV2Repo } from '../../pipelines/check.js';
import { teamLines } from '../../pipelines/team.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';
import { workspaceCheckCommand } from './workspace-check.js';

export interface CheckCliOpts extends GlobalOpts {
  coverage?: boolean;
  gaps?: boolean;
  matrix?: boolean;
  csv?: boolean;
  drift?: boolean;
  align?: boolean;
  since?: string;
  /** Alias of `since`, so CI and the change commands can use one word. */
  base?: string;
  spec?: string;
  /** Explain one capability's proof statement: its blocking reasons first, then the advisory ones. */
  explain?: string;
  /** Judge the proof statement as if every `proof.require*` gate were on. */
  strict?: boolean;
  /** `--no-notes` (commander sets `notes` to false): ignore the CI proof notes in git. */
  notes?: boolean;
  out?: string;
  /** Show what the team's server knows next to this working tree's proofs. */
  team?: boolean;
  /** The combined view of a workspace: a path, or true for the manifest above the current directory. */
  workspace?: string | true;
  /** With --workspace: run check in each repo first. */
  refresh?: boolean;
}

export async function checkCommand(opts: CheckCliOpts): Promise<void> {
  if (opts.workspace !== undefined) return workspaceCheckCommand({ workspace: opts.workspace, refresh: opts.refresh, json: opts.json });
  const config = await loadCliConfig(opts);
  const view: CheckView = opts.coverage ? 'coverage' : opts.gaps ? 'gaps' : opts.matrix ? 'matrix' : opts.drift ? 'drift' : opts.align ? 'align' : 'summary';
  // A repo that has not moved to v2 specs gets the file-based status, with a pointer to the migration.
  if (view === 'summary' && !(await isV2Repo(config))) {
    const result = await runStatus(config);
    result.messages.push('This repo uses per-file specs. Run `specguard spec consolidate` to move to functional capability specs.');
    if (opts.explain !== undefined || opts.strict) result.messages.push('The proof statement (--explain, --strict) needs functional capability specs.');
    outputResult(result, opts);
  }
  const result = await runCheck(config, { view, csv: opts.csv, out: opts.out, since: opts.since ?? opts.base, spec: opts.spec, explain: opts.explain, strict: opts.strict, ...(opts.notes === false ? { noNotes: true } : {}) });
  if (opts.team) result.messages.push(...(await teamLines(config)));
  outputResult(result, opts);
}
