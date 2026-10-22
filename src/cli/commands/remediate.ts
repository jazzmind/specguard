/**
 * `specguard remediate`: wiring only. See src/pipelines/remediate/index.ts.
 */
import { SEVERITIES, type Severity } from '../../core/advisory.js';
import { SpecGuardError } from '../../core/errors.js';
import { ExitCode, remediateExitLabel } from '../../core/exit-codes.js';
import { runAppFix } from '../../pipelines/remediate/app-fix.js';
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
  autoMerge?: boolean;
  /** `failing`: repair the application for failing claims instead of fixing dependencies. */
  from?: string;
  claim?: string;
  max?: string;
}

export async function remediateCommand(opts: RemediateCliOpts): Promise<void> {
  if (opts.minSeverity && !(SEVERITIES as readonly string[]).includes(opts.minSeverity)) {
    throw new SpecGuardError(`--min-severity must be one of ${SEVERITIES.filter((s) => s !== 'unknown').join(', ')}`, ExitCode.InternalError);
  }
  if (opts.from !== undefined && opts.from !== 'failing') {
    throw new SpecGuardError(`--from must be failing (got '${opts.from}')`, ExitCode.InternalError);
  }
  const config = await loadCliConfig(opts);
  if (opts.from === 'failing') {
    const fixed = await runAppFix(config, {
      claim: opts.claim,
      max: opts.max ? Number(opts.max) : undefined,
      pr: opts.pr === true,
      dryRun: opts.dryRun,
      ledger: opts.ledger,
      app: opts.app,
      force: opts.force,
      onLog: opts.json ? undefined : (line) => process.stdout.write(`${line}\n`),
    });
    if (opts.json) process.stdout.write(JSON.stringify({ ...fixed, exitLabel: remediateExitLabel(fixed.exitCode) }) + '\n');
    else process.stdout.write(`remediate --from failing: ${fixed.exitCode === 0 ? 'nothing to repair' : remediateExitLabel(fixed.exitCode)} (exit ${fixed.exitCode})\n`);
    process.exit(fixed.exitCode);
  }
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
    autoMerge: opts.autoMerge,
    onLog: opts.json ? undefined : (line) => process.stdout.write(`${line}\n`),
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...result, exitLabel: remediateExitLabel(result.exitCode) }) + '\n');
  } else {
    process.stdout.write(`remediate: ${remediateExitLabel(result.exitCode)} (exit ${result.exitCode})\n`);
  }
  process.exit(result.exitCode);
}
