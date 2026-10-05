import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cliVersion, versionInfo } from '../../src/core/version.js';

const root = path.join(__dirname, '..', '..');
const pkgVersion = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;

describe('version', () => {
  it('comes from package.json, never a hard-coded value', () => {
    expect(cliVersion()).toBe(pkgVersion);
    expect(versionInfo()).toEqual({ name: 'specguard-ai', version: pkgVersion, node: process.version });
  });

  it('`--version --json` prints the machine-readable payload on one line', () => {
    const out = execFileSync('npx', ['tsx', 'src/cli/index.ts', '--version', '--json'], { cwd: root, encoding: 'utf8' });
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out)).toMatchObject({ name: 'specguard-ai', version: pkgVersion });
    expect(execFileSync('npx', ['tsx', 'src/cli/index.ts', '--version'], { cwd: root, encoding: 'utf8' }).trim()).toBe(pkgVersion);
  });
});
