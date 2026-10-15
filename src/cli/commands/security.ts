/**
 * `specguard security` — generate security tests / run SAST (Phase 5).
 */
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

export async function securityScanCommand(opts: GlobalOpts & { minSeverity?: string; app?: string; specReview?: boolean }): Promise<void> {
  const config = await loadCliConfig(opts);
  outputResult(await runSecurityScan(config, { minSeverity: opts.minSeverity as Severity | undefined, app: opts.app, noSpecReview: opts.specReview === false }), opts);
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
