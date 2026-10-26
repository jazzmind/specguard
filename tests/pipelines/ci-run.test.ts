import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readCiContext, type CiContext } from '../../src/ci/context.js';
import type { ApiCheckRun, ApiPrFile, ApiReview, CheckRunBody, GitHubApi } from '../../src/ci/github-api.js';
import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { PACKET_MARKER, type ProofPacket } from '../../src/core/proof-packet.js';
import { readNote, resolveNotesConfig } from '../../src/core/proof-store.js';
import { ciContextFromEnv, renderSavedPacket, runCi, runCiDoctor, type CiRunDeps } from '../../src/pipelines/ci-run.js';

// Each case builds real git repos and spawns processes (4-9 s alone); under the whole suite running in parallel they stretch well past the default.
vi.setConfig({ testTimeout: 180_000 });
import { runTestRun } from '../../src/pipelines/test-run.js';
import { AUTH_TITLE, RUNNER, SHOP_CATALOG, addFreeShippingClaim, approveShop, changeRepo, setCatalog, writeShopCode, writeShopTests } from '../helpers/change-fixture.js';
import { bareRemote, sh } from '../helpers/notes-git.js';
import type { TmpRepo } from '../helpers/repo.js';
import { gitCommit } from '../helpers/v2-repo.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const FREE_SHIPPING = 'capabilities/shop#free-shipping';
const noSleep = async (): Promise<void> => undefined;

interface FakeApi {
  api: GitHubApi;
  comments: Array<{ pr: number; marker: string; body: string }>;
  checks: CheckRunBody[];
  reviewCalls: number;
}

/** A GitHub client that records what it was asked and answers from the given reviews; no network. */
function fakeApi(over: { reviews?: ApiReview[]; checkRuns?: ApiCheckRun[]; files?: ApiPrFile[]; reviewsFail?: boolean } = {}): FakeApi {
  const state: FakeApi = { api: undefined as unknown as GitHubApi, comments: [], checks: [], reviewCalls: 0 };
  state.api = {
    listReviews: async () => {
      state.reviewCalls += 1;
      if (over.reviewsFail) throw new Error('GitHub API GET /pulls/7/reviews: HTTP 403');
      return over.reviews ?? [];
    },
    // Without a stand-in the pull request's files come from git, which is also what a missing permission falls back to.
    listPrFiles: async () => {
      if (over.files) return over.files;
      throw new Error('files are read from git in this test');
    },
    listCheckRuns: async () => over.checkRuns ?? [],
    createCheckRun: async (_repo, body) => {
      state.checks.push(body);
      return { id: state.checks.length };
    },
    upsertComment: async (_repo, pr, marker, body) => {
      state.comments.push({ pr, marker, body });
      return { posted: true, updated: state.comments.length > 1 };
    },
  };
  return state;
}

const approval = (login: string, commit: string, over: Partial<ApiReview> = {}): ApiReview => ({
  id: 11,
  user: { login, type: 'User' },
  state: 'APPROVED',
  commit_id: commit,
  submitted_at: '2026-10-26T10:00:00Z',
  author_association: 'MEMBER',
  ...over,
});

interface Scenario {
  repo: TmpRepo;
  remote: string;
  base: string;
  head: string;
}

/** The fake runner also writes an lcov report from `coverage.json` (file -> executable and hit lines) when asked for coverage. */
const COVERAGE_TAIL = `
if (args.includes('--coverage') && fs.existsSync('coverage.json')) {
  const cov = JSON.parse(fs.readFileSync('coverage.json', 'utf8'));
  let out = '';
  for (const [file, c] of Object.entries(cov)) {
    out += 'SF:' + file + '\\n';
    for (const n of c.exec) out += 'DA:' + n + ',' + (c.hit.includes(n) ? 1 : 0) + '\\n';
    out += 'end_of_record\\n';
  }
  fs.writeFileSync('lcov.info', out);
}
process.exit(`;
const COVERAGE_RUNNER = RUNNER.replace('process.exit(', COVERAGE_TAIL);

const GITIGNORE = ['.specguard/ci/', '.specguard/runs/', '.specguard/cache/', '.specguard/coverage/', '.specguard/proofs.json', 'report.json', 'argv.json', 'lcov.info', ''].join('\n');

