import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { augmentCoverageFromDisk } from './dashboard/coverage-parse.js';
import {
  cachedProjectConfig,
  clearProjectConfigCache,
  configDirFor,
  configFileFor,
  describeProjectConfig,
  detectProjectConfig,
  overlayMayApply,
  overlayRegistryPath,
  parseResolveOutput,
  resolveProjectConfig,
  setConfigRunner,
  type CliRunner,
} from './project-config.js';

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-ext-')));
const withConfig = (dir: string): string => {
  mkdirSync(path.join(dir, '.specguard'), { recursive: true });
  writeFileSync(path.join(dir, '.specguard', 'config.json'), '{}');
  return dir;
};

const resolved = {
  dir: '/work/shop-api',
  configured: true,
  via: 'overlay',
  configDir: '/work/shop-specs/apps/api',
  config: '/work/shop-specs/apps/api/.specguard/config.json',
  overlayRoot: '/work/shop-specs',
  repo: '/work/shop-api',
  app: 'api',
  warnings: [],
};
const answering = (body: unknown, code = 0): CliRunner => vi.fn(async () => ({ stdout: `${JSON.stringify(body)}\n`, code }));
const registered = { env: { HOME: '/nobody' } as NodeJS.ProcessEnv, exists: (f: string) => f.endsWith('overlays.json') };

afterEach(() => {
  clearProjectConfigCache();
  setConfigRunner(undefined);
});

describe('overlay-aware folder detection [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('a folder with its own config is configured without starting the CLI', async () => {
    const dir = withConfig(tmp());
    const run = answering(resolved);
    expect(await resolveProjectConfig(dir, { run })).toEqual({ configured: true, via: 'repo', configDir: dir, configFile: path.join(dir, '.specguard', 'config.json') });
    expect(run).not.toHaveBeenCalled();
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('a folder without one asks `overlay resolve <folder> --json` and takes the overlay answer', async () => {
    const dir = tmp();
    const run = answering(resolved);
    const info = await resolveProjectConfig(dir, { run, ...registered });
    expect(run).toHaveBeenCalledWith(['overlay', 'resolve', dir, '--json'], dir);
    expect(info).toEqual({ configured: true, via: 'overlay', configDir: resolved.configDir, configFile: resolved.config, overlayRoot: resolved.overlayRoot, app: 'api' });
    expect(describeProjectConfig(info)).toBe('specs in overlay /work/shop-specs (app api)');
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('is not configured when the CLI says so (exit 1 with JSON), prints nothing usable, or cannot run', async () => {
    const dir = tmp();
    const no = await resolveProjectConfig(dir, { run: answering({ dir, configured: false, reason: 'no overlay names it', warnings: [] }, 1), ...registered });
    expect(no).toEqual({ configured: false, via: 'none', reason: 'no overlay names it' });
    expect((await resolveProjectConfig(dir, { run: vi.fn(async () => ({ stdout: 'garbage', code: 0 })), ...registered })).configured).toBe(false);
    expect((await resolveProjectConfig(dir, { run: vi.fn(async () => { throw new Error('ENOENT'); }), ...registered })).configured).toBe(false);
    expect((await resolveProjectConfig(dir, { ...registered })).configured).toBe(false);
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('does not start the CLI for a plain unconfigured folder: only when a registry file or SPECGUARD_OVERLAY / SPECGUARD_CONFIG exists', async () => {
    const dir = tmp();
    const run = answering(resolved);
    expect(await resolveProjectConfig(dir, { run, env: { HOME: dir }, exists: () => false })).toEqual({ configured: false, via: 'none' });
    expect(run).not.toHaveBeenCalled();
    expect(overlayMayApply({ env: { HOME: dir, SPECGUARD_OVERLAY: '/x' }, exists: () => false })).toBe(true);
    expect(overlayMayApply({ env: { HOME: dir, SPECGUARD_CONFIG: '/x' }, exists: () => false })).toBe(true);
    expect(overlayRegistryPath({ HOME: '/h' })).toBe(path.join('/h', '.config', 'specguard', 'overlays.json'));
    expect(overlayRegistryPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' })).toBe(path.join('/x', 'specguard', 'overlays.json'));
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('parses the JSON line even when other output comes first', () => {
    expect(parseResolveOutput(`note\n${JSON.stringify(resolved)}\n`)?.app).toBe('api');
    expect(parseResolveOutput('{"configured":"yes"}')).toBeNull();
    expect(parseResolveOutput('')).toBeNull();
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('detect remembers the answer for the synchronous readers: configured, and where the config and specs are', async () => {
    const dir = tmp();
    expect(cachedProjectConfig(dir).configured).toBe(false);
    setConfigRunner(answering(resolved));
    await detectProjectConfig(dir, registered);
    expect(cachedProjectConfig(dir).configured).toBe(true);
    expect(configDirFor(dir)).toBe(resolved.configDir);
    expect(configFileFor(dir)).toBe(resolved.config);
  });

  // [claims: capabilities/integration-surfaces#overlay-clients]
  it('without a recorded answer the readers behave exactly as before: the folder itself and its own config path', () => {
    const dir = tmp();
    expect(configDirFor(dir)).toBe(dir);
    expect(configFileFor(dir)).toBe(path.join(dir, '.specguard', 'config.json'));
    withConfig(dir);
    expect(cachedProjectConfig(dir)).toMatchObject({ configured: true, via: 'repo' });
  });
});

describe('reading specs from the folder that holds the config [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#overlay-clients]
  it("augmentCoverageFromDisk counts the overlay's specs: specDir is relative to the config folder, not the repo", () => {
    const base = tmp();
    const app = path.join(base, 'shop-specs', 'apps', 'api');
    const repo = path.join(base, 'shop-api');
    mkdirSync(path.join(app, 'specs'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(app, 'specs', 'cart.md'), '# Cart\n');
    withConfig(app);
    writeFileSync(path.join(app, '.specguard', 'config.json'), JSON.stringify({ apps: [{ name: 'api', specDir: 'specs', testOutput: 'tests/' }] }));
    const empty = () => [{ name: 'api', specCount: 0, sourceCount: 0, testCount: 0, percentage: 0, items: [] }];

    const fromRepo = empty();
    augmentCoverageFromDisk(fromRepo, repo);
    expect(fromRepo[0]!.specCount).toBe(0);

    const fromOverlay = empty();
    augmentCoverageFromDisk(fromOverlay, repo, app);
    expect(fromOverlay[0]!.specCount).toBe(1);
    expect(fromOverlay[0]!.items[0]).toMatchObject({ key: 'cart', hasSpec: true });
  });
});
