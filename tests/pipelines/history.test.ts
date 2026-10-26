import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn() }));

import { loadConfig } from '../../src/core/config.js';
import { listHistory } from '../../src/core/history.js';
import { intentGaps } from '../../src/core/intent-gap.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { buildTraceModel } from '../../src/core/trace.js';
import { capturePlan, planFromHook, proposeAffects, recordPrompt, runHistoryAdd, runHistoryLog } from '../../src/pipelines/history.js';
import { gitCommit, gitInit, makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const mocked = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;
let repo: TmpRepo;
const read = (rel: string) => readFileSync(path.join(repo.dir, rel), 'utf8');

beforeEach(() => {
  mocked.mockReset();
  repo = makeV2Repo();
});

describe('history add [history-add]', () => {
  // [claims: capabilities/requirement-history#history-add, capabilities/requirement-history#history-backrefs, capabilities/requirement-history#history-entry-format]
  it('writes an entry and links it from every affected capability [add-and-link]', async () => {
    const config = await loadConfig(repo.dir);
    const r = await runHistoryAdd(config, { prompt: 'Add a second factor to login', decision: 'Use TOTP', title: 'Second factor', affects: ['auth'], date: '2026-10-15' });
    expect(r.exitCode).toBe(0);
    const entry = read('specs/history/2026-10-15-second-factor.md');
    expect(entry).toContain('kind: decision');
    expect(entry).toContain('## Decision');
    expect(entry).toContain('  - auth');
    expect(read('specs/capabilities/auth.md')).toContain('history:\n  - 2026-10-15-second-factor');
    expect(listHistory(config)).toHaveLength(1);
  });

  // [claims: capabilities/requirement-history#history-entry-format]
  it('writes the policy lines of a decision into the entry and leaves other entries without one [policy]', async () => {
    const config = await loadConfig(repo.dir);
    await runHistoryAdd(config, { decision: 'Raise cart to warn', title: 'Ratchet cart', affects: ['auth'], policy: ['enforce auth observe->warn'], date: '2026-10-25' });
    await runHistoryAdd(config, { decision: 'No policy here', title: 'Plain', affects: ['auth'], date: '2026-10-25' });
    expect(read('specs/history/2026-10-25-ratchet-cart.md')).toContain('policy:\n  - "enforce auth observe->warn"');
    expect(read('specs/history/2026-10-25-plain.md')).not.toContain('policy:');
    expect(listHistory(config).find((e) => e.id === '2026-10-25-ratchet-cart')?.policy).toEqual(['enforce auth observe->warn']);
  });

  // [claims: capabilities/requirement-history#history-redaction]
  it('redacts secrets before anything is written [redaction]', async () => {
    const config = await loadConfig(repo.dir);
    await runHistoryAdd(config, { prompt: 'use key sk-abcdefghijklmnopqrstuvwx and mail wes@example.com', affects: [], date: '2026-10-15' });
    const [file] = listHistory(config).map((e) => e.file);
    // The secret must not reach the file name or the title either.
    expect(path.basename(file)).not.toMatch(/sk-|abcdefghijkl|example/);
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('[KEY]');
    expect(written).not.toContain('sk-abcdefghijklmnop');
    expect(written).not.toContain('wes@example.com');
  });

  // [claims: capabilities/requirement-history#history-add]
  it('reads a plan from a file and uses its heading as the title [plan-file]', async () => {
    repo.write('plan.md', '# Rework checkout\n\nstep one\n');
    const r = await runHistoryAdd(await loadConfig(repo.dir), { plan: 'plan.md', affects: ['shop'], date: '2026-10-16' });
    expect(r.items[0].key).toBe('2026-10-16-rework-checkout');
    expect(read('specs/history/2026-10-16-rework-checkout.md')).toContain('step one');
  });

  // [claims: capabilities/requirement-history#history-affects-proposal]
  it('proposes affected capabilities with the fast model when --affects is omitted, dropping unknown ids [propose]', async () => {
    const config = await loadConfig(repo.dir);
    config.llm = { ...config.llm, provider: 'anthropic' };
    mocked.mockResolvedValue({ capabilities: ['auth', 'ghost'] });
    expect(await proposeAffects(config, 'login changes')).toEqual(['auth']);
    expect(mocked.mock.calls[0][0].pipeline).toBe('history');
    const r = await runHistoryAdd(config, { decision: 'Rotate session tokens', date: '2026-10-15' });
    expect(r.messages.join('\n')).toContain('affects (proposed): auth');
    expect(read('specs/capabilities/auth.md')).toContain('2026-10-15-rotate-session-tokens');
  });

  // [claims: capabilities/requirement-history#history-affects-proposal]
  it('records against the system spec when no model can propose capabilities [no-llm]', async () => {
    const config = await loadConfig(repo.dir);
    expect(config.llm.provider).toBe('none');
    const r = await runHistoryAdd(config, { decision: 'Keep it simple', date: '2026-10-15' });
    expect(r.created).toBe(1);
    const entry = read('specs/history/2026-10-15-keep-it-simple.md');
    expect(entry).toContain('affects:\n  - system');
    expect(entry).toContain('source: manual');
    expect(read('specs/system.md')).toContain('history:\n  - 2026-10-15-keep-it-simple');
  });

  // [claims: capabilities/requirement-history#history-add-affects]
  it('fails with exit 2 and writes nothing when --affects names an unknown capability [unknown-capability]', async () => {
    const r = await runHistoryAdd(await loadConfig(repo.dir), { decision: 'x', affects: ['auth', 'ghost'], date: '2026-10-15' });
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toContain('ghost');
    expect(existsSync(path.join(repo.dir, 'specs/history'))).toBe(false);
    expect(read('specs/capabilities/auth.md')).not.toContain('history:');
  });

  // [claims: capabilities/requirement-history#history-add]
  it('requires something to record [needs-input]', async () => {
    expect((await runHistoryAdd(await loadConfig(repo.dir), {})).exitCode).toBe(1);
  });

  // [claims: capabilities/requirement-history#history-log]
  it('log filters to one capability through affects or the history: list [log]', async () => {
    const config = await loadConfig(repo.dir);
    await runHistoryAdd(config, { decision: 'about auth', affects: ['auth'], date: '2026-01-01' });
    await runHistoryAdd(config, { decision: 'about shop', affects: ['shop'], date: '2026-01-02' });
    const all = await runHistoryLog(await loadConfig(repo.dir));
    expect(all.created).toBe(2);
    // Newest first.
    expect(all.items.map((i) => i.key)).toEqual(['2026-01-02-about-shop', '2026-01-01-about-auth']);
    const auth = await runHistoryLog(await loadConfig(repo.dir), { capability: 'auth' });
    expect(auth.messages.join('\n')).toContain('about auth');
    expect(auth.messages.join('\n')).not.toContain('about shop');
  });
});

describe('hook entry points [history-capture]', () => {
  const prompt = (session: string, text: string) => JSON.stringify({ session_id: session, cwd: '/x', hook_event_name: 'UserPromptSubmit', prompt: text });
  const plan = (session: string, text: string) => JSON.stringify({ session_id: session, tool_name: 'ExitPlanMode', tool_input: { plan: text } });

  // [claims: capabilities/requirement-history#history-inbox-capture, capabilities/requirement-history#history-redaction]
  it('records redacted prompts and ignores empty or malformed input without throwing [inbox]', async () => {
    const config = await loadConfig(repo.dir);
    expect(recordPrompt(config, prompt('s1', 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 now'))).toBe(true);
    expect(recordPrompt(config, prompt('s1', '   '))).toBe(false);
    expect(recordPrompt(config, 'not json')).toBe(false);
    expect(recordPrompt(config, '')).toBe(false);
    const inbox = read('.specguard/history/inbox.jsonl');
    expect(inbox).toContain('[KEY]');
    expect(inbox).not.toContain('ghp_abcdef');
  });

  // [claims: capabilities/requirement-history#history-inbox-capture]
  it('trims an oversized inbox [inbox-cap]', async () => {
    const config = await loadConfig(repo.dir);
    const file = path.join(repo.dir, '.specguard/history/inbox.jsonl');
    recordPrompt(config, prompt('s', 'first'));
    appendFileSync(file, `${JSON.stringify({ ts: 1, session: 'old', prompt: 'x'.repeat(2000) })}\n`.repeat(600));
    recordPrompt(config, prompt('s', 'last'));
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(301);
    expect(lines[lines.length - 1]).toContain('last');
  });

  // [claims: capabilities/requirement-history#history-plan-capture]
  it('writes one committed entry from the approved plan and only that session\'s prompts [capture]', async () => {
    const config = await loadConfig(repo.dir);
    recordPrompt(config, prompt('s1', 'build the thing'), 1000);
    recordPrompt(config, prompt('s2', 'unrelated chatter from another session'), 1100);
    recordPrompt(config, prompt('s1', 'and make it fast'), 1200);
    const id = await capturePlan(config, plan('s1', '# Build the thing\n\n1. do it'));
    expect(id).toMatch(/-build-the-thing$/);
    const entry = read(`specs/history/${id}.md`);
    expect(entry).toContain('kind: prompt+plan');
    expect(entry).toContain('source: claude-code');
    expect(entry).toContain('build the thing');
    expect(entry).toContain('and make it fast');
    expect(entry).not.toContain('unrelated chatter');

    // A second plan in the same session only gets prompts since the last capture.
    recordPrompt(config, prompt('s1', 'now add logging'), 5_000_000_000_000);
    const second = await capturePlan(config, plan('s1', '# Add logging\n\n1. log'));
    const secondEntry = read(`specs/history/${second}.md`);
    expect(secondEntry).toContain('now add logging');
    expect(secondEntry).not.toContain('build the thing');
  });

  // [claims: capabilities/requirement-history#history-plan-capture]
  it('does nothing when the hook carries no plan [no-plan]', async () => {
    const config = await loadConfig(repo.dir);
    expect(await capturePlan(config, JSON.stringify({ session_id: 's', tool_name: 'ExitPlanMode', tool_input: {} }))).toBeUndefined();
    expect(await capturePlan(config, 'garbage')).toBeUndefined();
    expect(existsSync(path.join(repo.dir, 'specs/history'))).toBe(false);
  });

  // [claims: capabilities/requirement-history#history-plan-capture]
  it('falls back to the transcript when the hook input has no plan [transcript]', () => {
    const t = repo.write('t.jsonl', [JSON.stringify({ message: { content: [{ type: 'text', text: 'hi' }] } }), JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: '# From transcript' } }] } })].join('\n'));
    expect(planFromHook({ transcript_path: t, tool_input: {} })).toBe('# From transcript');
  });
});