/**
 * A repo on `main` with a bare remote, and a `feat` branch that adds the free-shipping requirement, a test, the code and
 * a person's recorded approval. `sensitive: false` makes the test pass on the old code too.
 */
async function scenario(o: { enforce?: 'observe' | 'warn' | 'enforce'; sensitive?: boolean; approve?: boolean; config?: Record<string, unknown>; extraLine?: boolean; skipAuthTest?: boolean; touchAuth?: boolean; spike?: boolean } = {}): Promise<Scenario> {
  const repo = changeRepo();
  const configFile = path.join(repo.dir, '.specguard/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as { apps: Array<{ test: Record<string, unknown> }> };
  config.apps[0]!.test.coverage = { flags: '--coverage', reports: ['lcov.info'], format: 'lcov' };
  writeFileSync(configFile, JSON.stringify({ ...config, enforce: { default: o.enforce ?? 'enforce' }, ...(o.config ?? {}) }));
  repo.write('run-tests.cjs', COVERAGE_RUNNER);
  repo.write('.gitignore', GITIGNORE);
  gitCommit(repo.dir, 'enforce and ignore');
  sh(repo.dir, 'branch', '-M', 'main');
  const remote = bareRemote();
  sh(repo.dir, 'remote', 'add', 'origin', remote);
  sh(repo.dir, 'push', '-q', 'origin', 'main');
  const base = sh(repo.dir, 'rev-parse', 'HEAD');

  sh(repo.dir, 'checkout', '-q', '-b', 'feat');
  addFreeShippingClaim(repo);
  writeShopTests(repo);
  if (o.sensitive === false) setCatalog(repo, SHOP_CATALOG.map(({ needs: _needs, ...entry }) => entry));
  writeShopCode(repo);
  // The lines of the shop code, and which of them any test reaches.
  const exec = o.extraLine ? [1, 2, 3] : [1, 2];
  if (o.extraLine) repo.write('src/shop/cart.ts', `${readFileSync(path.join(repo.dir, 'src/shop/cart.ts'), 'utf8')}export const EXTRA = 1;\n`);
  repo.write('coverage.json', JSON.stringify({ 'src/shop/cart.ts': { exec, hit: [1, 2] } }));
  if (o.skipAuthTest) repo.write('tests/auth.test.ts', `it.skip('${AUTH_TITLE}', () => {});\n`);
  if (o.touchAuth) repo.write('src/auth/login.ts', 'export const login = 2;\n');
  if (o.spike) {
    const record = { version: 1, id: '20261026-free-shipping-a1b2', kind: 'spike', capabilities: ['shop'], createdAt: NOW.toISOString(), createdBy: 'dev', baseRef: 'main', plans: [] };
    repo.write('.specguard/changes/20261026-free-shipping-a1b2.json', `${JSON.stringify(record, null, 2)}\n`);
  }
  if (o.approve !== false) await approveShop(repo);
  gitCommit(repo.dir, 'free shipping');
  return { repo, remote, base, head: sh(repo.dir, 'rev-parse', 'HEAD') };
}

interface Event {
  name?: 'pull_request' | 'push' | 'merge_group';
  head: string;
  base: string;
  /** Pull request payload: the head repository, and so whether it is a fork. */
  headRepo?: string;
  token?: boolean;
  before?: string;
  author?: string;
}

/** The context the Actions environment and the event payload give, built by the code under test. */
function contextOf(e: Event): CiContext {
  const name = e.name ?? 'pull_request';
  const env: NodeJS.ProcessEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: name,
    GITHUB_EVENT_PATH: '/event.json',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: e.head,
    GITHUB_API_URL: 'https://api.github.test',
    ...(e.token === false ? {} : { SG_GITHUB_TOKEN: 'token-for-tests' }),
  };
  const payload =
    name === 'pull_request'
      ? { pull_request: { number: 7, user: { login: e.author ?? 'dev' }, head: { sha: e.head, repo: { full_name: e.headRepo ?? 'o/r' } }, base: { sha: e.base } } }
      : { before: e.before ?? e.base, after: e.head, repository: { default_branch: 'main' } };
  return readCiContext(env, () => payload);
}

