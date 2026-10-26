import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ChangeKind } from '../../src/core/change-record.js';
import { loadConfig } from '../../src/core/config.js';
import type { EnforceLevel } from '../../src/core/types.js';
import { changeStatuses, runChangeStart, type ChangeStatusEntry } from '../../src/pipelines/change.js';
import { runChangeGreen, runChangeRed } from '../../src/pipelines/change-run.js';
import { AUTH_TITLE, CART_TOTALS, RUNNER, SHIPPING_TITLE, approveShop, commentTag, changeRepo, gitCommit, setCatalog, type CatalogEntry } from './change-fixture.js';
import { editOf, readLog, runBundle, claudePayload, type Ran } from './hook-repo.js';
import type { TmpRepo } from './repo.js';

export { RUNNER };

export const CART_TITLE = 'adds up the cart';
export const NOW = new Date('2026-10-26T10:00:00.000Z');

/** The catalog of the fake runner: auth and the baseline cart test always pass; the shipping test passes once the code has the marker. */
export const catalogWith = (shipping: boolean): CatalogEntry[] => [
  { file: 'tests/auth.test.ts', title: AUTH_TITLE },
  { file: 'tests/cart.test.ts', title: CART_TITLE },
  ...(shipping ? [{ file: 'tests/shop.test.ts', title: SHIPPING_TITLE, needs: { file: 'src/shop/cart.ts', marker: 'FREE_SHIPPING' } }] : []),
];

/**
 * A committed v2 repo with the fake runner, a baseline test for the existing shop requirement and that requirement
 * approved by a person. `shop` is the enforce level written into the shop spec (a fixture shortcut: the ratchet command
 * is covered by its own test).
 */
export async function e2eRepo(opts: { shop?: EnforceLevel; auth?: EnforceLevel } = {}): Promise<TmpRepo> {
  const repo = changeRepo();
  const setLevel = (rel: string, level: EnforceLevel | undefined): void => {
    if (!level) return;
    const file = path.join(repo.dir, rel);
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: active', `status: active\nenforce: ${level}`));
  };
  setLevel('specs/capabilities/shop.md', opts.shop);
  setLevel('specs/capabilities/auth.md', opts.auth);
  repo.write('tests/cart.test.ts', [commentTag(CART_TOTALS), `it('${CART_TITLE}', () => {`, '  expect(1 + 1).toBe(2);', '});', ''].join('\n'));
  setCatalog(repo, catalogWith(false));
  await approveShop(repo);
  gitCommit(repo.dir, 'baseline: shop approved and tested');
  return repo;
}

/** The shipping test as the agent writes it (tagged, so `change red` runs exactly it). */
export const writeShippingTest = (repo: TmpRepo, extra = ''): void => {
  repo.write('tests/shop.test.ts', [commentTag('capabilities/shop#free-shipping'), `it('${SHIPPING_TITLE}', () => {`, '  expect(shippingFee(60)).toBe(0);', '});', extra, ''].join('\n'));
  setCatalog(repo, catalogWith(true));
};

export async function startChange(repo: TmpRepo, opts: { capabilities?: string[]; kind?: ChangeKind; why?: string; random?: string } = {}): Promise<string> {
  const r = await runChangeStart(await loadConfig(repo.dir), {
    capabilities: opts.capabilities ?? ['shop'],
    kind: opts.kind ?? 'feature',
    why: opts.why ?? 'free shipping',
    now: NOW,
    random: () => opts.random ?? 'a1b2',
  });
  if (r.exitCode !== 0) throw new Error(r.messages.join('\n'));
  return r.items[0]!.key;
}

export async function stageOf(repo: TmpRepo, id: string): Promise<ChangeStatusEntry> {
  const got = await changeStatuses(await loadConfig(repo.dir), { id });
  if (!got.ok) throw new Error(got.error);
  return got.changes[0]!;
}

export const blockCodes = (s: ChangeStatusEntry): string[] => s.blocks.map((b) => b.code);

export async function red(repo: TmpRepo, id?: string) {
  return runChangeRed(await loadConfig(repo.dir), { id });
}

export async function green(repo: TmpRepo, id?: string) {
  return runChangeGreen(await loadConfig(repo.dir), { id });
}

// ---------------------------------------------------------------------------------------------------------------------
// The real hook process
// ---------------------------------------------------------------------------------------------------------------------

export interface Guard {
  /** `allow` or `deny`, from the decision log the hook wrote. */
  decision: string;
  code: string;
  /** The deny reason, or the allow's additional context. */
  message: string;
  ran: Ran;
}

function guardOf(repo: TmpRepo, ran: Ran): Guard {
  const last = readLog(repo).at(-1) ?? {};
  const out = ran.json?.hookSpecificOutput ?? {};
  return {
    decision: String(last.decision),
    code: String(last.code),
    message: String(out.permissionDecisionReason ?? out.additionalContext ?? ''),
    ran,
  };
}

/** A Claude Code Edit of `rel` through the committed bundle. */
export const claudeEdit = (repo: TmpRepo, rel: string): Guard => guardOf(repo, runBundle(editOf(repo, rel)));

/** A Claude Code Write of `content` to `rel`. */
export const claudeWrite = (repo: TmpRepo, rel: string, content: string): Guard =>
  guardOf(repo, runBundle(claudePayload(repo, { tool: 'Write', input: { file_path: path.join(repo.dir, rel), content } })));

/** A Claude Code Bash call. */
export const claudeBash = (repo: TmpRepo, command: string): Guard => guardOf(repo, runBundle(claudePayload(repo, { tool: 'Bash', input: { command } })));

/** A Codex `apply_patch` of `rel`, with `--agent codex`. */
export function codexPatch(repo: TmpRepo, rel: string): Guard {
  const patch = ['*** Begin Patch', `*** Update File: ${rel}`, '@@', '-a', '+b', '*** End Patch'].join('\n');
  const payload = JSON.stringify({ session_id: 'c-1', turn_id: 'turn-1', cwd: repo.dir, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch }, model: 'm' });
  return guardOf(repo, runBundle(payload, { args: ['pre-tool-use', '--agent', 'codex'] }));
}
