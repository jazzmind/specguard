/** Explicit output routing, shared by the CLI and editor. Spec: integration-surfaces. */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { globSync } from 'tinyglobby';
import type { AppConfig, SpecGuardConfig } from './types.js';

export const outputKinds = ['specs', 'tests.unit', 'tests.integration', 'tests.e2e', 'docs', 'plans'] as const;
export type OutputKind = typeof outputKinds[number];
const schema = z.object({ version: z.literal(1), specPrefixes: z.record(z.string()).optional(), apps: z.record(z.record(z.enum(outputKinds), z.string().min(1))) });
export type OutputLocations = z.infer<typeof schema>;
export const locationsFile = (root: string): string => path.join(root, '.specguard/output-locations.json');

export function readOutputLocations(root: string): OutputLocations {
  const file = locationsFile(root);
  return existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { version: 1, apps: {} };
}

export function saveOutputLocation(config: SpecGuardConfig, appName: string, kind: OutputKind, directory: string): void {
  if (!config.apps.some(a => a.name === appName)) throw new Error(`Unknown application: ${appName}`);
  if (!outputKinds.includes(kind) || !directory.trim()) throw new Error('Choose an output kind and directory');
  const root = config.rootDir ?? process.cwd();
  const settings = readOutputLocations(root);
  if (kind === 'specs') {
    // Keep canonical keys unchanged when choosing a new spec root. Never delete the old files or overwrite a conflict.
    const source = outputDirectory(config, config.apps.find(a => a.name === appName)!, 'specs');
    const target = path.resolve(root, directory);
    const top = path.resolve(root, config.paths?.specsRoot ?? 'specs');
    const prefix = path.relative(top, source).split(path.sep).join('/');
    settings.specPrefixes ??= {};
    if (!(appName in settings.specPrefixes)) settings.specPrefixes[appName] = prefix && !prefix.startsWith('..') && !path.isAbsolute(prefix) ? prefix : '';
    if (source !== target && (target.startsWith(source + path.sep) || source.startsWith(target + path.sep))) {
      throw new Error('Choose a separate spec directory, not an ancestor or child of the current spec root');
    }
    const copies: Array<{ file: string; content: string }> = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir) || source === target) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.md')) {
          const content = readFileSync(file, 'utf8');
          const dest = path.join(target, path.relative(source, file));
          if (existsSync(dest) && readFileSync(dest, 'utf8') !== content) throw new Error(`Spec destination has conflicting content: ${dest}`);
          copies.push({ file: dest, content });
        }
      }
    };
    walk(source);
    for (const copy of copies) { mkdirSync(path.dirname(copy.file), { recursive: true }); if (!existsSync(copy.file)) writeFileSync(copy.file, copy.content, { flag: 'wx' }); }
  }
  const relative = path.relative(root, path.resolve(root, directory)).split(path.sep).join('/') || '.';
  settings.apps[appName] = { ...settings.apps[appName], [kind]: relative };
  const file = locationsFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(schema.parse(settings), null, 2) + '\n');
  renameSync(temporary, file);
}

export function outputDirectory(config: SpecGuardConfig, app: AppConfig, kind: OutputKind): string {
  const root = config.rootDir ?? process.cwd();
  const saved = readOutputLocations(root).apps[app.name]?.[kind];
  const fallback = kind === 'specs' ? app.specDir : kind === 'docs' ? (typeof app.docs === 'string' ? app.docs : config.paths?.docsOut ?? 'docs/user')
    : kind === 'plans' ? '.specguard/plans' : app.testOutput;
  return path.resolve(root, saved ?? fallback);
}

/** Saved test directories are also inputs to test discovery; they never replace native test sources. */
export function applyOutputLocations(config: SpecGuardConfig): void {
  const root = config.rootDir ?? process.cwd();
  const settings = readOutputLocations(root);
  for (const app of config.apps) {
    const saved = settings.apps[app.name];
    if (!saved) continue;
    if (saved.specs) {
      app.originalSpecDir ??= path.resolve(root, app.specDir);
      app.specDir = path.resolve(root, saved.specs);
      app.specKeyPrefix = settings.specPrefixes?.[app.name] ?? '';
    }
    const tests = outputKinds.filter(k => k.startsWith('tests.') && saved[k]).map(k => path.resolve(root, saved[k]!, '**/*'));
    if (tests.length) app.extraTestSources = [...new Set([...(app.extraTestSources ?? []), ...tests])];
  }
}

export function describeOutputs(config: SpecGuardConfig) {
  return config.apps.map(app => {
    const root = config.rootDir ?? process.cwd();
    const repo = path.resolve(root, app.repo);
    const files = globSync(app.sources.tests ?? [], { cwd: repo, absolute: true, ignore: ['**/node_modules/**', '**/target/**', '**/.git/**'], followSymbolicLinks: false });
    const testDirectories: Record<string, string> = {};
    const testDirectoryOptions: Record<string, string[]> = {};
    for (const layer of ['unit', 'integration', 'e2e']) {
      const selected = files.filter(file => {
        const inferred = /[\\/](e2e|journeys)[\\/]/.test(file) || app.framework === 'playwright' ? 'e2e' : /integration/i.test(file) ? 'integration' : 'unit';
        return inferred === layer;
      });
      if (!selected.length) continue;
      let common = path.dirname(selected[0]);
      for (const file of selected) while (path.dirname(file) !== common && !path.dirname(file).startsWith(common + path.sep) && path.dirname(common) !== common) common = path.dirname(common);
      // A common ancestor of several Maven modules is not a runnable test root.
      const nativeRoots = selected.map(file => /^(.*[\\/]src[\\/]test[\\/](?:java|kotlin|groovy|scala))(?:[\\/]|$)/.exec(file)?.[1]).filter((dir): dir is string => !!dir);
      const choices = nativeRoots.length === selected.length ? [...new Set(nativeRoots)].sort() : [common];
      testDirectories[layer] = choices[0];
      testDirectoryOptions[layer] = choices;
    }
    return {
    app: app.name, code: path.resolve(config.rootDir ?? process.cwd(), app.repo), configRoot: config.rootDir,
    testDirectories,
    testDirectoryOptions,
    outputs: outputKinds.map(kind => ({ kind, directory: outputDirectory(config, app, kind),
      saved: !!readOutputLocations(config.rootDir ?? process.cwd()).apps[app.name]?.[kind],
      mappingOnly: kind.startsWith('tests.') && /(^|[\\/])tags([\\/]|$)/.test(outputDirectory(config, app, kind)),
    })),
    };
  });
}
