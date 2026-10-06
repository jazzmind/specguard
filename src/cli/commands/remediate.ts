/**
 * `specguard remediate`: wiring only. See src/pipelines/remediate/index.ts.
 */
import { SEVERITIES, type Severity } from '../../core/advisory.js';
import { SpecGuardError } from '../../core/errors.js';
import { ExitCode, remediateExitLabel } from '../../core/exit-codes.js';
import { runRemediate } from '../../pipelines/remediate/index.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export interface RemediateCliOpts extends GlobalOpts {
  scanOnly?: boolean;
  advisory?: string;
  minSeverity?: string;
  allowMajor?: boolean;
  ledger?: string;
  pr?: boolean;
  dryRun?: boolean;
  llm?: boolean;
  app?: string;
  force?: boolean;
}

export async function remediateCommand(opts: RemediateCliOpts): Promise<void> {
  if (opts.minSeverity && !(SEVERITIES as readonly string[]).includes(opts.minSeverity)) {
    throw new SpecGuardError(`--min-severity must be one of ${SEVERITIES.filter((s) => s !== 'unknown').join(', ')}`, ExitCode.InternalError);
  }
  const config = await loadCliConfig(opts);
  const result = await runRemediate(config, {
    scanOnly: opts.scanOnly,
    advisory: opts.advisory,
    minSeverity: opts.minSeverity as Severity | undefined,
    allowMajor: opts.allowMajor,
    ledger: opts.ledger,
    pr: opts.pr === true,
    dryRun: opts.dryRun,
    noLlm: opts.llm === false,
    app: opts.app,
    force: opts.force,
    onLog: opts.json ? undefined : (line) => process.stdout.write(`${line}\n`),
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...result, exitLabel: remediateExitLabel(result.exitCode) }) + '\n');
  } else {
    process.stdout.write(`remediate: ${remediateExitLabel(result.exitCode)} (exit ${result.exitCode})\n`);
  }
  process.exit(result.exitCode);
}