describe('intent gaps [intent-gap]', () => {
  async function gaps() {
    const config = await loadConfig(repo.dir);
    const model = await buildTraceModel(config, {});
    return intentGaps(repo.dir, model.nodes, listHistory(config));
  }

  // [claims: capabilities/requirement-history#history-check-gap]
  it('reports code that changed after the last recorded intent, and clears when intent is recorded [gap-lifecycle]', { timeout: 30_000 }, async () => {
    gitInit(repo.dir, '2020-01-01T12:00:00Z');
    // No history in the repo yet: nothing to compare against.
    expect(await gaps()).toEqual([]);

    // History exists, but nothing was recorded for auth, and its code changes after the spec did.
    await runHistoryAdd(await loadConfig(repo.dir), { decision: 'long ago', affects: ['shop'], date: '2000-01-01' });
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 2;\n');
    gitCommit(repo.dir, 'change login', '2021-06-01T12:00:00Z');
    const found = await gaps();
    expect(found.map((g) => g.id)).toEqual(['auth']);
    expect(found[0]).toMatchObject({ codeDate: '2021-06-01', intentDate: '2020-01-01' });

    // Recording the intent, even the same day as the change, closes the gap.
    await runHistoryAdd(await loadConfig(repo.dir), { decision: 'why login changed', affects: ['auth'], date: '2021-06-01' });
    expect(await gaps()).toEqual([]);
  });
});
