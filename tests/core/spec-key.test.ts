import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import type { DriftRegistry } from '../../src/core/drift-registry.js';
import {
  canonicalSpecKey,
  declaredSources,
  loadCanonicalSpecs,
  migrateRegistrySpecKeys,
  resetSourceWarnings,
  resolveDeclaredSources,
} from '../../src/core/spec-key.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import { makeHiRockyRepo } from '../helpers/hirocky-fixture.js';
import { makeRepo } from '../helpers/repo.js';

describe('spec-key', () => {
  it('canonical key is specs-root relative regardless of the owning app [root-relative-key]', async () => {
    const fx = makeHiRockyRepo();
    const config = await loadConfig(fx.dir);
    expect(canonicalSpecKey(config, path.join(fx.dir, 'specs/api/services/messaging.md'), path.join(fx.dir, 'specs/api'))).toBe('api/services/messaging');
  });

  it('falls back to the specDir-relative key without a specs root [legacy-fallback]', async () => {
    const repo = makeRepo({ paths: { specsRoot: 'nope' } });
    const config = await loadConfig(repo.dir);
    expect(canonicalSpecKey(config, path.join(repo.dir, 'specs/core/awards.md'), path.join(repo.dir, 'specs'))).toBe('core/awards');
  });

  it('loadCanonicalSpecs sets specKey and localKey [load-canonical]', async () => {
    const fx = makeHiRockyRepo();
    const config = await loadConfig(fx.dir);
    const specs = loadCanonicalSpecs(config, path.join(fx.dir, 'specs/api'));
    const m = specs.find((s) => s.localKey === 'services/messaging');
    expect(m?.specKey).toBe('api/services/messaging');
  });

  it('declaredSources reads sources: then module: [declared-sources]', () => {
    const a = parseSpecContent('# A\n\n<!-- module: x.ts\n sources: a.ts, b/*.ts -->\n', '/s/a.md', '/s');
    expect(declaredSources(a)).toEqual(['a.ts', 'b/*.ts']);
    const b = parseSpecContent('# B\n\n<!-- module: only.ts -->\n', '/s/b.md', '/s');
    expect(declaredSources(b)).toEqual(['only.ts']);
  });

  it('resolves app-relative globs and warns once for root-relative ones [sources-root-fallback]', async () => {
    const fx = makeHiRockyRepo();
    const config = await loadConfig(fx.dir);
    const api = config.apps.find((a) => a.name === 'api');
    resetSourceWarnings();
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const rel = await resolveDeclaredSources(config, api, ['src/sms/signature.ts'], warn);
    expect(rel).toEqual([path.join(fx.dir, 'apps/api/src/sms/signature.ts')]);
    expect(warnings).toHaveLength(0);
    const root1 = await resolveDeclaredSources(config, api, ['apps/api/src/services/*.ts'], warn);
    expect(root1.map((f) => path.basename(f))).toEqual(['messaging.ts', 'redaction.ts']);
    await resolveDeclaredSources(config, api, ['apps/api/src/services/*.ts'], warn);
    expect(warnings).toHaveLength(1);
  });

  it('migrates legacy registry keys to the canonical key [migrate-registry]', async () => {
    const fx = makeHiRockyRepo();
    const config = await loadConfig(fx.dir);
    const file = (h: string) => ({ hash: h, lastChecked: 'x', lastVerdict: 'no-drift' as const });
    const registry: DriftRegistry = {
      'api/services/messaging': { specKey: 'api/services/messaging', specHash: 's', files: { 'a.ts': file('1') } },
      'api/api/services/messaging': { specKey: 'api/api/services/messaging', specHash: 's', files: { 'b.ts': file('2') } },
    };
    expect(migrateRegistrySpecKeys(config, registry)).toBe(true);
    expect(Object.keys(registry)).toEqual(['api/services/messaging']);
    expect(Object.keys(registry['api/services/messaging'].files).sort()).toEqual(['a.ts', 'b.ts']);
    expect(migrateRegistrySpecKeys(config, registry)).toBe(false);
  });
});
