import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeOverlayWorkspace } from '../helpers/overlay-fixture.js';

const SCRIPT = path.resolve(import.meta.dirname, '../../plugins/specguard/scripts/session-status.sh');
const cli = path.resolve(import.meta.dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const sh = (cwd: string, env: NodeJS.ProcessEnv) => spawnSync('sh', [SCRIPT], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...env, SPECGUARD_HOST_AGENT: '0' } });

/** A stand-in CLI that logs how it was called and answers `overlay resolve` with configured:true. */
function stubCli(dir: string): { file: string; log: string } {
  const log = path.join(dir, 'calls.log');
  const file = path.join(dir, 'stub-cli.mjs');
  writeFileSync(file, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nif (process.argv[2] === 'overlay') console.log('{"dir":".","configured":true}');\nelse console.log('stub check output');\n`);
  return { file, log };
}

describe('the SessionStart status script [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('shows the status of a repo whose specs live in an overlay, starting with where the config came from', () => {
    const ws = makeOverlayWorkspace({ shop: 'warn' });
    const r = sh(path.join(ws.api), { ...ws.env, SPECGUARD_CLI: cli, NODE_OPTIONS: `--import ${tsx}` });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe(`configured via overlay ${ws.specs} (app api)`);
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('asks the CLI only when the folder has no config and an overlay is known: no start-up cost for plain projects', () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-sess-')));
    const stub = stubCli(dir);
    const home = path.join(dir, 'home');
    mkdirSync(home);
    const bare = path.join(dir, 'bare');
    mkdirSync(bare);
    const env = { PATH: process.env.PATH ?? '', HOME: home, SPECGUARD_CLI: stub.file };

    // no config, no overlay registry, no env: silent and the CLI is never started
    expect(sh(bare, env)).toMatchObject({ status: 0, stdout: '' });
    expect(existsSync(stub.log)).toBe(false);

    // a registry file exists: the CLI is asked to resolve, and (stub says yes) then runs check
    mkdirSync(path.join(home, '.config', 'specguard'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'specguard', 'overlays.json'), '{"version":1,"overlays":[]}');
    expect(sh(bare, env).stdout).toBe('stub check output\n');
    expect(readFileSync(stub.log, 'utf8').trim().split('\n')).toEqual(['overlay resolve . --json', 'check']);
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('stays silent when the CLI says the folder resolves to nothing, and does not ask when the folder has its own config', () => {
    const ws = makeOverlayWorkspace();
    const env = { ...ws.env, SPECGUARD_CLI: cli, NODE_OPTIONS: `--import ${tsx}` };
    expect(sh(ws.base, env)).toMatchObject({ status: 0, stdout: '' });

    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-own-')));
    const stub = stubCli(dir);
    const repo = path.join(dir, 'repo');
    mkdirSync(path.join(repo, '.specguard'), { recursive: true });
    writeFileSync(path.join(repo, '.specguard', 'config.json'), '{}');
    sh(repo, { ...ws.env, SPECGUARD_CLI: stub.file });
    expect(readFileSync(stub.log, 'utf8').trim()).toBe('check');
  });
});
