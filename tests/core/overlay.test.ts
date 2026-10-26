import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConfigAmbiguousError, ConfigInvalidError } from '../../src/core/errors.js';
import {
  CONFIG_ENV,
  OVERLAY_ENV,
  configDirFromPath,
  describeResolution,
  enclosingGitRoot,
  distinctConfigs,
  dropOverlay,
  matchOverlayEntries,
  overlayCoverage,
  overlayRegistryFile,
  parseOverlayRoots,
  readOverlayRegistry,
  resolveConfigDir,
  resolveConfigDirDetailed,
  scanOverlay,
  upsertOverlay,
  writeOverlayRegistry,
  type OverlayRegistry,
} from '../../src/core/overlay.js';
import { appConfig, makeNestedWorkspace, makeOverlayWorkspace, registerOverlay } from '../helpers/overlay-fixture.js';

describe('scanning an overlay [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#overlay-scan]
  it('finds one entry per app config and resolves apps[].repo against the folder that holds .specguard', () => {
    const ws = makeOverlayWorkspace();
    const scan = scanOverlay(ws.specs);
    expect(scan.root).toBe(ws.specs);
    expect(scan.entries.map((e) => [e.app, e.repo, path.relative(ws.specs, e.config)])).toEqual([
      ['api', ws.api, path.join('apps', 'api', '.specguard', 'config.json')],
      ['web', ws.web, path.join('apps', 'web', '.specguard', 'config.json')],
    ]);
    expect(scan.skipped).toEqual([]);
  });

  // [claims: capabilities/platform-foundation#overlay-scan]
  it('reports what it skips and why: a repo that does not exist, bad JSON, no apps, and an in-repo root config', () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.specs, 'apps/ghost/.specguard/config.json'), JSON.stringify(appConfig('ghost', '../../../shop-ghost')));
    ws.write(path.join(ws.specs, 'apps/broken/.specguard/config.json'), '{ nope');
    ws.write(path.join(ws.specs, 'apps/empty/.specguard/config.json'), '{"apps":[]}');
    ws.write(path.join(ws.specs, '.specguard/config.json'), JSON.stringify(appConfig('specs-itself', '.')));
    const scan = scanOverlay(ws.specs);
    expect(scan.entries.map((e) => e.app)).toEqual(['api', 'web']);
    const reasons = Object.fromEntries(scan.skipped.map((s) => [path.relative(ws.specs, s.config).split(path.sep)[1] === '.specguard' ? 'root' : path.relative(ws.specs, s.config).split(path.sep)[1]!, s.reason]));
    expect(reasons.ghost).toContain('does not exist');
    expect(reasons.broken).toContain('not valid JSON');
    expect(reasons.empty).toContain('no apps');
    expect(scan.skipped.some((s) => s.reason.includes('in-repo config'))).toBe(true);
  });

  // [claims: capabilities/platform-foundation#overlay-scan]
  it('does not look inside node_modules, .git, dist or deeper than four levels', () => {
    const ws = makeOverlayWorkspace();
    const put = (rel: string, app: string): void => {
      const holder = path.join(ws.specs, rel);
      ws.write(path.join(holder, '.specguard/config.json'), JSON.stringify(appConfig(app, path.relative(holder, ws.api))));
    };
    put('node_modules/pkg', 'in-node-modules');
    put('dist/a', 'in-dist');
    put('a/b/c/d/e', 'too-deep');
    put('a/b/c/d', 'deep');
    const scan = scanOverlay(ws.specs);
    expect(scan.entries.map((e) => e.app).sort()).toEqual(['api', 'deep', 'web']);
  });

  // [claims: capabilities/platform-foundation#overlay-scan]
  it('follows extends when the overlay config takes its apps from a base config', () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.specs, 'base/.specguard/config.json'), JSON.stringify(appConfig('shared', '../../../shop-web')));
    ws.write(path.join(ws.specs, 'apps/child/.specguard/config.json'), JSON.stringify({ extends: '../../base' }));
    const child = scanOverlay(ws.specs).entries.filter((e) => e.config.includes(`${path.sep}child${path.sep}`));
    expect(child.map((e) => [e.app, e.repo])).toEqual([['shared', ws.web]]);
  });
});

