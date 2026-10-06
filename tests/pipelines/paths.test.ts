import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { safeRootsFor } from '../../src/pipelines/git-ops.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { runMatrix } from '../../src/pipelines/matrix.js';
import { makeRepo, SPEC_AWARDS } from '../helpers/repo.js';

describe('config.paths', () => {
  it('git-ops stages only the directories the config writes into', async () => {
    const repo = makeRepo({ paths: { docsOut: 'documentation', securityTests: 'qa/security' } });
    const roots = safeRootsFor(await loadConfig(repo.dir));
    expect(roots).toEqual(expect.arrayContaining(['tests/', 'specs/', '.specguard/', 'documentation/', 'qa/security/']));
  });

  it('proof ingest finds specs under paths.specsRoot', async () => {
    const repo = makeRepo({ paths: { specsRoot: 'spec-tree' } });
    repo.write('spec-tree/core/awards.md', SPEC_AWARDS);
    const config = await loadConfig(repo.dir);
    config.apps[0].specDir = 'elsewhere';
    const result = await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir);
    expect(result.failed).toBe(0);
    expect(JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8')).proofs['core/awards#award-once']).toBeDefined();
  });

  it('matrix looks for security tests and docs under the configured paths', async () => {
    const repo = makeRepo({ paths: { docsOut: 'documentation', securityTests: 'qa/security' } });
    repo.write('qa/security/awards.test.ts', '');
    repo.write('documentation/awards.md', '# docs');
    const config = await loadConfig(repo.dir);
    await runMatrix(config, { out: 'out.json' });
    const entry = JSON.parse(readFileSync(path.join(repo.dir, 'out.json'), 'utf8')).entries[0];
    expect(entry.tests.map((t: string) => path.relative(repo.dir, t))).toContain('qa/security/awards.test.ts');
    expect(entry.docs.map((d: string) => path.relative(repo.dir, d))).toContain('documentation/awards.md');
  });
});
