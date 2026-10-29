import * as fs from 'fs';
import * as path from 'path';
import type { ProjectConfigInfo } from './project-config.js';

const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
/** Contributions and relationships, independent of whether the container itself has an app config. */
export function repositoryContent(root: string, projects: Array<{ key: string; absPath: string; config: ProjectConfigInfo }>) {
  const contents = new Set<string>();
  const overlayFor: string[] = [];
  const suppliedBy: string[] = [];
  for (const p of projects) {
    const c = p.config;
    if (c.overlayRoot && inside(root, c.overlayRoot)) overlayFor.push(p.key);
    if (p.absPath === root && c.configDir && !inside(root, c.configDir)) suppliedBy.push(c.overlayRoot ?? c.configDir);
    if (p.absPath === root && c.configured) contents.add('code');
    if (c.configDir) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(c.configDir, '.specguard/config.json'), 'utf8'));
        for (const app of raw.apps ?? []) for (const [key, role] of [['specDir', 'specs'], ['testDir', 'tests'], ['testOutput', 'tests'], ['testOutputDir', 'tests'], ['docsDir', 'docs']] as const) {
          if (typeof app[key] === 'string' && inside(root, path.resolve(c.configDir, app[key]))) contents.add(role);
          for (const ref of app.extraTestSources ?? []) {
            if (typeof ref === 'string' && inside(root, path.resolve(c.configDir, ref.split(/[?*{]/)[0]))) contents.add('tests');
          }
        }
      } catch { /* Missing configs carry no inferred contributions. */ }
    }
  }
  for (const [dir, role] of [['specs', 'specs'], ['tests', 'tests'], ['test', 'tests'], ['e2e', 'tests'], ['docs', 'docs'], ['src', 'code']] as const) {
    try { if (fs.statSync(path.join(root, dir)).isDirectory()) contents.add(role); } catch { /* absent */ }
  }
  return { contents: [...contents], overlayFor, suppliedBy };
}
