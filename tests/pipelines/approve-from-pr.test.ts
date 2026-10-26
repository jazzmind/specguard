import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiReview } from '../../src/ci/github-api.js';
import { qualifyingReviews, trustApprovals, type ReviewFact } from '../../src/ci/pr-approvals.js';
import { makeHashAt } from '../../src/ci/claim-hash-at.js';
import { approvalsFrom, indexApprovals } from '../../src/core/approvals.js';
import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { listHistory } from '../../src/core/history.js';
import { buildSpecGraph } from '../../src/core/spec-graph.js';
import { approvalStatus, runSpecApprove, type SpecApproveOpts } from '../../src/pipelines/approve.js';
import { sh } from '../helpers/notes-git.js';
import type { TmpRepo } from '../helpers/repo.js';
import { gitCommit, gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const PERSON = { agent: false, tty: true };
const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';

let repo: TmpRepo;
let reviewed: string;

const review = (login: string, over: Partial<ApiReview> = {}): ApiReview => ({
  id: 100,
  user: { login, type: 'User' },
  state: 'APPROVED',
  commit_id: reviewed,
  submitted_at: '2026-10-26T10:00:00Z',
  author_association: 'MEMBER',
  ...over,
});

async function fromPr(reviews: ApiReview[], opts: SpecApproveOpts = {}) {
  return runSpecApprove(await loadConfig(repo.dir), { fromPr: 7, yes: true, actor: PERSON, loadPr: async () => ({ author: 'dev', reviews }), ...opts });
}
const entries = async () => listHistory(await loadConfig(repo.dir)).filter((e) => e.kind === 'approval');

beforeEach(() => {
  repo = makeV2Repo();
  gitInit(repo.dir);
  reviewed = sh(repo.dir, 'rev-parse', 'HEAD');
});

describe('spec approve --from-pr [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approve-from-pr]
  it('writes one committed method-pr entry per reviewer, naming the reviewer, for the claims their review covers', async () => {
    const r = await fromPr([review('rev'), review('rev2', { id: 101 })], { targets: ['auth'] });
    expect(r.exitCode).toBe(0);
    const written = await entries();
    // The newest review that covers a claim is the one recorded; both reviewers cover the same claims, so one of them is.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'approval', method: 'pr', source: 'spec-approve' });
    expect(['rev', 'rev2']).toContain(written[0]?.author);
    const approvals = approvalsFrom(written);
    expect(approvals.map((a) => a.claim).sort()).toEqual([LOGIN, LOGOUT]);
    expect(approvals.every((a) => a.method === 'pr' && a.by === written[0]?.author)).toBe(true);
    expect(written[0]?.body).toContain('review 10');
    expect(readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8')).toContain(written[0]!.id);

    const status = await approvalStatus(await loadConfig(repo.dir));
    expect(status.byCapability.auth).toEqual({ total: 2, approved: 2, unapproved: [] });
  });

  // [claims: capabilities/intent-approval#approve-from-pr]
  it('is a dry run without --yes: it lists what it would record and writes nothing', async () => {
    const r = await fromPr([review('rev')], { yes: false });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join('\n')).toContain('would record 3 approval(s) from 1 reviewer(s) of pull request 7; rerun with --yes');
    expect(await entries()).toEqual([]);
  });

  // [claims: capabilities/intent-approval#approve-from-pr-qualifying]
  it('ignores the author\'s own review, a bot, a commenter and a reviewer without write access, and writes nothing without a qualifying review', async () => {
    const r = await fromPr([review('dev'), review('ci[bot]', { id: 2, user: { login: 'ci[bot]', type: 'Bot' } }), review('talker', { id: 3, state: 'COMMENTED' }), review('visitor', { id: 4, author_association: 'NONE' })]);
    expect(r.exitCode).toBe(ExitCode.ValidationFailed);
    expect(r.messages.join('\n')).toContain('no qualifying review');
    expect(await entries()).toEqual([]);
  });

  // [claims: capabilities/intent-approval#approve-from-pr-qualifying]
  it('a claim reworded after the review is not covered, and the others are', async () => {
    repo.write('specs/capabilities/auth.md', readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8').replace('Logout clears the session', 'Logout clears the session and the cookie'));
    gitCommit(repo.dir, 'reword logout');
    const r = await fromPr([review('rev')], { targets: ['auth'] });
    expect(r.messages.join('\n')).toContain(`not covered by a review at its current wording: ${LOGOUT}`);
    expect(approvalsFrom(await entries()).map((a) => a.claim)).toEqual([LOGIN]);
  });

  // [claims: capabilities/intent-approval#approve-from-pr-qualifying]
  it('skips claims that are already approved, and says nothing is left when all are', async () => {
    await fromPr([review('rev')]);
    const again = await fromPr([review('rev')]);
    expect(again.exitCode).toBe(0);
    expect(again.messages.join('\n')).toContain('nothing to approve');
    expect(await entries()).toHaveLength(1);
  });

  // [claims: capabilities/intent-approval#approve-from-pr-person-only]
  it('stays a person-only command, and refuses --as-built, a bad number and a pull request it cannot read', async () => {
    const agent = await fromPr([review('rev')], { actor: { agent: true, tty: false } });
    expect(agent.exitCode).toBe(ExitCode.InternalError);
    expect(agent.messages.join('\n')).toContain('must be given by a person');
    expect((await fromPr([review('rev')], { asBuilt: true })).exitCode).toBe(ExitCode.ValidationFailed);
    expect((await fromPr([review('rev')], { fromPr: 0 })).exitCode).toBe(ExitCode.ValidationFailed);
    const broken = await fromPr([], { loadPr: async () => { throw new Error('no GitHub token: set GH_TOKEN'); } });
    expect(broken.exitCode).toBe(ExitCode.InternalError);
    expect(broken.messages.join('\n')).toContain('could not read pull request 7');
    expect(await entries()).toEqual([]);
  });

  // [claims: capabilities/intent-approval#approve-from-pr-ci-rechecks]
  it('is a convenience and never a bypass: CI counts the committed entry only while a review covers it', async () => {
    await fromPr([review('rev')], { targets: ['auth'] });
    const config = await loadConfig(repo.dir);
    const recorded = approvalsFrom(listHistory(config)).map((a) => ({ ...a, onBase: false }));
    const graph = await buildSpecGraph(config);
    const facts = (login: string): ReviewFact[] => [{ id: 100, login, isBot: false, state: 'APPROVED', commitId: reviewed, submittedAt: '2026-10-26T10:00:00Z', association: 'MEMBER' }];
    const trust = (login?: string) =>
      trustApprovals({
        changed: [],
        recorded,
        reviews: login ? qualifyingReviews(facts(login), 'dev') : [],
        noteApprovals: [],
        enforce: new Map([['auth', 'enforce']]),
        capabilityOf: () => 'auth',
        policy: { requireReview: 'enforce', allowSelf: false },
        hashAt: makeHashAt(config, graph),
      });
    expect(trust('rev').effective.map((a) => a.claim).sort()).toEqual([LOGIN, LOGOUT]);
    // Without a covering review the entry is only a record, however it was written.
    expect(trust().effective).toEqual([]);
    expect(indexApprovals(trust('rev').effective).find(LOGIN, (await approvalStatus(config)).claims[0]!.claimHash)?.method).toBe('pr');
  });
});
