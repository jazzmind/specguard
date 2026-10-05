/**
 * Dependency fingerprint: one hash over the lockfiles (or, when a repo has no
 * lockfile, the dependency manifests) that decide which third-party code a
 * proof ran against. A dependency bump changes the fingerprint and marks
 * stored proofs stale.
 *
 * Spec: specs/pipelines/proof.md
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
];

const MANIFESTS = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
];

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash of the dependency sections of package.json, ignoring scripts and metadata. */
function packageJsonDeps(text: string): string {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const pick: Record<string, unknown> = {};
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions']) {
      if (pkg[key]) pick[key] = pkg[key];
    }
    return sha(JSON.stringify(pick, Object.keys(pick).sort()));
  } catch {
    return sha(text);
  }
}

function candidateDirs(repoDir: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(repoDir);
  for (let i = 0; i < 6; i += 1) {
    dirs.push(dir);
    if (existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Fingerprint for a repo. Walks from `repoDir` up to the git root and uses the
 * nearest directory that has a lockfile; falls back to the nearest manifests.
 * `extraFiles` (paths relative to `repoDir`) are always included. Returns
 * undefined when nothing was found.
 */
export function dependencyFingerprint(repoDir: string, extraFiles: string[] = []): string | undefined {
  const parts: string[] = [];
  const dirs = candidateDirs(repoDir);
  const lockDir = dirs.find((dir) => LOCKFILES.some((name) => existsSync(path.join(dir, name))));
  if (lockDir) {
    for (const name of LOCKFILES) {
      const file = path.join(lockDir, name);
      if (existsSync(file)) parts.push(`${name}:${sha(readFileSync(file))}`);
    }
  } else {
    const manifestDir = dirs.find((dir) => MANIFESTS.some((name) => existsSync(path.join(dir, name))));
    if (manifestDir) {
      for (const name of MANIFESTS) {
        const file = path.join(manifestDir, name);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        parts.push(`${name}:${name === 'package.json' ? packageJsonDeps(text) : sha(text)}`);
      }
    }
  }
  for (const rel of extraFiles) {
    const file = path.resolve(repoDir, rel);
    if (existsSync(file)) parts.push(`${rel}:${sha(readFileSync(file))}`);
  }
  if (parts.length === 0) return undefined;
  return sha(parts.sort().join('\n'));
}
