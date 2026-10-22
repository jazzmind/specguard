import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadWorkspace,
  manifestRootForCodeWorkspace,
  readCodeWorkspace,
  resolveWorkspaceRoot,
  workspaceHint,
} from '../../src/core/workspace.js';
import {
  setIgnoreOnDisk,
  syncFromCodeWorkspace,
  syncManifestOnDisk,
  type SyncProbe,
} from '../../src/core/workspace-sync.js';
import { scanRepos } from '../../src/cli/commands/workspace.js';

function tree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-sync-')));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const CFG = '{"apps":[]}';
const CWS_WITH_COMMENTS = `{
  // the sandbox repos
  "folders": [
    { "name": "hub", "path": "../hub" },
    { "path": "../apps/portal" }, /* no name */
    { "path": "../apps/new-thing" },
  ],
  "settings": {}
}`;

/** A probe that answers from a fixed table instead of the disk. */
function probe(configured: string[], missing: string[] = []): SyncProbe {
  return {
    exists: (abs) => !missing.some((m) => abs.endsWith(m)),
    real: (abs) => path.resolve(abs),
    hasConfig: (abs) => configured.some((c) => abs.endsWith(c)),
    role: () => 'consumer',
    now: () => '2026-10-22T00:00:00.000Z',
  };
}

const opts = (folders: { path: string; name?: string }[], p: SyncProbe) => ({
  manifestRoot: '/ws/.specguard-workspaces/sandbox',
  codeWorkspaceFile: '/ws/sandbox.code-workspace',
  folders,
  probe: p,
});

describe('ignore in the workspace manifest [workspace-ignore]', () => {
  // [claims: capabilities/workspaces#workspace-ignore]
  it('moves an ignored repo out of repos and units so every pipeline skips it', async () => {
    const dir = tree({
      '.specguard/workspace.json': JSON.stringify({
        version: '2',
        name: 'x',
        repos: { hub: { path: '../hub', role: 'consumer', ignore: true, ignoreReason: 'the hub is not a product' }, api: { path: '../api', role: 'provider' } },
        units: { web: { path: '../web', kind: 'repo', ignore: true } },
      }),
    });
    const m = await loadWorkspace(dir);
    expect(Object.keys(m.repos)).toEqual(['api']);
    expect(Object.keys(m.units)).toEqual(['api']);
    expect(Object.keys(m.ignored).sort()).toEqual(['hub', 'web']);
    expect(m.ignored.hub.ignoreReason).toBe('the hub is not a product');
  });

  // [claims: capabilities/workspaces#workspace-ignore]
  it('still rejects a key listed under both repos and units, ignored or not', async () => {
    const dir = tree({
      '.specguard/workspace.json': JSON.stringify({ version: '2', name: 'x', repos: { a: { path: 'a', role: 'consumer', ignore: true } }, units: { a: { path: 'a', kind: 'repo' } } }),
    });
    await expect(loadWorkspace(dir)).rejects.toThrow(/both repos and units/);
  });

  // [claims: capabilities/workspaces#workspace-ignore]
  it('ignore and unignore edit the manifest on disk without normalising it', () => {
    const dir = tree({
      '.specguard/workspace.json': JSON.stringify({ version: '2', name: 'x', note: 'keep me', repos: { hub: { path: '../hub', role: 'consumer' } } }),
    });
    setIgnoreOnDisk(dir, 'hub', true, 'not a product');
    const after = JSON.parse(readFileSync(path.join(dir, '.specguard/workspace.json'), 'utf-8'));
    expect(after).toMatchObject({ note: 'keep me', repos: { hub: { ignore: true, ignoreReason: 'not a product' } } });
    expect(after.units).toBeUndefined();
    setIgnoreOnDisk(dir, 'hub', false);
    expect(JSON.parse(readFileSync(path.join(dir, '.specguard/workspace.json'), 'utf-8')).repos.hub.ignore).toBeUndefined();
    expect(() => setIgnoreOnDisk(dir, 'nope', true)).toThrow(/no repo "nope"/);
  });
});

