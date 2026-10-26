import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { OVERLAY_ENV, readOverlayRegistry } from '../../src/core/overlay.js';
import { appConfig, makeNestedWorkspace, makeOverlayWorkspace, type OverlayWorkspace } from '../helpers/overlay-fixture.js';

const cli = path.resolve(import.meta.dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (ws: { env: NodeJS.ProcessEnv }, cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...ws.env, SPECGUARD_HOST_AGENT: '0' } });
const json = (stdout: string): Record<string, any> => JSON.parse(stdout) as Record<string, any>;
const registryFile = (ws: OverlayWorkspace): string => path.join(ws.env.HOME!, '.config', 'specguard', 'overlays.json');

describe('specguard overlay [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#overlay-cli]
  it('add scans the overlay, shows each entry, registers it with mode 600 and writes nothing into the app repos', () => {
    const ws = makeOverlayWorkspace({ registered: false, git: true });
    const r = run(ws, ws.base, 'overlay', 'add', ws.specs);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('2 repo(s) covered');
    expect(r.stdout).toContain(ws.api);
    expect(r.stdout).toContain(path.join('apps', 'web', '.specguard', 'config.json'));
    expect(r.stdout).toContain('Nothing was written into the application repos');
    expect(statSync(registryFile(ws)).mode & 0o777).toBe(0o600);
    expect(readOverlayRegistry(ws.env).registry.overlays.map((o) => o.root)).toEqual([ws.specs]);
    expect(existsSync(path.join(ws.api, '.specguard'))).toBe(false);
    expect(existsSync(path.join(ws.web, '.specguard'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#overlay-scan, capabilities/integration-surfaces#overlay-cli]
  it('add shows what it skipped and why, and --json carries the same', () => {
    const ws = makeOverlayWorkspace({ registered: false });
    ws.write(path.join(ws.specs, 'apps/ghost/.specguard/config.json'), JSON.stringify(appConfig('ghost', '../../../shop-ghost')));
    const text = run(ws, ws.base, 'overlay', 'add', ws.specs);
    expect(text.stdout).toContain('skipped  apps/ghost/.specguard/config.json (app ghost)');
    expect(text.stdout).toContain('does not exist');
    const body = json(run(ws, ws.base, '--json', 'overlay', 'add', ws.specs).stdout);
    expect(body.entries.map((e: { app: string }) => e.app)).toEqual(['api', 'web']);
    expect(body.skipped).toHaveLength(1);
  });

  // [claims: capabilities/integration-surfaces#overlay-cli]
  it('add refuses a directory with no configs, or with none that point at another repo, and registers nothing', () => {
    const ws = makeOverlayWorkspace({ registered: false });
    const empty = mkdtempSync(path.join(os.tmpdir(), 'sg-empty-'));
    const none = run(ws, ws.base, 'overlay', 'add', empty);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('Not an overlay');
    const missing = run(ws, ws.base, 'overlay', 'add', path.join(empty, 'nope'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('does not exist');
    // a repo's own config (repo ".") is not an overlay
    const own = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-own-')));
    ws.write(path.join(own, '.specguard/config.json'), JSON.stringify(appConfig('own', '.')));
    const inRepo = run(ws, ws.base, 'overlay', 'add', own);
    expect(inRepo.status).toBe(1);
    expect(inRepo.stderr).toContain('in-repo config');
    expect(existsSync(registryFile(ws))).toBe(false);
  });

  // [claims: capabilities/integration-surfaces#overlay-cli]
  it('list shows registered overlays (and SPECGUARD_OVERLAY roots) as text and JSON, and flags a stale entry', () => {
    const ws = makeOverlayWorkspace();
    expect(run(ws, ws.base, 'overlay', 'list').stdout).toContain(ws.specs);
    rmSync(path.join(ws.webApp, '.specguard'), { recursive: true });
    const text = run(ws, ws.base, 'overlay', 'list').stdout;
    expect(text).toContain('[stale: config is gone, run overlay refresh]');
    const body = json(run(ws, ws.base, 'overlay', 'list', '--json').stdout);
    expect(body.overlays[0].entries.map((e: { app: string; stale: boolean }) => [e.app, e.stale])).toEqual([['api', false], ['web', true]]);
    expect(body.env).toEqual([]);
    const fromEnv = json(spawnSync(process.execPath, ['--import', tsx, cli, '--json', 'overlay', 'list'], { cwd: ws.base, encoding: 'utf8', env: { ...ws.env, [OVERLAY_ENV]: ws.specs } }).stdout);
    expect(fromEnv.env[0].root).toBe(ws.specs);
    const none = makeOverlayWorkspace({ registered: false });
    expect(run(none, none.base, 'overlay', 'list').stdout).toContain('no overlays registered');
  });

  // [claims: capabilities/integration-surfaces#overlay-cli]
  it('refresh rescans after a config was added or deleted, for one overlay or all, and reports the difference', () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.specs, 'apps/admin/.specguard/config.json'), JSON.stringify(appConfig('admin', '../../../shop-api/src')));
    rmSync(path.join(ws.webApp, '.specguard'), { recursive: true });
    const r = run(ws, ws.base, 'overlay', 'refresh', ws.specs);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 added, 1 removed');
    expect(r.stdout).toContain(`+ ${path.join(ws.api, 'src')}`);
    expect(readOverlayRegistry(ws.env).registry.overlays[0]!.entries.map((e) => e.app)).toEqual(['admin', 'api']);
    expect(run(ws, ws.base, 'overlay', 'refresh').stdout).toContain('0 added, 0 removed');
    expect(run(ws, ws.base, 'overlay', 'refresh', path.join(ws.base, 'elsewhere')).status).toBe(1);
  });

  // [claims: capabilities/integration-surfaces#overlay-cli]
  it('remove forgets an overlay and leaves its files alone; removing an unknown one fails', () => {
    const ws = makeOverlayWorkspace();
    const r = run(ws, ws.base, 'overlay', 'remove', ws.specs);
    expect(r.status, r.stderr).toBe(0);
    expect(readOverlayRegistry(ws.env).registry.overlays).toEqual([]);
    expect(existsSync(path.join(ws.apiApp, '.specguard/config.json'))).toBe(true);
    expect(run(ws, ws.base, 'overlay', 'remove', ws.specs).status).toBe(1);
  });

  // [claims: capabilities/integration-surfaces#overlay-cli]
  it('resolve says which config, overlay and app a directory resolves to (exit 0), or why none (exit 1), read-only', () => {
    const ws = makeOverlayWorkspace({ git: true });
    const before = readFileSync(registryFile(ws), 'utf8');
    const hit = run(ws, path.join(ws.api, 'src'), 'overlay', 'resolve', '--json');
    expect(hit.status, hit.stderr).toBe(0);
    expect(json(hit.stdout)).toEqual({
      dir: path.join(ws.api, 'src'),
      configured: true,
      via: 'overlay',
      configDir: ws.apiApp,
      config: path.join(ws.apiApp, '.specguard', 'config.json'),
      overlayRoot: ws.specs,
      repo: ws.api,
      app: 'api',
      warnings: [],
    });
    expect(run(ws, ws.api, 'overlay', 'resolve').stdout).toContain(`configured via overlay ${ws.specs} (app api)`);
    const miss = run(ws, ws.base, 'overlay', 'resolve', ws.base, '--json');
    expect(miss.status).toBe(1);
    expect(json(miss.stdout)).toMatchObject({ configured: false });
    expect(json(miss.stdout).reason).toContain('no registered overlay');
    expect(readFileSync(registryFile(ws), 'utf8')).toBe(before);
    expect(existsSync(path.join(ws.api, '.specguard'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#overlay-ambiguity, capabilities/integration-surfaces#overlay-cli]
  it('resolve reports an ambiguous repo with both candidates, and add warns about it', () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.specs, 'apps/api-v2/.specguard/config.json'), JSON.stringify(appConfig('api-v2', '../../../shop-api')));
    const refreshed = run(ws, ws.base, 'overlay', 'refresh', ws.specs);
    expect(refreshed.stderr).toContain('more than one overlay config');
    const r = run(ws, ws.api, 'overlay', 'resolve', '--json');
    expect(r.status).toBe(1);
    const body = json(r.stdout);
    expect(body).toMatchObject({ configured: false, ambiguous: true });
    expect(body.candidates).toHaveLength(2);
    expect(body.reason).toContain('--config');
  });

  // [claims: capabilities/platform-foundation#overlay-mode-semantics, capabilities/integration-surfaces#overlay-cli]
  it('status and check run from inside the real repo and say on the first line that the config came from the overlay', () => {
    const ws = makeOverlayWorkspace({ shop: 'warn' });
    const first = (args: string[]): string => run(ws, path.join(ws.api, 'src'), ...args).stdout.split('\n')[0]!;
    expect(first(['status'])).toBe(`configured via overlay ${ws.specs} (app api)`);
    expect(first(['check'])).toBe(`configured via overlay ${ws.specs} (app api)`);
    // from inside the overlay app itself there is no such line
    expect(run(ws, ws.apiApp, 'status').stdout).not.toContain('configured via overlay');
    expect(existsSync(path.join(ws.api, '.specguard'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#overlay-no-change, capabilities/integration-surfaces#overlay-cli]
  it('a repo no overlay covers still says to run init, and an overlay-covered repo is not re-initialised into', () => {
    const ws = makeOverlayWorkspace();
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-bare-')));
    mkdirSync(path.join(dir, '.git'));
    const bare = run(ws, dir, 'status');
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain('specguard init');
    expect(bare.stderr).toContain('specguard overlay add');
    const init = run(ws, ws.api, 'init');
    expect(init.status).toBe(1);
    expect(init.stderr).toContain('already covered');
    expect(existsSync(path.join(ws.api, '.specguard'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#overlay-env-config, capabilities/integration-surfaces#overlay-cli]
  it('--config and SPECGUARD_CONFIG pick the config explicitly, and --config keeps working as before', () => {
    const ws = makeOverlayWorkspace();
    const viaEnv = run({ env: { ...ws.env, SPECGUARD_CONFIG: ws.webApp } }, ws.api, 'status');
    expect(viaEnv.stdout.split('\n')[0]).toBe(`configured via SPECGUARD_CONFIG (${ws.webApp})`);
    const viaFlag = run(ws, ws.base, '--config', path.join(ws.apiApp, '.specguard', 'config.json'), 'status');
    // exit 4 is status reporting uncovered claims: the config was found
    expect(viaFlag.stderr).not.toContain('No config found');
    expect([0, 4]).toContain(viaFlag.status);
    expect(viaFlag.stdout).not.toContain('configured via overlay');
  });

  // [claims: capabilities/integration-surfaces#overlay-cli, capabilities/platform-foundation#overlay-enclosing-git-root]
  it('add and list show the enclosing git root when it differs from the entry folder, and resolve works from the git root', () => {
    const ws = makeNestedWorkspace({ registered: false });
    const added = run(ws, ws.base, 'overlay', 'add', ws.specs);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain(`${ws.webApp}  (git root ${ws.webRoot})`);
    expect(run(ws, ws.base, 'overlay', 'list').stdout).toContain(`(git root ${ws.webRoot})`);
    const hit = run(ws, ws.webRoot, 'overlay', 'resolve', '--json');
    expect(hit.status, hit.stderr).toBe(0);
    expect(json(hit.stdout)).toMatchObject({ configured: true, app: 'web', repo: ws.webApp, gitRoot: ws.webRoot });
    expect(run(ws, ws.webRoot, 'overlay', 'resolve').stdout).toContain(`covers the git repository ${ws.webRoot}`);
    const mono = run(ws, ws.monoRoot, 'overlay', 'resolve', '--json');
    expect(mono.status).toBe(1);
    expect(json(mono.stdout)).toMatchObject({ configured: false, ambiguous: true });
    expect(json(mono.stdout).reason).toContain('Start from inside one of the apps');
    expect(run(ws, ws.base, 'overlay', 'resolve', '--json').status).toBe(1);
  });
});
