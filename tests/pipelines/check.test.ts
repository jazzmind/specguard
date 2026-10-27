import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { isV2Repo, runCheck } from '../../src/pipelines/check.js';
import { runGapAnalysis } from '../../src/pipelines/gap-analysis.js';
import { runMatrix } from '../../src/pipelines/matrix.js';
import { runStatus } from '../../src/pipelines/status.js';
import { writeFileSync } from 'node:fs';
import { runHistoryAdd } from '../../src/pipelines/history.js';
import { makeRepo } from '../helpers/repo.js';
import { AUTH_SPEC, gitCommit, gitInit, makeV2Repo } from '../helpers/v2-repo.js';
import { versionInfo } from '../../src/core/version.js';

const cfg = async (dir: string) => loadConfig(dir);

describe('check [check]', () => {
  // [claims: capabilities/traceability-and-drift#check-engine-provenance]
  it('records the checking engine version beside the checked commit for workspace freshness', async () => {
    const repo = makeV2Repo();
    gitInit(repo.dir);
    await runCheck(await cfg(repo.dir));
    const trace = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/trace.json'), 'utf8'));
    expect(trace.tool).toEqual(versionInfo());
    expect(trace.statement.head).toMatch(/^[a-f0-9]{40}$/);
    expect(trace.version).toBe(1);
  });
  it('recognises v2 repos and leaves v1 repos alone [is-v2]', async () => {
    expect(await isV2Repo(await cfg(makeV2Repo().dir))).toBe(true);
    expect(await isV2Repo(await cfg(makeRepo().dir))).toBe(false);
  });

  // [claims: capabilities/traceability-and-drift#check-exit-codes]
  it('summary reports ownership, tests and proofs, exits 4 for unowned files [summary]', async () => {
    const repo = makeV2Repo();
    const r = await runCheck(await cfg(repo.dir), {});
    const text = r.messages.join('\n');
    expect(text).toContain('# auth [capability] 2 files, 1 tests, 2 claims');
    expect(text).toContain('[missing-spec] src/orphan.ts');
    expect(text).toMatch(/TOTAL: 5 source files, 4 specs \(80%\)/);
    expect(text).toContain('ORPHANS: 0');
    expect(r.exitCode).toBe(4);
    const trace = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/trace.json'), 'utf8'));
    expect(trace.unowned).toEqual(['src/orphan.ts']);
    expect(trace.totals.capabilities).toBe(2);
    expect(trace.totals.sourceFiles).toBe(5);
  });

  it('never reports more than 100% tested when a capability also owns files outside the source set [percent-bounded]', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "docs/**"\n  - "src/orphan.ts"\n'));
    repo.write('docs/guide.md', '# guide\n');
    repo.write('docs/more.md', '# more\n');
    const text = (await runCheck(await cfg(repo.dir), {})).messages.join('\n');
    const m = text.match(/TOTAL: (\d+) source files, (\d+) specs \((\d+)%\), (\d+) tests \((\d+)%\)/)!;
    expect(Number(m[4])).toBeLessThanOrEqual(Number(m[1]));
    expect(Number(m[5])).toBeLessThanOrEqual(100);
  });

  // [claims: capabilities/traceability-and-drift#check-exit-codes]
  it('exits 0 once every source file has an owner [clean-exit]', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "src/orphan.ts"\n'));
    const r = await runCheck(await cfg(repo.dir), {});
    expect(r.exitCode).toBe(0);
    expect(r.failed).toBe(0);
  });

  // [claims: capabilities/traceability-and-drift#check-exit-codes]
  it('exits 2 and names the rule on a graph error [graph-error]', async () => {
    const repo = makeV2Repo();
    repo.write('specs/system.md', '# no frontmatter\n');
    const r = await runCheck(await cfg(repo.dir), {});
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toContain('no-system');
  });

  // [claims: capabilities/traceability-and-drift#gap-classification]
  it('gaps lists untested claims and non-proven claims [gaps]', async () => {
    const repo = makeV2Repo();
    const r = await runCheck(await cfg(repo.dir), { view: 'gaps' });
    const text = r.messages.join('\n');
    expect(text).toContain('[untested-claim] capabilities/auth#logout-clears-session');
    expect(text).not.toContain('[untested-claim] capabilities/auth#login-valid-code');
    expect(text).toContain('[no-tests] capabilities/shop'.replace('capabilities/', ''));
    expect(text).toContain('[unowned] src/orphan.ts');
  });

  // [claims: capabilities/traceability-and-drift#matrix-links-all-artifacts]
  it('writes the matrix as JSON or CSV with one row per claim [matrix]', async () => {
    const repo = makeV2Repo();
    await runCheck(await cfg(repo.dir), { view: 'matrix' });
    const rows = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/traceability.json'), 'utf8')).rows;
    expect(rows).toHaveLength(3);
    expect(rows.find((r: { claim: string }) => r.claim === 'capabilities/auth#login-valid-code').tests).toEqual(['tests/auth.test.ts']);
    await runCheck(await cfg(repo.dir), { view: 'matrix', csv: true });
    const csv = readFileSync(path.join(repo.dir, '.specguard/traceability.csv'), 'utf8').split('\n');
    expect(csv[0]).toBe('capability,claim,proof,tests,docs,sources');
    expect(csv).toHaveLength(5);
  });

  // [claims: capabilities/traceability-and-drift#planned-unified-check]
  it('status, gap-analysis and matrix delegate with their own names and exit codes [aliases]', async () => {
    const repo = makeV2Repo();
    const config = await cfg(repo.dir);
    const status = await runStatus(config);
    expect(status.pipeline).toBe('status');
    expect(status.exitCode).toBe(4);
    expect(status.messages.join('\n')).toContain('TOTAL:');
    const gaps = await runGapAnalysis(config, { plan: false });
    expect(gaps.pipeline).toBe('gap-analysis');
    expect(gaps.gaps).toEqual([]);
    const matrix = await runMatrix(config, {});
    expect(matrix.pipeline).toBe('matrix');
  });

  it('a v1 repo keeps the file-based status [v1-unchanged]', async () => {
    const r = await runStatus(await cfg(makeRepo().dir));
    expect(r.pipeline).toBe('status');
    expect(r.messages.join('\n')).toContain('TOTAL:');
    expect(r.messages.join('\n')).not.toContain('capability');
  });

  describe('intent gaps [check-intent-gap]', () => {
    async function repoWithGap(extra: Record<string, unknown> = {}) {
      const repo = makeV2Repo(extra);
      // Own every source file so the only finding is the intent gap.
      repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "src/orphan.ts"\n'));
      gitInit(repo.dir, '2020-01-01T12:00:00Z');
      await runHistoryAdd(await loadConfig(repo.dir), { decision: 'long ago', affects: ['shop'], date: '2000-01-01' });
      writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 2;\n');
      gitCommit(repo.dir, 'change login', '2021-06-01T12:00:00Z');
      return repo;
    }

    it('is reported but does not fail the build by default [advisory]', { timeout: 30_000 }, async () => {
      const repo = await repoWithGap();
      const r = await runCheck(await cfg(repo.dir), {});
      expect(r.messages.join('\n')).toContain('[intent-gap] auth: code changed 2021-06-01');
      expect(r.exitCode).toBe(0);
    });

    it('fails with the drift exit code when the project opts in [opt-in]', async () => {
      const repo = await repoWithGap({ history: { failOnIntentGap: true } });
      const r = await runCheck(await cfg(repo.dir), {});
      expect(r.exitCode).toBe(3);
      expect(r.failed).toBe(1);
    });
  });

  // [claims: capabilities/traceability-and-drift#check-exit-codes]
  it('counts each graph error once in the failed total [failed-count]', async () => {
    const repo = makeV2Repo();
    const base = await runCheck(await cfg(repo.dir), {});
    repo.write('specs/capabilities/stray.md', AUTH_SPEC.replace('id: auth', 'id: stray').replace('parent: system', 'parent: nobody'));
    const r = await runCheck(await cfg(repo.dir), {});
    expect(r.messages.join('\n')).toMatch(/nobody/);
    expect(r.failed - base.failed).toBe(1);
  });
});
