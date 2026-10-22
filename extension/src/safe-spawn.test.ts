import { describe, expect, it } from 'vitest';

import { nodeRuntime, planSpawn, shellQuote, UnsafeArgumentError, winQuote } from './safe-spawn.js';

// [claims: capabilities/security-and-remediation#no-shell-spawn]
describe('starting the CLI without a shell', () => {
  it('runs a script under node, and a .ts checkout under node --import tsx, on any platform', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(planSpawn('/x/cli.js', ['check', '--spec', 'a b; rm -rf /'], { platform })).toEqual({ command: 'node', args: ['/x/cli.js', 'check', '--spec', 'a b; rm -rf /'] });
      expect(planSpawn('/x/index.ts', ['serve'], { platform, node: '/n/node' })).toEqual({ command: '/n/node', args: ['--import', 'tsx', '/x/index.ts', 'serve'] });
    }
  });

  it('runs any other command directly off Windows, with the arguments untouched', () => {
    const plan = planSpawn('/proj/node_modules/.bin/specguard', ['--spec', '$(touch pwned) `id` & x'], { platform: 'darwin' });
    expect(plan).toEqual({ command: '/proj/node_modules/.bin/specguard', args: ['--spec', '$(touch pwned) `id` & x'] });
    expect('windowsVerbatimArguments' in plan).toBe(false);
  });

  it('runs an .exe directly on Windows, and a .cmd shim or bare name through cmd.exe with every argument quoted', () => {
    expect(planSpawn('C:\\bin\\specguard.exe', ['check'], { platform: 'win32' })).toEqual({ command: 'C:\\bin\\specguard.exe', args: ['check'] });
    const shim = planSpawn('C:\\p\\.bin\\specguard.cmd', ['check', '--spec', 'a & b (x)'], { platform: 'win32', comspec: 'cmd.exe' });
    expect(shim).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\p\\.bin\\specguard.cmd" "check" "--spec" "a & b (x)""'], windowsVerbatimArguments: true });
    const bare = planSpawn('C:\\p\\.bin\\specguard', ['x'], { platform: 'win32', comspec: 'cmd.exe', exists: (f) => f.endsWith('.cmd') });
    expect(bare.args[3]).toContain('specguard.cmd');
  });

  it('refuses an argument cmd.exe cannot be given safely, and protects a trailing backslash', () => {
    for (const bad of ['a"b', '50%', 'a\nb', 'a\0b']) {
      expect(() => winQuote(bad)).toThrow(UnsafeArgumentError);
      expect(() => planSpawn('x.cmd', ['ok', bad], { platform: 'win32' })).toThrow(UnsafeArgumentError);
    }
    expect(winQuote('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(winQuote('plain')).toBe('"plain"');
  });
});

// [claims: capabilities/security-and-remediation#no-shell-spawn]
describe('quoting an argument for a terminal', () => {
  it('single-quotes so $(...), backticks and ; are text, and survives an embedded quote', () => {
    expect(shellQuote('specs/auth.md', 'linux')).toBe("'specs/auth.md'");
    expect(shellQuote('$(touch pwned).md', 'darwin')).toBe("'$(touch pwned).md'");
    expect(shellQuote("it's `id`; x", 'linux')).toBe("'it'\\''s `id`; x'");
    expect(shellQuote("it's", 'win32')).toBe("'it''s'");
    expect(() => shellQuote('a\nb')).toThrow(UnsafeArgumentError);
  });

  it('round-trips through a real shell without executing anything', async () => {
    const { execFileSync } = await import('node:child_process');
    for (const nasty of ['$(echo PWNED)', '`echo PWNED`', "a'b", 'a b;echo PWNED', '$HOME', '"q"']) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(nasty, 'linux')}`], { encoding: 'utf8' });
      expect(out).toBe(nasty);
    }
  });
});


describe('nodeRuntime', () => {
  // [claims: capabilities/security-and-remediation#no-shell-spawn]
  it('uses the host executable as Node inside Electron, and plain node elsewhere', () => {
    const electron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    try {
      Object.defineProperty(process.versions, 'electron', { value: '30.0.0', configurable: true });
      expect(nodeRuntime()).toEqual({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
      Object.defineProperty(process.versions, 'electron', { value: undefined, configurable: true });
      expect(nodeRuntime()).toEqual({ command: 'node', env: {} });
    } finally {
      if (electron) Object.defineProperty(process.versions, 'electron', electron);
      else delete (process.versions as Record<string, unknown>).electron;
    }
  });
});
