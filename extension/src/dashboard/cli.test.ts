/**
 * Tests for dashboard/cli.ts — resolveCliPath, loadDotEnv, spawnCli.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 *
 * ESM note: fs and child_process namespace objects are non-configurable, so
 * vi.spyOn doesn't work. Both modules are fully mocked here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('../settings.js', () => ({ runtimeEnvironment: async () => ({ SG_SECURE_KEY: 'secure-test-value' }) }));

// vscode is not available in the test environment — provide a manual mock.
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(),
  },
}));

// ESM modules are non-configurable — must use full module mocks.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import { resolveCliPath, setExtensionPath, loadDotEnv, spawnCli } from './cli.js';

afterEach(() => {
  vi.mocked(fs.existsSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(cp.spawn).mockReset();
  setExtensionPath('');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockVscodeCfg(cliPath: string) {
  (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
    get: (key: string, def: unknown) => (key === 'cliPath' ? cliPath : def),
  });
}

function makeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

// ---------------------------------------------------------------------------
// resolveCliPath — AC-1 through AC-5
// ---------------------------------------------------------------------------

describe('resolveCliPath', () => {
  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-1: returns explicit cliPath setting without filesystem checks', async () => {
    mockVscodeCfg('/custom/specguard');
    expect(await resolveCliPath('/workspace')).toBe('/custom/specguard');
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-2: falls back to workspace node_modules/.bin/specguard', async () => {
    mockVscodeCfg('');
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).endsWith('node_modules/.bin/specguard'),
    );
    expect(await resolveCliPath('/workspace')).toBe('/workspace/node_modules/.bin/specguard');
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-3: falls back to dev src/cli/index.ts when no local bin', async () => {
    mockVscodeCfg('');
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).endsWith('src/cli/index.ts'),
    );
    expect(await resolveCliPath('/workspace')).toBe('/workspace/src/cli/index.ts');
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-4: falls back to bundled dist/cli.js when extension path is set', async () => {
    mockVscodeCfg('');
    setExtensionPath('/ext');
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p) === '/ext/dist/cli.js',
    );
    expect(await resolveCliPath('/workspace')).toBe('/ext/dist/cli.js');
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-5: returns empty string when no CLI path is resolvable', async () => {
    mockVscodeCfg('');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(await resolveCliPath('/workspace')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// loadDotEnv — AC-10 and related
// ---------------------------------------------------------------------------

describe('loadDotEnv', () => {
  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-10: ignores blank lines and # comment lines', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('# comment\n\nVALID=ok\n' as unknown as ReturnType<typeof fs.readFileSync>);
    const vars = loadDotEnv('/ws/.specguard/.env');
    expect(vars).toEqual({ VALID: 'ok' });
    expect(Object.keys(vars)).not.toContain('');
    expect(Object.keys(vars)).not.toContain('# comment');
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('strips surrounding single and double quotes from values', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('A="double"\nB=\'single\'\n' as unknown as ReturnType<typeof fs.readFileSync>);
    const vars = loadDotEnv('/ws/.specguard/.env');
    expect(vars.A).toBe('double');
    expect(vars.B).toBe('single');
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('returns empty object when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadDotEnv('/no/such/.env')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// spawnCli — AC-6, AC-7, AC-11, AC-12
// ---------------------------------------------------------------------------

describe('spawnCli', () => {
  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-6: rejects with actionable error message when cliPath is empty', async () => {
    const handle = spawnCli('', ['status'], '/ws', () => {});
    await expect(handle.promise).rejects.toThrow('SpecGuard CLI not found');
    expect(() => handle.kill()).not.toThrow();
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-7: .js path spawns via node', async () => {
    const mockProc = makeProc();
    vi.mocked(cp.spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof cp.spawn>);
    spawnCli('/ext/dist/cli.js', ['--version'], '/ws', () => {});
    await vi.waitFor(() => expect(cp.spawn).toHaveBeenCalled());
    expect(cp.spawn).toHaveBeenCalledWith(
      'node',
      ['/ext/dist/cli.js', '--version'],
      expect.objectContaining({ cwd: '/ws', env: expect.objectContaining({ SG_SECURE_KEY: 'secure-test-value' }) }),
    );
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-7: .ts path spawns via node --import tsx, without a shell', async () => {
    const mockProc = makeProc();
    vi.mocked(cp.spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof cp.spawn>);
    spawnCli('/ws/src/cli/index.ts', ['status'], '/ws', () => {});
    await vi.waitFor(() => expect(cp.spawn).toHaveBeenCalled());
    expect(cp.spawn).toHaveBeenCalledWith(
      'node',
      ['--import', 'tsx', '/ws/src/cli/index.ts', 'status'],
      expect.objectContaining({ cwd: '/ws', env: expect.objectContaining({ SG_SECURE_KEY: 'secure-test-value' }) }),
    );
  });

  // [claims: capabilities/security-and-remediation#no-shell-spawn]
  it('never starts a shell, and passes an argument full of shell syntax as one argument', async () => {
    const mockProc = makeProc();
    vi.mocked(cp.spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof cp.spawn>);
    spawnCli('/ext/dist/cli.js', ['check', '--spec', '$(touch pwned); rm -rf / & `id`'], '/ws', () => {});
    spawnCli('/ws/src/cli/index.ts', ['x; y'], '/ws', () => {});
    spawnCli('/proj/node_modules/.bin/specguard', ['a b'], '/ws', () => {});
    await vi.waitFor(() => expect(cp.spawn).toHaveBeenCalledTimes(3));
    for (const call of vi.mocked(cp.spawn).mock.calls) {
      expect((call[2] as { shell?: unknown }).shell).toBeUndefined();
    }
    expect(vi.mocked(cp.spawn).mock.calls[0][1]).toEqual(['/ext/dist/cli.js', 'check', '--spec', '$(touch pwned); rm -rf / & `id`']);
  });

  // [claims: capabilities/security-and-remediation#no-shell-spawn]
  it('rejects, rather than running, an argument cmd.exe cannot be given safely', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const handle = spawnCli('C:\\p\\.bin\\specguard.cmd', ['--spec', 'a" & calc & "'], 'C:\\ws', () => {});
      await expect(handle.promise).rejects.toThrow(/refusing to pass an argument/);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-11: streams stdout lines to onLine callback', async () => {
    const mockProc = makeProc();
    vi.mocked(cp.spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof cp.spawn>);
    const lines: string[] = [];
    const handle = spawnCli('/ext/dist/cli.js', ['status'], '/ws', (l) => lines.push(l));
    await vi.waitFor(() => expect(cp.spawn).toHaveBeenCalled());
    mockProc.stdout.emit('data', Buffer.from('line1\nline2\n'));
    mockProc.emit('close', 0);
    await handle.promise;
    expect(lines).toContain('line1');
    expect(lines).toContain('line2');
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('AC-12: kill() sends SIGTERM without throwing', async () => {
    const mockProc = makeProc();
    vi.mocked(cp.spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof cp.spawn>);
    const handle = spawnCli('/ext/dist/cli.js', ['status'], '/ws', () => {});
    await vi.waitFor(() => expect(cp.spawn).toHaveBeenCalled());
    expect(() => handle.kill()).not.toThrow();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// [claims: capabilities/integration-surfaces#extension-workspace-settings]
it('cancels while credentials are still being resolved without starting a child process', async () => {
  const handle = spawnCli('/ext/dist/cli.js', ['generate'], '/ws', () => {});
  handle.kill();
  expect(await handle.promise).toBe(-1);
  expect(cp.spawn).not.toHaveBeenCalled();
});
