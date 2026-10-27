import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const make = (...args: string[]): string => execFileSync('make', args, { cwd: root, encoding: 'utf8' });

describe('Make workflows [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#make-workflows]
  it('lists each public command once, grouped by usage, development, validation and publishing', () => {
    const help = stripVTControlCharacters(make('help'));
    expect(help).toMatch(/Local usage[\s\S]*install-cli[\s\S]*vsix-install[\s\S]*Local development[\s\S]*deps[\s\S]*Validation[\s\S]*prove[\s\S]*Publishing[\s\S]*publish/);
    const source = readFileSync(path.join(root, 'Makefile'), 'utf8');
    for (const [, command] of source.matchAll(/^([\w-]+):.*## /gm)) {
      expect(help.match(new RegExp(`^  ${command}\\s`, 'gm')), command).toHaveLength(1);
    }
    expect(help).toContain('Alias for deps');
    expect(help).toContain('npm install --global .');
  });

  // [claims: capabilities/integration-surfaces#make-workflows]
  it('packages locally without release operations and keeps install as a dependency setup alias', () => {
    const setup = make('-n', 'install');
    expect(setup.match(/npm ci/g)).toHaveLength(2);
    expect(setup).toContain('npm --prefix webview ci');
    const local = make('-n', 'vsix');
    expect(local).toContain('vsce package --no-dependencies');
    expect(local).not.toMatch(/git (tag|push)|vsce publish|npm publish|release-check/);
  });

  // [claims: capabilities/integration-surfaces#make-workflows]
  it('installs the expected VSIX with an explicit editor executable whose path contains spaces', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'sg-make-'));
    try {
      const editor = path.join(temp, 'fake code');
      const argsFile = path.join(temp, 'args.json');
      writeFileSync(editor, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
      writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
      // Packaging is checked separately; run the install recipe against a recording executable.
      make('-o', 'vsix', 'vsix-install', `CODE=${editor}`);
      const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
      expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toEqual(['--install-extension', `extension/specguard-${version}.vsix`, '--force']);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