describe('finding a manifest from a .code-workspace [workspace-resolve]', () => {
  // [claims: capabilities/workspaces#workspace-resolve]
  it('reads JSONC: comments, trailing commas and unnamed folders', () => {
    const dir = tree({ 'sandbox.code-workspace': CWS_WITH_COMMENTS });
    const cws = readCodeWorkspace(path.join(dir, 'sandbox.code-workspace'));
    expect(cws.folders).toEqual([{ path: '../hub', name: 'hub' }, { path: '../apps/portal', name: undefined }, { path: '../apps/new-thing', name: undefined }]);
  });

  // [claims: capabilities/workspaces#workspace-resolve]
  it('gives each .code-workspace its own manifest folder unless a setting points elsewhere', () => {
    const dir = tree({
      'a.code-workspace': '{"folders":[]}',
      'b.code-workspace': '{"folders":[],"settings":{"specguard.workspaceManifest":"custom"}}',
    });
    expect(manifestRootForCodeWorkspace(path.join(dir, 'a.code-workspace'))).toBe(path.join(dir, '.specguard-workspaces', 'a'));
    expect(manifestRootForCodeWorkspace(path.join(dir, 'b.code-workspace'))).toBe(path.join(dir, 'custom'));
  });

  // [claims: capabilities/workspaces#workspace-resolve]
  it('accepts a workspace.json, its folder, the .specguard folder or a .code-workspace', async () => {
    const dir = tree({
      '.specguard-workspaces/sb/.specguard/workspace.json': JSON.stringify({ version: '2', name: 'sb', repos: {} }),
      'sb.code-workspace': '{"folders":[]}',
    });
    const root = path.join(dir, '.specguard-workspaces', 'sb');
    expect(resolveWorkspaceRoot(path.join(dir, 'sb.code-workspace'))).toBe(root);
    expect(resolveWorkspaceRoot(root)).toBe(root);
    expect(resolveWorkspaceRoot(path.join(root, '.specguard'))).toBe(root);
    expect(resolveWorkspaceRoot(path.join(root, '.specguard', 'workspace.json'))).toBe(root);
    expect(resolveWorkspaceRoot(path.join(dir, 'missing'))).toBeNull();
    expect((await loadWorkspace('/', path.join(dir, 'sb.code-workspace'))).name).toBe('sb');
  });

  // [claims: capabilities/workspaces#workspace-resolve]
  it('uses the flag, then SPECGUARD_WORKSPACE, and nothing when neither is set', () => {
    const before = process.env.SPECGUARD_WORKSPACE;
    try {
      delete process.env.SPECGUARD_WORKSPACE;
      expect(workspaceHint()).toBeUndefined();
      process.env.SPECGUARD_WORKSPACE = '/from/env';
      expect(workspaceHint()).toBe('/from/env');
      expect(workspaceHint('/from/flag')).toBe('/from/flag');
    } finally {
      if (before === undefined) delete process.env.SPECGUARD_WORKSPACE;
      else process.env.SPECGUARD_WORKSPACE = before;
    }
  });
});