describe('the overlay registry [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#overlay-registry]
  it('lives in $XDG_CONFIG_HOME/specguard/overlays.json, else ~/.config/specguard/overlays.json, and none without a home', () => {
    expect(overlayRegistryFile({ HOME: '/h', XDG_CONFIG_HOME: '/x' })).toBe(path.join('/x', 'specguard', 'overlays.json'));
    expect(overlayRegistryFile({ HOME: '/h' })).toBe(path.join('/h', '.config', 'specguard', 'overlays.json'));
    expect(overlayRegistryFile({})).toBeUndefined();
  });

  // [claims: capabilities/platform-foundation#overlay-registry]
  it('round-trips, is written with mode 600 in a 700 folder, and leaves no temp file behind', () => {
    const ws = makeOverlayWorkspace({ registered: false });
    const registry = upsertOverlay({ version: 1, overlays: [] }, { root: ws.specs, addedAt: '2026-10-26T00:00:00.000Z', entries: scanOverlay(ws.specs).entries });
    const file = writeOverlayRegistry(registry, ws.env);
    expect(file).toBe(path.join(ws.env.HOME!, '.config', 'specguard', 'overlays.json'));
    expect(readOverlayRegistry(ws.env).registry).toEqual(registry);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(file))).toEqual(['overlays.json']);
    const shape = JSON.parse(readFileSync(file, 'utf8')) as OverlayRegistry;
    expect(shape.version).toBe(1);
    expect(Object.keys(shape.overlays[0]!).sort()).toEqual(['addedAt', 'entries', 'root']);
    expect(Object.keys(shape.overlays[0]!.entries[0]!).sort()).toEqual(['app', 'config', 'repo']);
  });

  // [claims: capabilities/platform-foundation#overlay-registry]
  it('is isolated by the env it is given: HOME and XDG_CONFIG_HOME pick the file, and the real home is never touched', () => {
    const ws = makeOverlayWorkspace({ registered: false });
    const xdg = path.join(ws.base, 'xdg');
    const file = writeOverlayRegistry({ version: 1, overlays: [] }, { HOME: ws.env.HOME, XDG_CONFIG_HOME: xdg });
    expect(file).toBe(path.join(xdg, 'specguard', 'overlays.json'));
    expect(existsSync(path.join(ws.env.HOME!, '.config'))).toBe(false);
    expect(() => writeOverlayRegistry({ version: 1, overlays: [] }, {})).toThrow(/HOME/);
    expect(readOverlayRegistry({}).registry.overlays).toEqual([]);
  });

  // [claims: capabilities/platform-foundation#overlay-registry]
  it('reads a missing, corrupt or foreign file as empty and says why; it never throws', () => {
    const ws = makeOverlayWorkspace({ registered: false });
    expect(readOverlayRegistry(ws.env)).toMatchObject({ registry: { overlays: [] } });
    const file = path.join(ws.env.HOME!, '.config', 'specguard', 'overlays.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ truncated');
    expect(readOverlayRegistry(ws.env).problem).toContain('could not be read');
    writeFileSync(file, JSON.stringify({ version: 2, overlays: [] }));
    expect(readOverlayRegistry(ws.env).problem).toContain('not an overlay registry');
  });

  // [claims: capabilities/platform-foundation#overlay-registry]
  it('upsert replaces the overlay of the same root and drop removes it, both pure', () => {
    const rec = (root: string, n: number) => ({ root, addedAt: 'x', entries: Array.from({ length: n }, (_, i) => ({ repo: `/r${i}`, config: `/c${i}`, app: `a${i}` })) });
    const one = upsertOverlay({ version: 1, overlays: [] }, rec('/o', 1));
    const two = upsertOverlay(one, rec('/o', 2));
    expect(two.overlays).toHaveLength(1);
    expect(two.overlays[0]!.entries).toHaveLength(2);
    expect(one.overlays[0]!.entries).toHaveLength(1);
    expect(dropOverlay(two, '/o')).toEqual({ registry: { version: 1, overlays: [] }, removed: true });
    expect(dropOverlay(two, '/nope').removed).toBe(false);
  });
});

