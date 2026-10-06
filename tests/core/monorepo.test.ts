import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appNameFor, detectMonorepo, testCommandFor } from '../../src/core/monorepo.js';
import { runInit } from '../../src/pipelines/init.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-mono-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const pkg = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, ...extra });

describe('detectMonorepo', () => {
  it('reads pnpm workspaces with exclusions and infers frameworks', async () => {
    const dir = repo({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/skip'\n",
      'package.json': pkg('root'),
      'packages/web/package.json': pkg('@acme/web', { scripts: { test: 'vitest' }, devDependencies: { vitest: '1' } }),
      'packages/api/package.json': pkg('@acme/api', { scripts: { test: 'jest' }, devDependencies: { jest: '29' } }),
      'packages/e2e/package.json': pkg('@acme/e2e', { devDependencies: { '@playwright/test': '1' } }),
      'packages/skip/package.json': pkg('skipped'),
    });
    const info = (await detectMonorepo(dir))!;
    expect(info.packageManager).toBe('pnpm');
    expect(info.tools).toEqual(['pnpm']);
    expect(info.packages.map((p) => [p.name, p.dir, p.framework, p.hasTestScript])).toEqual([
      ['@acme/api', 'packages/api', 'jest', true],
      ['@acme/e2e', 'packages/e2e', 'playwright', false],
      ['@acme/web', 'packages/web', 'vitest', true],
    ]);
    expect(testCommandFor(info, info.packages[0])).toBe('pnpm --filter @acme/api test');
    expect(appNameFor(info.packages[0])).toBe('acme-api');
  });

  it('reads Yarn and npm workspaces (array and object forms)', async () => {
    const yarn = await detectMonorepo(repo({ 'yarn.lock': '', 'package.json': pkg('r', { workspaces: ['apps/*'] }), 'apps/a/package.json': pkg('a') }));
    expect(yarn?.packageManager).toBe('yarn');
    expect(testCommandFor(yarn!, yarn!.packages[0])).toBe('yarn workspace a test');
    const npm = await detectMonorepo(repo({ 'package.json': pkg('r', { workspaces: { packages: ['libs/*'] } }), 'libs/b/package.json': pkg('b') }));
    expect(npm?.packageManager).toBe('npm');
    expect(testCommandFor(npm!, npm!.packages[0])).toBe('npm test --workspace=b');
  });

  it('detects Nx and Turbo and prefers their runners', async () => {
    const nx = await detectMonorepo(repo({ 'nx.json': '{}', 'package.json': pkg('r'), 'apps/shop/package.json': pkg('shop') }));
    expect(nx?.tools).toContain('nx');
    expect(testCommandFor(nx!, nx!.packages[0])).toBe('npx nx test shop');
    const turbo = await detectMonorepo(repo({ 'turbo.json': '{}', 'pnpm-lock.yaml': '', 'package.json': pkg('r', { workspaces: ['packages/*'] }), 'packages/c/package.json': pkg('c') }));
    expect(turbo?.tools).toEqual(expect.arrayContaining(['turbo']));
    expect(testCommandFor(turbo!, turbo!.packages[0])).toBe('npx turbo run test --filter=c');
  });

  it('returns null for a single package', async () => {
    expect(await detectMonorepo(repo({ 'package.json': pkg('solo') }))).toBeNull();
  });
});

describe('init in a workspace', () => {
  const files = {
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': pkg('root'),
    'packages/web/package.json': pkg('web', { devDependencies: { vitest: '1' } }),
    'packages/api/package.json': pkg('api', { devDependencies: { jest: '1' } }),
  };

  it('writes one app per package with its own test command', async () => {
    const dir = repo(files);
    await runInit({ cwd: dir, harness: 'claude' });
    const config = JSON.parse(readFileSync(path.join(dir, '.specguard/config.json'), 'utf8'));
    expect(config.apps.map((a: { name: string }) => a.name)).toEqual(['api', 'web']);
    expect(config.apps[1]).toMatchObject({
      repo: 'packages/web',
      specDir: 'specs/web',
      testOutput: 'packages/web/tests/',
      framework: 'vitest',
      test: { command: 'pnpm --filter web test', reporter: 'vitest' },
    });
  });

  it('--single keeps one app', async () => {
    const dir = repo(files);
    await runInit({ cwd: dir, harness: 'claude', single: true });
    const config = JSON.parse(readFileSync(path.join(dir, '.specguard/config.json'), 'utf8'));
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe('app');
  });
});