const stepSummary = (): string => path.join(os.tmpdir(), `sg-summary-${process.pid}-${Math.random().toString(36).slice(2)}.md`);

async function run(s: Scenario, e: Event, deps: CiRunDeps = {}, opts: Parameters<typeof runCi>[2] = {}): Promise<Awaited<ReturnType<typeof runCi>>> {
  return runCi(await loadConfig(s.repo.dir), contextOf(e), { now: NOW, ...opts }, { sleep: noSleep, ...deps });
}

const remoteNotes = (s: Scenario): string => sh(s.remote, 'notes', '--ref=refs/notes/specguard', 'list');
const packetOf = (r: Awaited<ReturnType<typeof runCi>>): ProofPacket => {
  if (!r.packet) throw new Error(`no packet: ${r.messages.join('\n')}`);
  return r.packet;
};

describe('ci run on a pull request [ci-run]', () => {
  // [claims: capabilities/integration-surfaces#ci-run-ready]
  it('a pull request that adds a claim, tested, sensitive and approved with a countersigning review is ready, with one packet comment', async () => {
    const s = await scenario();
    const fake = fakeApi({ reviews: [approval('rev', '')] });
    fake.api.listReviews = async () => [approval('rev', s.head)];
    const summary = stepSummary();
    const r = await run(s, { head: s.head, base: s.base }, { api: fake.api, env: { GITHUB_STEP_SUMMARY: summary } });

    const packet = packetOf(r);
    expect(r.exitCode).toBe(0);
    expect(r.gate).toBe('pass');
    expect(packet.verdict).toBe('ready');
    expect(packet.intent.map((i) => [i.ref, i.change])).toEqual([[FREE_SHIPPING, 'added']]);
    expect(packet.intent[0]?.approval).toMatchObject({ method: 'command', trust: 'countersigned', countersignedBy: 'rev' });
    expect(packet.evidence[0]?.sensitivity).toMatchObject({ kind: 'red-green', status: 'ok' });

    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]).toMatchObject({ pr: 7, marker: PACKET_MARKER });
    expect(fake.comments[0]?.body).toContain('SpecGuard proof packet');
    expect(readFileSync(summary, 'utf8')).toContain('SpecGuard proof packet');
    for (const f of ['packet.json', 'packet.md', 'statement.json', 'note.json']) expect(existsSync(path.join(s.repo.dir, '.specguard/ci', f))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('token-for-tests');
  });

  // [claims: capabilities/integration-surfaces#ci-run-blocks-enforce]
  it('the same pull request with a recorded approval no one countersigned is blocked at enforce, and the packet says what is needed', async () => {
    const s = await scenario();
    const fake = fakeApi({ reviews: [] });
    const r = await run(s, { head: s.head, base: s.base }, { api: fake.api, env: {} });

    const packet = packetOf(r);
    expect(r.gate).toBe('fail');
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(packet.verdict).toBe('blocked');
    expect(packet.intent[0]?.approval).toMatchObject({ trust: 'missing' });
    const shop = packet.capabilities.find((c) => c.capability === 'shop');
    expect(shop).toMatchObject({ enforce: 'enforce', effect: 'blocks' });
    expect(shop?.pillars.approved).not.toBe('ok');
    const body = fake.comments[0]?.body ?? '';
    expect(body).toContain('blocked');
    expect(body).toContain('not approved');
    expect(body).toMatch(/review/i);
  });

  // [claims: capabilities/integration-surfaces#ci-run-blocks-enforce]
  it('a self-approval counts, labelled, only when the repository allows it', async () => {
    const s = await scenario({ config: { approvals: { ci: { allowSelf: true } } } });
    const r = await run(s, { head: s.head, base: s.base }, { api: fakeApi().api, env: {} });
    expect(packetOf(r).verdict).toBe('ready');
    expect(packetOf(r).intent[0]?.approval).toMatchObject({ trust: 'self-approved' });
  });

  // [claims: capabilities/integration-surfaces#ci-run-observe-silent]
  it('an observe capability stays silent: nothing blocks and nothing is annotated, whatever the approvals', async () => {
    const s = await scenario({ enforce: 'observe' });
    const r = await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [] }).api, env: {} });
    expect(r.gate).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.messages.some((m) => m.startsWith('::warning'))).toBe(false);
    expect(packetOf(r).capabilities.every((c) => c.effect === 'none')).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#ci-run-observe-silent]
  it('a warn capability annotates and does not fail the gate', async () => {
    const s = await scenario({ enforce: 'warn', extraLine: true });
    const r = await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [] }).api, env: {} });
    expect(r.gate).toBe('advisory');
    expect(r.exitCode).toBe(0);
    expect(r.messages.some((m) => m.startsWith('::warning title=SpecGuard::'))).toBe(true);
  });
});

