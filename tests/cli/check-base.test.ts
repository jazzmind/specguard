import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const cli = path.resolve(__dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });

describe('check --base is an alias of --since [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#cli-routing-and-flags]
  it('judges the same base: a ref that does not resolve is reported the same way through either flag', () => {
    const repo = makeV2Repo();
    gitInit(repo.dir);
    const since = run(repo.dir, 'check', '--since', 'no-such-ref');
    const base = run(repo.dir, 'check', '--base', 'no-such-ref');
    expect(base.status).toBe(since.status);
    expect(base.stdout + base.stderr).toContain('does not resolve to a commit');
    expect(since.stdout + since.stderr).toContain('does not resolve to a commit');
    // and a ref that resolves is accepted by both
    expect(run(repo.dir, 'check', '--base', 'HEAD').stdout + '').not.toContain('does not resolve');
    expect(run(repo.dir, 'check', '--base', 'HEAD').stderr).not.toContain('unknown option');
  });
});