describe('matching a directory to an overlay entry [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#overlay-deepest-match]
  it('picks the entry whose repo is the deepest ancestor-or-equal of the start directory', () => {
    const ws = makeOverlayWorkspace();
    const inner = path.join(ws.api, 'packages', 'core');
    mkdirSync(path.join(inner, 'src'), { recursive: true });
    const entries = [
      { repo: ws.api, config: '/o/api.json', app: 'api' },
      { repo: inner, config: '/o/core.json', app: 'core' },
    ];
    expect(matchOverlayEntries(path.join(inner, 'src'), entries)?.hits[0]?.app).toBe('core');
    expect(matchOverlayEntries(inner, entries)?.hits[0]?.app).toBe('core');
    expect(matchOverlayEntries(path.join(ws.api, 'src'), entries)?.hits[0]?.app).toBe('api');
    expect(matchOverlayEntries(ws.web, entries)).toBeNull();
    expect(matchOverlayEntries(ws.api, [])).toBeNull();
  });

  // [claims: capabilities/platform-foundation#overlay-deepest-match]
  it('compares real paths, so a symlinked spelling of the repo matches', () => {
    const ws = makeOverlayWorkspace();
    const link = path.join(ws.base, 'link-to-api');
    symlinkSync(ws.api, link);
    const hit = matchOverlayEntries(path.join(link, 'src'), [{ repo: ws.api, config: '/o/api.json', app: 'api' }]);
    expect(hit?.hits[0]?.app).toBe('api');
    // the match is reported in the spelling of the start directory
    expect(hit?.dir).toBe(link);
  });

  // [claims: capabilities/platform-foundation#overlay-deepest-match]
  it('does not reach a repo across a git boundary: a nested repo without a config is not part of an outer one', () => {
    const ws = makeOverlayWorkspace();
    const nested = path.join(ws.api, 'vendor', 'lib');
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(matchOverlayEntries(nested, [{ repo: ws.api, config: '/o/api.json', app: 'api' }])).toBeNull();
  });

  // [claims: capabilities/platform-foundation#overlay-ambiguity]
  it('counts one config that names a repo through several apps once, and two different configs as two', () => {
    const a = { repo: '/r', config: '/c1', app: 'one' };
    expect(distinctConfigs([a, { ...a, app: 'two' }])).toHaveLength(1);
    expect(distinctConfigs([a, { ...a, config: '/c2' }])).toHaveLength(2);
  });
});

