import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetProbeCache } from '../../src/client/index.js';
import { loadConfig } from '../../src/core/config.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { runPublish } from '../../src/pipelines/publish.js';
import { readPlan, writePlan } from '../../src/pipelines/security-plan.js';
import { planList, planSetStatus, planShow, teamLines } from '../../src/pipelines/team.js';
import { startTestServer, type TestServer } from '../helpers/central.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

let ts: TestServer | undefined;
let repo: TmpRepo;
const saved = { token: process.env.SPECGUARD_TOKEN, server: process.env.SPECGUARD_SERVER };

beforeEach(() => {
  delete process.env.SPECGUARD_TOKEN;
  delete process.env.SPECGUARD_SERVER;
  process.env.HOME = repoHome();
  resetProbeCache();
});
afterEach(async () => {
  await ts?.stop();
  ts = undefined;
  for (const [k, v] of [['SPECGUARD_TOKEN', saved.token], ['SPECGUARD_SERVER', saved.server]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetProbeCache();
});

function repoHome(): string {
  return path.join(makeV2Repo().dir, 'home');
}

const planItem = (id: string, fp: string) => ({ id, title: id, severity: 'high', type: 'code', change: 'code', summary: 's', findings: [{ id, detector: 'semgrep', message: 'm' }], capability: 'auth', claims: [], files: ['src/auth/login.ts'], verify: { scope: 'listed', claims: [] }, status: 'open', statusHistory: [], fingerprint: fp });

/** A repo with a plan, configured for a server (or not), publishing to a running one when asked. */
async function project(over: { server?: Record<string, unknown> | null; publish?: boolean; token?: boolean } = {}) {
  ts = await startTestServer();
  const serverBlock = over.server === null ? {} : { server: { url: ts.base, project: 'demo', timeoutMs: 400, ...over.server } };
  repo = makeV2Repo(serverBlock);
  repo.write('.gitignore', '.specguard/\n');
  const config = await loadConfig(repo.dir);
  await writePlan(config, { version: 1, id: 'scan-1', createdAt: '2026-10-15T00:00:00Z', tool: { name: 'specguard' }, items: [planItem('sec-a', 'fa'), planItem('sec-b', 'fb')] } as never);
  const token = await ts.mint({ name: 'dev', role: 'maintainer', project: 'demo', owner: 'dev@plymouthrock.com' });
  if (over.token !== false) process.env.SPECGUARD_TOKEN = token;
  if (over.publish !== false) {
    const res = await runPublish(await loadConfig(repo.dir), { push: true });
    expect(res.exitCode, res.messages.join('\n')).toBe(0);
  }
  return { config: await loadConfig(repo.dir), token };
}

const localPlan = async (id = 'scan-1') => readPlan(await loadConfig(repo.dir), id)!;

describe('publish --push [publish-push]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('sends the snapshot to the server and the project appears there [push]', async () => {
    const { config } = await project({ publish: false });
    const res = await runPublish(config, { push: true });
    expect(res.exitCode).toBe(0);
    expect(res.messages.join('\n')).toContain('pushed to');
    const body = await (await fetch(`${ts!.base}/api/v1/projects`, { headers: { Authorization: `Bearer ${process.env.SPECGUARD_TOKEN}` } })).json();
    expect(body.projects.map((p: { name: string }) => p.name)).toEqual(['demo']);
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('fails, and says why, when the token is wrong, the server is down, or no server is configured [push-failures]', async () => {
    const { config } = await project({ publish: false });
    process.env.SPECGUARD_TOKEN = 'sg_wrong';
    const refused = await runPublish(config, { push: true });
    expect(refused.exitCode).toBe(1);
    expect(refused.messages.join('\n')).toMatch(/refused the snapshot \(401\)/);
    const down = await runPublish(await loadConfig(makeV2Repo({ server: { url: 'http://127.0.0.1:1' } }).dir), { push: true });
    expect(down.exitCode).toBe(1);
    expect(down.messages.join('\n')).toContain('could not push');
    const none = await runPublish(await loadConfig(makeV2Repo().dir), { push: true });
    expect(none.exitCode).toBe(2);
    expect(none.messages.join('\n')).toContain('needs a server');
    // The snapshot file is still written, so CI can upload it and the server can fetch it.
    expect(readFileSync(path.join(repo.dir, '.specguard/publish/snapshot.json'), 'utf8')).toContain('"project":"demo"');
  });
});

describe('plan reads [team-plan-reads]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('reads plans from the server when it answers, and from local files, saying so, when it does not [read-fallback]', async () => {
    const { config } = await project();
    const fromServer = await planList(config);
    expect(fromServer.messages.join('\n')).toContain('scan-1');
    expect(fromServer.messages).toContain('[source: server]');
    expect((await planShow(config, 'latest')).messages).toContain('[source: server]');
    await ts!.stop();
    ts = undefined;
    resetProbeCache();
    const local = await planList(config);
    expect(local.messages.join('\n')).toContain('scan-1');
    expect(local.messages.join('\n')).toMatch(/\[source: local; /);
    expect((await planShow(config, 'latest')).messages.join('\n')).toContain('sec-a');
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('reads locally, without trying a server, when none is configured [no-server]', async () => {
    const { config } = await project({ server: null, publish: false });
    const res = await planList(config);
    expect(res.messages).toContain('[source: local]');
  });
});

describe('plan writes [team-plan-writes]', () => {
  const stateOnServer = async (id: string) => {
    const res = await fetch(`${ts!.base}/api/v1/projects/demo/security/plans/scan-1`, { headers: { Authorization: `Bearer ${process.env.SPECGUARD_TOKEN}` } });
    return ((await res.json()) as { items: Array<{ id: string; status: string; externalRef?: string }> }).items.find((i) => i.id === id)!;
  };

  // [claims: capabilities/team-server#local-first-fallback]
  it('writes to the server when it answers, and leaves the local plan alone [write-server]', async () => {
    const { config } = await project();
    const res = await planSetStatus(config, 'scan-1', 'sec-a', 'in-progress', { note: 'on it', externalRef: 'SEC-5' });
    expect(res.exitCode).toBe(0);
    expect(res.messages).toContain('[written to the team server]');
    expect(await stateOnServer('sec-a')).toMatchObject({ status: 'in-progress', externalRef: 'SEC-5' });
    expect((await localPlan()).items[0].status).toBe('open');
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('writes locally and says it is local-only when the server does not answer [write-local]', async () => {
    const { config } = await project();
    await ts!.stop();
    ts = undefined;
    resetProbeCache();
    const res = await planSetStatus(config, 'scan-1', 'sec-a', 'in-progress', { note: 'offline' });
    expect(res.exitCode).toBe(0);
    expect(res.messages.join('\n')).toContain('[local-only');
    expect((await localPlan()).items[0].status).toBe('in-progress');
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('does not hide a refusal by writing locally: a wrong token is an error and nothing changes [no-silent-switch]', async () => {
    const { config } = await project();
    process.env.SPECGUARD_TOKEN = 'sg_wrong';
    resetProbeCache();
    const res = await planSetStatus(config, 'scan-1', 'sec-a', 'in-progress');
    expect(res.exitCode).toBe(1);
    expect(res.messages.join('\n')).toContain('specguard login');
    expect((await localPlan()).items[0].status).toBe('open');
    process.env.SPECGUARD_TOKEN = await ts!.mint({ name: 'viewer', role: 'viewer', project: 'demo', owner: 'v@x' });
    resetProbeCache();
    const viewer = await planSetStatus(config, 'scan-1', 'sec-a', 'in-progress');
    expect(viewer.exitCode).toBe(1);
    expect(viewer.messages.join('\n')).toMatch(/may not/);
    expect((await localPlan()).items[0].status).toBe('open');
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('writes locally when the plan has not been published yet, and reports a lifecycle violation instead of working around it [not-on-server]', async () => {
    const { config } = await project();
    await writePlan(config, { version: 1, id: 'scan-2', createdAt: '2026-10-16T00:00:00Z', tool: { name: 'specguard' }, items: [planItem('sec-z', 'fz')] } as never);
    const local = await planSetStatus(config, 'scan-2', 'sec-z', 'in-progress');
    expect(local.exitCode).toBe(0);
    expect(local.messages.join('\n')).toContain('[local-only');
    expect((await localPlan('scan-2')).items[0].status).toBe('in-progress');
    // open -> verified is not allowed; the server's 422 is reported, and the local plan is untouched.
    const bad = await planSetStatus(config, 'scan-1', 'sec-b', 'verified');
    expect(bad.exitCode).toBe(2);
    expect(bad.messages.join('\n')).toContain('cannot move');
    expect((await localPlan()).items[1].status).toBe('open');
  });
});

describe('check --team [team-check]', () => {
  // [claims: capabilities/team-server#local-first-fallback]
  it('shows CI\'s proofs set against this working tree\'s [lines]', async () => {
    await ingestVerdicts({ runId: 'ci', verdicts: [{ claim: 'capabilities/auth#login-valid-code', verdict: 'proven' }] }, (await (async () => { ts = await startTestServer(); repo = makeV2Repo({ server: { url: ts.base, project: 'demo', timeoutMs: 400 } }); return repo; })()).dir, { provenance: { origin: 'ci', branch: 'main' } });
    process.env.SPECGUARD_TOKEN = await ts!.mint({ name: 'dev', role: 'maintainer', project: 'demo', owner: 'dev@x' });
    expect((await runPublish(await loadConfig(repo.dir), { push: true })).exitCode).toBe(0);
    // This working tree has not proven it: the ledger is gone.
    rmSync(path.join(repo.dir, '.specguard/proofs.json'));
    const lines = await teamLines(await loadConfig(repo.dir));
    expect(lines[0]).toMatch(/^TEAM: demo.*1 proven/);
    expect(lines.join('\n')).toContain('proven in CI but not here: 1 (capabilities/auth#login-valid-code)');
    expect(lines.join('\n')).toContain('proven here but not in CI: 0');
  });

  // [claims: capabilities/team-server#local-first-fallback]
  it('says no server answered rather than failing [degraded]', async () => {
    const config = await loadConfig(makeV2Repo({ server: { url: 'http://127.0.0.1:1', timeoutMs: 300 } }).dir);
    expect((await teamLines(config))[0]).toMatch(/^TEAM: no server answered/);
  });
});
