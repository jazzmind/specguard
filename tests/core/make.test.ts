import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(help).toMatch(/Local usage[\s\S]*install-cli[\s\S]*install-vsix[\s\S]*Local development[\s\S]*install-dev[\s\S]*build-vsix[\s\S]*Validation[\s\S]*prove[\s\S]*Publishing[\s\S]*publish/);
    const source = readFileSync(path.join(root, 'Makefile'), 'utf8');
    for (const [, command] of source.matchAll(/^([\w-]+):.*## /gm)) {
      expect(help.match(new RegExp(`^  ${command}\\s`, 'gm')), command).toHaveLength(1);
    }
    expect(help).toContain('npm install --global .');
    expect(help).toContain('    make install-dev\n    make install\n    specguard --help');
    expect(help).toContain('    make bump V=x.y.z');
    expect(help).toContain('    make publish  # waits for GitHub CI on this commit before tagging');
  });

  // [claims: capabilities/integration-surfaces#make-workflows]
  it('separates development setup, local installation and packaging', () => {
    const setup = make('-n', 'install-dev');
    expect(setup.match(/npm ci/g)).toHaveLength(2);
    expect(setup).toContain('npm --prefix webview ci');
    const local = make('-n', 'build-vsix');
    expect(local).toContain('vsce package --no-dependencies');
    expect(local).not.toMatch(/git (tag|push)|vsce publish|npm publish|release-check/);
    expect(local).not.toContain('--install-extension');
    const install = make('-n', 'install', 'CODE=code');
    expect(install).toContain('npm install --global .');
    expect(install).toContain('--install-extension');
    expect(install).not.toContain('npm ci');
    expect(install).not.toMatch(/git (tag|push)|npm publish|vsce publish/);
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
      make('-o', 'build-vsix', 'install-vsix', `CODE=${editor}`);
      const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
      expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toEqual(['--install-extension', `extension/specguard-${version}.vsix`, '--force']);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it('runs the same CI-wait prerequisite for release-check and publish before tagging', () => {
    const check = make('-n', 'release-check');
    expect(check).toContain('scripts/wait-for-ci.mjs');
    const publish = make('-n', 'publish');
    expect(publish.indexOf('scripts/wait-for-ci.mjs')).toBeLessThan(publish.indexOf('git tag -a'));
  });

  // [claims: capabilities/integration-surfaces#release-waits-for-ci]
  it.each([true, false])('only tags after running CI succeeds (success: %s)', (success) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'sg-release-make-'));
    try {
      for (const dir of ['scripts', 'extension/scripts', 'bin']) mkdirSync(path.join(temp, dir), { recursive: true });
      for (const file of ['Makefile', 'scripts/wait-for-ci.mjs', 'extension/scripts/sync-version.mjs']) {
        copyFileSync(path.join(root, file), path.join(temp, file));
      }
      for (const file of ['package.json', 'extension/package.json']) writeFileSync(path.join(temp, file), '{"type":"module","version":"1.2.3"}');
      const events = path.join(temp, 'events.jsonl');
      // These recording executables never access a real repository, registry or GitHub.
      const fakeTool = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(events)}, JSON.stringify([tool, ...args]) + '\\n');
const sha = 'a'.repeat(40);
const run = { databaseId: 42, headSha: sha, status: 'in_progress', conclusion: '', url: 'https://example.test/ci/42' };
if (tool === 'git') {
  if (args.includes('--abbrev-ref')) console.log('main');
  else if (args.includes('--verify')) process.exit(1);
  else if (args[0] === 'rev-parse') console.log(sha);
} else if (tool === 'gh') {
  if (args[0] === 'auth') console.log('fixture-token');
  else if (args[1] === 'list') console.log(JSON.stringify([run]));
  else if (args[1] === 'watch') process.exit(${success ? 0 : 1});
  else if (args[1] === 'view') console.log(JSON.stringify({ ...run, status: 'completed', conclusion: 'success' }));
}
`;
      for (const name of ['git', 'npm', 'gh']) writeFileSync(path.join(temp, 'bin', name), fakeTool, { mode: 0o755 });
      const result = spawnSync('make', ['publish', 'YES=1'], { cwd: temp, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(temp, 'bin')}${path.delimiter}${process.env.PATH}` }, timeout: 15_000 });
      const calls = readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      const watch = calls.findIndex((c) => c[0] === 'gh' && c[2] === 'watch');
      const tag = calls.findIndex((c) => c[0] === 'git' && c[1] === 'tag');
      expect(watch).toBeGreaterThan(-1);
      expect(result.status, result.stdout + result.stderr).toBe(success ? 0 : 2);
      if (success) {
        expect(tag).toBeGreaterThan(watch);
        expect(calls.some((c) => c[0] === 'git' && c[1] === 'push')).toBe(true);
      } else {
        expect(tag).toBe(-1);
        expect(calls.some((c) => c[0] === 'git' && c[1] === 'push')).toBe(false);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