describe('resolveConfigDir [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#overlay-resolution-order]
  it('resolves a registered overlay entry for a directory inside the repo, and reports the overlay root and app', () => {
    const ws = makeOverlayWorkspace();
    expect(resolveConfigDir(path.join(ws.api, 'src'), ws.env)).toEqual({ dir: ws.apiApp, via: 'overlay', overlayRoot: ws.specs, repo: ws.api, app: 'api' });
    expect(resolveConfigDir(ws.web, ws.env)).toMatchObject({ dir: ws.webApp, via: 'overlay', app: 'web' });
    expect(describeResolution(resolveConfigDir(ws.api, ws.env)!)).toBe(`configured via overlay ${ws.specs} (app api)`);
    expect(resolveConfigDir(ws.base, ws.env)).toBeNull();
  });

  // [claims: capabilities/platform-foundation#overlay-repo-config-wins]
  it("a repo's own config always wins over an overlay entry for it", () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.api, '.specguard/config.json'), JSON.stringify(appConfig('own', '.')));
    expect(resolveConfigDir(path.join(ws.api, 'src'), ws.env)).toEqual({ dir: ws.api, via: 'repo' });
    expect(resolveConfigDir(ws.api, { ...ws.env, [CONFIG_ENV]: ws.apiApp })).toEqual({ dir: ws.api, via: 'repo' });
  });

  // [claims: capabilities/platform-foundation#overlay-env-config]
  it('SPECGUARD_CONFIG names the config for any directory, as a file, its .specguard folder or the folder above it, and beats the registry', () => {
    const ws = makeOverlayWorkspace();
    const file = path.join(ws.webApp, '.specguard', 'config.json');
    for (const value of [file, path.dirname(file), ws.webApp]) {
      expect(resolveConfigDir(path.join(ws.api, 'src'), { ...ws.env, [CONFIG_ENV]: value })).toEqual({ dir: ws.webApp, via: 'env-config' });
      expect(resolveConfigDir(ws.base, { ...ws.env, [CONFIG_ENV]: value })).toEqual({ dir: ws.webApp, via: 'env-config' });
    }
    expect(configDirFromPath(path.join(ws.base, 'nowhere'))).toBeNull();
    expect(() => resolveConfigDir(ws.api, { ...ws.env, [CONFIG_ENV]: path.join(ws.base, 'nowhere') })).toThrow(ConfigInvalidError);
  });

  // [claims: capabilities/platform-foundation#overlay-env-roots]
  it('SPECGUARD_OVERLAY roots are scanned on the fly with no registration, several separated by the path-list separator, and come first', () => {
    const ws = makeOverlayWorkspace({ registered: false });
    const env = { ...ws.env, [OVERLAY_ENV]: ['/nowhere/at/all', ws.specs].join(path.delimiter) };
    expect(parseOverlayRoots(env[OVERLAY_ENV])).toEqual([path.resolve('/nowhere/at/all'), ws.specs]);
    expect(resolveConfigDir(ws.api, env)).toMatchObject({ dir: ws.apiApp, via: 'env-overlay', overlayRoot: ws.specs, app: 'api' });
    expect(readOverlayRegistry(ws.env).registry.overlays).toEqual([]);

    // an env root wins over a registry entry for the same repo, even when the registry points at another config
    const other = makeOverlayWorkspace({ registered: false });
    registerOverlay(other.specs, ws.env);
    expect(parseOverlayRoots(undefined)).toEqual([]);
    expect(resolveConfigDir(other.api, { ...ws.env, [OVERLAY_ENV]: other.specs })?.via).toBe('env-overlay');
  });

  // [claims: capabilities/platform-foundation#overlay-ambiguity]
  it('two overlay configs for the same repo are ambiguous: a typed error names both and says how to pick, never a guess', () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.specs, 'apps/api-v2/.specguard/config.json'), JSON.stringify(appConfig('api-v2', '../../../shop-api')));
    registerOverlay(ws.specs, ws.env);
    let caught: unknown;
    try {
      resolveConfigDir(path.join(ws.api, 'src'), ws.env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigAmbiguousError);
    const e = caught as ConfigAmbiguousError;
    expect(e.candidates.map((c) => c.app).sort()).toEqual(['api', 'api-v2']);
    expect(e.message).toContain(path.join('apps', 'api', '.specguard', 'config.json'));
    expect(e.message).toContain(path.join('apps', 'api-v2', '.specguard', 'config.json'));
    expect(e.message).toContain('--config');
    expect(e.message).toContain(CONFIG_ENV);
    // picking explicitly resolves it
    expect(resolveConfigDir(ws.api, { ...ws.env, [CONFIG_ENV]: ws.apiApp })).toEqual({ dir: ws.apiApp, via: 'env-config' });
    // and the web repo, which is not ambiguous, still resolves
    expect(resolveConfigDir(ws.web, ws.env)?.app).toBe('web');
  });

  // [claims: capabilities/platform-foundation#overlay-stale-entry]
  it('ignores a registered entry whose config was deleted, with a warning that names the fix', () => {
    const ws = makeOverlayWorkspace();
    rmSync(path.join(ws.webApp, '.specguard'), { recursive: true });
    const detail = resolveConfigDirDetailed(ws.web, ws.env);
    expect(detail.resolved).toBeNull();
    expect(detail.overlaysKnown).toBe(true);
    expect(detail.warnings.join('\n')).toContain('no longer exists');
    expect(detail.warnings.join('\n')).toContain('specguard overlay refresh');
    // the other repo is unaffected, and has no warning
    expect(resolveConfigDirDetailed(ws.api, ws.env).warnings).toEqual([]);
  });

  // [claims: capabilities/platform-foundation#overlay-resolution-order]
  it('with no overlay known it answers null without reading anything else', () => {
    const ws = makeOverlayWorkspace({ registered: false });
    expect(resolveConfigDirDetailed(ws.api, ws.env)).toEqual({ resolved: null, warnings: [], overlaysKnown: false });
  });

  // [claims: capabilities/platform-foundation#overlay-resolution-order]
  it('overlayCoverage is the overlay-only view: SPECGUARD_CONFIG is not coverage, and an ambiguous setup reads as not covered', () => {
    const ws = makeOverlayWorkspace();
    expect(overlayCoverage(ws.api, ws.env)?.app).toBe('api');
    expect(overlayCoverage(ws.api, { ...ws.env, [CONFIG_ENV]: ws.webApp })?.via).toBe('overlay');
    expect(overlayCoverage(ws.base, { ...ws.env, [CONFIG_ENV]: ws.webApp })).toBeNull();
    ws.write(path.join(ws.specs, 'apps/api-v2/.specguard/config.json'), JSON.stringify(appConfig('api-v2', '../../../shop-api')));
    registerOverlay(ws.specs, ws.env);
    expect(overlayCoverage(ws.api, ws.env)).toBeNull();
  });
});

