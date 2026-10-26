/**
 * Units of a workspace: how a detected monorepo becomes units, which units
 * depend on which, and which units a set of changed files touches.
 *
 * A unit is a repo or a package; everything here works on the manifest's
 * `units` and never cares which kind a unit is.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { formatClaimRef, parseClaimRef } from './claims.js';
import { appNameFor, type MonorepoInfo, type WorkspacePackage } from './monorepo.js';
import { unitOfFile, type WorkspaceManifest, type WorkspaceUnit } from './workspace.js';

/** Unit keys for a monorepo's packages: JS packages keep their scoped name, others use their folder name; duplicates get a suffix. */
export function unitKeys(info: MonorepoInfo): Map<WorkspacePackage, string> {
  const used = new Set<string>();
  const out = new Map<WorkspacePackage, string>();
  for (const pkg of info.packages) {
    const base = pkg.ecosystem === 'js' ? appNameFor(pkg) : path.posix.basename(pkg.dir).toLowerCase();
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
    used.add(key);
    out.set(pkg, key);
  }
  return out;
}

/** The `units` entries for a detected monorepo, each with the command that runs only its tests. */
export function unitsFromMonorepo(info: MonorepoInfo, testCommand: (pkg: WorkspacePackage) => string): Record<string, WorkspaceUnit> {
  const units: Record<string, WorkspaceUnit> = {};
  for (const [pkg, key] of unitKeys(info)) {
    units[key] = {
      path: pkg.dir,
      kind: 'package',
      role: 'package',
      packageName: pkg.name,
      ecosystem: pkg.ecosystem,
      test: { command: testCommand(pkg), framework: pkg.framework },
    };
  }
  return units;
}

export interface UnitDependency {
  /** The unit that depends on another. */
  from: string;
  /** The unit it depends on. */
  to: string;
  /** Where the dependency is declared, for the edge's surface. */
  declaredIn: string;
}

function text(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Dependency names declared by one unit's manifest, by ecosystem. */
function declaredDependencies(root: string, unit: WorkspaceUnit): { names: Set<string>; file: string } {
  const dir = path.resolve(root, unit.path);
  const names = new Set<string>();
  const eco = unit.ecosystem;
  if (eco === 'js' || (!eco && text(path.join(dir, 'package.json')))) {
    const file = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(text(file) ?? '{}') as Record<string, Record<string, string> | undefined>;
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[key] ?? {})) names.add(name);
      }
    } catch {
      /* unreadable manifest: no dependencies */
    }
    return { names, file: 'package.json' };
  }
  if (eco === 'go') {
    const mod = text(path.join(dir, 'go.mod')) ?? '';
    for (const m of mod.matchAll(/^\s*(?:require\s+)?([\w.\-/]+)\s+v[\w.\-+]+/gm)) names.add(m[1]);
    return { names, file: 'go.mod' };
  }
  if (eco === 'rust') {
    const toml = text(path.join(dir, 'Cargo.toml')) ?? '';
    for (const sec of toml.matchAll(/^\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
      for (const m of sec[1].matchAll(/^([A-Za-z0-9_-]+)\s*[=.]/gm)) names.add(m[1]);
    }
    return { names, file: 'Cargo.toml' };
  }
  if (eco === 'python') {
    const toml = text(path.join(dir, 'pyproject.toml')) ?? '';
    // The array ends at the first `]` outside a quoted string: `"httpx[http2]>=0.2"` has one inside.
    for (const arr of toml.matchAll(/^dependencies\s*=\s*\[((?:"[^"\n]*"|'[^'\n]*'|[^\]"'])*)\]/gm)) {
      for (const m of arr[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) names.add(m[1].toLowerCase().replace(/_/g, '-'));
    }
    return { names, file: 'pyproject.toml' };
  }
  return { names, file: '' };
}

const normName = (unit: WorkspaceUnit): string | undefined =>
  unit.ecosystem === 'python' ? unit.packageName?.toLowerCase().replace(/_/g, '-') : unit.packageName;

/** Dependencies between the workspace's own units, read from each unit's manifest. */
export function unitDependencies(manifest: Pick<WorkspaceManifest, 'rootDir' | 'units'>): UnitDependency[] {
  const units = manifest.units ?? {};
  const byName = new Map<string, string>();
  for (const [key, unit] of Object.entries(units)) {
    const name = normName(unit);
    if (name) byName.set(name, key);
  }
  const out: UnitDependency[] = [];
  for (const [key, unit] of Object.entries(units)) {
    const { names, file } = declaredDependencies(manifest.rootDir, unit);
    for (const name of names) {
      const to = byName.get(name);
      if (to && to !== key) out.push({ from: key, to, declaredIn: path.posix.join(unit.path, file) });
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Units that own at least one of `files` (workspace-relative); files outside every unit are returned separately. */
export function affectedUnits(manifest: Pick<WorkspaceManifest, 'units'>, files: string[]): { units: string[]; outside: string[] } {
  const units = new Set<string>();
  const outside: string[] = [];
  for (const f of files) {
    const u = unitOfFile(manifest, f);
    if (u) units.add(u);
    else outside.push(f);
  }
  return { units: [...units].sort(), outside };
}

/**
 * Units whose tests could be affected: the changed units and, transitively,
 * every unit that depends on one of them.
 */
export function unitsToTest(deps: UnitDependency[], changed: string[]): string[] {
  const out = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const d of deps) {
      if (d.to === current && !out.has(d.from)) {
        out.add(d.from);
        queue.push(d.from);
      }
    }
  }
  return [...out].sort();
}

/**
 * A claim ref that names a package unit (`web:capabilities/auth#login`) means
 * the same claim without the prefix: package units share the workspace root's
 * specs, so there is no separate spec tree for the prefix to point at. Refs
 * that name a separate repo, or no unit, are returned unchanged.
 */
export function canonicalClaimRef(ref: string, units: Record<string, { kind: string }> | undefined): string {
  const parsed = parseClaimRef(ref);
  if (!parsed?.repo || units?.[parsed.repo]?.kind !== 'package') return ref;
  return formatClaimRef(undefined, parsed.specKey, parsed.claimId, parsed.exampleId);
}
