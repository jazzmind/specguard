import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(),
  llmGenerateObject: vi.fn(),
  resolveTargets: vi.fn((o: { model: string }) => [{ provider: 'p', model: o.model }]),
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {},
}));

import { loadConfig } from '../../src/core/config.js';
import { currentLlmScope } from '../../src/core/llm-runtime.js';
import { llmGenerateText } from '../../src/core/llm.js';
import { writePlan } from '../../src/pipelines/security-plan.js';
import { buildSnapshot } from '../../src/pipelines/publish.js';
import { fileBackend } from '../../src/server/central/file-backend.js';
import { startCentralServer, type RunningCentralServer } from '../../src/server/central/server.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const BOOTSTRAP = 'bootstrap-secret-for-tests';
const ADA = { 'x-deploykit-email': 'ada@plymouthrock.com' };
const BOB = { 'x-deploykit-email': 'bob@plymouthrock.com' };
const llm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;

let server: RunningCentralServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(over: { basePath?: string; maxBodyBytes?: number } = {}) {
  const backend = fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-central-')));
  server = await startCentralServer({
    backend,
    llm: { provider: 'litellm', model: 'fast', apiKeyEnv: 'NOKEY' },
    port: 0,
    host: '127.0.0.1',
    workDir: mkdtempSync(path.join(os.tmpdir(), 'sg-central-work-')),
    auth: { bootstrapToken: BOOTSTRAP, maintainerEmails: ['ada@plymouthrock.com'], allowedDomain: 'plymouthrock.com' },
    ...over,
  });
  return { backend, base: server.url };
}

