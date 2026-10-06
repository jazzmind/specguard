/**
 * Regression suite for the HiRocky pilot findings (docs/readiness/specguard.md):
 * one canonical spec key across ingest, drift registry, matrix, align, status.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn() }));

import { loadConfig } from '../../src/core/config.js';
import { loadRegistry, saveRegistry } from '../../src/core/drift-registry.js';
import { resetSourceWarnings } from '../../src/core/spec-key.js';
import { runAlign } from '../../src/pipelines/align.js';
import { runDrift } from '../../src/pipelines/drift.js';
import { runMatrix } from '../../src/pipelines/matrix.js';
import { appendProofCoverage, walkClaimVerdicts } from '../../src/pipelines/proof.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import { runStatus } from '../../src/pipelines/status.js';
import { INBOX, JOURNEY, makeHiRockyRepo, MESSAGING, SIGNATURE, type HiRockyFixture } from '../helpers/hirocky-fixture.js';

const ledger = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, '.specguard/proofs.json'), 'utf8')).proofs as Record<string, { verdict: string; fileHashes: Record<string, string> }>;

let fx: HiRockyFixture;
const ALL = () => [fx.reports.api, fx.reports.web, fx.reports.e2e];

beforeEach(() => {
  resetSourceWarnings();
  fx = makeHiRockyRepo();
});

describe('hirocky-shaped repo', () => {
  it('ingest records source hashes from declared sources (root- and app-relative)', async () => {
    await runResultsIngest(ALL(), fx.dir, { runId: 'r1' });
    const proofs = ledger(fx.dir);
    expect(Object.keys(proofs['api/services/messaging#stop-opts-out'].fileHashes).sort()).toEqual([
      'apps/api/src/services/messaging.ts',
      'apps/api/src/services/redaction.ts',
    ]);
    expect(Object.keys(proofs[`${SIGNATURE}#valid-signature`].fileHashes)).toEqual(['apps/api/src/sms/signature.ts']);
    expect(Object.keys(proofs[`${INBOX}#lists-cases`].fileHashes)).toEqual(['apps/web/src/pages/inbox.tsx']);
  });

  it('a source edit stales exactly the claims of the specs that declare it', async () => {
    await runResultsIngest(ALL(), fx.dir, { runId: 'r1' });
    writeFileSync(path.join(fx.dir, 'apps/api/src/services/redaction.ts'), 'export const redact = 2;\n');
    const config = await loadConfig(fx.dir);
    const stale = new Set<string>();
    const proven = new Set<string>();
    await walkClaimVerdicts(config, (ref, verdict) => (verdict === 'stale' ? stale : proven).add(ref));
    expect([...stale].sort()).toEqual([`${MESSAGING}#send-blocked`, `${MESSAGING}#stop-opts-out`]);
    expect(proven.has(`${SIGNATURE}#valid-signature`)).toBe(true);
    expect(proven.has(`${JOURNEY}#journey-stop`)).toBe(true);
  });

  it('matrix reports claim-level coverage under canonical keys', async () => {
    const out = path.join(fx.dir, 'matrix.json');
    const config = await loadConfig(fx.dir);
    await runMatrix(config, { out, format: 'json' });
    const entries = JSON.parse(readFileSync(out, 'utf8')).entries as Array<{ specKey: string; claims: Array<{ tests: unknown[] }> }>;
    const m = entries.find((e) => e.specKey === MESSAGING);
    expect(m?.claims).toHaveLength(2);
    expect(m?.claims.every((c) => c.tests.length > 0)).toBe(true);
    for (const e of entries) expect(e.claims.every((c) => c.tests.length > 0)).toBe(true);
  });

  it('align covers claims from tags without an LLM call', async () => {
    const config = await loadConfig(fx.dir);
    const res = await runAlign(config, { app: 'api', fresh: true });
    const entry = res.report.entries.find((e) => e.specKey.endsWith('services/messaging'));
    expect(entry?.coveredClaims?.map((c) => c.claim).sort()).toEqual(['send-blocked', 'stop-opts-out']);
    expect(entry?.uncoveredClaims ?? []).toEqual([]);
  });

  it('status does not report specs with tagged tests as (no test)', async () => {
    const config = await loadConfig(fx.dir);
    const res = await runStatus(config);
    const text = res.messages.join('\n');
    expect(text).not.toMatch(/services\/messaging.*\(no test\)/);
    expect(text).not.toMatch(/sms\/signature.*\(no test\)/);
  });

  it('migrates old registry keys (api/api/..., api/...) to the canonical key', async () => {
    const file = { hash: 'h', lastChecked: 'x', lastVerdict: 'no-drift' as const };
    saveRegistry(fx.dir, {
      'api/api/services/messaging': { specKey: 'x', specHash: 's', files: { 'apps/api/src/services/messaging.ts': file } },
      'api/services/messaging': { specKey: 'y', specHash: 's', files: {} },
    });
    const config = await loadConfig(fx.dir);
    await runDrift(config, { force: true });
    const registry = loadRegistry(fx.dir);
    expect(Object.keys(registry).filter((k) => k.includes('messaging'))).toEqual([MESSAGING]);
    expect(registry[MESSAGING].specKey).toBe(MESSAGING);
    expect(Object.keys(registry)).not.toContain('api/api/services/messaging');
  });
});

void appendProofCoverage;
