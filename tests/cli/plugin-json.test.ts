import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeRepo } from '../helpers/repo.js';

const cli = path.resolve(__dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });

describe('plugin subcommands honour --json [plugin-json]', () => {
  // The root program also defines --json; the extension's Plugins view parses this output.
  // [claims: capabilities/integration-surfaces#plugin-manage]
  it('`plugin list --json` prints JSON, not the table', () => {
    const repo = makeRepo();
    const res = run(repo.dir, 'plugin', 'list', '--json');
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { plugins: Array<{ id: string }> };
    expect(parsed.plugins.map((p) => p.id)).toContain('quality');
  });
});
