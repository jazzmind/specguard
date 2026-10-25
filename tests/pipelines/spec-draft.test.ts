import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The LLM chokepoint is mocked per pipeline name: summarize, cluster, spec-draft.
vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn(), resolveTargets: vi.fn(() => [{ model: 'm' }]), usesHostAgent: vi.fn(() => false) }));

import { loadConfig } from '../../src/core/config.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { buildSpecGraph } from '../../src/core/spec-graph.js';
import { runSpecDraft } from '../../src/pipelines/spec-draft.js';
import { runSpecIndex } from '../../src/pipelines/spec-index.js';
import { makeRepo, type TmpRepo } from '../helpers/repo.js';

const mocked = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

const synth = {
  problemAndValue: 'Players are rewarded fairly.',
  users: ['A player earns points'],
  requirements: [{ text: 'Points are awarded once per action' }, { text: 'Duplicate awards are rejected' }],
  scenarios: [{ name: 'Award once', steps: ['Perform the action'], expected: ['Points are added'] }],
  security: 'Award state is per user.',
  interfaces: 'awardPoints()',
  outOfScope: 'Redemption.',
};

const cap = (id: string, sources: string[]) => ({
  id,
  title: id.toUpperCase(),
  value: `${id} value`,
  rationale: 'because',
  sources,
  tests: [],
  docs: [],
  specs: [],
  components: [],
});

function cluster(caps: ReturnType<typeof cap>[]) {
  return {
    system: { title: 'Game', problem: 'Players need rewards.', users: ['Players'], value: 'Fun.', nonGoals: ['Payments'] },
    capabilities: caps,
  };
}

let repo: TmpRepo;
const calls = () => mocked.mock.calls.map((c) => (c[0] as { pipeline: string }).pipeline);

beforeEach(() => {
  mocked.mockReset();
  mocked.mockImplementation(async (opts: { pipeline: string }) => {
    if (opts.pipeline === 'summarize') return { summary: 'does a thing' };
    if (opts.pipeline === 'spec-draft') return synth;
    throw new Error(`unexpected pipeline ${opts.pipeline}`);
  });
  repo = makeRepo({ granularity: { target: [2, 3] } });
  repo.write('specs/core/awards.md', '');
  repo.write('src/auth/login.ts', 'export const login = 1;\n');
  repo.write('src/shop/cart.ts', 'export const cart = 1;\n');
  repo.write('src/core/awards.ts', 'export const awards = 1;\n');
});

function clusterReturns(...answers: ReturnType<typeof cluster>[]) {
  const base = mocked.getMockImplementation() as (o: { pipeline: string }) => Promise<unknown>;
  const queue = [...answers];
  mocked.mockImplementation(async (opts: { pipeline: string }) => (opts.pipeline === 'cluster' ? queue.shift() ?? answers[answers.length - 1] : base(opts)));
}

