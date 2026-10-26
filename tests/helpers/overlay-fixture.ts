import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanOverlay, upsertOverlay, writeOverlayRegistry, type OverlayRegistry } from '../../src/core/overlay.js';
import type { EnforceLevel } from '../../src/core/types.js';
import { SHOP_SPEC, SYSTEM_SPEC } from './v2-repo.js';

/**
 * A generic overlay workspace in a temp dir: two application repos (shop-api, shop-web) that hold only code, and one
 * overlay repo (shop-specs) holding the SpecGuard config, specs and tags for each of them. Nothing of SpecGuard is in
 * the application repos.
 */
export interface OverlayWorkspace {
  /** Canonical temp dir that holds the three repos. */
  base: string;
  api: string;
  web: string;
  specs: string;
  /** The overlay folder of the api app (holds its `.specguard/` and `specs/`). */
  apiApp: string;
  webApp: string;
  /** An environment that keeps SpecGuard's per-user files inside the temp dir. */
  env: NodeJS.ProcessEnv;
  write: (abs: string, content: string) => string;
}

const git = (dir: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
};

export function appConfig(name: string, repo: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apps: [{ name, repo, specDir: 'specs', sources: { api: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] }, framework: 'vitest', testOutput: 'tests/' }],
    llm: { provider: 'none', model: 'none', apiKeyEnv: 'NONE' },
    ...extra,
  };
}

export function makeOverlayWorkspace(opts: { shop?: EnforceLevel; registered?: boolean; git?: boolean } = {}): OverlayWorkspace {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-overlay-')));
  const write = (abs: string, content: string): string => {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };
  const api = path.join(base, 'shop-api');
  const web = path.join(base, 'shop-web');
  const specs = path.join(base, 'shop-specs');
  write(path.join(api, 'src/shop/cart.ts'), 'export const cart = 1;\n');
  write(path.join(api, 'src/orphan.ts'), 'export const orphan = 1;\n');
  write(path.join(api, 'tests/shop.test.ts'), "it('totals', () => {});\n");
  write(path.join(web, 'src/index.ts'), 'export const web = 1;\n');

  const apiApp = path.join(specs, 'apps/api');
  const webApp = path.join(specs, 'apps/web');
  write(path.join(apiApp, '.specguard/config.json'), JSON.stringify(appConfig('api', '../../../shop-api')));
  write(path.join(webApp, '.specguard/config.json'), JSON.stringify(appConfig('web', '../../../shop-web')));
  write(path.join(apiApp, 'specs/system.md'), SYSTEM_SPEC);
  const level = opts.shop ? SHOP_SPEC.replace('status: active', `status: active\nenforce: ${opts.shop}`) : SHOP_SPEC;
  write(path.join(apiApp, 'specs/capabilities/shop.md'), level);
  write(path.join(specs, '.gitignore'), '.specguard/cache/\n');
  write(path.join(apiApp, '.gitignore'), '.specguard/cache/\n');
  // `git init` per repo is the slow part of a fixture: only the tests that need real repositories ask for it.
  for (const dir of opts.git ? [api, web, specs] : []) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
  }

  const home = path.join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: home };
  if (opts.registered !== false) registerOverlay(specs, env);
  return { base, api, web, specs, apiApp, webApp, env, write };
}

/** Scan `root` and register it in the registry that `env` points at, as `overlay add` does. */
export function registerOverlay(root: string, env: NodeJS.ProcessEnv): OverlayRegistry {
  const scan = scanOverlay(root);
  const registry = upsertOverlay({ version: 1, overlays: [] }, { root: scan.root, addedAt: '2026-10-26T00:00:00.000Z', entries: scan.entries });
  writeOverlayRegistry(registry, env);
  return registry;
}

/**
 * Overlay entries that point at a NESTED folder of a git repository: shop-web is the git root and `web/` the app inside
 * it; `shop-mono` is a git root with two apps (`apps/a`, `apps/b`), each with its own overlay config; `loose` is a folder
 * outside any repo. Repos are marked with a bare `.git` folder (enough for the walk; no `git init` cost).
 */
export interface NestedWorkspace {
  base: string;
  /** Git root of shop-web. */
  webRoot: string;
  /** The app folder inside it that the overlay config names. */
  webApp: string;
  /** The overlay app folder (holds `.specguard/` and `specs/`) for the nested web app. */
  webSpecs: string;
  monoRoot: string;
  monoA: string;
  monoB: string;
  specs: string;
  loose: string;
  env: NodeJS.ProcessEnv;
  write: (abs: string, content: string) => string;
}

export function makeNestedWorkspace(opts: { shop?: EnforceLevel; registered?: boolean } = {}): NestedWorkspace {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-nested-')));
  const write = (abs: string, content: string): string => {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };
  const webRoot = path.join(base, 'shop-web');
  const webApp = path.join(webRoot, 'web');
  const monoRoot = path.join(base, 'shop-mono');
  const specs = path.join(base, 'shop-specs');
  const loose = path.join(base, 'loose');
  for (const dir of [webRoot, monoRoot, specs]) mkdirSync(path.join(dir, '.git'), { recursive: true });
  mkdirSync(loose, { recursive: true });
  write(path.join(webApp, 'src/shop/cart.ts'), 'export const cart = 1;\n');
  write(path.join(webApp, 'src/orphan.ts'), 'export const orphan = 1;\n');
  write(path.join(webRoot, 'README.md'), '# shop-web\n');
  write(path.join(webRoot, 'ci/build.ts'), 'export const build = 1;\n');
  write(path.join(monoRoot, 'apps/a/src/a.ts'), 'export const a = 1;\n');
  write(path.join(monoRoot, 'apps/b/src/b.ts'), 'export const b = 1;\n');

  const webSpecs = path.join(specs, 'apps/web');
  write(path.join(webSpecs, '.specguard/config.json'), JSON.stringify(appConfig('web', '../../../shop-web/web')));
  write(path.join(webSpecs, 'specs/system.md'), SYSTEM_SPEC);
  write(path.join(webSpecs, 'specs/capabilities/shop.md'), opts.shop ? SHOP_SPEC.replace('status: active', `status: active\nenforce: ${opts.shop}`) : SHOP_SPEC);
  write(path.join(specs, 'apps/mono-a/.specguard/config.json'), JSON.stringify(appConfig('mono-a', '../../../shop-mono/apps/a')));
  write(path.join(specs, 'apps/mono-b/.specguard/config.json'), JSON.stringify(appConfig('mono-b', '../../../shop-mono/apps/b')));

  const home = path.join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: home };
  if (opts.registered !== false) registerOverlay(specs, env);
  return { base, webRoot, webApp, webSpecs, monoRoot, monoA: path.join(monoRoot, 'apps/a'), monoB: path.join(monoRoot, 'apps/b'), specs, loose, env, write };
}