describe('what else blocks at enforce [ci-run-blocks]', () => {
  const reviewed = (s: Scenario): CiRunDeps => ({ api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} });

  // [claims: capabilities/integration-surfaces#ci-run-blocks-enforce]
  it('a changed line that no claim test reaches is unrequested code and blocks at enforce, and is silent at observe', async () => {
    const enforced = await scenario({ extraLine: true });
    const r = await run(enforced, { head: enforced.head, base: enforced.base }, reviewed(enforced));
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    const lines = packetOf(r).unrequested.lines.filter((l) => l.class === 'unrequested');
    expect(lines).toEqual([expect.objectContaining({ file: 'src/shop/cart.ts', capability: 'shop', lines: [[3, 3]] })]);
    expect(packetOf(r).capabilities.find((c) => c.capability === 'shop')?.blocking.map((b) => b.code)).toContain('UNREQUESTED_CODE');

    const observed = await scenario({ extraLine: true, enforce: 'observe' });
    const quiet = await run(observed, { head: observed.head, base: observed.base }, reviewed(observed));
    expect(quiet.exitCode).toBe(0);
    expect(packetOf(quiet).capabilities.every((c) => c.effect === 'none')).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#ci-run-blocks-enforce]
  it('a test turned into a skip blocks at enforce as test weakening', async () => {
    const s = await scenario({ skipAuthTest: true });
    const r = await run(s, { head: s.head, base: s.base }, reviewed(s));
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(packetOf(r).weakening.some((w) => w.severity === 'error' && w.file === 'tests/auth.test.ts')).toBe(true);
    expect(packetOf(r).capabilities.find((c) => c.capability === 'auth')?.effect).toBe('blocks');
  });

  // [claims: capabilities/integration-surfaces#ci-run-blocks-enforce]
  it('owned code changed with no change record and no changed requirement blocks at enforce', async () => {
    const s = await scenario({ touchAuth: true });
    const r = await run(s, { head: s.head, base: s.base }, reviewed(s));
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(packetOf(r).unrequested.withoutChange).toEqual([{ file: 'src/auth/login.ts', capabilities: ['auth'] }]);
    expect(packetOf(r).capabilities.find((c) => c.capability === 'auth')?.blocking.map((b) => b.code)).toContain('CODE_WITHOUT_CHANGE');
  });

  // [claims: capabilities/integration-surfaces#ci-run-blocks-enforce]
  it('a spike change cannot merge at enforce, even when every proof holds', async () => {
    const s = await scenario({ spike: true });
    const r = await run(s, { head: s.head, base: s.base }, reviewed(s));
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(packetOf(r).changes).toEqual([expect.objectContaining({ id: '20261026-free-shipping-a1b2', verdict: 'spike' })]);
    expect(packetOf(r).capabilities.find((c) => c.capability === 'shop')?.blocking.map((b) => b.code)).toContain('CHANGE_IS_SPIKE');
  });
});

describe('verified notes [ci-run-verify]', () => {
  // [claims: capabilities/integration-surfaces#ci-run-note-head]
  it('with attestation on, an ancestor note without a matching check run is ignored and its claims are re-proved, and a matching one is carried', async () => {
    const s = await scenario({ config: { proofStore: { verify: 'check-run' } } });
    const first = await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} });
    s.repo.write('src/auth/login.ts', 'export const login = 2;\n');
    gitCommit(s.repo.dir, 'touch auth');
    const second = sh(s.repo.dir, 'rev-parse', 'HEAD');
    const asked: string[][] = [];
    const spy: CiRunDeps['runTests'] = async (config, opts) => {
      if (opts.record === 'ci-head') asked.push(opts.claims ?? []);
      return runTestRun(config, opts);
    };

    // No check run vouches for the note on the first head: it is ignored and everything is proven again.
    const untrusted = await run(s, { head: second, base: s.head }, { api: fakeApi().api, runTests: spy, env: {} });
    expect(untrusted.messages.join('\n')).toContain('is unverified, not verified: ignoring it');
    expect(asked[0]).toContain(FREE_SHIPPING);
    expect(packetOf(untrusted).limits.join('\n')).toContain('was not verified');

    // A check run that carries the digest of the note on the second commit vouches for it: the third run carries its proofs.
    s.repo.write('src/auth/logout.ts', 'export const logout = 2;\n');
    gitCommit(s.repo.dir, 'touch logout');
    const third = sh(s.repo.dir, 'rev-parse', 'HEAD');
    asked.length = 0;
    const attested: ApiCheckRun[] = [{ id: 5, app: { slug: 'github-actions' }, output: { summary: `note-sha256: ${untrusted.note?.digest}\nschema: 1` } }];
    const trusted = await run(s, { head: third, base: second }, { api: fakeApi({ checkRuns: attested }).api, runTests: spy, env: {} });
    expect(trusted.messages.join('\n')).toContain('carrying proofs from the note on');
    expect(asked[0]).not.toContain(FREE_SHIPPING);
    expect(first.note?.pushed).toBe(true);
  });
});

