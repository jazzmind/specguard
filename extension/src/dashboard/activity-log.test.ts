import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) } }));
import { ActivityLogService } from './activity-log.js';

// [claims: capabilities/platform-foundation#activity-log-git-clean]
it('persists, reconciles and clears extension activity without dirtying a clean repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ext-log-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't'); git('config', 'user.email', 't@example.com'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'README.md'), '# Test\n'); git('add', '-A'); git('commit', '-qm', 'base');
    const service = new ActivityLogService(root);
    service.append({ pipeline: 'commit', status: 'running', source: 'extension' });
    service.append({ pipeline: 'commit', status: 'pass', source: 'extension' });
    expect(git('status', '--porcelain')).toBe('');
    service.clearCompleted();
    expect(JSON.parse(fs.readFileSync(path.join(root, '.specguard/activity-log.json'), 'utf8'))).toEqual([]);
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    service.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);
