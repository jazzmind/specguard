import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { WORKSPACE_PUBLISH_CHECK_SCHEMA, type PublishCheck, type WorkspacePublishCheck } from '../../src/core/publish-contract.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import { runWorkspacePublish } from '../../src/pipelines/workspace-publish.js';
import { startFakeServer, type FakeServer } from '../helpers/fake-publish-server.js';
import { makeOverlayWorkspace, type OverlayWorkspace } from '../helpers/overlay-fixture.js';
import { playwrightWith } from '../helpers/publish-fixture.js';
import { gitCommit, SYSTEM_SPEC } from '../helpers/v2-repo.js';

const ENV = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'CI', 'SPECGUARD_SERVER', 'SPECGUARD_TOKEN', 'SPECGUARD_PROJECT', 'SPECGUARD_OVERLAY', 'SPECGUARD_CONFIG'] as const;
const saved: Record<string, string | undefined> = {};
let server: FakeServer | undefined;
beforeEach(() => {
  for (const v of ENV) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(async () => {
  for (const v of ENV) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  await server?.close();
  server = undefined;
});

/** Two apps (`apps/api`, `apps/web`) in ONE git repo, each with its own `.specguard` config, and a workspace manifest over them. */
function overlayWithManifest(): OverlayWorkspace {
  const ws = makeOverlayWorkspace({ git: true });
  ws.write(path.join(ws.webApp, 'specs/system.md'), SYSTEM_SPEC);
  ws.write(
    path.join(ws.specs, '.specguard/workspace.json'),
    JSON.stringify({ version: '1', name: 'Shop', repos: { api: { path: 'apps/api', role: 'provider' }, web: { path: 'apps/web', role: 'consumer' } } }),
  );
  gitCommit(ws.specs, 'add web specs and manifest');
  return ws;
}

const repoCheck = (c: WorkspacePublishCheck, key: string): PublishCheck => c.repos.find((r) => 'key' in r && r.key === key) as PublishCheck;

describe('workspace publish --check [workspace-publish-check]', () => {
  // [claims: capabilities/team-server#publish-state-check]
  it('checks each overlay repo by its own config and digest although every app shares one commit', async () => {
    const ws = overlayWithManifest();
    server = await startFakeServer();
    const opts = { server: server.url, env: ws.env, token: undefined };
    const first = await runWorkspacePublish(ws.specs, ws.specs, { ...opts, check: true });
    const check = first.publish as WorkspacePublishCheck;
    expect(check).toMatchObject({ schema: WORKSPACE_PUBLISH_CHECK_SCHEMA, workspace: 'shop', definition: { needsPublish: true, reasons: ['missing'] } });
    expect(first.exitCode).toBe(9);
    expect(check.repos.map((r) => ('project' in r ? [r.key, r.project, r.reasons] : r))).toEqual([['api', 'api', ['never-published']], ['web', 'web', ['never-published']]]);

    const sent = await runWorkspacePublish(ws.specs, ws.specs, { ...opts, repos: true });
    expect(sent.exitCode, sent.messages.join('\n')).toBe(0);
    expect([...server.snapshots.keys()].sort()).toEqual(['api', 'web']);
    const apiCommit = server.snapshots.get('api')![0].commit;
    expect(apiCommit).toBeTruthy();
    expect(server.snapshots.get('web')![0].commit).toBe(apiCommit);

    const clean = await runWorkspacePublish(ws.specs, ws.specs, { ...opts, check: true });
    expect(clean.exitCode, JSON.stringify(clean.publish)).toBe(0);
    expect((clean.publish as WorkspacePublishCheck).repos.every((r) => 'needsPublish' in r && !r.needsPublish)).toBe(true);

    // Edit only the api app's spec and commit: both apps are at the same new commit, yet only api needs a publish.
    ws.write(path.join(ws.apiApp, 'specs/capabilities/shop.md'), '---\nid: shop\nkind: capability\nparent: system\nvalue: v\nstatus: active\nsources:\n  - "src/shop/**"\n---\n# Shop\n\n## Problem & Value\n\nChanged.\n');
    gitCommit(ws.specs, 'change api spec');
    const changed = await runWorkspacePublish(ws.specs, ws.specs, { ...opts, check: true });
    const cc = changed.publish as WorkspacePublishCheck;
    expect(changed.exitCode).toBe(9);
    expect(repoCheck(cc, 'api')).toMatchObject({ needsPublish: true, reasons: expect.arrayContaining(['specs-changed']) });
    expect(repoCheck(cc, 'api').specFiles.modified).toEqual(['specs/capabilities/shop.md']);
    expect(repoCheck(cc, 'web')).toMatchObject({ needsPublish: false, reasons: [], commitDiffers: true });
    expect(cc.server).toMatchObject({ reachable: true, signedIn: true, role: 'maintainer' });
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('--only limits the check; a repo that cannot be loaded is an error row and the rest still answer', async () => {
    const ws = overlayWithManifest();
    server = await startFakeServer();
    const only = await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env, check: true, only: ['web'] });
    expect((only.publish as WorkspacePublishCheck).repos.map((r) => r.key)).toEqual(['web']);

    writeFileSync(path.join(ws.specs, '.specguard/workspace.json'), JSON.stringify({ version: '1', name: 'Shop', repos: { api: { path: 'apps/api', role: 'provider' }, gone: { path: 'apps/gone', role: 'consumer' } } }));
    const mixed = await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env, check: true });
    const rows = (mixed.publish as WorkspacePublishCheck).repos;
    expect(rows.find((r) => r.key === 'gone')).toEqual({ key: 'gone', error: expect.any(String) });
    expect(rows.find((r) => r.key === 'api')).toMatchObject({ needsPublish: true });
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('detects a definition that differs from the server and answers cleanly when no server is configured', async () => {
    const ws = overlayWithManifest();
    server = await startFakeServer();
    await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env });
    expect(((await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env, check: true })).publish as WorkspacePublishCheck).definition).toEqual({ needsPublish: false, reasons: [] });
    writeFileSync(path.join(ws.specs, '.specguard/workspace.json'), JSON.stringify({ version: '1', name: 'Shop', repos: { api: { path: 'apps/api', role: 'provider' } } }));
    expect(((await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env, check: true })).publish as WorkspacePublishCheck).definition).toEqual({ needsPublish: true, reasons: ['projects-differ'] });

    const none = await runWorkspacePublish(ws.specs, ws.specs, { env: ws.env, check: true });
    expect(none.publish).toEqual({ schema: WORKSPACE_PUBLISH_CHECK_SCHEMA, workspace: 'shop', server: { url: '', reachable: false, signedIn: false, features: [] }, definition: { needsPublish: false, reasons: [] }, repos: [] });
    expect(none.exitCode).toBe(0);
  });
});