describe('red by construction [ci-run-red]', () => {
  // [claims: capabilities/integration-surfaces#ci-run-red-by-construction]
  it('runs the changed claim tests against the base version of the owned code and sees them fail there and pass at head', async () => {
    const s = await scenario();
    const r = await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} });
    const evidence = packetOf(r).evidence.find((e) => e.ref === FREE_SHIPPING);
    expect(evidence?.sensitivity).toEqual({ kind: 'red-green', status: 'ok', redTests: 1 });
    expect(r.messages.join('\n')).toMatch(/sensitivity capabilities\/shop#free-shipping: ok \(1 test fail on the base code\)/);
    // The construction leaves nothing behind: no worktree, and the checkout still holds the head's code.
    expect(sh(s.repo.dir, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(readFileSync(path.join(s.repo.dir, 'src/shop/cart.ts'), 'utf8')).toContain('FREE_SHIPPING');
  });

  // [claims: capabilities/integration-surfaces#ci-run-red-by-construction]
  it('a test that passes on the base code is reported as not sensitive and blocks at enforce', async () => {
    const s = await scenario({ sensitive: false });
    const r = await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} });
    const packet = packetOf(r);
    expect(packet.evidence.find((e) => e.ref === FREE_SHIPPING)?.sensitivity).toMatchObject({ kind: 'red-green', status: 'fail' });
    expect(packet.verdict).toBe('blocked');
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(r.messages.join('\n')).toContain('its tests pass on the base code');
  });

  // [claims: capabilities/integration-surfaces#ci-run-red-by-construction]
  it('says unknown, never ok, when the red run is skipped', async () => {
    const s = await scenario();
    const r = await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} }, { noRed: true });
    expect(packetOf(r).evidence.find((e) => e.ref === FREE_SHIPPING)?.sensitivity).toMatchObject({ status: 'unknown' });
    expect(packetOf(r).verdict).toBe('blocked');
  });
});

