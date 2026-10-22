/**
 * `specguard security` — generate security tests / run SAST (Phase 5).
 */
import path from 'node:path';
import { planToSarif } from '../../core/sarif.js';
import { writeFile } from '../../core/writer.js';
import { runSecurity } from '../../pipelines/security.js';
import { planList, planSetStatus, planShow } from '../../pipelines/team.js';
import { runSecurityFix, type SecurityFixOpts } from '../../pipelines/security-fix.js';
import { runSecurityScan } from '../../pipelines/security-scan.js';
import type { Severity } from '../../core/advisory.js';

import { loadCliConfig, outputResult, type GlobalOpts } from './helpers.js';

export interface SecurityCliOpts extends GlobalOpts {
  spec?: string;
  all?: boolean;
  withSast?: boolean;
  app?: string;
  force?: boolean;
}

export async function securityCommand(opts: SecurityCliOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runSecurity(config, {
    spec: opts.spec,
    all: opts.all,
    withSast: opts.withSast,
    app: opts.app,
    force: opts.force,
  });

  outputResult(result, opts);
}

// --- scan / fix / plan ------------------------------------------------------

export async function securityScanCommand(opts: GlobalOpts & { minSeverity?: string; app?: string; specReview?: boolean; sarif?: string | true }): Promise<void> {
  const config = await loadCliConfig(opts);
  const result = await runSecurityScan(config, { minSeverity: opts.minSeverity as Severity | undefined, app: opts.app, noSpecReview: opts.specReview === false });
  if (opts.sarif !== undefined && result.plan) {
    // Written even when the scan found something: that is when the upload matters.
    const file = path.resolve(config.rootDir ?? process.cwd(), typeof opts.sarif === 'string' ? opts.sarif : '.specguard/security/scan.sarif');
    await writeFile(file, `${JSON.stringify(planToSarif(result.plan), null, 2)}\n`);
    result.messages.push(`sarif: ${path.relative(config.rootDir ?? process.cwd(), file)}`);
  }
  outputResult(result, opts);
}

export async function securityFixCommand(opts: GlobalOpts & SecurityFixOpts): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSecurityFix(config, opts), opts);
}

export async function securityPlanListCommand(opts: GlobalOpts): Promise<void> {
  outputResult(await planList(await loadCliConfig(opts)), opts);
}

export async function securityPlanShowCommand(planId: string, opts: GlobalOpts): Promise<void> {
  outputResult(await planShow(await loadCliConfig(opts), planId), opts);
}

export async function securityPlanSetStatusCommand(
  planId: string,
  itemId: string,
  status: string,
  opts: GlobalOpts & { note?: string; by?: string; externalRef?: string },
): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await planSetStatus(config, planId, itemId, status, { note: opts.note, by: opts.by, externalRef: opts.externalRef }), opts);
}