describe('workspace publish --repos [workspace-publish-repos]', () => {
  // [claims: capabilities/team-server#publish-back-compat]
  it('by default publishes the definition only: one PUT, no snapshots, no run routes', async () => {
    const ws = overlayWithManifest();
    server = await startFakeServer();
    const res = await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env });
    expect(res.exitCode).toBe(0);
    expect(server.log).toEqual(['PUT /api/v1/workspaces/shop']);
    expect(res.messages.join('\n')).toContain('each repo still needs its own');
    expect(server.workspaces.get('shop').projects.map((p: { project: string }) => p.project)).toEqual(['api', 'web']);
  });

  // [claims: capabilities/team-server#publish-state-check]
  it('--repos --only publishes just those repos, each with its own config', async () => {
    const ws = overlayWithManifest();
    server = await startFakeServer();
    const res = await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env, repos: true, only: ['web'] });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect([...server.snapshots.keys()]).toEqual(['web']);
    expect(server.snapshots.get('web')![0].project).toBe('web');
    expect(res.messages.some((m) => m.startsWith('[web] pushed to'))).toBe(true);
  });

  // [claims: capabilities/team-server#evidence-upload-protocol]
  it('--evidence uploads each repo\'s newest run, with progress tagged by repo key', async () => {
    const ws = overlayWithManifest();
    ws.write(path.join(ws.apiApp, 'shots/a.png'), 'png-bytes');
    ws.write(path.join(ws.apiApp, 'reports/pw.json'), playwrightWith([{ name: 'shot', contentType: 'image/png', path: 'shots/a.png' }]));
    await runResultsIngest(['reports/pw.json'], ws.apiApp, { runId: 'api-run' });
    server = await startFakeServer();
    const keys = new Set<string>();
    const res = await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env, repos: true, evidence: 'all', only: ['api'], onProgress: (p) => keys.add(String(p.key)) });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
    expect(server.manifests.get('api')![0]).toMatchObject({ status: 'complete', manifest: { runId: 'api-run', project: 'api' } });
    expect([...keys]).toEqual(['api']);
    expect((await loadConfig(ws.apiApp)).rootDir).toBe(ws.apiApp);
    // A repo without a recorded run fails on its own and the failure is reported, not thrown.
    const both = await runWorkspacePublish(ws.specs, ws.specs, { server: server.url, env: ws.env, repos: true, evidence: 'all' });
    expect(both.failed).toBe(1);
    expect(both.messages.join('\n')).toContain('[web] no recorded runs');
  });
});

describe('workspace publish against a minimal fetch [workspace-publish-compat]', () => {
  // [claims: capabilities/team-server#publish-back-compat]
  it('still works with a fetch that returns only ok, status and text', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-wspub2-'));
    mkdirSync(path.join(dir, 'ws/.specguard'), { recursive: true });
    mkdirSync(path.join(dir, 'a/.specguard'), { recursive: true });
    writeFileSync(path.join(dir, 'ws/.specguard/workspace.json'), JSON.stringify({ version: '1', name: 'W', repos: { a: { path: '../a', role: 'consumer' } } }));
    writeFileSync(path.join(dir, 'a/.specguard/config.json'), JSON.stringify({ apps: [{ name: 'a', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }], llm: { provider: 'none', model: 'none', apiKeyEnv: 'N' } }));
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: { method?: string }) => {
      calls.push(`${init.method} ${url}`);
      return { ok: true, status: 200, text: async () => '{}' };
    }) as never;
    const res = await runWorkspacePublish(path.join(dir, 'ws'), path.join(dir, 'ws'), { server: 'http://sandbox/sg', token: 't', fetchImpl });
    expect(res.exitCode).toBe(0);
    expect(calls).toEqual(['PUT http://sandbox/sg/api/v1/workspaces/w']);
  });
});
