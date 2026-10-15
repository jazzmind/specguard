import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { loadSpecGuardEnv } from '../../src/core/env.js';
import { makeRepo } from '../helpers/repo.js';

function workspace(): { root: string; repo: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sg-env-'));
  mkdirSync(path.join(root, '.specguard'), { recursive: true });
  writeFileSync(path.join(root, '.specguard/workspace.json'), JSON.stringify({ version: 1, name: 'w', repos: {} }));
  const repo = path.join(root, 'app');
  mkdirSync(path.join(repo, '.specguard'), { recursive: true });
  return { root, repo };
}

describe('.env loading [env-loading]', () => {
  // [claims: capabilities/workspaces#shared-env]
  it('applies the real environment first, then the repo file, then the workspace file [precedence]', () => {
    const { root, repo } = workspace();
    writeFileSync(path.join(root, '.specguard/.env'), 'SHARED=workspace\nONLY_WS=ws\nFROM_SHELL=workspace\n');
    writeFileSync(path.join(repo, '.specguard/.env'), '# comment\nSHARED=repo\nONLY_REPO="quoted"\nFROM_SHELL=repo\n');
    const env: NodeJS.ProcessEnv = { FROM_SHELL: 'shell' };
    loadSpecGuardEnv(repo, env);
    expect(env).toMatchObject({ SHARED: 'repo', ONLY_WS: 'ws', ONLY_REPO: 'quoted', FROM_SHELL: 'shell' });
  });

  // [claims: capabilities/workspaces#shared-env]
  it('does nothing without any env file, and ignores malformed lines [none]', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-env-'));
    const env: NodeJS.ProcessEnv = {};
    loadSpecGuardEnv(dir, env);
    expect(env).toEqual({});
    mkdirSync(path.join(dir, '.specguard'), { recursive: true });
    writeFileSync(path.join(dir, '.specguard/.env'), 'NOEQUALS\n=nokey\nGOOD=1\n');
    loadSpecGuardEnv(dir, env);
    expect(env).toEqual({ GOOD: '1' });
  });
});

describe('server config [server-config]', () => {
  // [claims: capabilities/integration-surfaces#planned-reduced-surface]
  it('accepts an optional server block and rejects a bad mode [schema]', async () => {
    const ok = makeRepo({ server: { url: 'http://sandbox/specguard', project: 'portal', mode: 'required', timeoutMs: 500 } });
    expect((await loadConfig(ok.dir)).server).toEqual({ url: 'http://sandbox/specguard', project: 'portal', mode: 'required', timeoutMs: 500 });
    expect((await loadConfig(makeRepo({}).dir)).server).toBeUndefined();
    await expect(loadConfig(makeRepo({ server: { mode: 'sometimes' } }).dir)).rejects.toThrow();
  });
});
