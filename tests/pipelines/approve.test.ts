import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { approvalsFrom } from '../../src/core/approvals.js';
import { loadConfig } from '../../src/core/config.js';
import { listHistory } from '../../src/core/history.js';
import { approvalStatus, enumerateClaims, runSpecApprovals, runSpecApprove, type SpecApproveOpts } from '../../src/pipelines/approve.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const PERSON = { agent: false, tty: true };
const DRAFT_SPEC =
  '---\nid: draft\nkind: capability\nparent: system\nvalue: later\nstatus: draft\nsources:\n  - "src/draft/**"\n---\n# Draft\n\n## Problem & Value\n\nNot built yet.\n\n## Requirements\n\n- [ ] It will exist <!-- claim: will-exist -->\n';

let repo: TmpRepo;
const read = (rel: string) => readFileSync(path.join(repo.dir, rel), 'utf8');
const historyFiles = () => (existsSync(path.join(repo.dir, 'specs/history')) ? readdirSync(path.join(repo.dir, 'specs/history')) : []);

async function approve(opts: SpecApproveOpts) {
  return runSpecApprove(await loadConfig(repo.dir), { by: 'Ada', actor: PERSON, ...opts });
}

beforeEach(() => {
  repo = makeV2Repo();
});

describe('enumerateClaims [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approve-targets]
  it('lists claims with ids of v2 capability specs, with owned source counts', async () => {
    const claims = await enumerateClaims(await loadConfig(repo.dir));
    expect(claims.map((c) => c.ref)).toEqual(['capabilities/auth#login-valid-code', 'capabilities/auth#logout-clears-session', 'capabilities/shop#cart-totals']);
    expect(claims[0]).toMatchObject({ capabilityId: 'auth', claimId: 'login-valid-code', ownedSources: 2 });
    expect(claims[0].claimHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // [claims: capabilities/intent-approval#approve-targets]
  it('skips v1 specs', async () => {
    repo.write('specs/core/awards.md', '# Awards\n\n<!--\n  module: src/awards.ts\n  type: core\n  status: draft\n-->\n\n## Acceptance Criteria\n\n- [ ] Award once <!-- claim: award-once -->\n');
    const refs = (await enumerateClaims(await loadConfig(repo.dir))).map((c) => c.ref);
    expect(refs.some((r) => r.includes('award-once'))).toBe(false);
  });
});

describe('spec approve [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approve-dry-run]
  it('is a dry run without --yes: lists what it would approve and writes nothing', async () => {
    const before = read('specs/capabilities/auth.md');
    const r = await approve({ all: true });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join('\n')).toContain('would approve 3 claim(s) in 2 capabilities; rerun with --yes');
    expect(historyFiles()).toEqual([]);
    expect(read('specs/capabilities/auth.md')).toBe(before);
  });

  // [claims: capabilities/intent-approval#approval-entry-record, capabilities/intent-approval#approval-backrefs-keep-hashes]
  it('--yes writes one approval entry, back-references it, and changes no claim hash', async () => {
    const config = await loadConfig(repo.dir);
    const hashesBefore = (await enumerateClaims(config)).map((c) => `${c.ref}=${c.claimHash}`);
    const r = await approve({ all: true, yes: true, note: 'reviewed together' });
    expect(r.exitCode).toBe(0);
    expect(r.created).toBe(1);

    const entries = listHistory(config).filter((e) => e.kind === 'approval');
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e).toMatchObject({ kind: 'approval', method: 'command', author: 'Ada' });
    expect(e.affects).toEqual(['auth', 'shop']);
    expect(e.approves).toHaveLength(3);
    expect(e.body).toContain('reviewed together');
    expect(approvalsFrom(entries).map((a) => a.claim).sort()).toEqual(['capabilities/auth#login-valid-code', 'capabilities/auth#logout-clears-session', 'capabilities/shop#cart-totals']);

    expect(read('specs/capabilities/auth.md')).toContain(`history:\n  - ${e.id}`);
    expect(read('specs/capabilities/shop.md')).toContain(`  - ${e.id}`);
    expect((await enumerateClaims(config)).map((c) => `${c.ref}=${c.claimHash}`)).toEqual(hashesBefore);

    const status = await approvalStatus(config);
    expect(status.claims.every((c) => c.approval?.by === 'Ada')).toBe(true);
    expect(status.byCapability.auth).toEqual({ total: 2, approved: 2, unapproved: [] });
  });

  // [claims: capabilities/intent-approval#approved-untouched]
  it('is idempotent: a second run writes nothing', async () => {
    await approve({ all: true, yes: true });
    const files = historyFiles();
    const auth = read('specs/capabilities/auth.md');
    const r = await approve({ all: true, yes: true });
    expect(r.exitCode).toBe(0);
    expect(r.created).toBe(0);
    expect(r.messages.join('\n')).toContain('all already approved');
    expect(historyFiles()).toEqual(files);
    expect(read('specs/capabilities/auth.md')).toBe(auth);
  });

  // [claims: capabilities/intent-approval#approved-untouched, capabilities/intent-approval#approved-while-hash-matches]
  it('approves only a reworded claim after an edit, leaving approved claims alone', async () => {
    await approve({ all: true, yes: true });
    repo.write('specs/capabilities/auth.md', read('specs/capabilities/auth.md').replace('Logout clears the session', 'Logout ends the session and clears it'));
    const config = await loadConfig(repo.dir);
    const status = await approvalStatus(config);
    expect(status.byCapability.auth.unapproved).toEqual(['capabilities/auth#logout-clears-session']);
    expect(status.byCapability.shop.unapproved).toEqual([]);

    const r = await approve({ targets: ['auth'], yes: true });
    expect(r.skipped).toBe(1);
    const entries = listHistory(config).filter((e) => e.kind === 'approval');
    expect(entries).toHaveLength(2);
    const second = entries.find((e) => e.approves!.length === 1)!;
    expect(second.approves![0]).toContain('capabilities/auth#logout-clears-session@');
    expect((await approvalStatus(config)).byCapability.auth.approved).toBe(2);
  });

  // [claims: capabilities/intent-approval#approve-targets]
  it('takes targets by capability, by capability#claim, by specKey#claim and by bare claim id', async () => {
    expect((await approve({ targets: ['auth'] })).messages.join('\n')).toContain('would approve 2 claim(s) in 1 capabilities');
    expect((await approve({ targets: ['auth#login-valid-code'] })).messages.join('\n')).toContain('would approve 1 claim(s)');
    expect((await approve({ targets: ['capabilities/shop#cart-totals'] })).messages.join('\n')).toContain('capabilities/shop#cart-totals');
    expect((await approve({ targets: ['cart-totals'] })).messages.join('\n')).toContain('would approve 1 claim(s)');

    const r = await approve({ targets: ['auth#logout-clears-session'], yes: true });
    expect(r.exitCode).toBe(0);
    const [e] = listHistory(await loadConfig(repo.dir)).filter((x) => x.kind === 'approval');
    expect(e.approves).toHaveLength(1);
    expect(e.affects).toEqual(['auth']);
  });

  // [claims: capabilities/intent-approval#approve-targets]
  it('fails on an unknown target, or no scope at all, and writes nothing', async () => {
    const unknown = await approve({ targets: ['auth', 'nope'], yes: true });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.messages.join('\n')).toContain('nope');
    const none = await approve({ yes: true });
    expect(none.exitCode).toBe(1);
    expect(historyFiles()).toEqual([]);
  });

  // [claims: capabilities/intent-approval#as-built-needs-sources]
  it('--as-built refuses a capability that owns no source files and writes nothing', async () => {
    repo.write('specs/capabilities/draft.md', DRAFT_SPEC);
    const refused = await approve({ all: true, asBuilt: true, yes: true });
    expect(refused.exitCode).toBe(2);
    expect(refused.messages.join('\n')).toContain('draft');
    expect(refused.messages.join('\n')).toContain('no source files');
    expect(historyFiles()).toEqual([]);

    const ok = await approve({ targets: ['auth', 'shop'], asBuilt: true, yes: true });
    expect(ok.exitCode).toBe(0);
    const [e] = listHistory(await loadConfig(repo.dir)).filter((x) => x.kind === 'approval');
    expect(e.method).toBe('as-built');
    // Without --as-built the unbuilt capability can still be approved on its wording.
    expect((await approve({ targets: ['draft'], yes: true })).exitCode).toBe(0);
  });

  // [claims: capabilities/intent-approval#agent-needs-terminal]
  it('refuses an agent without a terminal, and allows an agent that has one', async () => {
    const refused = await approve({ all: true, yes: true, actor: { agent: true, tty: false } });
    expect(refused.exitCode).toBe(1);
    expect(refused.messages.join('\n')).toContain('in their own terminal');
    expect(historyFiles()).toEqual([]);
    expect((await approve({ all: true, yes: true, actor: { agent: true, tty: true } })).exitCode).toBe(0);
  });

  // [claims: capabilities/intent-approval#agent-needs-terminal]
  it('derives the default actor from the host agent environment', async () => {
    const prev = process.env.SPECGUARD_HOST_AGENT;
    process.env.SPECGUARD_HOST_AGENT = '1';
    try {
      const config = await loadConfig(repo.dir);
      const r = await runSpecApprove(config, { all: true, yes: true, by: 'Ada', actor: undefined });
      // Under vitest stdin is not a terminal, so an agent environment is refused.
      expect(process.stdin.isTTY ? 0 : r.exitCode).toBe(process.stdin.isTTY ? 0 : 1);
    } finally {
      if (prev === undefined) delete process.env.SPECGUARD_HOST_AGENT;
      else process.env.SPECGUARD_HOST_AGENT = prev;
    }
  });
});

describe('spec approvals [intent-approval]', () => {
  // [claims: capabilities/intent-approval#approvals-report]
  it('reports approved/total per capability and the unapproved refs', async () => {
    await approve({ targets: ['auth#login-valid-code'], yes: true });
    const r = await runSpecApprovals(await loadConfig(repo.dir));
    const text = r.messages.join('\n');
    expect(text).toMatch(/auth\s+1\/2 approved/);
    expect(text).toContain('unapproved: capabilities/auth#logout-clears-session');
    expect(text).toMatch(/shop\s+0\/1 approved/);
    expect(text).toContain('1/3 claim(s) approved');
  });
});