describe('spec draft [spec-draft]', () => {
  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('stops after writing the capability map unless --yes [stop-at-map]', async () => {
    clusterReturns(cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**', 'src/core/**'])]));
    const config = await loadConfig(repo.dir);
    const r = await runSpecDraft(config, {});
    expect(r.exitCode).toBe(0);
    expect(existsSync(path.join(repo.dir, '.specguard/spec-map.json'))).toBe(true);
    expect(readFileSync(path.join(repo.dir, '.specguard/spec-map.md'), 'utf8')).toContain('identity');
    expect(existsSync(path.join(repo.dir, 'specs/capabilities/identity.md'))).toBe(false);
    expect(r.messages.join('\n')).toContain('--from-map');
    expect(calls()).not.toContain('spec-draft');
  });

  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('with --yes writes a valid spec tree: system plus one spec per capability [yes-writes-tree]', async () => {
    clusterReturns(cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**', 'src/core/**'])]));
    const config = await loadConfig(repo.dir);
    const r = await runSpecDraft(config, { yes: true, history: ['2026-10-15-x'] });
    expect(r.failed).toBe(0);
    const text = readFileSync(path.join(repo.dir, 'specs/capabilities/identity.md'), 'utf8');
    expect(text).toContain('id: identity');
    expect(text).toContain('  - "src/auth/**"');
    expect(text).toContain('  - "2026-10-15-x"');
    expect(text).toContain('## Problem & Value');
    expect(text).toMatch(/- \[ \] Points are awarded once per action <!-- claim: points-are-awarded-once-per-action -->/);
    expect(readFileSync(path.join(repo.dir, 'specs/system.md'), 'utf8')).toContain('[IDENTITY](capabilities/identity.md)');

    const graph = await buildSpecGraph(await loadConfig(repo.dir));
    expect(graph.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(graph.system?.children.sort()).toEqual(['commerce', 'identity']);
    expect(graph.specsForFile('src/auth/login.ts')).toEqual(['identity']);
  });

  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('retries once when the capability count misses the target [retry-on-count]', async () => {
    clusterReturns(cluster([cap('everything', ['src/**'])]), cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**'])]));
    const r = await runSpecDraft(await loadConfig(repo.dir), {});
    expect(calls().filter((p) => p === 'cluster')).toHaveLength(2);
    const map = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/spec-map.json'), 'utf8'));
    expect(map.capabilities.map((c: { id: string }) => c.id)).toEqual(['identity', 'commerce']);
    expect(r.exitCode).toBe(0);
  });

  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('drops globs that match nothing and reports unowned files [map-check]', async () => {
    clusterReturns(cluster([cap('identity', ['src/auth/**', 'src/ghost/**']), cap('commerce', ['src/shop/**'])]));
    const r = await runSpecDraft(await loadConfig(repo.dir), {});
    const map = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/spec-map.json'), 'utf8'));
    expect(map.capabilities[0].sources).toEqual(['src/auth/**']);
    expect(r.messages.join('\n')).toContain('src/ghost/**');
    expect(readFileSync(path.join(repo.dir, '.specguard/spec-map.md'), 'utf8')).toContain('src/core/awards.ts');
  });

  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('asks again when the model returns an id that is not kebab-case or repeats one, instead of aborting [bad-id-retry]', async () => {
    clusterReturns(cluster([cap('Auth_Service', ['src/auth/**']), cap('commerce', ['src/shop/**'])]), cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**'])]));
    const r = await runSpecDraft(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(0);
    const clusterCalls = mocked.mock.calls.map((c) => c[0] as { pipeline: string; prompt: string }).filter((c) => c.pipeline === 'cluster');
    expect(clusterCalls).toHaveLength(2);
    expect(clusterCalls[1].prompt).toContain('was rejected');
    const map = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/spec-map.json'), 'utf8'));
    expect(map.capabilities.map((c: { id: string }) => c.id)).toEqual(['identity', 'commerce']);
  });

  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('passes the maintainers\' guidance to the clustering model, on a retry too [guidance]', async () => {
    clusterReturns(cluster([cap('everything', ['src/**'])]), cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**'])]));
    await runSpecDraft(await loadConfig(repo.dir), { guidance: 'Use the capability names Identity and Commerce.' });
    const clusterCalls = mocked.mock.calls.map((c) => c[0] as { pipeline: string; prompt: string }).filter((c) => c.pipeline === 'cluster');
    expect(clusterCalls).toHaveLength(2);
    expect(clusterCalls[0].prompt).toContain('Guidance from the maintainers');
    expect(clusterCalls[0].prompt).toContain('Use the capability names Identity and Commerce.');
    expect(clusterCalls[1].prompt).toContain('Use the capability names Identity and Commerce.');
    expect(clusterCalls[1].prompt).toContain('previous answer had 1 capabilities');
  });

  it('--from-map writes from the edited map and never calls the cluster model [from-map]', async () => {
    clusterReturns(cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**'])]));
    const config = await loadConfig(repo.dir);
    await runSpecDraft(config, {});
    const mapFile = path.join(repo.dir, '.specguard/spec-map.json');
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    map.capabilities = map.capabilities.filter((c: { id: string }) => c.id === 'commerce');
    map.capabilities[0].title = 'Shopping';
    await (await import('node:fs/promises')).writeFile(mapFile, JSON.stringify(map));
    mocked.mockClear();
    const r = await runSpecDraft(config, { fromMap: true });
    expect(calls()).not.toContain('cluster');
    expect(existsSync(path.join(repo.dir, 'specs/capabilities/identity.md'))).toBe(false);
    expect(readFileSync(path.join(repo.dir, 'specs/capabilities/commerce.md'), 'utf8')).toContain('title: "Shopping"');
    expect(r.created).toBe(1);
  });

  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('skips specs that exist unless --force, and caches file summaries by content [skip-and-cache]', async () => {
    clusterReturns(cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**'])]));
    const config = await loadConfig(repo.dir);
    await runSpecDraft(config, { yes: true });
    const firstSummaries = calls().filter((p) => p === 'summarize').length;
    expect(firstSummaries).toBeGreaterThan(0);
    mocked.mockClear();
    const again = await runSpecDraft(config, { yes: true });
    expect(calls().filter((p) => p === 'summarize')).toHaveLength(0);
    expect(again.skipped).toBe(2);
    const forced = await runSpecDraft(config, { yes: true, force: true });
    expect(forced.created).toBe(2);
  });
});

describe('spec index [spec-index]', () => {
  // [claims: capabilities/spec-authoring#spec-index-refreshes-map]
  it('rewrites only the marked region of system.md [index-region]', async () => {
    clusterReturns(cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**'])]));
    const config = await loadConfig(repo.dir);
    await runSpecDraft(config, { yes: true });
    const sysFile = path.join(repo.dir, 'specs/system.md');
    const handWritten = readFileSync(sysFile, 'utf8').replace('## Non-goals', '## Non-goals\n\nHand-written note.');
    await (await import('node:fs/promises')).writeFile(sysFile, handWritten);
    const capFile = path.join(repo.dir, 'specs/capabilities/identity.md');
    await (await import('node:fs/promises')).writeFile(capFile, readFileSync(capFile, 'utf8').replace('value: "identity value"', 'value: "A new value"'));
    const r = await runSpecIndex(await loadConfig(repo.dir));
    expect(r.updated).toBe(1);
    const after = readFileSync(sysFile, 'utf8');
    expect(after).toContain('A new value');
    expect(after).toContain('Hand-written note.');
    expect((await runSpecIndex(await loadConfig(repo.dir))).updated).toBe(0);
  });

  it('fails clearly when there is no system spec [index-no-system]', async () => {
    const r = await runSpecIndex(await loadConfig(repo.dir));
    expect(r.exitCode).toBe(1);
    expect(r.messages.join(' ')).toContain('system.md');
  });

  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('rewrites cached summaries when the summarising model changes, and reuses them otherwise [summary-cache-key]', async () => {
    const resolve = (await import('../../src/core/llm.js')).resolveTargets as unknown as ReturnType<typeof vi.fn>;
    clusterReturns(cluster([cap('identity', ['src/auth/**']), cap('commerce', ['src/shop/**'])]));
    const summarizeCalls = () => mocked.mock.calls.filter((c) => (c[0] as { pipeline: string }).pipeline === 'summarize').length;
    await runSpecDraft(await loadConfig(repo.dir), {});
    const first = summarizeCalls();
    expect(first).toBeGreaterThan(0);
    await runSpecDraft(await loadConfig(repo.dir), {});
    expect(summarizeCalls()).toBe(first);
    resolve.mockReturnValue([{ model: 'a-better-model' }]);
    await runSpecDraft(await loadConfig(repo.dir), {});
    expect(summarizeCalls()).toBe(first * 2);
    resolve.mockReturnValue([{ model: 'm' }]);
  });
});
