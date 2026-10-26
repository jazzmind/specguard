import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanRepos } from '../../src/cli/commands/workspace.js';
import { loadWorkspace } from '../../src/core/workspace.js';
import { readRepoInput } from '../../src/core/workspace-rollup.js';
import { guessRepoRole } from '../../src/core/workspace-heuristics.js';
import { syncFromCodeWorkspace, syncManifestOnDisk, type SyncProbe } from '../../src/core/workspace-sync.js';
import { makeNestedWorkspace, makeOverlayWorkspace } from '../helpers/overlay-fixture.js';

/** A probe that answers from tables: `configured` folders have their own config, `overlaid` ones are covered by an overlay. */
function probe(configured: string[], overlaid: string[]): SyncProbe {
  return {
    exists: () => true,
    real: (abs) => path.resolve(abs),
    hasConfig: (abs) => configured.some((c) => abs.endsWith(c)),
    overlay: (abs) => overlaid.some((c) => abs.endsWith(c)),
    role: () => 'consumer',
    now: () => '2026-10-26T00:00:00.000Z',
  };
}

const opts = (folders: { path: string }[], p: SyncProbe) => ({ manifestRoot: '/ws/m', codeWorkspaceFile: '/ws/s.code-workspace', folders, probe: p });

describe('workspace sync with overlays [workspaces]', () => {
  // [claims: capabilities/workspaces#workspace-sync-overlay]
  it('registers a folder with no config of its own but covered by an overlay as a normal repo, recording configVia', () => {
    const raw = { version: '2', name: 'x', repos: {}, source: { codeWorkspace: '../s.code-workspace', mode: 'auto', autoIgnoreUnconfigured: true } };
    const { next, changes } = syncFromCodeWorkspace(raw, opts([{ path: 'shop-api' }, { path: 'shop-web' }, { path: 'bare' }], probe(['shop-web'], ['shop-api'])));
    const repos = next.repos as Record<string, Record<string, unknown>>;
    expect(repos['shop-api']).toMatchObject({ origin: 'code-workspace', configVia: 'overlay' });
    expect(repos['shop-api']!.ignore).toBeUndefined();
    expect(repos['shop-web']!.configVia).toBeUndefined();
    expect(repos['shop-web']!.ignore).toBeUndefined();
    expect(repos.bare).toMatchObject({ ignore: true, ignoreReason: 'auto:no-config' });
    expect(changes.find((c) => c.key === 'shop-api')?.detail).toContain('overlay');
  });

  // [claims: capabilities/workspaces#workspace-sync-retire]
  it('retires an auto:no-config ignore when an overlay now covers the unit, and never touches a hand-made ignore', () => {
    const raw = {
      version: '2',
      name: 'x',
      repos: {
        'shop-api': { path: '../shop-api', role: 'consumer', origin: 'code-workspace', ignore: true, ignoreReason: 'auto:no-config', syncedValues: { path: '../shop-api', role: 'consumer' } },
        'shop-web': { path: '../shop-web', role: 'consumer', origin: 'code-workspace', ignore: true, ignoreReason: 'not a product', syncedValues: { path: '../shop-web', role: 'consumer' } },
        'shop-by-hand': { path: '../shop-by-hand', role: 'consumer', ignore: true, ignoreReason: 'auto:no-config' },
      },
      source: { codeWorkspace: '../s.code-workspace', mode: 'auto', autoIgnoreUnconfigured: true },
    };
    const folders = [{ path: 'shop-api' }, { path: 'shop-web' }, { path: 'shop-by-hand' }];
    const { next, changes } = syncFromCodeWorkspace(raw, { manifestRoot: '/ws/m', codeWorkspaceFile: '/ws/s.code-workspace', folders, probe: probe([], ['shop-api', 'shop-web', 'shop-by-hand']) });
    const repos = next.repos as Record<string, Record<string, unknown>>;
    expect(repos['shop-api']!.ignore).toBeUndefined();
    expect(repos['shop-api']!.ignoreReason).toBeUndefined();
    expect(repos['shop-api']!.configVia).toBe('overlay');
    expect(changes.some((c) => c.type === 'unignored' && c.key === 'shop-api' && c.detail.includes('overlay'))).toBe(true);
    // a person's ignore reason, and an entry the tool did not create, are left exactly as they were
    expect(repos['shop-web']).toMatchObject({ ignore: true, ignoreReason: 'not a product' });
    expect(repos['shop-by-hand']).toEqual(raw.repos['shop-by-hand']);
  });

  // [claims: capabilities/workspaces#workspace-sync-overlay]
  it('drops configVia when the overlay no longer covers the folder, and a second sync is a no-op', () => {
    const raw = { version: '2', name: 'x', repos: {}, source: { codeWorkspace: '../s.code-workspace', mode: 'auto', autoIgnoreUnconfigured: true } };
    const o = opts([{ path: 'shop-api' }], probe([], ['shop-api']));
    const first = syncFromCodeWorkspace(raw, o);
    expect(syncFromCodeWorkspace(first.next, o).changes).toEqual([]);
    const lost = syncFromCodeWorkspace(first.next, opts([{ path: 'shop-api' }], probe(['shop-api'], [])));
    expect((lost.next.repos as Record<string, Record<string, unknown>>)['shop-api']!.configVia).toBeUndefined();
  });
});

