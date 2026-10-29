/** Local output inventories use the configured directories, including overlay specs. */
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'tinyglobby';
import { parse } from 'yaml';

export type OutputKind = 'specs' | 'tests' | 'docs';
export interface OutputFile { path: string; title: string; relativePath: string; group?: string; order?: number; }
export interface OutputOrganization { placements?: Array<{ref: string; group: string; order: number}>; groups?: Array<{id: string; title: string; order: number}>; }
export interface ProjectSettings {
  extends?: string;
  paths?: { specsRoot?: string; docsOut?: string };
  apps?: Array<{ name?: string; originalSpecDir?: string; repo?: string; specDir?: string; testOutput?: string; docs?: boolean | string; sources?: { tests?: string[] } }>;
  featureState?: { catalog?: string; catalogFormat?: string; catalogExclude?: string[] };
}

export function readProjectSettings(configDir: string, seen = new Set<string>()): ProjectSettings {
  const settings = readSettingsFile(path.join(configDir, '.specguard', 'config.json'), seen);
  const file = path.join(configDir, '.specguard/output-locations.json');
  if (fs.existsSync(file)) {
    const locations = JSON.parse(fs.readFileSync(file, 'utf8')) as { apps: Record<string, Record<string, string>> };
    for (const app of settings.apps ?? []) {
      const saved = locations.apps[app.name ?? ''];
      if (!saved) continue;
      if (saved.specs) { app.originalSpecDir = app.specDir; app.specDir = saved.specs; }
      if (saved.docs) app.docs = saved.docs;
      app.sources = { ...app.sources, tests: [...(app.sources?.tests ?? []), ...Object.entries(saved).filter(([k]) => k.startsWith('tests.')).map(([, v]) => path.resolve(configDir, v, '**/*'))] };
    }
  }
  return settings;
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

export async function collectOutputs(kind: OutputKind, root: string, configDir = root, inheritedOrganization?: OutputOrganization): Promise<OutputFile[]> {
  let config: ProjectSettings = {};
  try { config = readProjectSettings(configDir); } catch { /* unconfigured projects still have browsable files */ }
  const apps = config.apps ?? [];
  let patterns: string[];
  if (kind === 'specs') {
    patterns = [...new Set([...(config.paths?.specsRoot ? [config.paths.specsRoot] : []), ...(apps.length ? apps.map((a) => a.specDir ?? 'specs') : ['specs'])])].map((dir) => path.resolve(configDir, dir, '**/*.md'));
  } else if (kind === 'tests') {
    patterns = [
      ...apps.flatMap((a) => (a.sources?.tests ?? []).map((p) => path.resolve(root, p))),
      ...apps.filter((a) => a.testOutput).map((a) => path.resolve(configDir, a.testOutput!, '**/*')),
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
  let organization: OutputOrganization = inheritedOrganization ?? {};
  let prefixes: Record<string, string> = {};
  try { if (!inheritedOrganization) organization = JSON.parse(fs.readFileSync(path.join(configDir, '.specguard/experience.json'), 'utf8')); } catch { /* organization is optional */ }
  try { prefixes = JSON.parse(fs.readFileSync(path.join(configDir, '.specguard/output-locations.json'), 'utf8')).specPrefixes ?? {}; } catch { /* no relocated specs */ }
  return [...new Set(files)].filter(file => kind !== 'specs' || !apps.some(a => a.originalSpecDir && path.resolve(configDir, a.originalSpecDir) !== path.resolve(configDir, a.specDir ?? 'specs') && file.startsWith(path.resolve(configDir, a.originalSpecDir) + path.sep)) || apps.some(a => file.startsWith(path.resolve(configDir, a.specDir ?? 'specs') + path.sep))).sort().map((file) => {
    let title = path.basename(file);
    if (/\.mdx?$/i.test(file)) try {
      const text = fs.readFileSync(file, 'utf8');
      const meta = markdownMeta(text);
      title = typeof meta.title === 'string' ? meta.title : /^#\s+(.+)$/m.exec(text)?.[1] ?? title;
    } catch { /* the file name remains useful */ }
    let presentation: {group?: string; order?: number} = {};
    if (kind === 'specs') for (const app of apps) {
      const dir = path.resolve(configDir, app.specDir ?? 'specs');
      const local = path.relative(dir, file).split(path.sep).join('/');
      if (local.startsWith('../') || path.isAbsolute(local)) continue;
      const top = path.resolve(configDir, config.paths?.specsRoot ?? 'specs');
      const fromTop = path.relative(top, file).split(path.sep).join('/');
      const key = (app.name && app.name in prefixes ? [prefixes[app.name], local].filter(Boolean).join('/') : fromTop.startsWith('../') ? local : fromTop).replace(/\.md$/, '');
      const placement = organization.placements?.find(p => p.ref === `${app.name}:${key}`);
      if (placement) { const group = organization.groups?.find(g => g.id === placement.group); presentation = { group: group?.title ?? 'Ungrouped', order: (group?.order ?? 99999) * 100000 + placement.order }; }
    }
    return { path: file, title, ...presentation, relativePath: path.relative(root, file).split(path.sep).join('/') };
  });
}