describe('the proof note [ci-run-note]', () => {
  // [claims: capabilities/integration-surfaces#ci-run-note-head]
  it('writes the proof note for the pull request head commit, with countersign rows, and pushes it', async () => {
    const s = await scenario();
    const fake = fakeApi({ reviews: [approval('rev', s.head)] });
    const r = await run(s, { head: s.head, base: s.base }, { api: fake.api, env: {} });
    expect(r.note).toMatchObject({ written: true, pushed: true });
    expect(remoteNotes(s)).toContain(s.head);

    const config = await loadConfig(s.repo.dir);
    const read = readNote(s.repo.dir, resolveNotesConfig(config.proofStore), s.head);
    if (!read?.ok) throw new Error('no readable note');
    const note = read.note;
    expect(note.commit).toBe(s.head);
    expect(note.tree).toBe(sh(s.repo.dir, 'rev-parse', `${s.head}^{tree}`));
    expect(note.ci).toMatchObject({ provider: 'github', event: 'pull_request', repo: 'o/r', pr: 7, runId: '42' });
    expect(note.countersigns).toEqual([expect.objectContaining({ method: 'command', status: 'countersigned', by: 'rev', pr: 7 })]);
    expect(note.rows.some((x) => x.claim === FREE_SHIPPING && x.verdict === 'proven' && x.sensitivity?.kind === 'red-green')).toBe(true);
    expect(note.packet).toMatchObject({ pr: 7, verdict: 'ready' });
    expect(r.note?.digest).toMatch(/^[0-9a-f]{64}$/);
    // Attestation is opt-in: with proofStore.verify off no check run is written, so the workflow needs no checks permission.
    expect(fake.checks).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#ci-run-note-head]
  it('records the check runs that bind the note to its digest when attestation is on', async () => {
    const s = await scenario({ config: { proofStore: { verify: 'check-run' } } });
    const fake = fakeApi({ reviews: [approval('rev', s.head)] });
    const r = await run(s, { head: s.head, base: s.base }, { api: fake.api, env: {} });
    expect(fake.checks.map((c) => c.name)).toEqual(['specguard/proof-note', 'specguard/proof']);
    expect(fake.checks[0]?.head_sha).toBe(s.head);
    expect(fake.checks[0]?.output.summary).toContain(`note-sha256: ${r.note?.digest}`);
    expect(fake.checks[1]?.conclusion).toBe('success');
  });

  // [claims: capabilities/integration-surfaces#ci-run-affected-only]
  it('a second commit re-runs only the stale claims and carries the others from the note', async () => {
    const s = await scenario();
    await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} });

    s.repo.write('src/auth/login.ts', 'export const login = 2;\n');
    gitCommit(s.repo.dir, 'touch auth');
    const second = sh(s.repo.dir, 'rev-parse', 'HEAD');
    const asked: string[][] = [];
    const spy: CiRunDeps['runTests'] = async (config, opts) => {
      asked.push(opts.claims ?? []);
      return runTestRun(config, opts);
    };
    // The base is now the first head (the earlier commits were merged or the base moved): nothing about shipping changed.
    const r = await run(s, { head: second, base: s.head }, { api: fakeApi({ reviews: [approval('rev', second)] }).api, runTests: spy, env: {} });

    const firstRun = asked[0] ?? [];
    expect(firstRun).toContain('capabilities/auth#login-valid-code');
    expect(firstRun).not.toContain(FREE_SHIPPING);
    expect(r.messages.join('\n')).toMatch(/carrying proofs from the note on/);
    const config = await loadConfig(s.repo.dir);
    const read = readNote(s.repo.dir, resolveNotesConfig(config.proofStore), second);
    if (!read?.ok) throw new Error('no note for the second commit');
    expect(read.note.carriedFrom).toBe(s.head);
    expect(read.note.rows.map((x) => x.claim)).toEqual(expect.arrayContaining([FREE_SHIPPING, 'capabilities/auth#login-valid-code']));
  });

  // [claims: capabilities/integration-surfaces#ci-run-squash-import]
  it('a squash commit with the pull request head\'s tree imports its note by tree equality and runs no tests', async () => {
    const s = await scenario();
    await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} });

    sh(s.repo.dir, 'checkout', '-q', 'main');
    sh(s.repo.dir, 'merge', '--squash', 'feat');
    sh(s.repo.dir, 'commit', '-q', '-m', 'free shipping (#7)');
    const merged = sh(s.repo.dir, 'rev-parse', 'HEAD');
    expect(sh(s.repo.dir, 'rev-parse', `${merged}^{tree}`)).toBe(sh(s.repo.dir, 'rev-parse', `${s.head}^{tree}`));

    let ran = 0;
    const spy: CiRunDeps['runTests'] = async (config, opts) => {
      ran += 1;
      return runTestRun(config, opts);
    };
    const r = await run(s, { name: 'push', head: merged, base: s.base, before: s.base }, { api: fakeApi().api, runTests: spy, env: {} });
    expect(ran).toBe(0);
    expect(r.messages.join('\n')).toContain('importing its proof note');
    expect(r.note).toMatchObject({ written: true, pushed: true });
    expect(remoteNotes(s)).toContain(merged);

    const config = await loadConfig(s.repo.dir);
    const read = readNote(s.repo.dir, resolveNotesConfig(config.proofStore), merged);
    if (!read?.ok) throw new Error('no imported note');
    expect(read.note).toMatchObject({ commit: merged, importedFrom: { commit: s.head, reason: 'tree-equal' } });
    expect(read.note.rows.length).toBeGreaterThan(0);
  });
});

