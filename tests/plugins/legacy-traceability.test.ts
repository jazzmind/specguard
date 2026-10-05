import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { legacyTraceabilityImporter, LEGACY_TRACEABILITY_FILE } from '../../src/plugins/practera/legacy-traceability.js';
import { runContracts } from '../../src/pipelines/contracts.js';
import type { WorkspaceManifest, WorkspaceRepoWithConfig } from '../../src/core/workspace.js';

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sg-ws-'));
  for (const repo of ['consumer', 'provider']) {
    mkdirSync(path.join(root, repo, 'specs'), { recursive: true });
    mkdirSync(path.join(root, repo, '.specguard'), { recursive: true });
  }
  writeFileSync(path.join(root, 'provider', 'specs', 'auth.md'), '# Auth\n');
  const manifest: WorkspaceManifest = {
    version: '1.0',
    name: 'ws',
    rootDir: root,
    repos: { consumer: { path: 'consumer', role: 'consumer' }, provider: { path: 'provider', role: 'provider' } },
  };
  const repos: WorkspaceRepoWithConfig[] = Object.entries(manifest.repos).map(([key, r]) => ({
    ...r,
    key,
    absPath: path.join(root, r.path),
    specGuardConfig: null,
  }));
  return { root, manifest, repos };
}

describe('legacy traceability importer (plugin)', () => {
  it('reads dependencies from its own file, not the matrix output', () => {
    const { root, manifest } = setup();
    // the matrix writes this one; the importer must ignore it
    writeFileSync(path.join(root, 'consumer', '.specguard', 'traceability.json'), JSON.stringify({ generatedAt: 'x', entries: [] }));
    expect(legacyTraceabilityImporter.read({ key: 'consumer', absPath: path.join(root, 'consumer') }, manifest)).toEqual([]);
    writeFileSync(
      path.join(root, 'consumer', '.specguard', LEGACY_TRACEABILITY_FILE),
      JSON.stringify({ mappings: [{ spec: 'specs/login.md', graphqlDependencies: ['../provider/specs/auth.md'] }] }),
    );
    expect(legacyTraceabilityImporter.read({ key: 'consumer', absPath: path.join(root, 'consumer') }, manifest)).toEqual([
      { consumerSpec: 'specs/login.md', providerPath: 'provider::specs/auth.md', docPage: null },
    ]);
  });

  it('runContracts runs importers only for enabled plugins', async () => {
    const { root, manifest, repos } = setup();
    writeFileSync(
      path.join(root, 'consumer', '.specguard', LEGACY_TRACEABILITY_FILE),
      JSON.stringify({ mappings: [{ spec: 'specs/login.md', graphqlDependencies: ['../provider/specs/auth.md'] }] }),
    );
    await runContracts(manifest, repos, { force: true });
    const off = JSON.parse(readFileSync(path.join(root, '.specguard', 'contracts.json'), 'utf8'));
    expect(off.edges).toHaveLength(0);
    await runContracts(manifest, repos, { force: true, plugins: ['practera'] });
    const on = JSON.parse(readFileSync(path.join(root, '.specguard', 'contracts.json'), 'utf8'));
    expect(on.edges).toHaveLength(1);
    expect(on.edges[0]).toMatchObject({ consumer: 'consumer::specs/login.md', provider: 'provider::specs/auth.md' });
  });
});
