/** Keep optional runtime logging out of Git without writing the project's .gitignore or touching its index. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IgnoreCache { marker: string | null; files: string[]; stamp: string; allowed: boolean; }
const cache = new Map<string, IgnoreCache>();
const stamp = (files: string[]): string => files.map((file) => {
  try { const s = statSync(file); return s.isDirectory() ? 'directory' : `${s.ino}:${s.mtimeMs}:${s.size}`; } catch { return 'missing'; }
}).join('|');
function gitMarker(root: string): string | null {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.git');
    if (existsSync(marker)) return marker;
    if (path.dirname(dir) === dir) return null;
  }
}

export function ensureActivityLogIgnored(root: string): boolean {
  try {
    const cwd = realpathSync(root); // Git reports canonical paths, including macOS /var -> /private/var.
    const marker = gitMarker(cwd);
    const key = `${cwd}\0${process.env.GIT_DIR ?? ''}\0${process.env.GIT_WORK_TREE ?? ''}`;
    const cached = cache.get(key);
    if (cached && cached.marker === marker && cached.stamp === stamp(cached.files)) return cached.allowed;
    const file = path.join(cwd, '.specguard', 'activity-log.json');
    const options = { cwd, encoding: 'utf8' as const, timeout: 2000, stdio: 'pipe' as const };
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', file], options).status === 0;
    const git = spawnSync('git', ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude', '--git-path', 'config'], options);
    if (git.status !== 0) {
      if (marker || process.env.GIT_DIR) return false;
      // A later git init invalidates this through .git marker detection.
      if (!marker) cache.set(key, { marker, files: [], stamp: '', allowed: true });
      return true;
    }
    const [top, excludePath, configPath] = git.stdout.trim().split(/\r?\n/);
    if (!top || !excludePath) return false;
    const exclude = path.resolve(cwd, excludePath);
    const watched = [exclude, path.join(cwd, '.specguard', '.gitignore'), ...(marker ? [marker] : []),
      ...(configPath ? [path.resolve(cwd, configPath)] : []),
      process.env.GIT_CONFIG_GLOBAL ?? path.join(os.homedir(), '.gitconfig'),
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'git', 'config'), '/etc/gitconfig'];
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      watched.push(path.join(dir, '.gitignore'));
      if (dir === top || path.dirname(dir) === dir) break;
    }
    const remember = (allowed: boolean): boolean => {
      cache.set(key, { marker, files: watched, stamp: stamp(watched), allowed });
      return allowed;
    };
    if (ignored) {
      const verbose = spawnSync('git', ['check-ignore', '--verbose', '-z', '--no-index', '--stdin'], { ...options, input: `${file}\0` });
      const source = verbose.stdout?.split('\0')[0];
      if (source) watched.push(path.isAbsolute(source) ? source : path.resolve(top, source));
      return remember(true);
    }
    // Escape literal folder names, including spaces and glob metacharacters in nested projects.
    const relative = path.relative(top, file).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) return false;
    const rule = '/' + relative.replace(/([\\*?[\]#! ])/g, '\\$1');
    const old = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!old.split(/\r?\n/).includes(rule)) {
      mkdirSync(path.dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${old && !old.endsWith('\n') ? '\n' : ''}# SpecGuard local runtime activity\n${rule}\n`);
    }
    // A repository's explicit negation can override info/exclude. Avoid persisting an unignored log in that case.
    return remember(spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', file], options).status === 0);
  } catch {
    return false; // logging is optional; do not create an unignored file if the exclude cannot be written
  }
}
