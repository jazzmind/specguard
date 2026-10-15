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
  // [claims: capabilities/workspaces#monorepo-detection]
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

  // [claims: capabilities/workspaces#monorepo-detection]
  it('reads Yarn and npm workspaces (array and object forms)', async () => {
    const yarn = await detectMonorepo(repo({ 'yarn.lock': '', 'package.json': pkg('r', { workspaces: ['apps/*'] }), 'apps/a/package.json': pkg('a') }));
    expect(yarn?.packageManager).toBe('yarn');
    expect(testCommandFor(yarn!, yarn!.packages[0])).toBe('yarn workspace a test');
    const npm = await detectMonorepo(repo({ 'package.json': pkg('r', { workspaces: { packages: ['libs/*'] } }), 'libs/b/package.json': pkg('b') }));
    expect(npm?.packageManager).toBe('npm');
    expect(testCommandFor(npm!, npm!.packages[0])).toBe('npm test --workspace=b');
  });

  // [claims: capabilities/workspaces#monorepo-detection]
  it('detects Nx and Turbo and prefers their runners', async () => {
    const nx = await detectMonorepo(repo({ 'nx.json': '{}', 'package.json': pkg('r'), 'apps/shop/package.json': pkg('shop') }));
    expect(nx?.tools).toContain('nx');
    expect(testCommandFor(nx!, nx!.packages[0])).toBe('npx nx test shop');
    const turbo = await detectMonorepo(repo({ 'turbo.json': '{}', 'pnpm-lock.yaml': '', 'package.json': pkg('r', { workspaces: ['packages/*'] }), 'packages/c/package.json': pkg('c') }));
    expect(turbo?.tools).toEqual(expect.arrayContaining(['turbo']));
    expect(testCommandFor(turbo!, turbo!.packages[0])).toBe('npx turbo run test --filter=c');
  });

  // [claims: capabilities/workspaces#monorepo-detection]
  it('returns null for a single package', async () => {
    expect(await detectMonorepo(repo({ 'package.json': pkg('solo') }))).toBeNull();
  });
});

describe('detection beyond JavaScript [monorepo-ecosystems]', () => {
  // [claims: capabilities/workspaces#more-ecosystems]
  it('reads go.work, in block and single-line forms, with each module\'s name [go-work]', async () => {
    const dir = repo({
      'go.work': 'go 1.22\n\nuse (\n\t./services/api // the api\n\t./libs/shared\n)\nuse ./tools/cli\n',
      'services/api/go.mod': 'module example.com/acme/api\n\ngo 1.22\n',
      'libs/shared/go.mod': 'module example.com/acme/shared\n',
      'tools/cli/go.mod': 'module example.com/acme/cli\n',
    });
    const info = (await detectMonorepo(dir))!;
    expect(info.tools).toEqual(['go']);
    expect(info.packages.map((p) => [p.name, p.dir, p.ecosystem])).toEqual([
      ['example.com/acme/shared', 'libs/shared', 'go'],
      ['example.com/acme/api', 'services/api', 'go'],
      ['example.com/acme/cli', 'tools/cli', 'go'],
    ]);
    expect(testCommandFor(info, info.packages[0])).toBe('cd libs/shared && go test ./...');
  });

  // [claims: capabilities/workspaces#more-ecosystems]
  it('reads go.work when a comment follows a single-line use or holds a closing paren [go-work-comments]', async () => {
    const dir = repo({
      'go.work': 'go 1.22\nuse ./a // main svc\nuse (\n\t./b // the (main) one\n\t./c\n)\n',
      'a/go.mod': 'module ex/a\n',
      'b/go.mod': 'module ex/b\n',
      'c/go.mod': 'module ex/c\n',
    });
    const info = (await detectMonorepo(dir))!;
    expect(info.packages.map((p) => p.dir).sort()).toEqual(['a', 'b', 'c']);
  });

  // [claims: capabilities/workspaces#more-ecosystems]
  it('reads Cargo workspace members, globs and exclusions [cargo]', async () => {
    const dir = repo({
      'Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["crates/*", "tools/xtask"]\nexclude = ["crates/old"]\n',
      'crates/core/Cargo.toml': '[package]\nname = "acme-core"\nversion = "0.1.0"\n',
      'crates/old/Cargo.toml': '[package]\nname = "acme-old"\n',
      'tools/xtask/Cargo.toml': '[package]\nname = "xtask"\n',
    });
    const info = (await detectMonorepo(dir))!;
    expect(info.tools).toEqual(['cargo']);
    expect(info.packages.map((p) => p.name)).toEqual(['acme-core', 'xtask']);
    expect(testCommandFor(info, info.packages[0])).toBe('cargo test -p acme-core');
  });

  // [claims: capabilities/workspaces#more-ecosystems]
  it('reads uv workspace members [uv]', async () => {
    const dir = repo({
      'pyproject.toml': '[project]\nname = "root"\n\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      'packages/api/pyproject.toml': '[project]\nname = "acme-api"\nversion = "1"\n',
      'packages/models/pyproject.toml': '[project]\nname = "acme-models"\n',
    });
    const info = (await detectMonorepo(dir))!;
    expect(info.tools).toEqual(['uv']);
    expect(info.packages.map((p) => [p.name, p.framework])).toEqual([['acme-api', 'pytest'], ['acme-models', 'pytest']]);
    expect(testCommandFor(info, info.packages[0])).toBe('uv run --package acme-api pytest');
  });

  // [claims: capabilities/workspaces#more-ecosystems]
  it('a pyproject without a uv workspace is not a monorepo [no-uv]', async () => {
    expect(await detectMonorepo(repo({ 'pyproject.toml': '[project]\nname = "solo"\n' }))).toBeNull();
  });

  // [claims: capabilities/workspaces#more-ecosystems]
  it('lists the packages of every ecosystem in a polyglot repo [polyglot]', async () => {
    const dir = repo({
      'pnpm-workspace.yaml': "packages:\n  - 'web/*'\n",
      'package.json': pkg('root'),
      'web/app/package.json': pkg('@acme/app'),
      'go.work': 'use ./svc\n',
      'svc/go.mod': 'module example.com/svc\n',
    });
    const info = (await detectMonorepo(dir))!;
    expect(info.tools).toEqual(['pnpm', 'go']);
    expect(info.packages.map((p) => p.ecosystem).sort()).toEqual(['go', 'js']);
  });
});

