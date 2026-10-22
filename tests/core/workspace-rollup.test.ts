import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadWorkspace } from '../../src/core/workspace.js';
import {
  readRepoInput,
  rollupManifest,
  rollupRepo,
  rollupWorkspace,
  WorkspaceRollupSchema,
} from '../../src/core/workspace-rollup.js';
import { worstExit } from '../../src/cli/commands/workspace-check.js';
import { Api } from '../../src/server/api.js';
import { workspaceRegistry } from '../../src/server/project.js';

const zero = { claims: 0, proven: 0, failed: 0, stale: 0, unexercised: 0, error: 0, unproven: 0, withTests: 0 };
const trace = (totals: Partial<typeof zero> & { sourceFiles?: number; capabilities?: number }, extra: Record<string, unknown> = {}) => ({
  version: 1 as const,
  generated: '2026-10-22T10:00:00.000Z',
  nodes: [],
  unowned: [] as string[],
  issues: [],
  totals: { ...zero, capabilities: 0, ownedFiles: 0, sourceFiles: 0, ...totals },
  ...extra,
});

const plan = (items: { status: string; severity: string }[]) =>
  ({ version: 1, id: 'plan-1', createdAt: '2026-10-21T00:00:00.000Z', tool: { name: 'specguard' }, items: items.map((i, n) => ({ id: String(n), ...i })) }) as never;

describe('workspace rollup [workspace-rollup]', () => {
  // [claims: capabilities/workspaces#workspace-rollup]
  it('reports coverage, claims and open security items from what a repo recorded', () => {
    const r = rollupRepo({
      key: 'api',
      path: '../api',
      role: 'provider',
      configured: true,
      trace: trace({ sourceFiles: 10, claims: 20, proven: 15, failed: 1, stale: 2, unproven: 2, withTests: 18, capabilities: 4 }, { unowned: ['a.ts', 'b.ts'] }) as never,
      ledgerNewest: '2026-10-22T11:00:00.000Z',
      plan: plan([{ status: 'open', severity: 'high' }, { status: 'planned', severity: 'high' }, { status: 'fixed', severity: 'critical' }, { status: 'open', severity: 'low' }]),
    });
    expect(r.state).toBe('ok');
    expect(r.coverage).toMatchObject({ sourceFiles: 10, unowned: 2, sourcePct: 80, claims: 20, provenPct: 75, testedPct: 90, failed: 1, stale: 2 });
    expect(r.security).toMatchObject({ planId: 'plan-1', total: 3, open: { critical: 0, high: 2, low: 1 } });
    expect(r.freshness.stale).toBe(true); // proofs were ingested after the trace was computed
  });

  // [claims: capabilities/workspaces#workspace-rollup]
  it('says why a repo has no numbers instead of reporting zeros as fact', () => {
    expect(rollupRepo({ key: 'a', path: 'a', role: 'consumer', configured: false }).state).toBe('no-config');
    expect(rollupRepo({ key: 'a', path: 'a', role: 'consumer', configured: true, trace: null }).state).toBe('no-trace');
    expect(rollupRepo({ key: 'a', path: 'a', role: 'consumer', configured: true, unreadable: true }).state).toBe('unreadable');
  });

  // [claims: capabilities/workspaces#workspace-rollup]
  it('carries git-derived gaps recorded in the trace, and counts layers claim by claim', () => {
    const t = trace({ claims: 2, proven: 1, capabilities: 1 }, {
      gaps: { intent: [{ id: 'auth', codeDate: '2026-10-20', intentDate: '' }], docsStale: ['billing'] },
      nodes: [{
        kind: 'capability', id: 'auth', docs: ['docs/auth.md'],
        claims: [
          { id: 'a', required: ['unit', 'e2e'], layers: { unit: 'proven' }, missing: ['e2e'] },
          { id: 'b', required: ['unit'], layers: { unit: 'failed' } },
        ],
      }],
    });
    const r = rollupRepo({ key: 'a', path: 'a', role: 'consumer', configured: true, trace: t as never });
    expect(r.intentGaps).toEqual(['auth']);
    expect(r.docs).toEqual({ withDocs: 1, stale: ['billing'] });
    expect(r.layers.unit).toEqual({ required: 2, proven: 1, failed: 1, stale: 0, missing: 0 });
    expect(r.layers.e2e).toEqual({ required: 1, proven: 0, failed: 0, stale: 0, missing: 1 });
    expect(r.coverage.incomplete).toBe(1);
  });

  // [claims: capabilities/workspaces#workspace-rollup]
  it('lists ignored repos but adds nothing from them to the totals', () => {
    const live = rollupRepo({ key: 'a', path: 'a', role: 'consumer', configured: true, trace: trace({ sourceFiles: 4, claims: 10, proven: 5 }) as never });
    const hub = rollupRepo({ key: 'hub', path: '../hub', role: 'consumer', ignored: true, ignoreReason: 'tooling', configured: true, trace: trace({ sourceFiles: 99, claims: 999, proven: 999 }) as never });
    const w = rollupWorkspace('sb', [live, hub], '2026-10-22T00:00:00.000Z');
    expect(w.totals).toMatchObject({ repos: 1, ignored: 1, coverage: { claims: 10, proven: 5, provenPct: 50 } });
    expect(w.repos.map((r) => [r.key, r.ignored])).toEqual([['a', false], ['hub', true]]);
    expect(WorkspaceRollupSchema.parse(w)).toEqual(w);
  });

  // [claims: capabilities/workspaces#workspace-rollup]
  it('reads a manifest of real folders: configured, unconfigured, ignored', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-roll-')));
    const put = (rel: string, body: unknown) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
    };
    put('ws/.specguard/workspace.json', { version: '1', name: 'ws', repos: { api: { path: '../api', role: 'provider' }, bare: { path: '../bare', role: 'consumer' }, hub: { path: '../hub', role: 'consumer', ignore: true } } });
    put('api/.specguard/config.json', '{"apps":[]}');
    put('api/.specguard/trace.json', trace({ sourceFiles: 5, claims: 4, proven: 4 }));
    put('api/.specguard/proofs.json', { version: 1, proofs: { 'x#a': { ingestedAt: '2026-10-22T09:00:00.000Z' } } });
    put('bare/readme.md', '');
    put('hub/.specguard/config.json', '{"apps":[]}');
    put('hub/.specguard/trace.json', '{ broken');
    const roll = rollupManifest(await loadWorkspace(path.join(dir, 'ws')));
    expect(roll.repos.map((r) => `${r.key}:${r.state}${r.ignored ? ':ignored' : ''}`)).toEqual(['api:ok', 'bare:no-config', 'hub:unreadable:ignored']);
    expect(roll.totals.coverage.claims).toBe(4);
    expect(readRepoInput({ key: 'api', path: '../api', role: 'x' }, path.join(dir, 'api')).ledgerNewest).toBe('2026-10-22T09:00:00.000Z');
  });

  // [claims: capabilities/workspaces#workspace-check]
  it('exits with the worst per-repo outcome in check\'s own order', () => {
    expect(worstExit([0, 4, 0])).toBe(4);
    expect(worstExit([4, 3])).toBe(3);
    expect(worstExit([4, 3, 2])).toBe(2);
    expect(worstExit([])).toBe(0);
  });
});

