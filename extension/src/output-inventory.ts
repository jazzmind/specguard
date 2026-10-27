/** Local output inventories use the configured directories, including overlay specs. */
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'tinyglobby';
import { parse } from 'yaml';

export type OutputKind = 'specs' | 'tests' | 'docs';
export interface OutputFile { path: string; title: string; relativePath: string; }
export interface ProjectSettings {
  extends?: string;
  paths?: { specsRoot?: string; docsOut?: string };
  apps?: Array<{ name?: string; specDir?: string; testOutput?: string; docs?: boolean | string; sources?: { tests?: string[] } }>;
  featureState?: { catalog?: string; catalogFormat?: string; catalogExclude?: string[] };
}

export function readProjectSettings(configDir: string, seen = new Set<string>()): ProjectSettings {
  return readSettingsFile(path.join(configDir, '.specguard', 'config.json'), seen);
}

function readSettingsFile(file: string, seen: Set<string>): ProjectSettings {
  if (seen.has(file)) throw new Error('Circular SpecGuard config inheritance');
  seen.add(file);
  const own = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectSettings;
  if (!own.extends) return own;
  let target = path.resolve(path.dirname(path.dirname(file)), own.extends);
  if (!target.endsWith('.json')) target = path.join(target, '.specguard', 'config.json');
  const parent = readSettingsFile(target, seen);
  return { ...parent, ...own, paths: { ...parent.paths, ...own.paths }, featureState: { ...parent.featureState, ...own.featureState } };
}

export function markdownMeta(text: string): Record<string, unknown> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return {};
  try { return (parse(block) as Record<string, unknown>) ?? {}; } catch { return {}; }
}

export async function collectOutputs(kind: OutputKind, root: string, configDir = root): Promise<OutputFile[]> {
  let config: ProjectSettings = {};
  try { config = readProjectSettings(configDir); } catch { /* unconfigured projects still have browsable files */ }
  const apps = config.apps ?? [];
  let patterns: string[];
  if (kind === 'specs') {
    patterns = [...new Set([...(config.paths?.specsRoot ? [config.paths.specsRoot] : []), ...(apps.length ? apps.map((a) => a.specDir ?? 'specs') : ['specs'])])].map((dir) => path.resolve(configDir, dir, '**/*.md'));
  } else if (kind === 'tests') {
    patterns = [
      ...apps.flatMap((a) => (a.sources?.tests ?? []).map((p) => path.resolve(root, p))),
      ...apps.filter((a) => a.testOutput).map((a) => path.resolve(root, a.testOutput!, '**/*')),
      path.resolve(root, '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}'),
      path.resolve(root, '**/tests/**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,rb}'),
    ];
  } else {
    patterns = [...new Set([root, configDir])].map((base) => path.resolve(base, 'docs/**/*.{md,mdx,rst,txt,html,pdf}'));
    if (config.paths?.docsOut) patterns.push(path.resolve(configDir, config.paths.docsOut, '**/*.{md,mdx,rst,txt,html,pdf}'));
    patterns.push(...apps.filter((a) => typeof a.docs === 'string').map((a) => path.resolve(configDir, a.docs as string, '**/*.{md,mdx,rst,txt,html,pdf}')));
  }
  const files = await glob(patterns.map((p) => p.split(path.sep).join('/')), {
    cwd: root,
    absolute: true, onlyFiles: true, followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/_archive/**', ...(kind === 'specs' ? ['**/history/**', '**/README.md'] : [])],
  });
  return [...new Set(files)].sort().map((file) => {
    let title = path.basename(file);
    if (/\.mdx?$/i.test(file)) try {
      const text = fs.readFileSync(file, 'utf8');
      const meta = markdownMeta(text);
      title = typeof meta.title === 'string' ? meta.title : /^#\s+(.+)$/m.exec(text)?.[1] ?? title;
    } catch { /* the file name remains useful */ }
    return { path: file, title, relativePath: path.relative(root, file).split(path.sep).join('/') };
  });
}