describe('init in a workspace [monorepo-init]', () => {
  const files = {
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': pkg('root'),
    'packages/web/package.json': pkg('web', { devDependencies: { vitest: '1' } }),
    'packages/api/package.json': pkg('api', { devDependencies: { jest: '1' } }),
  };

  // [claims: capabilities/workspaces#more-ecosystems, capabilities/workspaces#per-package-test-command]
  it('writes one app over every package and a units manifest with each package\'s test command [one-config-units]', async () => {
    const dir = repo(files);
    await runInit({ cwd: dir, harness: 'claude' });
    const config = JSON.parse(readFileSync(path.join(dir, '.specguard/config.json'), 'utf8'));
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0]).toMatchObject({ name: 'app', repo: '.', specDir: 'specs' });
    expect(config.apps[0].sources.routes).toEqual(['packages/api/src/**/*.{ts,tsx,js,jsx}', 'packages/web/src/**/*.{ts,tsx,js,jsx}']);
    expect(config.apps[0].sources.tests).toEqual(['packages/api/tests/**/*.test.{ts,js}', 'packages/web/tests/**/*.test.{ts,js}']);

    const manifest = JSON.parse(readFileSync(path.join(dir, '.specguard/workspace.json'), 'utf8'));
    expect(manifest.repos).toEqual({});
    expect(manifest.units.web).toMatchObject({ path: 'packages/web', kind: 'package', packageName: 'web', ecosystem: 'js', test: { command: 'pnpm --filter web test', framework: 'vitest' } });
    expect(Object.keys(manifest.units)).toEqual(['api', 'web']);
  });

  // [claims: capabilities/workspaces#more-ecosystems]
  it('gives each ecosystem of a polyglot repo its own app, the primary language first [polyglot-apps]', async () => {
    const dir = repo({ ...files, 'go.work': 'use ./svc\n', 'svc/go.mod': 'module example.com/svc\n' });
    await runInit({ cwd: dir, harness: 'claude' });
    const config = JSON.parse(readFileSync(path.join(dir, '.specguard/config.json'), 'utf8'));
    expect(config.apps.map((a: { name: string; language: string }) => [a.name, a.language])).toEqual([['app', 'typescript'], ['app-go', 'go']]);
    // A negation keeps its `!` at the front.
    expect(config.apps[1].sources.routes).toEqual(['svc/**/*.go', '!svc/**/*_test.go']);
  });

  // [claims: capabilities/workspaces#per-package-test-command]
  it('--single keeps one app and writes no manifest [single]', async () => {
    const dir = repo(files);
    await runInit({ cwd: dir, harness: 'claude', single: true });
    const config = JSON.parse(readFileSync(path.join(dir, '.specguard/config.json'), 'utf8'));
    expect(config.apps).toHaveLength(1);
    expect(JSON.stringify(config.apps[0].sources)).not.toContain('packages/web');
    expect(() => readFileSync(path.join(dir, '.specguard/workspace.json'))).toThrow();
  });
});
