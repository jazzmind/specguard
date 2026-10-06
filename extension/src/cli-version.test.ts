import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

import * as cp from 'child_process';
import { expectedCliVersion, mismatchMessage, parseVersionOutput, queryCliVersion } from './cli-version.js';

afterEach(() => vi.mocked(cp.spawn).mockReset());

function fakeChild(stdout: string, opts: { error?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    if (opts.error) child.emit('error', new Error('ENOENT'));
    else {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    }
  });
  return child as unknown as ReturnType<typeof cp.spawn>;
}

describe('cli version check', () => {
  it('parses the JSON line, ignoring noise around it', () => {
    expect(parseVersionOutput('warning\n{"name":"specguard-ai","version":"1.2.3","node":"v22"}\n')).toEqual({ name: 'specguard-ai', version: '1.2.3' });
    expect(parseVersionOutput('1.2.3')).toBeNull();
    expect(parseVersionOutput('{ nope')).toBeNull();
  });

  it('warns only on a real mismatch', () => {
    expect(mismatchMessage({ name: 'x', version: '1.0.0' }, '1.0.0')).toBeNull();
    expect(mismatchMessage(null, '1.0.0')).toBeNull();
    expect(mismatchMessage({ name: 'x', version: '1.0.0' }, undefined)).toBeNull();
    const msg = mismatchMessage({ name: 'x', version: '0.9.0' }, '1.0.0')!;
    expect(msg).toContain('0.9.0');
    expect(msg).toContain('specguard-ai@1.0.0');
  });

  it('runs `<cli> --version --json` (node for .js bundles) and reads the answer', async () => {
    vi.mocked(cp.spawn).mockReturnValueOnce(fakeChild('{"name":"specguard-ai","version":"0.1.2"}'));
    expect(await queryCliVersion('/ext/dist/cli.js', '/ws')).toEqual({ name: 'specguard-ai', version: '0.1.2' });
    expect(vi.mocked(cp.spawn).mock.calls[0][0]).toBe('node');
    expect(vi.mocked(cp.spawn).mock.calls[0][1]).toEqual(['/ext/dist/cli.js', '--version', '--json']);
    vi.mocked(cp.spawn).mockReturnValueOnce(fakeChild('{"version":"0.1.2"}'));
    await queryCliVersion('/ws/node_modules/.bin/specguard', '/ws');
    expect(vi.mocked(cp.spawn).mock.calls[1][0]).toBe('/ws/node_modules/.bin/specguard');
  });

  it('resolves null when the CLI cannot run', async () => {
    vi.mocked(cp.spawn).mockReturnValueOnce(fakeChild('', { error: true }));
    expect(await queryCliVersion('/missing', '/ws')).toBeNull();
  });

  it('has no expected version in an unbundled run', () => {
    expect(expectedCliVersion()).toBeUndefined();
  });
});
