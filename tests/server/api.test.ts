import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(),
  llmGenerateObject: vi.fn(),
  resolveTargets: vi.fn((o: { model: string }) => [{ provider: 'p', model: o.model }]),
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {},
}));

import { loadConfig } from '../../src/core/config.js';
import { LlmBudgetExceededError, llmGenerateText } from '../../src/core/llm.js';
import { runHistoryAdd } from '../../src/pipelines/history.js';
import { Api } from '../../src/server/api.js';
import { installNpmPlugin } from '../helpers/npm-plugin.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const llm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;
let repo: TmpRepo;

async function api(tweak?: (c: Awaited<ReturnType<typeof loadConfig>>) => void) {
  const config = await loadConfig(repo.dir);
  tweak?.(config);
  return new Api(config);
}
const get = async (a: Api, p: string) => {
  const r = await a.handle({ method: 'GET', path: p });
  return { ...r, json: r.type.startsWith('application/json') ? JSON.parse(r.body) : null };
};

beforeEach(() => {
  llm.mockReset();
  repo = makeV2Repo();
});

describe('API [api-v1]', () => {
  // [claims: capabilities/documentation-api#serve-readonly]
  it('is read-only [read-only]', async () => {
    const a = await api();
    expect((await a.handle({ method: 'POST', path: '/api/v1/system' })).status).toBe(405);
    expect((await a.handle({ method: 'DELETE', path: '/api/v1/capabilities/auth' })).status).toBe(405);
  });

  // [claims: capabilities/documentation-api#static-ui]
  it('serves the UI at / and 404s unknown paths [ui-and-404]', async () => {
    const a = await api();
    const ui = await get(a, '/');
    expect(ui.type).toContain('text/html');
    expect(ui.body).toContain('<title>SpecGuard</title>');
    expect((await get(a, '/nope')).status).toBe(404);
    expect((await get(a, '/api/v1/nope')).status).toBe(404);
    expect((await get(a, '/api/v1/health')).json).toEqual({ ok: true, version: 1, apiVersion: 1, engineVersion: expect.stringMatching(/^\d+\.\d+\.\d+/), hashVersion: 1, writable: false });
  });

  // [claims: capabilities/documentation-api#spec-endpoints]
  it('describes the system with its capabilities and totals [system]', async () => {
    const { json } = await get(await api(), '/api/v1/system');
    expect(json.system).toMatchObject({ id: 'system', value: 'v' });
    expect(json.capabilities.map((c: { id: string }) => c.id)).toEqual(['auth', 'shop']);
    expect(json.totals).toMatchObject({ capabilities: 2, claims: 3 });
  });

  // [claims: capabilities/documentation-api#spec-endpoints]
  it('lists capabilities and returns one with its claims, tests and files [capabilities]', async () => {
    const a = await api();
    const list = (await get(a, '/api/v1/capabilities')).json;
    expect(list.capabilities.map((c: { id: string }) => c.id)).toEqual(['auth', 'shop']);
    const auth = (await get(a, '/api/v1/capabilities/auth')).json;
    expect(auth.ownedFiles).toEqual(['src/auth/login.ts', 'src/auth/logout.ts']);
    expect(auth.claims.find((c: { id: string }) => c.id === 'login-valid-code').tests[0].file).toBe('tests/auth.test.ts');
    expect((await get(a, '/api/v1/capabilities/ghost')).status).toBe(404);
  });

  // [claims: capabilities/documentation-api#spec-endpoints]
  it('returns a capability\'s history and single entries [history]', async () => {
    const config = await loadConfig(repo.dir);
    await runHistoryAdd(config, { decision: 'Rotate codes hourly', affects: ['auth'], date: '2026-10-15' });
    const a = await api();
    const h = (await get(a, '/api/v1/capabilities/auth/history')).json;
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ id: '2026-10-15-rotate-codes-hourly', kind: 'decision' });
    expect(h.entries[0].body).toBeUndefined();
    const one = (await get(a, '/api/v1/history/2026-10-15-rotate-codes-hourly')).json;
    expect(one.body).toContain('Rotate codes hourly');
    expect(one.file).toBeUndefined();
    expect((await get(a, '/api/v1/history/nope')).status).toBe(404);
  });

  // [claims: capabilities/documentation-api#audit-endpoints]
  it('exposes the matrix and the audit [trace-and-audit]', async () => {
    const a = await api();
    const trace = (await get(a, '/api/v1/trace')).json;
    expect(trace.nodes.find((n: { id: string }) => n.id === 'auth').claims).toHaveLength(2);
    const audit = (await get(a, '/api/v1/audit')).json;
    expect(audit.unowned).toEqual(['src/orphan.ts']);
    expect(audit.untestedClaims).toContain('capabilities/auth#logout-clears-session');
    expect(audit.noTests).toEqual(['shop']);
    expect(audit.unproven).toHaveLength(3);
  });

  // [claims: capabilities/documentation-api#audience-shapes, capabilities/documentation-api#cache-key, capabilities/documentation-api#docs-endpoints]
  it('serves the agent brief without a model, exact ids included, and caches it [agent-doc]', async () => {
    const a = await api();
    const first = (await get(a, '/api/v1/docs/agent/auth')).json;
    expect(first.markdown).toContain('login-valid-code');
    expect(first.markdown).toContain('@claim:capabilities/auth#<id>');
    expect(first).toMatchObject({ generated: false, cached: false });
    expect((await get(a, '/api/v1/docs/agent/auth')).json.cached).toBe(true);
    expect(llm).not.toHaveBeenCalled();
  });

  // [claims: capabilities/documentation-api#docs-model-fallback]
  it('renders user and dev docs straight from the spec, with a warning, when no model is configured [no-model]', async () => {
    const a = await api();
    const user = (await get(a, '/api/v1/docs/user/auth')).json;
    expect(user.warning).toContain('no model configured');
    expect(user.markdown).toContain('Only approved people sign in.');
    expect(user.markdown).not.toContain('login-valid-code');
    const dev = (await get(a, '/api/v1/docs/dev/auth')).json;
    expect(dev.markdown).toContain('login-valid-code');
    expect(existsSync(path.join(repo.dir, '.specguard/cache/docs/user/auth.json'))).toBe(false);
  });

  // [claims: capabilities/documentation-api#docs-endpoints]
  it('rejects an unknown audience and an unknown spec [doc-errors]', async () => {
    const a = await api();
    expect((await get(a, '/api/v1/docs/robot/auth')).status).toBe(400);
    expect((await get(a, '/api/v1/docs/user/ghost')).status).toBe(404);
  });

  describe('with a model', () => {
    const withModel = (c: Awaited<ReturnType<typeof loadConfig>>) => {
      c.llm = { ...c.llm, provider: 'anthropic', model: 'haiku' };
    };

    // [claims: capabilities/documentation-api#audience-shapes, capabilities/documentation-api#cache-key, capabilities/documentation-api#docs-endpoints]
    it('generates with the docs pipeline, never shows claim ids to users, and caches by spec content [generate-and-cache]', async () => {
      llm.mockResolvedValue('# Sign in\n\nYou sign in with a code.');
      const a = await api(withModel);
      const first = (await get(a, '/api/v1/docs/user/auth')).json;
      expect(first).toMatchObject({ generated: true, cached: false, markdown: '# Sign in\n\nYou sign in with a code.' });
      const call = llm.mock.calls[0][0];
      expect(call.pipeline).toBe('docs');
      expect(call.prompt).toContain('Only approved people sign in.');
      expect(call.prompt).not.toContain('login-valid-code');

      expect((await get(a, '/api/v1/docs/user/auth')).json.cached).toBe(true);
      expect(llm).toHaveBeenCalledTimes(1);

      // Changing the spec invalidates the cache.
      const specFile = path.join(repo.dir, 'specs/capabilities/auth.md');
      writeFileSync(specFile, readFileSync(specFile, 'utf8').replace('Only approved people sign in.', 'Only approved staff sign in.'));
      llm.mockResolvedValue('# Sign in v2');
      const second = (await get(a, '/api/v1/docs/user/auth')).json;
      expect(second).toMatchObject({ cached: false, markdown: '# Sign in v2' });
      expect(llm).toHaveBeenCalledTimes(2);
    });

    // [claims: capabilities/documentation-api#audience-shapes]
    it('gives developers the ids and the code map [dev-prompt]', async () => {
      llm.mockResolvedValue('# Dev');
      await get(await api(withModel), '/api/v1/docs/dev/auth');
      const prompt = llm.mock.calls[0][0].prompt as string;
      expect(prompt).toContain('login-valid-code');
      expect(prompt).toContain('src/auth/**');
    });

    // [claims: capabilities/documentation-api#cache-key]
    it('a different model does not reuse the other model\'s docs [model-in-key]', async () => {
      llm.mockResolvedValue('# One');
      await get(await api(withModel), '/api/v1/docs/user/auth');
      llm.mockResolvedValue('# Two');
      const other = (await get(await api((c) => { c.llm = { ...c.llm, provider: 'anthropic', model: 'other' }; }), '/api/v1/docs/user/auth')).json;
      expect(other.markdown).toBe('# Two');
    });

    // [claims: capabilities/documentation-api#single-flight-budget]
    it('shares one model call between identical concurrent requests [single-flight]', async () => {
      let release!: (v: string) => void;
      llm.mockReturnValue(new Promise<string>((r) => { release = r; }));
      const a = await api(withModel);
      const both = Promise.all([get(a, '/api/v1/docs/user/auth'), get(a, '/api/v1/docs/user/auth')]);
      await new Promise((r) => setTimeout(r, 30));
      release('# Shared');
      const [x, y] = await both;
      expect(llm).toHaveBeenCalledTimes(1);
      expect(x.json.markdown).toBe('# Shared');
      expect(y.json.markdown).toBe('# Shared');
    });

    // [claims: capabilities/integration-surfaces#planned-plugin-extensions]
    it('lets a plugin renderer produce a document without a model call, and falls through when it declines or fails [doc-renderers]', async () => {
      installNpmPlugin(
        repo,
        'specguard-plugin-docs',
        "exports.plugin = { id: 'docs', docRenderers: [" +
          "{ id: 'broken', render: () => { throw new Error('x'); } }," +
          "{ id: 'user-only', render: (c) => c.audience === 'user' ? `# ${c.title} (rendered by a plugin)` : null }] };",
      );
      const viaPlugin = (c: Awaited<ReturnType<typeof loadConfig>>) => {
        withModel(c);
        c.plugins = [{ name: 'docs', package: 'specguard-plugin-docs' }];
      };
      const a = await api(viaPlugin);
      llm.mockResolvedValue('# From the model');
      const user = (await get(a, '/api/v1/docs/user/auth')).json;
      expect(user.markdown).toContain('(rendered by a plugin)');
      expect(user.generated).toBe(false);
      expect(llm).not.toHaveBeenCalled();
      // Cached, still marked as not model-generated.
      expect((await get(a, '/api/v1/docs/user/auth')).json).toMatchObject({ cached: true, generated: false });
      // The renderer declines the dev audience, so the model writes it.
      const dev = (await get(a, '/api/v1/docs/dev/auth')).json;
      expect(dev).toMatchObject({ markdown: '# From the model', generated: true });
      expect(llm).toHaveBeenCalledTimes(1);
    });

    // [claims: capabilities/documentation-api#single-flight-budget]
    it('runs generations for different documents concurrently, each in its own LLM scope [concurrent-scopes]', async () => {
      const { currentLlmScope } = await import('../../src/core/llm-runtime.js');
      const scopes = new Set<unknown>();
      let active = 0;
      let peak = 0;
      llm.mockImplementation(async () => {
        scopes.add(currentLlmScope());
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return '# Doc';
      });
      const a = await api(withModel);
      await Promise.all([get(a, '/api/v1/docs/user/auth'), get(a, '/api/v1/docs/dev/auth'), get(a, '/api/v1/docs/user/shop')]);
      expect(llm).toHaveBeenCalledTimes(3);
      expect(peak).toBeGreaterThan(1);
      expect(scopes.size).toBe(3);
      expect([...scopes].every((s) => (s as { tags?: string[] }).tags?.includes('specguard-docs'))).toBe(true);
    });

    // [claims: capabilities/documentation-api#single-flight-budget]
    it('keeps serving after one generation fails [gate-survives-failure]', async () => {
      llm.mockRejectedValueOnce(new Error('provider down')).mockResolvedValue('# Fine');
      const a = await api(withModel);
      const [first, second] = await Promise.all([get(a, '/api/v1/docs/user/auth'), get(a, '/api/v1/docs/user/shop')]);
      expect([first.json.warning, second.json.warning].filter(Boolean)).toHaveLength(1);
      expect([first.json.markdown, second.json.markdown]).toContain('# Fine');
    });

    // [claims: capabilities/documentation-api#docs-model-fallback]
    it('falls back to the spec when the model fails, and tries again next time [model-failure]', async () => {
      llm.mockRejectedValueOnce(new Error('provider down'));
      const a = await api(withModel);
      const failed = (await get(a, '/api/v1/docs/user/auth')).json;
      expect(failed.warning).toContain('provider down');
      expect(failed.markdown).toContain('Only approved people sign in.');
      llm.mockResolvedValueOnce('# Recovered');
      expect((await get(a, '/api/v1/docs/user/auth')).json).toMatchObject({ generated: true, markdown: '# Recovered' });
    });

    // [claims: capabilities/documentation-api#docs-model-fallback, capabilities/documentation-api#single-flight-budget]
    it('reports a spent LLM budget as a clear 429 instead of substituting another document [budget]', async () => {
      llm.mockRejectedValue(new LlmBudgetExceededError('LLM budget exceeded (1 of 1 calls)'));
      const r = await get(await api(withModel), '/api/v1/docs/user/auth');
      expect(r.status).toBe(429);
      expect(r.json.error).toContain('budget exceeded');
    });

    // [claims: capabilities/documentation-api#docs-endpoints]
    it('builds the system guide from the system spec and every capability [system-guide]', async () => {
      llm.mockResolvedValue('# Guide');
      const r = (await get(await api(withModel), '/api/v1/docs/user/system')).json;
      expect(r.markdown).toBe('# Guide');
      const prompt = llm.mock.calls[0][0].prompt as string;
      expect(prompt).toContain('# Capabilities');
      expect(prompt).toContain('Only approved people sign in.');
      expect(prompt).toContain('People can buy things.');
    });
  });

  // [claims: capabilities/documentation-api#docs-no-secrets, capabilities/documentation-api#served-redaction]
  it('never serves a credential that appears in a spec, but keeps ordinary personal data [served-redaction]', async () => {
    const specFile = path.join(repo.dir, 'specs/capabilities/auth.md');
    writeFileSync(specFile, readFileSync(specFile, 'utf8').replace('Only approved people sign in.', 'Only approved people sign in. Contact ops@example.com. Key sk-abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnop1234.'));
    const a = await api();
    for (const p of ['/api/v1/docs/agent/auth', '/api/v1/docs/user/auth', '/api/v1/docs/dev/auth', '/api/v1/capabilities/auth', '/api/v1/trace']) {
      const body = (await get(a, p)).body;
      expect(body, p).not.toContain('sk-abcdefghijklmnopqrstuvwx');
      expect(body, p).not.toContain('abcdefghijklmnop1234');
    }
    const doc = (await get(a, '/api/v1/docs/user/auth')).json.markdown as string;
    expect(doc).toContain('[KEY]');
    expect(doc).toContain('ops@example.com');
  });

  // [claims: capabilities/documentation-api#audit-endpoints]
  it('lists and reads security plans, and cannot be walked out of the plans folder [plans]', async () => {
    const a = await api();
    expect((await get(a, '/api/v1/security/plans')).json).toEqual({ plans: [] });
    const planItem = (id: string) => ({ id, title: id, severity: 'high', type: 'dependency', change: 'dependency', summary: 's', findings: [{ id, detector: 'advisory', message: 'm' }], claims: [], files: [], verify: { scope: 'all-proven', claims: [] }, status: 'open', statusHistory: [], fingerprint: id });
    repo.write('.specguard/security/plans/p1.json', JSON.stringify({ version: 1, id: 'p1', createdAt: '2026-10-15', tool: { name: 'specguard' }, items: [planItem('a'), planItem('b')] }));
    repo.write('.specguard/security/plans/broken.json', JSON.stringify({ id: 'broken', items: [{}] }));
    repo.write('secret.json', '{"leak":true}');
    // A plan that does not match the schema is never served.
    expect((await get(a, '/api/v1/security/plans')).json.plans).toEqual([{ id: 'p1', createdAt: '2026-10-15', items: 2 }]);
    expect((await get(a, '/api/v1/security/plans/p1')).json.id).toBe('p1');
    expect((await get(a, '/api/v1/security/plans/broken')).status).toBe(404);
    expect((await get(a, '/api/v1/security/plans/..%2F..%2Fsecret')).status).toBe(404);
  });
});
