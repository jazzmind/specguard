/**
 * `specguard publish`: write a snapshot of this project for a team server, check whether it needs publishing, or
 * publish it with its test evidence.
 */
import { runPublish } from '../../pipelines/publish.js';
import type { EvidenceMode } from '../../pipelines/publish-evidence.js';
import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface PublishCliOpts extends GlobalOpts {
  out?: string;
  project?: string;
  push?: boolean;
  server?: string;
  token?: string;
  check?: boolean;
  /** `--evidence` alone is `true`; `--evidence=summary` a string. */
  evidence?: boolean | string;
  run?: string;
  maxEvidenceMb?: string | number;
  skipOversized?: boolean;
  progressJson?: boolean;
}

/** `--evidence` / `--evidence=all|summary` to a mode; throws on anything else. */
export function evidenceMode(value: boolean | string | undefined): EvidenceMode | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true || value === 'all') return 'all';
  if (value === 'summary') return 'summary';
  throw new Error(`--evidence takes "all" or "summary", not "${value}"`);
}

export function megabytes(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--max-evidence-mb takes a number of megabytes, not "${value}"`);
  return n;
}

export async function publishCommand(opts: PublishCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  let evidence: EvidenceMode | undefined;
  let maxEvidenceMb: number | undefined;
  try {
    evidence = evidenceMode(opts.evidence);
    maxEvidenceMb = megabytes(opts.maxEvidenceMb);
  } catch (err) {
    process.stderr.write(`[publish] ${(err as Error).message}\n`);
    process.exit(2);
  }
  outputResult(
    await runPublish(config, {
      out: opts.out,
      project: opts.project,
      push: opts.push,
      server: opts.server,
      token: opts.token,
      check: opts.check,
      evidence,
      run: opts.run,
      maxEvidenceMb,
      skipOversized: opts.skipOversized,
      progressJson: opts.progressJson,
    }),
    opts,
  );
}
