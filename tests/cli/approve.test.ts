import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeV2Repo } from '../helpers/v2-repo.js';

const cli = path.resolve(__dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
// An explicit "not an agent" env so the guard does not depend on where the suite runs.
const run = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SPECGUARD_HOST_AGENT: '0', ...env } });

describe('spec approve / approvals on the CLI [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approve-dry-run, capabilities/intent-approval#approvals-report]
  it('dry-runs by default, writes with --yes, and reports through `spec approvals --json`', () => {
    const repo = makeV2Repo();
    const historyDir = path.join(repo.dir, 'specs', 'history');

    const dry = run(repo.dir, {}, 'spec', 'approve', 'auth');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would approve 2 claim(s) in 1 capabilities; rerun with --yes');
    expect(existsSync(historyDir)).toBe(false);

    const done = run(repo.dir, {}, 'spec', 'approve', 'auth', '--yes', '--by', 'Ada', '--note', 'checked');
    expect(done.status).toBe(0);
    expect(readdirSync(historyDir)).toHaveLength(1);

    const report = run(repo.dir, {}, '--json', 'spec', 'approvals');
    expect(report.status).toBe(0);
    const parsed = JSON.parse(report.stdout) as { byCapability: Record<string, { total: number; approved: number; unapproved: string[] }> };
    expect(parsed.byCapability.auth).toMatchObject({ total: 2, approved: 2, unapproved: [] });
    expect(parsed.byCapability.shop).toMatchObject({ total: 1, approved: 0 });
  });

  // [claims: capabilities/intent-approval#agent-needs-terminal]
  it('refuses an agent session with no terminal', () => {
    const repo = makeV2Repo();
    const res = run(repo.dir, { SPECGUARD_HOST_AGENT: '1' }, 'spec', 'approve', '--all', '--yes');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('in their own terminal');
    expect(existsSync(path.join(repo.dir, 'specs', 'history'))).toBe(false);
  });
});
