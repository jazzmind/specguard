import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { runChangeAbandon, runChangeStart } from '../../src/pipelines/change.js';
import { runHistoryAdd } from '../../src/pipelines/history.js';
import { addFreeShippingClaim, approveShop } from '../helpers/change-fixture.js';
import { NOW, blockCodes, claudeBash, claudeEdit, claudeWrite, e2eRepo, red, stageOf, startChange, writeShippingTest } from '../helpers/e2e-protocol.js';
import { readLog } from '../helpers/hook-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const CODE = 'src/shop/cart.ts';
const historyFiles = (repo: TmpRepo): string[] => readdirSync(path.join(repo.dir, 'specs', 'history')).sort();

const APPROVAL_TEXT = (ref: string): string =>
  ['---', 'id: 2026-10-26-forged', 'kind: approval', 'method: command', `approves:`, `  - ${ref}@0000000000000000`, 'author: Ada', '---', '# Forged', ''].join('\n');

describe('what an agent cannot write, with the real hook and the real commands [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#e2e-agent-cannot-approve]
  it('refuses `history add --kind approval`, and the hook denies a hand-written approval, a record edit and an approve command', async () => {
    const repo = await e2eRepo({ shop: 'observe' });
    const id = await startChange(repo);
    const config = await loadConfig(repo.dir);

    // the command route is closed: only `spec approve` writes an approval, and it needs a person
    const before = historyFiles(repo);
    const viaKind = await runHistoryAdd(config, { kind: 'approval', decision: 'approved', affects: ['shop'], author: 'bot' });
    expect(viaKind.exitCode).not.toBe(0);
    expect(viaKind.messages.join('\n')).toContain('approvals are recorded by `specguard spec approve`');
    const viaApproves = await runHistoryAdd(config, { decision: 'approved', affects: ['shop'], approves: ['capabilities/shop#cart-totals@abcd'], method: 'command' });
    expect(viaApproves.exitCode).not.toBe(0);
    expect(historyFiles(repo)).toEqual(before);

    // the file route is closed too, at every level (this repo's shop is at observe, the loosest)
    const forged = claudeWrite(repo, 'specs/history/2026-10-26-forged.md', APPROVAL_TEXT('capabilities/shop#cart-totals'));
    expect([forged.decision, forged.code]).toEqual(['deny', 'DENY_APPROVAL_WRITE']);
    expect(forged.message).toContain('specguard spec approve');
    expect(historyFiles(repo)).toEqual(before);
    // a plain decision entry is not an approval and is not stopped
    expect(claudeWrite(repo, 'specs/history/2026-10-26-note.md', '---\nid: n\nkind: decision\n---\n# A decision\n')).toMatchObject({ decision: 'allow' });

    // so is the shell route
    for (const command of ['specguard spec approve shop --yes', 'npx -p specguard-ai specguard spec approve --all --yes', `printf 'kind: approval' > specs/history/x.md`]) {
      expect(claudeBash(repo, command), command).toMatchObject({ decision: 'deny' });
    }
    expect(claudeBash(repo, 'specguard change status')).toMatchObject({ decision: 'allow' });

    // and the record of the change: intent can only move through the `change` commands
    const rewrite = claudeWrite(repo, `.specguard/changes/${id}.json`, JSON.stringify({ version: 1, id, kind: 'spike', capabilities: ['shop'] }));
    expect([rewrite.decision, rewrite.code]).toEqual(['deny', 'DENY_RECORD_EDIT']);
    const codes = readLog(repo).map((e) => e.code);
    expect(codes).toContain('DENY_APPROVAL_WRITE');
    expect(codes).toContain('DENY_BASH_APPROVE');

    // none of that moved the change: still nothing approved
    expect(blockCodes(await stageOf(repo, id))).toEqual(['NO_INTENT_CHANGE']);
  }, 60_000);
});

describe('parallel changes on one capability [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#e2e-parallel-changes]
  it('judges both on the same changed claims; any one with a valid red opens the code; closing it closes the code again', async () => {
    const repo = await e2eRepo({ shop: 'enforce' });
    const a = await startChange(repo, { why: 'free shipping', random: 'a1b2' });
    const second = await runChangeStart(await loadConfig(repo.dir), { capabilities: ['shop'], why: 'shipping tests', now: NOW, random: () => 'c3d4' });
    const b = second.items[0]!.key;
    expect(second.messages.join('\n')).toContain(`[warn] change ${a} is open on this branch for shop`);

    addFreeShippingClaim(repo);
    await approveShop(repo);
    writeShippingTest(repo);
    // one claim, two changes: each sees it, each needs its own red
    for (const id of [a, b]) {
      const s = await stageOf(repo, id);
      expect(s.changed.map((c) => c.ref)).toEqual(['capabilities/shop#free-shipping']);
      expect([s.stage, ...blockCodes(s)]).toEqual(['red', 'RED_MISSING']);
    }
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'deny', code: 'DENY_BEFORE_RED' });

    // a command that acts on one change will not guess between two
    const ambiguous = await red(repo);
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.messages.join('\n')).toContain('name one');

    expect((await red(repo, a)).exitCode).toBe(0);
    expect((await stageOf(repo, a)).stage).toBe('code');
    expect((await stageOf(repo, b)).stage).toBe('red');
    const open = claudeEdit(repo, CODE);
    expect([open.decision, open.code]).toEqual(['allow', 'ALLOW_CHANGE']);
    expect(readLog(repo).at(-1)).toMatchObject({ change: a });

    // abandoning the change that held the red: hooks ignore a closed change, and the other one has not seen red yet
    const abandoned = await runChangeAbandon(await loadConfig(repo.dir), { id: a, why: 'superseded' });
    expect(abandoned.exitCode, abandoned.messages.join('\n')).toBe(0);
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'deny', code: 'DENY_BEFORE_RED' });
    expect(claudeWrite(repo, `.specguard/changes/${a}.json`, readFileSync(path.join(repo.dir, `.specguard/changes/${a}.json`), 'utf8'))).toMatchObject({ decision: 'deny', code: 'DENY_RECORD_EDIT' });

    expect((await red(repo, b)).exitCode).toBe(0);
    expect(claudeEdit(repo, CODE)).toMatchObject({ decision: 'allow', code: 'ALLOW_CHANGE' });
    expect(readLog(repo).at(-1)).toMatchObject({ change: b });
  }, 120_000);
});