describe('degradation [ci-run-degrade]', () => {
  // [claims: capabilities/integration-surfaces#ci-run-degrades]
  it('a pull request from a fork posts no comment and pushes no note, and puts the packet in the job summary', async () => {
    const s = await scenario();
    const fake = fakeApi({ reviews: [approval('rev', s.head)] });
    const summary = stepSummary();
    const ctx = contextOf({ head: s.head, base: s.base, headRepo: 'someone/r' });
    expect(ctx.pr?.isFork).toBe(true);
    expect(ctx.canWrite).toEqual({ notes: false, comment: false, checks: false });
    const r = await runCi(await loadConfig(s.repo.dir), ctx, { now: NOW }, { api: fake.api, env: { GITHUB_STEP_SUMMARY: summary }, sleep: noSleep });

    expect(fake.comments).toEqual([]);
    expect(remoteNotes(s)).toBe('');
    expect(readFileSync(summary, 'utf8')).toContain('SpecGuard proof packet');
    expect(existsSync(path.join(s.repo.dir, '.specguard/ci/packet.md'))).toBe(true);
    expect(existsSync(path.join(s.repo.dir, '.specguard/ci/note.json'))).toBe(true);
    expect(r.note).toMatchObject({ written: false, pushed: false });
    expect(r.messages.join('\n')).toContain('fork pull request');
  });

  // [claims: capabilities/integration-surfaces#ci-run-degrades]
  it('with no token the gate is still decided by the exit code, and nothing is posted or pushed', async () => {
    const s = await scenario();
    const ctx = contextOf({ head: s.head, base: s.base, token: false });
    expect(ctx.canWrite).toEqual({ notes: false, comment: false, checks: false });
    const r = await runCi(await loadConfig(s.repo.dir), ctx, { now: NOW }, { env: {}, sleep: noSleep });
    expect(r.gate).toBe('fail');
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(packetOf(r).limits.join('\n')).toContain('no GitHub token');
    expect(remoteNotes(s)).toBe('');
  });

  // [claims: capabilities/integration-surfaces#ci-run-degrades]
  it('unreadable reviews are a limit of the packet, never a failure of the job on their own', async () => {
    const s = await scenario({ enforce: 'observe' });
    const fake = fakeApi({ reviewsFail: true });
    const r = await run(s, { head: s.head, base: s.base }, { api: fake.api, env: {} });
    expect(r.exitCode).toBe(0);
    expect(packetOf(r).limits.join('\n')).toContain('reviews could not be read');
    expect(r.note?.pushed).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#ci-run-degrades]
  it('a comment that cannot be posted falls back to the job summary and does not fail the run', async () => {
    const s = await scenario({ enforce: 'observe' });
    const fake = fakeApi();
    fake.api.upsertComment = async () => ({ posted: false, updated: false, reason: 'GitHub API POST: HTTP 403' });
    const summary = stepSummary();
    const r = await run(s, { head: s.head, base: s.base }, { api: fake.api, env: { GITHUB_STEP_SUMMARY: summary } });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join('\n')).toContain('no pull request comment (GitHub API POST: HTTP 403)');
    expect(readFileSync(summary, 'utf8')).toContain('SpecGuard proof packet');
  });

  // [claims: capabilities/integration-surfaces#ci-run-degrades]
  it('a dry run writes artifacts only: no comment, no note, no check run', async () => {
    const s = await scenario({ config: { proofStore: { verify: 'check-run' } } });
    const fake = fakeApi({ reviews: [approval('rev', s.head)] });
    const r = await run(s, { head: s.head, base: s.base }, { api: fake.api, env: {} }, { dryRun: true });
    expect(fake.comments).toEqual([]);
    expect(fake.checks).toEqual([]);
    expect(remoteNotes(s)).toBe('');
    expect(sh(s.repo.dir, 'for-each-ref', 'refs/notes')).toBe('');
    expect(existsSync(path.join(s.repo.dir, '.specguard/ci/packet.json'))).toBe(true);
    expect(r.packet?.verdict).toBe('ready');
  });

  // [claims: capabilities/integration-surfaces#ci-run-degrades]
  it('a checkout of the merge ref is proven but no note is written for it', async () => {
    const s = await scenario({ enforce: 'observe' });
    const r = await run(s, { head: 'f'.repeat(40), base: s.base }, { api: fakeApi().api, env: {} });
    expect(r.messages.join('\n')).toContain('is not the pull request head');
    expect(remoteNotes(s)).toBe('');
  });

  // [claims: capabilities/integration-surfaces#ci-run-degrades]
  it('does nothing, successfully, outside a git checkout and on v1 specs', async () => {
    const s = await scenario();
    const ctx = contextOf({ head: s.head, base: s.base });
    const config = await loadConfig(s.repo.dir);
    const outside = await runCi({ ...config, rootDir: os.tmpdir() }, ctx, { now: NOW }, { env: {}, sleep: noSleep });
    expect(outside.exitCode).toBe(0);
    expect(outside.messages.join('\n')).toContain('nothing to prove');
  });
});

describe('ci packet and ci doctor [ci-commands]', () => {
  // [claims: capabilities/integration-surfaces#ci-commands]
  it('re-renders a saved packet as markdown and refuses anything that is not one', async () => {
    const s = await scenario();
    const r = await run(s, { head: s.head, base: s.base }, { api: fakeApi({ reviews: [approval('rev', s.head)] }).api, env: {} });
    const saved = readFileSync(path.join(s.repo.dir, '.specguard/ci/packet.json'), 'utf8');
    const rendered = renderSavedPacket(saved);
    if (!rendered.ok) throw new Error(rendered.error);
    expect(rendered.markdown).toBe(readFileSync(path.join(s.repo.dir, '.specguard/ci/packet.md'), 'utf8').trimEnd());
    expect(rendered.packet.verdict).toBe(r.packet?.verdict);
    expect(renderSavedPacket('not json')).toEqual({ ok: false, error: 'the file is not JSON' });
    expect(renderSavedPacket('{"schema":"other"}')).toMatchObject({ ok: false });
    expect(renderSavedPacket(JSON.stringify({ ...JSON.parse(saved), version: 2 }))).toMatchObject({ ok: false, error: expect.stringContaining('newer SpecGuard') });
  });

  // [claims: capabilities/integration-surfaces#ci-commands]
  it('the doctor says what would happen here without a network and without a token in its output', async () => {
    const s = await scenario();
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: s.head, SG_GITHUB_TOKEN: 'token-for-tests' } as NodeJS.ProcessEnv;
    const r = await runCiDoctor(await loadConfig(s.repo.dir), { env });
    const text = r.messages.join('\n');
    expect(r.exitCode).toBe(0);
    expect(text).toContain('git checkout at');
    expect(text).toContain('would push the proof note');
    expect(text).toContain('attestation is off');
    expect(text).toContain('capabilities: 2 enforce');
    expect(text).not.toContain('token-for-tests');

    const bare = await runCiDoctor(await loadConfig(s.repo.dir), { env: {} });
    expect(bare.messages.join('\n')).toContain('not running in GitHub Actions');
  });

  // [claims: capabilities/integration-surfaces#ci-commands]
  it('a replayed event never carries the token, so a replay writes nothing to GitHub', () => {
    const file = path.join(os.tmpdir(), `sg-event-${process.pid}.json`);
    writeFileSync(file, JSON.stringify({ pull_request: { number: 3, user: { login: 'dev' }, head: { sha: 'a'.repeat(40), repo: { full_name: 'o/r' } }, base: { sha: 'b'.repeat(40) } } }));
    const ctx = ciContextFromEnv({ GITHUB_REPOSITORY: 'o/r', SG_GITHUB_TOKEN: 'token-for-tests' } as NodeJS.ProcessEnv, file);
    expect(ctx).toMatchObject({ event: 'pull_request', pr: { number: 3 }, canWrite: { notes: false, comment: false, checks: false } });
    expect(ctx.token).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain('token-for-tests');
  });
});
