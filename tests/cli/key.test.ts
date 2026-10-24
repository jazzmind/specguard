import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { dotEnvDefines, setDotEnvValue } from '../../src/core/env.js';
import { makeRepo } from '../helpers/repo.js';

const cli = path.resolve(__dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (cwd: string, home: string, input: string | undefined, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, input, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: '' } });

const SECRET = 'sk-ant-test-0123456789';

describe('giving SpecGuard the model key [key-command]', () => {
  // [claims: capabilities/workspaces#key-command]
  it('saves a key piped on stdin to the user file with mode 600, replaces it later, and never prints it', () => {
    const repo = makeRepo();
    const home = mkdtempSync(path.join(os.tmpdir(), 'sg-keyhome-'));
    const first = run(repo.dir, home, `${SECRET}\n`, 'key', 'set', '--env-var', 'ANTHROPIC_API_KEY');
    expect(first.status).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(SECRET);
    const file = path.join(home, '.config/specguard/.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(`ANTHROPIC_API_KEY=${SECRET}\n`);

    run(repo.dir, home, 'sk-ant-second\n', 'key', 'set', '--env-var', 'ANTHROPIC_API_KEY');
    expect(readFileSync(file, 'utf8')).toBe('ANTHROPIC_API_KEY=sk-ant-second\n');
  });

  // [claims: capabilities/workspaces#key-command]
  it('reports where the key is set without showing it', () => {
    const repo = makeRepo();
    const home = mkdtempSync(path.join(os.tmpdir(), 'sg-keyhome-'));
    run(repo.dir, home, `${SECRET}\n`, 'key', 'set', '--env-var', 'ANTHROPIC_API_KEY');
    const status = run(repo.dir, home, undefined, 'key', 'status', '--env-var', 'ANTHROPIC_API_KEY');
    expect(status.stdout).toMatch(/user\s+set\s/);
    expect(status.stdout).toMatch(/repo\s+not set\s/);
    expect(status.stdout).not.toContain(SECRET);
    expect(status.status).toBe(0);
  });

  // [claims: capabilities/workspaces#key-command]
  it('writes the repo scope into the repo and leaves other lines alone, and refuses a multi-line value', () => {
    const repo = makeRepo();
    const file = path.join(repo.dir, '.specguard/.env');
    writeFileSync(file, '# keep\nOTHER=1\nANTHROPIC_API_KEY=old\n');
    setDotEnvValue(file, 'ANTHROPIC_API_KEY', 'new');
    expect(readFileSync(file, 'utf8')).toBe('# keep\nOTHER=1\nANTHROPIC_API_KEY=new\n');
    expect(dotEnvDefines(file, 'ANTHROPIC_API_KEY')).toBe(true);
    expect(() => setDotEnvValue(file, 'ANTHROPIC_API_KEY', 'a\nB=2')).toThrow(/one non-empty line/);
    expect(() => setDotEnvValue(file, 'bad name', 'x')).toThrow(/not an environment variable name/);
  });
});
