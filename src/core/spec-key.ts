/**
 * Canonical spec key: path of a spec relative to the specs root, without
 * extension (`api/services/messaging`), independent of the owning app.
 * Also resolves a spec's declared `sources:` files and migrates legacy
 * drift-registry keys.
 *
 * Spec: specs/core/spec-key.md
 */
import fs from 'node:fs';
import path from 'node:path';

import type { DriftRegistry } from './drift-registry.js';
import { toRegistryKey } from './drift-registry.js';
import { expandGlobs } from './reader.js';
import { loadAllSpecs } from './spec-parser.js';
import type { AppConfig, ParsedSpec, SpecGuardConfig } from './types.js';

function rootOf(config: SpecGuardConfig): string {
  return config.rootDir ?? process.cwd();
}

export function specsRootDir(config: SpecGuardConfig): string {
  return path.resolve(rootOf(config), config.paths?.specsRoot ?? 'specs');
}

function posixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function stripMd(rel: string): string {
  return rel.toLowerCase().endsWith('.md') ? rel.slice(0, -3) : rel;
}

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Canonical key for an absolute spec file; `fallbackDir` is the owning specDir. */
export function canonicalSpecKey(config: SpecGuardConfig, absFile: string, fallbackDir?: string): string {
  const top = specsRootDir(config);
  if (fs.existsSync(top) && isInside(top, absFile)) return stripMd(posixRel(top, absFile));
  return stripMd(posixRel(fallbackDir ?? top, absFile));
}

/** Specs of one directory with canonical `specKey` and the `specDir`-relative `localKey`. */
export function loadCanonicalSpecs(config: SpecGuardConfig, dir: string): ParsedSpec[] {
  return loadAllSpecs(dir).map((spec) => ({
    ...spec,
    localKey: spec.specKey,
    specKey: canonicalSpecKey(config, path.join(dir, `${spec.specKey}.md`), dir),
  }));
}

/** Absolute spec file for an app-local key. */
export function specFileOf(spec: ParsedSpec, dir: string): string {
  return path.join(dir, `${spec.localKey ?? spec.specKey}.md`);
}

/** The app whose `specDir` contains the file (deepest wins). */
export function appForSpecFile(config: SpecGuardConfig, absFile: string): AppConfig | undefined {
  const root = rootOf(config);
  let best: AppConfig | undefined;
  let bestLen = -1;
  for (const app of config.apps) {
    const dir = path.resolve(root, app.specDir);
    if (isInside(dir, absFile) && dir.length > bestLen) {
      best = app;
      bestLen = dir.length;
    }
  }
  return best;
}

/** Patterns from a spec's `sources:` header, else its `module:` header. */
export function declaredSources(spec: Pick<ParsedSpec, 'meta'>): string[] {
  const raw = spec.meta.extra?.sources ?? spec.meta.module ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const warned = new Set<string>();
/** Test hook: forget which root-relative fallbacks were already warned about. */
export function resetSourceWarnings(): void {
  warned.clear();
}

/**
 * Resolve declared source patterns to absolute files. Globs are relative to
 * the app's `repo`; a pattern with no match there but matches from the config
 * root is accepted with a one-time warning through `warn`.
 */
export async function resolveDeclaredSources(
  config: SpecGuardConfig,
  app: AppConfig | undefined,
  patterns: string[],
  warn: (msg: string) => void = () => undefined,
): Promise<string[]> {
  const root = rootOf(config);
  const repoDir = app ? path.resolve(root, app.repo) : root;
  const out = new Set<string>();
  for (const pattern of patterns) {
    let hits = await expandGlobs([pattern], repoDir).catch(() => [] as string[]);
    if (hits.length === 0 && repoDir !== root) {
      hits = await expandGlobs([pattern], root).catch(() => [] as string[]);
      if (hits.length > 0) {
        const key = `${root}::${pattern}`;
        if (!warned.has(key)) {
          warned.add(key);
          warn(`[warn] sources pattern "${pattern}" matched relative to the repo root, not the app repo "${app?.repo}"; sources are normally relative to the app repo`);
        }
      }
    }
    for (const hit of hits) out.add(hit);
  }
  return [...out].sort();
}

/** Root-relative POSIX keys for resolved source files. */
export function sourceKeys(config: SpecGuardConfig, files: string[]): string[] {
  return files.map((f) => toRegistryKey(rootOf(config), f));
}

/**
 * Rename legacy registry keys to the canonical spec key, merging file
 * entries. Legacy forms: `<app>/<localKey>` and `<app>/<canonicalKey>`.
 * Returns true when the registry changed.
 */
export function migrateRegistrySpecKeys(config: SpecGuardConfig, registry: DriftRegistry): boolean {
  const root = rootOf(config);
  let changed = false;
  for (const app of config.apps) {
    const dir = path.resolve(root, app.specDir);
    let specs: ParsedSpec[];
    try {
      specs = loadCanonicalSpecs(config, dir);
    } catch {
      continue;
    }
    for (const spec of specs) {
      const canonical = spec.specKey;
      const legacy = new Set([`${app.name}/${spec.localKey}`, `${app.name}/${canonical}`]);
      for (const old of legacy) {
        if (old === canonical || !registry[old]) continue;
        const from = registry[old];
        const to = registry[canonical] ?? (registry[canonical] = { specKey: canonical, specHash: from.specHash, files: {} });
        for (const [file, entry] of Object.entries(from.files ?? {})) {
          if (!to.files[file]) to.files[file] = entry;
        }
        to.specKey = canonical;
        delete registry[old];
        changed = true;
      }
      if (registry[canonical] && registry[canonical].specKey !== canonical) {
        registry[canonical].specKey = canonical;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Expand an app's config globs (`sources`, `exclude`, `collapse`) relative to
 * its `repo`. When nothing matches there but the patterns match from the
 * config root (the HiRocky mistake: `apps/api/src/**`), accept them and warn
 * once per pattern on stderr.
 */
export async function expandAppGlobs(
  config: SpecGuardConfig,
  app: AppConfig,
  patterns: string[],
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Promise<string[]> {
  return resolveDeclaredSources(config, app, patterns, warn);
}
