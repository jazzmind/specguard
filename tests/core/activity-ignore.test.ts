import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureActivityLogIgnored } from '../../src/core/activity-ignore.js';
import { appendActivityLogEntry } from '../../src/mcp/activity-hook.js';
import { newRepo, sh } from '../helpers/notes-git.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).reverse().forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const repo = () => { const r = newRepo(); roots.push(r.dir); return r; };

describe('runtime activity stays out of Git', () => {
  // [claims: capabilities/platform-foundation#activity-log-git-clean, capabilities/integration-surfaces#activity-log-never-committed]
  it('stays clean after repeated real commits whose post-commit hook appends activity', () => {
    const r = repo();
    const hooks = path.join(r.dir, '.git/hooks');
    buildSync({ entryPoints: [path.resolve('src/mcp/activity-hook.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(hooks, 'activity-writer.cjs') });
    writeFileSync(path.join(hooks, 'post-commit'), `#!${process.execPath}\nconst {appendActivityLogEntry}=require('./activity-writer.cjs');appendActivityLogEntry(process.cwd(),{pipeline:'post-commit',status:'pass',source:'cli'});\n`, { mode: 0o755 });
    const index = sh(r.dir, 'ls-files', '-s');
    for (const n of [1, 2]) {
      r.commit('README.md', `commit ${n}\n`);
      expect(sh(r.dir, 'status', '--porcelain')).toBe('');
      expect(JSON.parse(readFileSync(path.join(r.dir, '.specguard/activity-log.json'), 'utf8'))).toHaveLength(n);
    }
    expect(existsSync(path.join(r.dir, '.gitignore'))).toBe(false);
    expect(sh(r.dir, 'ls-files')).toBe('README.md');
    expect(index).toContain('README.md');
    const exclude = readFileSync(path.join(r.dir, '.git/info/exclude'), 'utf8');
    expect(exclude.match(/^\/\.specguard\/activity-log\.json$/gm)).toHaveLength(1);
  });

  // [claims: capabilities/platform-foundation#activity-log-git-clean]
  it('ignores a nested project with literal spaces and brackets without changing versioned files or the index', () => {
    const r = repo();
    const project = path.join(r.dir, 'apps', 'my app [one]');
    mkdirSync(project, { recursive: true });
    const before = sh(r.dir, 'ls-files', '-s');
    appendActivityLogEntry(project, { pipeline: 'check', status: 'pass', source: 'mcp' });
    expect(sh(r.dir, 'status', '--porcelain')).toBe('');
    expect(sh(r.dir, 'ls-files', '-s')).toBe(before);
    expect(existsSync(path.join(project, '.specguard/activity-log.json'))).toBe(true);
    expect(existsSync(path.join(project, '.gitignore'))).toBe(false);
  });

  // [claims: capabilities/platform-foundation#activity-log-git-clean]
  it('supports linked worktrees whose .git is a file', () => {
    const r = repo();
    const linked = path.join(os.tmpdir(), path.basename(r.dir) + '-linked'); roots.push(linked);
    sh(r.dir, 'worktree', 'add', '-q', '-b', 'activity', linked);
    expect(ensureActivityLogIgnored(linked)).toBe(true);
    appendActivityLogEntry(linked, { pipeline: 'check', status: 'pass', source: 'mcp' });
    expect(sh(linked, 'status', '--porcelain')).toBe('');
  });

  // [claims: capabilities/platform-foundation#activity-log-git-clean]
  it('invalidates its cached exclusion when a repository ignore rule changes', () => {
    const r = repo();
    const entry = { pipeline: 'check', status: 'pass' as const, source: 'mcp' as const };
    appendActivityLogEntry(r.dir, entry);
    const file = path.join(r.dir, '.specguard/activity-log.json');
    const first = readFileSync(file, 'utf8');
    writeFileSync(path.join(r.dir, '.gitignore'), '!.specguard/activity-log.json\n');
    appendActivityLogEntry(r.dir, entry);
    expect(readFileSync(file, 'utf8')).toBe(first); // optional logging must not write an explicitly unignored file
    writeFileSync(path.join(r.dir, '.gitignore'), '');
    appendActivityLogEntry(r.dir, entry);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2);
  });

  // [claims: capabilities/platform-foundation#activity-log-git-clean]
  it('notices when a previously non-Git project becomes a repository', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sg-log-init-')); roots.push(root);
    const entry = { pipeline: 'check', status: 'pass' as const, source: 'mcp' as const };
    appendActivityLogEntry(root, entry);
    sh(root, 'init', '-q', '-b', 'main');
    appendActivityLogEntry(root, entry);
    expect(sh(root, 'status', '--porcelain')).toBe('');
    expect(JSON.parse(readFileSync(path.join(root, '.specguard/activity-log.json'), 'utf8'))).toHaveLength(2);
  });
});