describe('serving a workspace [workspace-serve]', () => {
  // [claims: capabilities/workspaces#workspace-serve]
  it('serves each active repo as a project and the rollup at /api/v1/workspace', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sg-serve-')));
    mkdirSync(path.join(dir, 'ws/.specguard'), { recursive: true });
    writeFileSync(path.join(dir, 'ws/.specguard/workspace.json'), JSON.stringify({ version: '1', name: 'ws', repos: { hub: { path: '../hub', role: 'consumer', ignore: true } } }));
    mkdirSync(path.join(dir, 'hub/.specguard'), { recursive: true });
    writeFileSync(path.join(dir, 'hub/.specguard/config.json'), '{"apps":[]}');
    const manifest = await loadWorkspace(path.join(dir, 'ws'));
    const registry = await workspaceRegistry(manifest);
    const api = new Api(registry, { workspace: async () => rollupManifest(manifest) });
    const w = await api.handle({ method: 'GET', path: '/api/v1/workspace' });
    expect(w.status).toBe(200);
    expect(JSON.parse(w.body).repos[0]).toMatchObject({ key: 'hub', ignored: true });
    expect(JSON.parse((await api.handle({ method: 'GET', path: '/api/v1/projects' })).body).projects).toEqual([]);
    expect((await api.handle({ method: 'POST', path: '/api/v1/workspace' })).status).toBe(405);
    expect((await new Api(registry).handle({ method: 'GET', path: '/api/v1/workspace' })).status).toBe(404);
  });
});