describe('workspace sync on disk with a real overlay [workspaces]', () => {
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  afterEach(() => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
  });

  // [claims: capabilities/workspaces#workspace-sync-overlay, capabilities/workspaces#workspace-sync-retire]
  it('an overlay registered after the first sync lifts the auto ignore on the next one; the manifest stays loadable', async () => {
    const ws = makeOverlayWorkspace({ registered: false });
    process.env.HOME = ws.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    writeFileSync(path.join(ws.base, 's.code-workspace'), JSON.stringify({ folders: [{ path: 'shop-api' }, { path: 'shop-web' }] }));
    const manifestRoot = path.join(ws.base, 'manifest');
    mkdirSync(path.join(manifestRoot, '.specguard'), { recursive: true });
    writeFileSync(path.join(manifestRoot, '.specguard/workspace.json'), JSON.stringify({ version: '2', name: 'x', repos: {}, source: { codeWorkspace: '../s.code-workspace', mode: 'auto', autoIgnoreUnconfigured: true } }));

    syncManifestOnDisk(manifestRoot);
    let manifest = await loadWorkspace(manifestRoot);
    expect(Object.keys(manifest.repos)).toEqual([]);
    expect(Object.keys(manifest.ignored).sort()).toEqual(['shop-api', 'shop-web']);

    const { registerOverlay } = await import('../helpers/overlay-fixture.js');
    registerOverlay(ws.specs, process.env);
    const second = syncManifestOnDisk(manifestRoot);
    expect(second.changes.filter((c) => c.type === 'unignored').map((c) => c.key).sort()).toEqual(['shop-api', 'shop-web']);
    manifest = await loadWorkspace(manifestRoot);
    expect(Object.keys(manifest.repos).sort()).toEqual(['shop-api', 'shop-web']);
    expect((manifest.repos['shop-api'] as { configVia?: string }).configVia).toBe('overlay');
    const onDisk = JSON.parse(readFileSync(path.join(manifestRoot, '.specguard/workspace.json'), 'utf8')) as { repos: Record<string, { configVia?: string }> };
    expect(onDisk.repos['shop-web']!.configVia).toBe('overlay');
  });

  // [claims: capabilities/workspaces#workspace-sync-overlay]
  it('workspace init scanning, the rollup and the role guess all see an overlay-covered repo as configured', () => {
    const ws = makeOverlayWorkspace();
    process.env.HOME = ws.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    mkdirSync(path.join(ws.api, '.git'), { recursive: true });
    mkdirSync(path.join(ws.web, '.git'), { recursive: true });
    expect(scanRepos(ws.base, 1).filter((r) => r.rel.startsWith('shop-')).map((r) => [r.rel, r.configured])).toEqual([['shop-api', true], ['shop-web', true]]);

    // the overlay's own trace is what the rollup reads for the repo
    mkdirSync(path.join(ws.apiApp, '.specguard'), { recursive: true });
    writeFileSync(path.join(ws.apiApp, '.specguard/proofs.json'), JSON.stringify({ proofs: { a: { ingestedAt: '2026-10-26T09:00:00.000Z' } } }));
    const input = readRepoInput({ key: 'shop-api', path: '../shop-api', role: 'consumer' }, ws.api);
    expect(input.configured).toBe(true);
    expect(input.ledgerNewest).toBe('2026-10-26T09:00:00.000Z');

    // the overlay config's framework decides the role: a Playwright suite is a test repo
    ws.write(path.join(ws.apiApp, '.specguard/config.json'), JSON.stringify({ apps: [{ name: 'api', repo: '../../../shop-api', specDir: 'specs', sources: {}, framework: 'playwright', testOutput: 'tests/' }] }));
    expect(guessRepoRole(ws.api)).toBe('test');
  });
});

describe('workspace sync with an entry for a nested app folder [workspaces]', () => {
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  afterEach(() => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
  });

  // [claims: capabilities/workspaces#workspace-sync-overlay, capabilities/platform-foundation#overlay-enclosing-git-root]
  it('treats the git root folder of a repo whose overlay entry names an app inside it as covered; a monorepo root with two apps is not', async () => {
    const ws = makeNestedWorkspace();
    process.env.HOME = ws.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    writeFileSync(path.join(ws.base, 's.code-workspace'), JSON.stringify({ folders: [{ path: 'shop-web' }, { path: 'shop-mono' }, { path: 'loose' }] }));
    const manifestRoot = path.join(ws.base, 'manifest');
    mkdirSync(path.join(manifestRoot, '.specguard'), { recursive: true });
    writeFileSync(path.join(manifestRoot, '.specguard/workspace.json'), JSON.stringify({ version: '2', name: 'x', repos: {}, source: { codeWorkspace: '../s.code-workspace', mode: 'auto', autoIgnoreUnconfigured: true } }));
    syncManifestOnDisk(manifestRoot);
    const manifest = await loadWorkspace(manifestRoot);
    expect(Object.keys(manifest.repos)).toEqual(['shop-web']);
    expect((manifest.repos['shop-web'] as { configVia?: string }).configVia).toBe('overlay');
    expect(Object.keys(manifest.ignored).sort()).toEqual(['loose', 'shop-mono']);
  });
});
