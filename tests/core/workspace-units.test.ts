import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadWorkspace, unitOfFile } from '../../src/core/workspace.js';
import { affectedUnits, unitDependencies, unitsToTest } from '../../src/core/workspace-units.js';

function workspace(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-ws-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const manifest = (extra: Record<string, unknown>) => JSON.stringify({ version: '2', name: 'acme', ...extra });

describe('units manifest [workspace-units]', () => {
  // [claims: capabilities/workspaces#units]
  it('loads a legacy repos-only manifest as units of kind repo [legacy-repos]', async () => {
    const dir = workspace({ '.specguard/workspace.json': manifest({ repos: { api: { path: '../api', role: 'provider' }, web: { path: 'web', role: 'consumer', description: 'ui' } } }) });
    const m = await loadWorkspace(dir);
    expect(Object.keys(m.units)).toEqual(['api', 'web']);
    expect(m.units.api).toMatchObject({ kind: 'repo', role: 'provider', path: '../api' });
    expect(m.repos.web.description).toBe('ui');
  });

  // [claims: capabilities/workspaces#units]
  it('loads a units-only manifest, and a repo-kind unit also appears under repos [units-only]', async () => {
    const dir = workspace({
      '.specguard/workspace.json': manifest({
        units: { shared: { path: 'packages/shared', packageName: '@acme/shared', ecosystem: 'js' }, docs: { path: '../docs', kind: 'repo', role: 'docs' } },
      }),
    });
    const m = await loadWorkspace(dir);
    expect(m.units.shared).toMatchObject({ kind: 'package', role: 'package', packageName: '@acme/shared' });
    expect(m.repos).toEqual({ docs: { path: '../docs', role: 'docs', description: undefined } });
    expect(Object.keys(m.repos)).not.toContain('shared');
  });

  // [claims: capabilities/workspaces#units]
  it('rejects a key listed as both a repo and a unit [duplicate-key]', async () => {
    const dir = workspace({ '.specguard/workspace.json': manifest({ repos: { x: { path: 'x', role: 'consumer' } }, units: { x: { path: 'y' } } }) });
    await expect(loadWorkspace(dir)).rejects.toThrow(/both repos and units/);
  });

  // [claims: capabilities/workspaces#units]
  it('finds the owning unit by the deepest matching path [unit-of-file]', () => {
    const units = { app: { path: 'apps/web', kind: 'package', role: 'package' }, nested: { path: 'apps/web/embedded', kind: 'package', role: 'package' }, root: { path: '.', kind: 'package', role: 'package' } } as never;
    expect(unitOfFile({ units }, 'apps/web/src/a.ts')).toBe('app');
    expect(unitOfFile({ units }, 'apps/web/embedded/x.ts')).toBe('nested');
    expect(unitOfFile({ units }, 'apps/web')).toBe('app');
    expect(unitOfFile({ units }, 'apps/website/a.ts')).toBeUndefined();
    expect(unitOfFile({ units }, 'README.md')).toBeUndefined();
  });
});

describe('dependencies between units [unit-deps]', () => {
  // [claims: capabilities/workspaces#package-edges]
  it('reads JS, Go, Cargo and Python manifests and ignores external packages [deps-by-ecosystem]', async () => {
    const dir = workspace({
      '.specguard/workspace.json': manifest({
        units: {
          web: { path: 'web', packageName: '@acme/web', ecosystem: 'js' },
          ui: { path: 'ui', packageName: '@acme/ui', ecosystem: 'js' },
          api: { path: 'api', packageName: 'example.com/acme/api', ecosystem: 'go' },
          core: { path: 'core', packageName: 'example.com/acme/core', ecosystem: 'go' },
          cli: { path: 'cli', packageName: 'acme-cli', ecosystem: 'rust' },
          engine: { path: 'engine', packageName: 'acme-engine', ecosystem: 'rust' },
          svc: { path: 'svc', packageName: 'acme-svc', ecosystem: 'python' },
          models: { path: 'models', packageName: 'acme_models', ecosystem: 'python' },
        },
      }),
      'web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/ui': 'workspace:*', react: '18' }, devDependencies: { '@acme/web': '1' } }),
      'ui/package.json': JSON.stringify({ name: '@acme/ui', peerDependencies: { react: '18' } }),
      'api/go.mod': 'module example.com/acme/api\n\nrequire (\n\texample.com/acme/core v0.0.0\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n',
      'core/go.mod': 'module example.com/acme/core\n',
      'cli/Cargo.toml': '[package]\nname = "acme-cli"\n\n[dependencies]\nacme-engine = { path = "../engine" }\nserde = "1"\n\n[dev-dependencies]\ntempfile = "3"\n',
      'engine/Cargo.toml': '[package]\nname = "acme-engine"\n',
      'svc/pyproject.toml': '[project]\nname = "acme-svc"\ndependencies = [\n  "acme-models>=1.0",\n  "requests",\n]\n',
      'models/pyproject.toml': '[project]\nname = "acme_models"\n',
    });
    const deps = unitDependencies(await loadWorkspace(dir)).map((d) => `${d.from}->${d.to}`);
    expect(deps).toEqual(['api->core', 'cli->engine', 'svc->models', 'web->ui']);
  });

  // [claims: capabilities/workspaces#package-edges]
  it('reads Python dependencies that carry extras, and Go modules without a dot in their path [extras-and-dotless]', async () => {
    const dir = workspace({
      '.specguard/workspace.json': manifest({
        units: {
          api: { path: 'api', packageName: 'acme-api', ecosystem: 'python' },
          core: { path: 'core', packageName: 'core', ecosystem: 'python' },
          gw: { path: 'gw', packageName: 'myapp/gw', ecosystem: 'go' },
          lib: { path: 'lib', packageName: 'myapp/lib', ecosystem: 'go' },
        },
      }),
      'api/pyproject.toml': '[project]\nname = "acme-api"\ndependencies = ["httpx[http2]>=0.2", "core"]\n\n[tool.x]\nlist = ["other"]\n',
      'core/pyproject.toml': '[project]\nname = "core"\n',
      'gw/go.mod': 'module myapp/gw\n\nrequire myapp/lib v0.0.0\n',
      'lib/go.mod': 'module myapp/lib\n',
    });
    expect(unitDependencies(await loadWorkspace(dir)).map((d) => `${d.from}->${d.to}`)).toEqual(['api->core', 'gw->lib']);
  });

  // [claims: capabilities/workspaces#package-edges]
  it('records where the dependency is declared and never makes a unit depend on itself [declared-in]', async () => {
    const dir = workspace({
      '.specguard/workspace.json': manifest({ units: { a: { path: 'pkgs/a', packageName: 'a', ecosystem: 'js' }, b: { path: 'pkgs/b', packageName: 'b', ecosystem: 'js' } } }),
      'pkgs/a/package.json': JSON.stringify({ name: 'a', dependencies: { a: '1', b: '1' } }),
      'pkgs/b/package.json': JSON.stringify({ name: 'b' }),
    });
    expect(unitDependencies(await loadWorkspace(dir))).toEqual([{ from: 'a', to: 'b', declaredIn: 'pkgs/a/package.json' }]);
  });
});

describe('affected units [unit-affected]', () => {
  const units = { web: { path: 'apps/web' }, ui: { path: 'packages/ui' }, api: { path: 'apps/api' } } as never;

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('maps changed files to units and reports files outside every unit [files-to-units]', () => {
    expect(affectedUnits({ units }, ['packages/ui/button.ts', 'apps/web/page.ts', 'apps/web/x.ts', 'package.json'])).toEqual({ units: ['ui', 'web'], outside: ['package.json'] });
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('adds every unit that depends on a changed one, transitively [dependents]', () => {
    const deps = [
      { from: 'web', to: 'ui', declaredIn: '' },
      { from: 'api', to: 'ui', declaredIn: '' },
      { from: 'e2e', to: 'web', declaredIn: '' },
    ];
    expect(unitsToTest(deps, ['ui'])).toEqual(['api', 'e2e', 'ui', 'web']);
    expect(unitsToTest(deps, ['web'])).toEqual(['e2e', 'web']);
    expect(unitsToTest(deps, ['api'])).toEqual(['api']);
  });
});