describe('syncing the manifest with a .code-workspace [workspace-sync]', () => {
  const folders = [{ path: '../hub', name: 'hub' }, { path: '../apps/portal' }, { path: '../apps/new-thing' }];

  // [claims: capabilities/workspaces#workspace-sync]
  it('adds each folder, ignoring the ones with no SpecGuard config', () => {
    const { next, changes } = syncFromCodeWorkspace({ version: '1.0', name: 'sb', repos: {} }, opts(folders, probe(['hub', 'portal'])));
    const repos = next.repos as Record<string, Record<string, unknown>>;
    expect(Object.keys(repos)).toEqual(['hub', 'portal', 'new-thing']);
    expect(repos.hub).toMatchObject({ path: '../../../hub', origin: 'code-workspace', folderName: 'hub' });
    expect(repos['new-thing']).toMatchObject({ ignore: true, ignoreReason: 'auto:no-config' });
    expect(repos.portal.ignore).toBeUndefined();
    expect(changes.map((c) => c.type)).toEqual(['added', 'added', 'added']);
    expect(next.source).toMatchObject({ codeWorkspace: '../../sandbox.code-workspace', mode: 'auto', syncedAt: '2026-10-22T00:00:00.000Z' });
  });

  // [claims: capabilities/workspaces#workspace-sync]
  it('is a no-op the second time', () => {
    const p = probe(['hub', 'portal', 'new-thing']);
    const first = syncFromCodeWorkspace({ version: '1.0', name: 'sb', repos: {} }, opts(folders, p));
    const second = syncFromCodeWorkspace(first.next, opts(folders, p));
    expect(second.changes).toEqual([]);
    expect(second.next).toEqual(first.next);
  });

  // [claims: capabilities/workspaces#workspace-sync]
  it('lifts an automatic ignore once the repo gets a config, but never a hand ignore', () => {
    const first = syncFromCodeWorkspace({ version: '1.0', name: 'sb', repos: {} }, opts(folders, probe(['hub', 'portal'])));
    const handIgnored = JSON.parse(JSON.stringify(first.next));
    handIgnored.repos.hub.ignore = true;
    handIgnored.repos.hub.ignoreReason = 'ignored by hand';
    const second = syncFromCodeWorkspace(handIgnored, opts(folders, probe(['hub', 'portal', 'new-thing'])));
    expect(second.changes).toEqual([{ type: 'unignored', key: 'new-thing', detail: 'a SpecGuard config appeared' }]);
    const repos = second.next.repos as Record<string, Record<string, unknown>>;
    expect(repos.hub.ignore).toBe(true);
    expect(repos['new-thing'].ignore).toBeUndefined();
  });

  // [claims: capabilities/workspaces#workspace-sync]
  it('never overwrites a hand edit, and never touches entries it did not create', () => {
    const raw = {
      version: '1.0',
      name: 'sb',
      repos: {
        mine: { path: '../../../hub', role: 'provider', description: 'by hand' },
        portal: { path: '../../../apps/portal', role: 'test', origin: 'code-workspace', syncedValues: { path: '../../../apps/portal', role: 'consumer' } },
      },
    };
    const { next, changes } = syncFromCodeWorkspace(raw, opts(folders, probe(['hub', 'portal', 'new-thing'])));
    const repos = next.repos as Record<string, Record<string, unknown>>;
    expect(repos.mine).toEqual(raw.repos.mine); // the hand-made entry already covers hub: no duplicate "hub"
    expect(repos.portal.role).toBe('test'); // role was edited by hand, so it stays
    expect(Object.keys(repos)).toEqual(['mine', 'portal', 'new-thing']);
    expect(changes.map((c) => `${c.type}:${c.key}`)).toEqual(['added:new-thing']);
  });

  // [claims: capabilities/workspaces#workspace-sync]
  it('removes a folder that was dropped if untouched, else ignores it', () => {
    const synced = syncFromCodeWorkspace({ version: '1.0', name: 'sb', repos: {} }, opts(folders, probe(['hub', 'portal', 'new-thing']))).next;
    const edited = JSON.parse(JSON.stringify(synced));
    edited.repos.portal.description = 'hand-written';
    edited.repos.portal.role = 'provider'; // differs from syncedValues
    const dropped = folders.filter((f) => f.path === '../hub');
    const { next, changes } = syncFromCodeWorkspace(edited, opts(dropped, probe(['hub'])));
    const repos = next.repos as Record<string, Record<string, unknown>>;
    expect(repos.portal).toMatchObject({ ignore: true, ignoreReason: 'auto:removed' });
    expect(repos['new-thing']).toBeUndefined();
    expect(changes.map((c) => `${c.type}:${c.key}`).sort()).toEqual(['ignored:portal', 'removed:new-thing']);
  });

  // [claims: capabilities/workspaces#workspace-sync]
  it('reports a folder missing on disk and does not add it; a repeat is not a removal', () => {
    const p = probe(['hub'], ['portal']);
    const { next, changes } = syncFromCodeWorkspace({ version: '1.0', name: 'sb', repos: {} }, opts(folders.slice(0, 2), p));
    expect(Object.keys(next.repos as object)).toEqual(['hub']);
    expect(changes.map((c) => c.type).sort()).toEqual(['added', 'missing']);
  });

  // [claims: capabilities/workspaces#workspace-sync]
  it('keeps two folders with the same name apart', () => {
    const dups = [{ path: '../apps/portal' }, { path: '../archive/portal' }];
    const { next } = syncFromCodeWorkspace({ version: '1.0', name: 'sb', repos: {} }, opts(dups, probe(['portal'])));
    expect(Object.keys(next.repos as object)).toEqual(['portal', 'archive-portal']);
  });

  // [claims: capabilities/workspaces#workspace-sync]
  it('syncs a real manifest on disk from a JSONC .code-workspace and leaves package units alone', async () => {
    const dir = tree({
      'sandbox.code-workspace': CWS_WITH_COMMENTS,
      'hub/.specguard/config.json': CFG,
      'apps/portal/.specguard/config.json': CFG,
      'apps/new-thing/readme.md': '',
    });
    const cws = path.join(dir, 'ws', 'sandbox.code-workspace');
    mkdirSync(path.dirname(cws), { recursive: true });
    writeFileSync(cws, CWS_WITH_COMMENTS);
    const root = manifestRootForCodeWorkspace(cws);
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    writeFileSync(path.join(root, '.specguard/workspace.json'), JSON.stringify({ version: '1.0', name: 'sb', repos: {}, units: { shared: { path: 'packages/shared', kind: 'package' } } }));
    const result = syncManifestOnDisk(root, cws);
    expect(result.changes.filter((c) => c.type === 'added').map((c) => c.key)).toEqual(['hub', 'portal', 'new-thing']);
    const m = await loadWorkspace('/', cws);
    expect(Object.keys(m.repos)).toEqual(['hub', 'portal']); // new-thing has no config, so it is ignored
    expect(Object.keys(m.ignored)).toEqual(['new-thing']);
    expect(m.units.shared.kind).toBe('package');
  });
});

describe('scanning a folder tree for repos [workspace-scan]', () => {
  // [claims: capabilities/workspaces#workspace-sync]
  it('finds nested repos, stops at a repo, and skips hidden folders and node_modules', () => {
    const dir = tree({
      'apps/a/.specguard/config.json': CFG,
      'apps/a/nested/.specguard/config.json': CFG,
      'utilities/b/.git/HEAD': '',
      'utilities/c/.specguard/config.json': CFG,
      '.hidden/x/.specguard/config.json': CFG,
      'node_modules/y/.specguard/config.json': CFG,
      'deep/1/2/3/4/.specguard/config.json': CFG,
    });
    expect(scanRepos(dir, 3)).toEqual([
      { rel: 'apps/a', configured: true },
      { rel: 'utilities/b', configured: false },
      { rel: 'utilities/c', configured: true },
    ]);
    expect(scanRepos(dir, 1)).toEqual([]);
  });
});
