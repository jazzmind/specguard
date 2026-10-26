import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ConfigAmbiguousError, ConfigNotFoundError } from '../../src/core/errors.js';
import { CONFIG_ENV } from '../../src/core/overlay.js';
import { appConfig, makeOverlayWorkspace, registerOverlay } from '../helpers/overlay-fixture.js';

describe('loadConfig through an overlay [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#overlay-mode-semantics]
  it('from inside the real repo it loads the overlay app config as if run from the overlay app directory', async () => {
    const ws = makeOverlayWorkspace();
    const config = await loadConfig(path.join(ws.api, 'src'), { env: ws.env });
    expect(config.rootDir).toBe(ws.apiApp);
    expect(config.apps[0]!.name).toBe('api');
    expect(path.resolve(config.rootDir!, config.apps[0]!.repo)).toBe(ws.api);
    expect(config.resolvedVia).toEqual({ dir: ws.apiApp, via: 'overlay', overlayRoot: ws.specs, repo: ws.api, app: 'api' });
    // identical to loading from the overlay app folder itself, except for the metadata
    const direct = await loadConfig(ws.apiApp, { env: ws.env });
    expect(direct.resolvedVia).toBeUndefined();
    expect({ ...config, resolvedVia: undefined }).toEqual({ ...direct, resolvedVia: undefined });
  });

  // [claims: capabilities/platform-foundation#overlay-mode-semantics]
  it('loads the other app of the same overlay from its own repo', async () => {
    const ws = makeOverlayWorkspace();
    const config = await loadConfig(ws.web, { env: ws.env });
    expect(config.rootDir).toBe(ws.webApp);
    expect(config.resolvedVia?.app).toBe('web');
  });

  // [claims: capabilities/platform-foundation#overlay-repo-config-wins]
  it("a repo's own config wins over the overlay, and carries no overlay metadata", async () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.api, '.specguard/config.json'), JSON.stringify(appConfig('own', '.')));
    const config = await loadConfig(path.join(ws.api, 'src'), { env: ws.env });
    expect(config.rootDir).toBe(ws.api);
    expect(config.apps[0]!.name).toBe('own');
    expect(config.resolvedVia).toBeUndefined();
  });

  // [claims: capabilities/platform-foundation#overlay-no-change]
  it('with no overlay and no config it throws ConfigNotFoundError exactly as before, with no overlay hint', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-noconfig-')));
    const env = { PATH: '', HOME: dir };
    const err = await loadConfig(dir, { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigNotFoundError);
    expect((err as ConfigNotFoundError).message).toBe(`No config found (searched from ${dir}). Run \`specguard init\` to create one.`);
    expect((err as ConfigNotFoundError).hint).toBeUndefined();
  });

  // [claims: capabilities/platform-foundation#overlay-no-change]
  it('when an overlay is registered but none covers the directory, the error carries a hint about overlay add', async () => {
    const ws = makeOverlayWorkspace();
    const err = (await loadConfig(ws.base, { env: ws.env }).catch((e: unknown) => e)) as ConfigNotFoundError;
    expect(err).toBeInstanceOf(ConfigNotFoundError);
    expect(err.hint).toContain('specguard overlay add');
    expect(err.message).toContain('specguard init');
  });

  // [claims: capabilities/platform-foundation#overlay-env-config]
  it('SPECGUARD_CONFIG beats the registry for a directory the registry covers', async () => {
    const ws = makeOverlayWorkspace();
    const config = await loadConfig(path.join(ws.api, 'src'), { env: { ...ws.env, [CONFIG_ENV]: path.join(ws.webApp, '.specguard', 'config.json') } });
    expect(config.rootDir).toBe(ws.webApp);
    expect(config.resolvedVia).toEqual({ dir: ws.webApp, via: 'env-config' });
  });

  // [claims: capabilities/platform-foundation#overlay-ambiguity]
  it('refuses to guess between two overlay configs for one repo', async () => {
    const ws = makeOverlayWorkspace();
    ws.write(path.join(ws.specs, 'apps/api-v2/.specguard/config.json'), JSON.stringify(appConfig('api-v2', '../../../shop-api')));
    registerOverlay(ws.specs, ws.env);
    await expect(loadConfig(ws.api, { env: ws.env })).rejects.toBeInstanceOf(ConfigAmbiguousError);
    // --config style explicit pick still works
    await expect(loadConfig(ws.apiApp, { env: ws.env })).resolves.toMatchObject({ rootDir: ws.apiApp });
  });

  // [claims: capabilities/platform-foundation#overlay-stale-entry]
  it('a registered entry whose config was deleted is ignored: the directory reads as not configured, with the stale warning in the hint', async () => {
    const ws = makeOverlayWorkspace();
    const { rmSync } = await import('node:fs');
    rmSync(path.join(ws.webApp, '.specguard'), { recursive: true });
    const err = (await loadConfig(ws.web, { env: ws.env }).catch((e: unknown) => e)) as ConfigNotFoundError;
    expect(err).toBeInstanceOf(ConfigNotFoundError);
    expect(err.hint).toContain('no longer exists');
  });
});
