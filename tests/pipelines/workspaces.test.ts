import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { loadContractGraph } from '../../src/core/contracts.js';
import { loadWorkspaceWithConfigs } from '../../src/core/workspace.js';
import { runCheck } from '../../src/pipelines/check.js';
import { runContracts } from '../../src/pipelines/contracts.js';
import { runImpact } from '../../src/pipelines/impact.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import { runTestRun } from '../../src/pipelines/test-run.js';
import { Api } from '../../src/server/api.js';
import { gitCommit, gitInit } from '../helpers/v2-repo.js';
import { makeMonorepo } from '../helpers/monorepo-fixture.js';

const cfg = async (dir: string) => loadConfig(dir);
const ledger = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.specguard/proofs.json'), 'utf8')).proofs as Record<string, { verdict: string }>;

describe('per-unit rollups [workspace-rollup]', () => {
  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('reports each unit with its source files, unowned files and the capabilities that touch it [check-units]', async () => {
    const repo = makeMonorepo();
    const r = await runCheck(await cfg(repo.dir), {});
    const text = r.messages.join('\n');
    expect(text).toContain('# unit ui [package] 2 source files, 0 unowned, 1 capabilities (design-system)');
    // A capability that spans two packages shows up in both.
    expect(text).toContain('# unit web [package] 1 source files, 0 unowned, 1 capabilities (auth)');
    expect(text).toContain('# unit api [package] 1 source files, 0 unowned, 1 capabilities (auth)');
    expect(text).toContain('# unit tools [package] 1 source files, 1 unowned, 0 capabilities');
    expect(r.exitCode).toBe(4);
    const trace = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/trace.json'), 'utf8'));
    expect(trace.units.find((u: { unit: string }) => u.unit === 'tools').unowned).toEqual(['packages/tools/src/index.ts']);
    expect(trace.units.find((u: { unit: string }) => u.unit === 'web').counts.claims).toBe(2);
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('serves the same rollup over the API [api-units]', async () => {
    const repo = makeMonorepo();
    const res = await new Api(await cfg(repo.dir)).handle({ method: 'GET', path: '/api/v1/units' });
    const units = JSON.parse(res.body).units as Array<{ unit: string; capabilities: string[] }>;
    expect(units.map((u) => u.unit)).toEqual(['api', 'tools', 'ui', 'web']);
    expect(units.find((u) => u.unit === 'api')?.capabilities).toEqual(['auth']);
  });

  it('omits unit rollups when there is no workspace manifest at the repo root [no-manifest]', async () => {
    const repo = makeMonorepo();
    writeFileSync(path.join(repo.dir, '.specguard/workspace.json'), '{"version":"2","name":"x"}');
    const r = await runCheck(await cfg(repo.dir), {});
    expect(r.messages.join('\n')).not.toContain('# unit');
  });
});

describe('package edges and impact [workspace-impact]', () => {
  async function graph(repo: ReturnType<typeof makeMonorepo>) {
    const { manifest, repos } = await loadWorkspaceWithConfigs(repo.dir);
    await runContracts(manifest, repos, {});
    return { manifest, graph: (await loadContractGraph(manifest.rootDir))! };
  }

  // [claims: capabilities/workspaces#package-edges]
  it('builds an edge for each dependency between units, from their own manifests [package-edges]', async () => {
    const { graph: g } = await graph(makeMonorepo());
    const edges = g.edges.map((e) => `${e.consumer}->${e.provider} ${e.type} ${e.source} ${e.surface[0]}`).sort();
    expect(edges).toEqual(['api::package->ui::package package workspace packages/api/package.json', 'web::package->ui::package package workspace packages/web/package.json']);
  });

  // [claims: capabilities/workspaces#package-edges]
  it('rebuilds them every run, so a removed dependency disappears and nothing duplicates [regenerated]', async () => {
    const repo = makeMonorepo();
    await graph(repo);
    writeFileSync(path.join(repo.dir, 'packages/api/package.json'), JSON.stringify({ name: '@acme/api' }));
    const { graph: g } = await graph(repo);
    expect(g.edges.map((e) => e.consumer)).toEqual(['web::package']);
  });

  // [claims: capabilities/workspaces#package-edges]
  it('reports the units downstream of a package and the capabilities built on them [impact-capabilities]', async () => {
    const repo = makeMonorepo();
    const { manifest } = await graph(repo);
    const { result, impact } = await runImpact(manifest, { target: 'ui' });
    expect(impact!.startNode.id).toBe('ui::package');
    expect(impact!.downstream.map((d) => d.node.repo).sort()).toEqual(['api', 'web']);
    expect(impact!.capabilities).toEqual([
      { id: 'auth', title: 'Auth', units: ['api', 'web'] },
      { id: 'design-system', title: 'Design system', units: ['ui'] },
    ]);
    expect(result.messages.join('\n')).toContain('Capabilities with code in these units (2)');
    expect(impact!.suggestedActions[0]).toContain('specguard test run --unit ui --unit');
  });

  // [claims: capabilities/workspaces#package-edges]
  it('accepts a file inside a package as the target, and a change nothing depends on has no downstream [impact-target-forms]', async () => {
    const repo = makeMonorepo();
    const { manifest } = await graph(repo);
    const byFile = await runImpact(manifest, { target: 'packages/ui/src/button.ts' });
    expect(byFile.impact!.startNode.id).toBe('ui::package');
    const leaf = await runImpact(manifest, { target: 'web' });
    expect(leaf.impact!.downstream).toEqual([]);
    expect(leaf.impact!.capabilities.map((c) => c.id)).toEqual(['auth']);
  });
});

describe('test run across units [workspace-test-run]', () => {
  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('runs every unit that says how to run its tests, and ingests the results [all-units]', async () => {
    const repo = makeMonorepo();
    const r = await runTestRun(await cfg(repo.dir), {});
    expect(r.exitCode).toBe(0);
    expect(repo.ran().sort()).toEqual(['api', 'tools', 'ui', 'web']);
    expect(ledger(repo.dir)['capabilities/auth#login'].verdict).toBe('proven');
    expect(ledger(repo.dir)['capabilities/design-system#buttons-accessible'].verdict).toBe('proven');
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('--unit runs only the named units and rejects an unknown one [unit-filter]', async () => {
    const repo = makeMonorepo();
    expect((await runTestRun(await cfg(repo.dir), { units: ['web'] })).exitCode).toBe(0);
    expect(repo.ran()).toEqual(['web']);
    const bad = await runTestRun(await cfg(repo.dir), { units: ['nope'] });
    expect(bad.exitCode).toBe(1);
    expect(bad.messages.join('\n')).toContain('unknown unit(s): nope');
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('--affected runs the changed units and everything that depends on them, and nothing else [affected]', async () => {
    const repo = makeMonorepo();
    writeFileSync(path.join(repo.dir, 'packages/ui/src/button.ts'), 'export const button = 2;\n');
    const r = await runTestRun(await cfg(repo.dir), { affected: true });
    expect(r.messages.join('\n')).toContain('1 changed unit(s); testing 3: api, ui, web');
    expect(repo.ran().sort()).toEqual(['api', 'ui', 'web']);
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('a change to a leaf unit tests only that unit [affected-leaf]', async () => {
    const repo = makeMonorepo();
    writeFileSync(path.join(repo.dir, 'packages/web/src/index.ts'), 'export const web = 2;\n');
    await runTestRun(await cfg(repo.dir), { affected: true });
    expect(repo.ran()).toEqual(['web']);
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('runs everything when a changed file is outside every unit, since it could affect any [affected-outside]', async () => {
    const repo = makeMonorepo();
    writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'root', changed: true }));
    const r = await runTestRun(await cfg(repo.dir), { affected: true });
    expect(r.messages.join('\n')).toContain('outside every unit');
    expect(repo.ran().sort()).toEqual(['api', 'tools', 'ui', 'web']);
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('runs nothing when nothing changed, and compares against a ref with --since [affected-none-since]', async () => {
    const repo = makeMonorepo();
    const none = await runTestRun(await cfg(repo.dir), { affected: true });
    expect(none.exitCode).toBe(0);
    expect(repo.ran()).toEqual([]);

    writeFileSync(path.join(repo.dir, 'packages/api/src/index.ts'), 'export const api = 2;\n');
    gitCommit(repo.dir, 'change api');
    await runTestRun(await cfg(repo.dir), { affected: true, since: 'HEAD~1' });
    expect(repo.ran()).toEqual(['api']);
  });
});

describe('--affected needs git [affected-git]', () => {
  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('fails, running nothing, when git cannot list the changes, instead of reporting green [bad-ref]', async () => {
    const repo = makeMonorepo();
    const r = await runTestRun(await cfg(repo.dir), { affected: true, since: 'no-such-ref' });
    expect(r.exitCode).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.messages.join('\n')).toContain('Nothing was run');
    expect(repo.ran()).toEqual([]);
  });

  // [claims: capabilities/workspaces#unit-aware-pipelines]
  it('maps changes to units when the workspace root sits below the git root [subdirectory-root]', async () => {
    const repo = makeMonorepo();
    const outer = mkdtempSync(path.join(os.tmpdir(), 'sg-outer-'));
    const inner = path.join(outer, 'sub');
    mkdirSync(outer, { recursive: true });
    rmSync(path.join(repo.dir, '.git'), { recursive: true, force: true });
    renameSync(repo.dir, inner);
    gitInit(outer);
    writeFileSync(path.join(inner, 'packages/web/src/index.ts'), 'export const web = 3;\n');
    const r = await runTestRun(await cfg(inner), { affected: true });
    expect(r.messages.join('\n')).toContain('1 changed unit(s); testing 1: web');
    expect(readFileSync(path.join(inner, 'ran.log'), 'utf8').trim().split('\n')).toEqual(['web']);
  });
});

describe('claim refs that name a package unit [workspace-claims]', () => {
  // [claims: capabilities/workspaces#unit-claim-refs]
  it('stores a proof for web:capabilities/auth#login under the root claim, so check can see it [unit-ref-proof]', async () => {
    const repo = makeMonorepo();
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'web:capabilities/auth#login', verdict: 'proven' }] }, repo.dir);
    expect(Object.keys(ledger(repo.dir))).toEqual(['capabilities/auth#login']);
    const r = await runCheck(await cfg(repo.dir), {});
    expect(r.messages.join('\n')).toMatch(/PROOFS: 1 proven/);
  });

  // [claims: capabilities/workspaces#unit-claim-refs]
  it('treats a test tag that names a package unit as the root claim [unit-ref-tag]', async () => {
    const repo = makeMonorepo();
    repo.write('a.xml', '<testsuite name="s"><testcase classname="c" name="t @claim:api:capabilities/auth#logout"/></testsuite>');
    await runResultsIngest(['a.xml'], repo.dir);
    expect(Object.keys(ledger(repo.dir))).toEqual(['capabilities/auth#logout']);
  });

  // [claims: capabilities/workspaces#unit-claim-refs]
  it('leaves a ref that names a separate repo alone [repo-ref-untouched]', async () => {
    const repo = makeMonorepo();
    const r = await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'elsewhere:capabilities/auth#login', verdict: 'proven' }] }, repo.dir);
    expect(r.failed).toBe(1);
  });
});
