import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadContractGraph } from '../../src/core/contracts.js';
import { loadWorkspaceWithConfigs } from '../../src/core/workspace.js';
import { runContracts } from '../../src/pipelines/contracts.js';

function workspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-nid-'));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  put('ws/.specguard/workspace.json', JSON.stringify({ version: '1', name: 'ws', repos: { web: { path: '../web', role: 'consumer' }, api: { path: '../api', role: 'provider' } } }));
  const config = JSON.stringify({ apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }], llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' } });
  put('web/.specguard/config.json', config);
  put('api/.specguard/config.json', config);
  put('api/specs/orders.md', '# Orders\n\n## Overview\nx\n');
  put('web/specs/nested/cart.md', '# Cart\n\n## Overview\nx\n\n## Dependencies\n\n<!-- contracts:start -->\napi::specs/orders.md [rest: GET /orders]\n<!-- contracts:end -->\n');
  return path.join(dir, 'ws');
}

describe('contract node ids [contract-node-ids-consistent]', () => {
  // [claims: capabilities/workspaces#contract-node-ids-consistent]
  it('names a consumer spec node by its repo-relative path, never its spec key', async () => {
    const ws = workspace();
    const { manifest, repos } = await loadWorkspaceWithConfigs(ws);
    await runContracts(manifest, repos, {});
    const graph = (await loadContractGraph(manifest.rootDir))!;
    const cart = graph.nodes.filter((n) => n.repo === 'web');
    expect(cart.map((n) => [n.id, n.spec])).toEqual([['web::specs/nested/cart.md', 'specs/nested/cart.md']]);
    expect(graph.edges[0]).toMatchObject({ consumer: 'web::specs/nested/cart.md', provider: 'api::specs/orders.md' });
    // Every edge endpoint has a node of that exact id.
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      expect(ids.has(e.consumer)).toBe(true);
      expect(ids.has(e.provider)).toBe(true);
    }
  });
});