type Init = { method?: string; headers?: Record<string, string>; body?: unknown };
async function call(base: string, p: string, init: Init = {}) {
  const res = await fetch(`${base}${p}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function adminMint(base: string, body: Record<string, unknown>) {
  const res = await call(base, '/api/v1/admin/tokens', { method: 'POST', headers: bearer(BOOTSTRAP), body });
  expect(res.status, res.text).toBe(201);
  return res.json.token as string;
}

async function snapshotOf(project: string, over: { plan?: boolean } = {}) {
  const repo = makeV2Repo();
  const config = await loadConfig(repo.dir);
  if (over.plan) {
    const item = (id: string, fp: string) => ({ id, title: id, severity: 'high', type: 'code', change: 'code', summary: 's', findings: [{ id, detector: 'semgrep', message: 'm' }], capability: 'auth', claims: [], files: ['src/auth/login.ts'], verify: { scope: 'listed', claims: [] }, status: 'open', statusHistory: [], fingerprint: fp });
    await writePlan(config, { version: 1, id: 'scan-1', createdAt: '2026-10-15T00:00:00Z', tool: { name: 'specguard' }, items: [item('sec-a', 'fa'), item('sec-b', 'fb')] } as never);
  }
  return buildSnapshot(await loadConfig(repo.dir), { project });
}

describe('team server: access [central-access]', () => {
  // [claims: capabilities/team-server#team-server-auth]
  it('serves health to anyone and everything else only to a valid credential [auth-gate]', async () => {
    const { base } = await start();
    expect((await call(base, '/api/v1/health')).json).toMatchObject({ ok: true, writable: true });
    const anon = await call(base, '/api/v1/projects');
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toBe('Bearer');
    const bad = await call(base, '/api/v1/projects', { headers: bearer('sg_not-a-real-token') });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('invalid_token');
    // A bad token is refused even when a signed-in header is also present.
    expect((await call(base, '/api/v1/projects', { headers: { ...ADA, ...bearer('sg_nope') } })).status).toBe(401);
    expect((await call(base, '/api/v1/projects', { headers: ADA })).status).toBe(200);
    // The header is only accepted for the configured domain.
    expect((await call(base, '/api/v1/projects', { headers: { 'x-deploykit-email': 'eve@example.com' } })).status).toBe(401);
  });

  // [claims: capabilities/team-server#team-server-auth]
  it('is mounted under its base path and nowhere else [base-path]', async () => {
    const { base } = await start({ basePath: '/specguard' });
    expect(base.endsWith('/specguard')).toBe(true);
    expect((await call(base, '/api/v1/health')).status).toBe(200);
    const root = base.replace(/\/specguard$/, '');
    expect((await call(root, '/api/v1/health')).status).toBe(404);
    const ui = await call(base, '/');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('<meta name="sg-base" content="/specguard">');
    expect(ui.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  // [claims: capabilities/team-server#team-server-auth]
  it('refuses a request target that is not a valid path, and an oversized body [bad-input]', async () => {
    // A small limit, so the whole body is sent before the refusal and the answer is deterministic.
    const { base } = await start({ maxBodyBytes: 2000 });
    const token = await adminMint(base, { name: 'big', role: 'admin' });
    expect((await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(token), body: 'x'.repeat(50_000) })).status).toBe(413);
    expect((await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(token), body: '{ nope' })).status).toBe(400);
    expect((await call(base, '/api/v1/projects/%E0%A4%A', { headers: ADA })).status).toBeLessThan(500);
  });
});

describe('team server: tokens [central-tokens]', () => {
  // [claims: capabilities/team-server#team-server-auth]
  it('lets a signed-in user mint their own token, never more power than they hold, and revoke it [own-tokens]', async () => {
    const { base } = await start();
    const mine = await call(base, '/api/v1/tokens', { method: 'POST', headers: { ...ADA, 'x-requested-with': 'specguard' }, body: { name: 'laptop' } });
    expect(mine.status).toBe(201);
    expect(mine.json).toMatchObject({ role: 'maintainer', name: 'laptop' });
    expect(mine.json.token).toMatch(/^sg_/);
    // Ada is a maintainer by sign-in; Bob is a viewer and cannot mint a maintainer token.
    expect((await call(base, '/api/v1/tokens', { method: 'POST', headers: { ...BOB, 'x-requested-with': 'specguard' }, body: { name: 'x', role: 'maintainer' } })).status).toBe(403);
    expect((await call(base, '/api/v1/tokens', { method: 'POST', headers: { ...ADA, 'x-requested-with': 'specguard' }, body: { name: 'x', role: 'admin' } })).status).toBe(403);
    // The token works, is listed without its secret, and stops working once revoked.
    expect((await call(base, '/api/v1/projects', { headers: bearer(mine.json.token) })).status).toBe(200);
    const listed = await call(base, '/api/v1/tokens', { headers: ADA });
    expect(listed.json.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.json)).not.toContain(mine.json.token);
    expect((await call(base, `/api/v1/tokens/${mine.json.id}`, { method: 'DELETE', headers: { ...ADA, 'x-requested-with': 'specguard' } })).status).toBe(200);
    expect((await call(base, '/api/v1/projects', { headers: bearer(mine.json.token) })).status).toBe(401);
    // Someone else cannot revoke it.
    const other = await call(base, '/api/v1/tokens', { method: 'POST', headers: { ...ADA, 'x-requested-with': 'specguard' }, body: { name: 'second' } });
    expect((await call(base, `/api/v1/tokens/${other.json.id}`, { method: 'DELETE', headers: { ...BOB, 'x-requested-with': 'specguard' } })).status).toBe(404);
  });

  // [claims: capabilities/team-server#team-server-auth]
  it('reserves administration for an admin token: the header never grants it, and the bootstrap token does [admin]', async () => {
    const { base } = await start();
    expect((await call(base, '/api/v1/admin/tokens', { method: 'POST', headers: { ...ADA, 'x-requested-with': 'specguard' }, body: { name: 'x', role: 'admin' } })).status).toBe(403);
    const adminToken = await adminMint(base, { name: 'ops', role: 'admin', owner: 'ops@plymouthrock.com' });
    const ci = await call(base, '/api/v1/admin/tokens', { method: 'POST', headers: bearer(adminToken), body: { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' } });
    expect(ci.status).toBe(201);
    expect(ci.json.project).toBe('demo');
    expect((await call(base, '/api/v1/admin/tokens', { method: 'POST', headers: bearer(adminToken), body: { name: '', role: 'admin' } })).status).toBe(400);
    expect((await call(base, '/api/v1/admin/tokens', { method: 'POST', headers: bearer(adminToken), body: { name: 'x', project: '../etc' } })).status).toBe(400);
  });

  // [claims: capabilities/team-server#team-server-auth]
  it('records who made and revoked tokens in the audit log [audit]', async () => {
    const { base, backend } = await start();
    const created = await call(base, '/api/v1/tokens', { method: 'POST', headers: { ...ADA, 'x-requested-with': 'specguard' }, body: { name: 'laptop' } });
    await call(base, `/api/v1/tokens/${created.json.id}`, { method: 'DELETE', headers: { ...ADA, 'x-requested-with': 'specguard' } });
    const audit = await backend.readAudit();
    expect(audit.map((a) => [a.actor, a.action])).toEqual([
      ['ada@plymouthrock.com', 'token.create'],
      ['ada@plymouthrock.com', 'token.revoke'],
    ]);
    expect(JSON.stringify(audit)).not.toContain('sg_');
  });
});

describe('team server: publishing [central-publish]', () => {
  // [claims: capabilities/team-server#team-server-publish]
  it('accepts a snapshot from a project\'s CI token and serves the project from it [publish-and-read]', async () => {
    const { base } = await start();
    const ci = await adminMint(base, { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' });
    const snap = await snapshotOf('demo');
    const posted = await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: snap });
    expect(posted.status, posted.text).toBe(201);
    const sys = await call(base, '/api/v1/projects/demo/system', { headers: BOB });
    expect(sys.json.capabilities.map((c: { id: string }) => c.id)).toEqual(['auth', 'shop']);
    const projects = await call(base, '/api/v1/projects', { headers: BOB });
    expect(projects.json.projects).toEqual([expect.objectContaining({ name: 'demo', kind: 'snapshot' })]);
    expect(projects.json.default).toBeNull();
    // Specs and coverage come from the snapshot, with no source files on the server.
    expect((await call(base, '/api/v1/projects/demo/specs', { headers: BOB })).json.specs.length).toBe(3);
    expect((await call(base, '/api/v1/projects/demo/coverage', { headers: BOB })).json.unowned).toEqual(['src/orphan.ts']);
  });

  // [claims: capabilities/team-server#team-server-publish]
  it('keeps a credential to its own project, and refuses viewers, bad snapshots and a mismatched name [publish-guards]', async () => {
    const { base } = await start();
    const ci = await adminMint(base, { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' });
    const snap = await snapshotOf('demo');
    // Another project is out of reach, to read or to write.
    expect((await call(base, '/api/v1/projects/other/snapshots', { method: 'POST', headers: bearer(ci), body: { ...snap, project: 'other' } })).status).toBe(403);
    expect((await call(base, '/api/v1/projects/other/system', { headers: bearer(ci) })).status).toBe(403);
    // A viewer, or a browser session without the CSRF header, cannot publish.
    expect((await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: BOB, body: snap })).status).toBe(403);
    expect((await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: { ...BOB, 'x-requested-with': 'specguard' }, body: snap })).status).toBe(403);
    // A body that is not a snapshot, or names another project than the URL, is refused.
    expect((await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: '{ nope' })).status).toBe(400);
    expect((await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: { ...snap, project: 'other' } })).status).toBe(400);
    expect((await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: { ...snap, files: { '../x.md': 'x' } } })).status).toBe(400);
  });

  // [claims: capabilities/team-server#team-server-publish]
  it('keeps what trackers changed when CI publishes a newer plan [plan-survives-republish]', async () => {
    const { base } = await start();
    const ci = await adminMint(base, { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' });
    const first = await snapshotOf('demo', { plan: true });
    await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: first });
    const tracker = await adminMint(base, { name: 'tracker', role: 'maintainer', project: 'demo', owner: 'tracker@plymouthrock.com' });
    const patched = await call(base, '/api/v1/projects/demo/security/plans/scan-1/items/sec-a', { method: 'PATCH', headers: bearer(tracker), body: { status: 'in-progress', externalRef: 'SEC-12', note: 'assigned' } });
    expect(patched.status, patched.text).toBe(200);
    // CI publishes again; its plan knows nothing of the tracker's change.
    const second = await snapshotOf('demo', { plan: true });
    await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: second });
    const plan = await call(base, '/api/v1/projects/demo/security/plans/scan-1', { headers: BOB });
    const a = plan.json.items.find((i: { id: string }) => i.id === 'sec-a');
    expect(a).toMatchObject({ status: 'in-progress', externalRef: 'SEC-12' });
    expect(a.statusHistory.at(-1)).toMatchObject({ by: 'tracker@plymouthrock.com', note: 'assigned' });
    expect(plan.json.items.find((i: { id: string }) => i.id === 'sec-b').status).toBe('open');
  });

  // [claims: capabilities/team-server#guarded-writes]
  it('requires a token for plan changes made through the API, attributing them to its owner, and the CSRF header for browser sessions [writes]', async () => {
    const { base } = await start();
    const ci = await adminMint(base, { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' });
    await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: await snapshotOf('demo', { plan: true }) });
    const url = '/api/v1/projects/demo/security/plans/scan-1/items/sec-a';
    // A signed-in maintainer in a browser must send the same-origin header.
    expect((await call(base, url, { method: 'PATCH', headers: ADA, body: { status: 'in-progress' } })).status).toBe(403);
    expect((await call(base, url, { method: 'PATCH', headers: { ...ADA, 'x-requested-with': 'specguard' }, body: { status: 'in-progress' } })).status).toBe(200);
    // A viewer cannot.
    expect((await call(base, url, { method: 'PATCH', headers: { ...BOB, 'x-requested-with': 'specguard' }, body: { status: 'fixed' } })).status).toBe(403);
    // The name in the body never overrides the authenticated user.
    const res = await call(base, url, { method: 'PATCH', headers: { ...ADA, 'x-requested-with': 'specguard', 'if-match': '1' }, body: { status: 'fixed', by: 'someone-else' } });
    expect(res.status).toBe(200);
    expect(res.json.item.statusHistory.at(-1).by).toBe('ada@plymouthrock.com');
  });
});

describe('team server: documents [central-docs]', () => {
  // [claims: capabilities/team-server#team-server-docs]
  it('generates a document once for everyone, and attributes the model spend to whoever asked [docs-shared-and-attributed]', async () => {
    const { base, backend } = await start();
    const ci = await adminMint(base, { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' });
    await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: await snapshotOf('demo') });
    llm.mockImplementation(async () => {
      const scope = currentLlmScope();
      scope?.onUsage?.({ pipeline: 'docs', model: 'fast', inputTokens: 100, outputTokens: 50, estimatedUsd: 0.001, unpriced: false, ...(scope.user ? { user: scope.user } : {}) });
      return '# Guide';
    });
    const first = await call(base, '/api/v1/projects/demo/docs/user/auth', { headers: ADA });
    expect(first.json).toMatchObject({ markdown: '# Guide', generated: true, cached: false });
    // A different person asking for the same document is served from the shared cache, at no cost.
    const second = await call(base, '/api/v1/projects/demo/docs/user/auth', { headers: BOB });
    expect(second.json).toMatchObject({ markdown: '# Guide', cached: true });
    expect(llm).toHaveBeenCalledTimes(1);
    const usage = await backend.readUsage();
    expect(usage).toEqual([expect.objectContaining({ user: 'ada@plymouthrock.com', project: 'demo', pipeline: 'docs', model: 'fast', inputTokens: 100 })]);
    // The model was given the requester and the project to send to the gateway.
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe('team server: MCP endpoint [central-mcp]', () => {
  const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
  const mcpHeaders = (token: string) => ({ ...bearer(token), accept: 'application/json, text/event-stream' });

  async function ready() {
    const { base } = await start();
    const ci = await adminMint(base, { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' });
    await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: await snapshotOf('demo') });
    const reader = await adminMint(base, { name: 'desktop', role: 'viewer', owner: 'ada@plymouthrock.com' });
    return { base, reader, ci };
  }

  /** The tool result text of a JSON-RPC answer, which may arrive as plain JSON or as one SSE event. */
  const resultOf = (text: string): any => {
    const data = text.startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
    return JSON.parse(data);
  };

  // [claims: capabilities/team-server#remote-mcp]
  it('needs a token, lists read-only tools, and answers them through the API as the caller [mcp]', async () => {
    const { base, reader } = await ready();
    expect((await call(base, '/mcp', { method: 'POST', body: rpc(1, 'tools/list') })).status).toBe(401);
    expect((await call(base, '/mcp', { method: 'POST', headers: ADA, body: rpc(1, 'tools/list') })).status).toBe(401);
    const list = resultOf((await call(base, '/mcp', { method: 'POST', headers: mcpHeaders(reader), body: rpc(1, 'tools/list') })).text);
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['specguard_audit', 'specguard_capability', 'specguard_coverage', 'specguard_docs', 'specguard_findings', 'specguard_history', 'specguard_plans', 'specguard_projects', 'specguard_read_spec', 'specguard_system']);
    const system = resultOf((await call(base, '/mcp', { method: 'POST', headers: mcpHeaders(reader), body: rpc(2, 'tools/call', { name: 'specguard_system', arguments: { project: 'demo' } }) })).text);
    expect(JSON.parse(system.result.content[0].text).capabilities.map((c: { id: string }) => c.id)).toEqual(['auth', 'shop']);
    const spec = resultOf((await call(base, '/mcp', { method: 'POST', headers: mcpHeaders(reader), body: rpc(3, 'tools/call', { name: 'specguard_read_spec', arguments: { project: 'demo', id: 'auth' } }) })).text);
    expect(JSON.parse(spec.result.content[0].text).markdown).toContain('## Problem & Value');
    const missing = resultOf((await call(base, '/mcp', { method: 'POST', headers: mcpHeaders(reader), body: rpc(4, 'tools/call', { name: 'specguard_system', arguments: { project: 'nope' } }) })).text);
    expect(missing.result.isError).toBe(true);
  });

  // [claims: capabilities/team-server#remote-mcp]
  it('keeps a project-scoped token to its project even through MCP [mcp-scope]', async () => {
    const { base, ci } = await ready();
    const other = resultOf((await call(base, '/mcp', { method: 'POST', headers: mcpHeaders(ci), body: rpc(5, 'tools/call', { name: 'specguard_system', arguments: { project: 'other' } }) })).text);
    expect(other.result.isError).toBe(true);
    expect(other.result.content[0].text).toContain('limited to project');
  });
});

describe('team server: spec files [central-spec-file]', () => {
  // [claims: capabilities/team-server#project-scoped-api]
  it('serves one spec\'s markdown from the snapshot [spec-file]', async () => {
    const { base } = await start();
    const ci = await adminMint(base, { name: 'ci', role: 'maintainer', project: 'demo', owner: 'ci:demo' });
    await call(base, '/api/v1/projects/demo/snapshots', { method: 'POST', headers: bearer(ci), body: await snapshotOf('demo') });
    const spec = await call(base, '/api/v1/projects/demo/specs/auth', { headers: BOB });
    expect(spec.json).toMatchObject({ id: 'auth', kind: 'capability', file: 'specs/capabilities/auth.md' });
    expect(spec.json.markdown).toContain('Login succeeds with a valid code');
    expect((await call(base, '/api/v1/projects/demo/specs/ghost', { headers: BOB })).status).toBe(404);
  });
});