describe('an entry covers the git repository that encloses its folder [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root]
  it('a repo opened at its git root resolves to the overlay entry for the app folder inside it, as do the app folder and below', () => {
    const ws = makeNestedWorkspace();
    const want = { dir: ws.webSpecs, via: 'overlay', overlayRoot: ws.specs, repo: ws.webApp, app: 'web' };
    expect(resolveConfigDir(ws.webRoot, ws.env)).toEqual(want);
    expect(resolveConfigDir(path.join(ws.webRoot, 'ci'), ws.env)).toEqual(want);
    expect(resolveConfigDir(ws.webApp, ws.env)).toEqual(want);
    expect(resolveConfigDir(path.join(ws.webApp, 'src', 'shop'), ws.env)).toEqual(want);
    const detail = resolveConfigDirDetailed(ws.webRoot, ws.env);
    expect(detail.repoDir).toBe(ws.webApp);
    expect(detail.gitRoot).toBe(ws.webRoot);
    expect(resolveConfigDirDetailed(ws.webApp, ws.env).gitRoot).toBeUndefined();
  });

  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root]
  it('a directory outside any git repository, and one above the git root, match nothing', () => {
    const ws = makeNestedWorkspace();
    expect(resolveConfigDir(ws.loose, ws.env)).toBeNull();
    expect(resolveConfigDir(ws.base, ws.env)).toBeNull();
    expect(matchOverlayEntries(ws.base, [{ repo: ws.webApp, config: '/o/web.json', app: 'web' }])).toBeNull();
  });

  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root]
  it('the enclosing git root is the nearest .git above the folder, by real path', () => {
    const ws = makeNestedWorkspace();
    expect(enclosingGitRoot(ws.webApp)).toBe(ws.webRoot);
    expect(enclosingGitRoot(ws.webRoot)).toBe(ws.webRoot);
    expect(enclosingGitRoot(path.join(ws.webApp, 'src', 'not-yet'))).toBe(ws.webRoot);
    expect(enclosingGitRoot(ws.loose)).not.toBe(ws.loose);
  });

  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root, capabilities/platform-foundation#overlay-ambiguity]
  it('a git root with an entry per app is ambiguous when started at the root, and the message says to start inside an app', () => {
    const ws = makeNestedWorkspace();
    let caught: unknown;
    try {
      resolveConfigDir(ws.monoRoot, ws.env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigAmbiguousError);
    const e = caught as ConfigAmbiguousError;
    expect(e.candidates.map((c) => c.app).sort()).toEqual(['mono-a', 'mono-b']);
    expect(e.message).toContain(`git repository ${ws.monoRoot}`);
    expect(e.message).toContain('Start from inside one of the apps');
    expect(e.message).toContain(ws.monoA);
    expect(e.message).toContain(ws.monoB);
    expect(e.message).toContain('--config');
    expect(e.message).toContain(CONFIG_ENV);
  });

  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root]
  it('started inside one of the apps it resolves to that app only, and an explicit pick resolves the root', () => {
    const ws = makeNestedWorkspace();
    expect(resolveConfigDir(path.join(ws.monoA, 'src'), ws.env)).toMatchObject({ app: 'mono-a', repo: ws.monoA });
    expect(resolveConfigDir(ws.monoB, ws.env)).toMatchObject({ app: 'mono-b' });
    expect(resolveConfigDir(ws.monoRoot, { ...ws.env, [CONFIG_ENV]: path.join(ws.specs, 'apps/mono-a') })).toMatchObject({ via: 'env-config' });
    // a file in the monorepo outside both apps has no single config either
    expect(() => resolveConfigDir(path.join(ws.monoRoot, 'apps'), ws.env)).toThrow(ConfigAmbiguousError);
  });

  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root]
  it('one config naming several app folders of one git repo resolves from the root (not ambiguous), to the first folder', () => {
    const ws = makeNestedWorkspace({ registered: false });
    ws.write(path.join(ws.specs, 'apps/mono-a/.specguard/config.json'), JSON.stringify({ ...appConfig('mono-a', '../../../shop-mono/apps/a'), apps: [
      { name: 'mono-a', repo: '../../../shop-mono/apps/a', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' },
      { name: 'mono-b', repo: '../../../shop-mono/apps/b', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' },
    ] }));
    ws.write(path.join(ws.specs, 'apps/mono-b/.specguard/config.json'), '{"apps":[]}');
    registerOverlay(ws.specs, ws.env);
    const detail = resolveConfigDirDetailed(ws.monoRoot, ws.env);
    expect(detail.resolved).toMatchObject({ dir: path.join(ws.specs, 'apps/mono-a'), app: 'mono-a' });
    expect(detail.repoDir).toBe(ws.monoA);
  });

  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root]
  it('a deeper entry that contains the start still wins over an enclosing-root match, and the git boundary is respected', () => {
    const ws = makeNestedWorkspace();
    const nested = path.join(ws.webApp, 'vendor', 'lib');
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    // started in a nested repo of its own: neither the app folder nor the outer git root covers it
    expect(resolveConfigDir(nested, ws.env)).toBeNull();
    // the outer entry still covers the app folder itself, which contains the start directly
    expect(resolveConfigDir(path.join(ws.webApp, 'src'), ws.env)?.app).toBe('web');
  });

  // [claims: capabilities/platform-foundation#overlay-enclosing-git-root]
  it('works for SPECGUARD_OVERLAY roots too, and overlayCoverage sees the git root as covered', () => {
    const ws = makeNestedWorkspace({ registered: false });
    const env = { ...ws.env, [OVERLAY_ENV]: ws.specs };
    expect(resolveConfigDir(ws.webRoot, env)).toMatchObject({ via: 'env-overlay', app: 'web', repo: ws.webApp });
    expect(overlayCoverage(ws.webRoot, env)?.app).toBe('web');
    expect(overlayCoverage(ws.monoRoot, env)).toBeNull();
  });
});
