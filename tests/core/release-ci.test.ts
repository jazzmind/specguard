import { describe, expect, it, vi } from 'vitest';

import { waitForCi } from '../../scripts/wait-for-ci.mjs';

const commit = 'a'.repeat(40);
const ci = { databaseId: 42, status: 'completed', conclusion: 'success', headSha: commit, url: 'https://github.com/o/r/actions/runs/42' };

function fixture(over: Record<string, unknown> = {}, options: { watchStatus?: number | null; final?: Record<string, unknown>; list?: unknown; authStatus?: number; listStatus?: number } = {}) {
  const log = vi.fn();
  const run = vi.fn((_bin: string, args: string[], config: { env?: NodeJS.ProcessEnv }) => {
    if (args[0] === 'auth') return { status: options.authStatus ?? 0, stdout: 'fixture-token\n' };
    expect(config.env?.GH_TOKEN).toBe('fixture-token');
    if (args[1] === 'list') return { status: options.listStatus ?? 0, stdout: JSON.stringify(options.list ?? [{ ...ci, ...over }]) };
    if (args[1] === 'watch') return { status: options.watchStatus === undefined ? 0 : options.watchStatus };
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ ...ci, ...options.final }) };
    throw new Error(`Unexpected gh invocation: ${args.join(' ')}`);
  });
  return { log, run, check: () => waitForCi({ commit, user: 'release-owner', run, log }) };
}

describe('release CI prerequisite [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it('selects the latest CI run for the exact main commit using the configured account', () => {
    const f = fixture();
    expect(f.check()).toBe(0);
    expect(f.run.mock.calls[0][1]).toEqual(['auth', 'token', '--user', 'release-owner']);
    expect(f.run.mock.calls[1][1]).toEqual(['run', 'list', '--branch', 'main', '--workflow', 'CI', '--commit', commit, '--limit', '1', '--json', 'databaseId,status,conclusion,headSha,url']);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it.each(['queued', 'in_progress', 'requested', 'waiting', 'pending'])('watches %s CI and confirms successful completion before allowing a release', (status) => {
    const f = fixture({ status, conclusion: '' });
    expect(f.check()).toBe(0);
    expect(f.run.mock.calls.map((c) => c[1][1])).toEqual(['token', 'list', 'watch', 'view']);
    expect(f.run.mock.calls[2][1]).toEqual(['run', 'watch', '42', '--exit-status', '--interval', '10']);
    expect(f.log.mock.calls.flat().join('\n')).toContain('Waiting for completion');
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'action_required'])('rejects completed CI with conclusion %s without watching it again', (conclusion) => {
    const f = fixture({ conclusion });
    expect(f.check()).toBe(1);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.log.mock.calls.flat().join('\n')).toContain(conclusion);
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it.each([1, null])('blocks publishing when the watcher fails or is interrupted (status %s)', (watchStatus) => {
    const f = fixture({ status: 'in_progress' }, { watchStatus });
    expect(f.check()).toBe(1);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.log.mock.calls.flat().join('\n')).toContain(ci.url);
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it.each([{ headSha: 'b'.repeat(40) }, { conclusion: 'failure' }, { status: 'in_progress' }])('rejects a watcher success whose final result is unsafe: %j', (final) => {
    const f = fixture({ status: 'queued' }, { final });
    expect(f.check()).toBe(1);
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it('reports a missing run and refuses runs for another commit or with an invalid ID', () => {
    for (const f of [fixture({}, { list: [] }), fixture({ headSha: 'b'.repeat(40) }), fixture({ databaseId: '--bad' })]) {
      expect(f.check()).toBe(1);
      expect(f.run).toHaveBeenCalledTimes(2);
    }
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it('reports authentication and API failures without exposing the token', () => {
    for (const f of [fixture({}, { authStatus: 1 }), fixture({}, { listStatus: 1 })]) {
      expect(f.check()).toBe(1);
      expect(f.log.mock.calls.flat().join('\n')).not.toContain('fixture-token');
    }
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it('rejects unreadable API output and an invalid commit without allowing a release', () => {
    const f = fixture();
    f.run.mockImplementationOnce(() => ({ status: 0, stdout: 'fixture-token' }));
    f.run.mockImplementationOnce(() => ({ status: 0, stdout: 'invalid JSON' }));
    expect(f.check()).toBe(1);
    expect(f.log.mock.calls.flat().join('\n')).toContain('unreadable CI result');
    const run = vi.fn();
    expect(waitForCi({ commit: 'HEAD', run, log: vi.fn() })).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });
});
