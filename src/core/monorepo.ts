/**
 * Monorepo detection: JavaScript/TypeScript (pnpm, Yarn and npm workspaces, Nx,
 * Turbo, Lerna), Go (`go.work`), Rust (Cargo workspaces) and Python (uv
 * workspaces). Read-only; never runs project code.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { expandGlobs } from './reader.js';

export type PackageManager = 'pnpm' | 'yarn' | 'npm';
export type WorkspaceTool = 'pnpm' | 'yarn' | 'npm' | 'nx' | 'turbo' | 'lerna' | 'go' | 'cargo' | 'uv';
export type Ecosystem = 'js' | 'python' | 'go' | 'rust';

export interface WorkspacePackage {
  /** Package name from package.json (may be scoped). */
  name: string;
  /** Directory relative to the repo root, POSIX separators. */
  dir: string;
  /** Test framework inferred from dependencies; 'vitest' when none is found. */
  framework: string;
  /** True when the package has a `test` script. */
  hasTestScript: boolean;
  ecosystem: Ecosystem;
  /** Shell command that runs just this package's tests, when the ecosystem has one fixed form. */
  testCommand?: string;
}

export interface MonorepoInfo {
  packageManager: PackageManager;
  tools: WorkspaceTool[];
  packages: WorkspacePackage[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  try {
    const doc = parseYaml(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: unknown } | null;
    globs.push(...stringList(doc?.packages));
  } catch {
    /* no pnpm workspace file */
  }
  const pkg = readJson(path.join(root, 'package.json'));
  const ws = pkg?.workspaces;
  globs.push(...stringList(ws));
  if (ws && typeof ws === 'object' && !Array.isArray(ws)) globs.push(...stringList((ws as { packages?: unknown }).packages));
  const lerna = readJson(path.join(root, 'lerna.json'));
  globs.push(...stringList(lerna?.packages));
  return globs;
}

function frameworkOf(pkg: Record<string, unknown>): string {
  const deps = Object.keys({
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  });
  if (deps.includes('@playwright/test') || deps.includes('playwright')) return 'playwright';
  if (deps.includes('vitest')) return 'vitest';
  if (deps.includes('jest') || deps.includes('ts-jest')) return 'jest';
  return 'vitest';
}

function managerOf(root: string): PackageManager {
  if (existsSync(path.join(root, 'pnpm-workspace.yaml')) || existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  const pm = readJson(path.join(root, 'package.json'))?.packageManager;
  if (typeof pm === 'string') {
    if (pm.startsWith('pnpm')) return 'pnpm';
    if (pm.startsWith('yarn')) return 'yarn';
  }
  return 'npm';
}

/** Detect a JS monorepo at `root`, or null when it is a single package. */
async function detectJsWorkspace(root: string): Promise<MonorepoInfo | null> {
  const tools = new Set<WorkspaceTool>();
  const packageManager = managerOf(root);
  const globs = workspaceGlobs(root);
  if (existsSync(path.join(root, 'pnpm-workspace.yaml'))) tools.add('pnpm');
  else if (globs.length > 0) tools.add(packageManager === 'yarn' ? 'yarn' : packageManager === 'pnpm' ? 'pnpm' : 'npm');
  if (existsSync(path.join(root, 'nx.json'))) tools.add('nx');
  if (existsSync(path.join(root, 'turbo.json'))) tools.add('turbo');
  if (existsSync(path.join(root, 'lerna.json'))) tools.add('lerna');
  if (tools.size === 0) return null;

  // Nx and Turbo without explicit workspace globs conventionally keep packages under these folders.
  const patterns = globs.length > 0 ? globs : ['apps/*', 'packages/*', 'libs/*', 'services/*'];
  const include = patterns.filter((g) => !g.startsWith('!')).map((g) => `${g.replace(/\/+$/, '')}/package.json`);
  const exclude = patterns.filter((g) => g.startsWith('!')).map((g) => `!${g.slice(1).replace(/\/+$/, '')}/package.json`);
  const files = await expandGlobs([...include, ...exclude, '!**/node_modules/**'], root).catch(() => [] as string[]);

  const packages: WorkspacePackage[] = [];
  for (const file of files) {
    const pkg = readJson(file);
    const dir = path.relative(root, path.dirname(file)).split(path.sep).join('/');
    if (!pkg || typeof pkg.name !== 'string' || !dir) continue;
    const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
    packages.push({ name: pkg.name, dir, framework: frameworkOf(pkg), hasTestScript: typeof scripts.test === 'string', ecosystem: 'js' });
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  if (packages.length === 0 && tools.size === 1 && tools.has('nx')) return null;
  return { packageManager, tools: [...tools], packages };
}

// ---------------------------------------------------------------------------
// Go, Cargo, uv
// ---------------------------------------------------------------------------

/** The body of a TOML `[header]` table: from the header to the next table header. */
function tomlTable(text: string, header: string): string | null {
  const esc = header.replace(/[.[\]]/g, '\\$&');
  const m = text.match(new RegExp(`^\\[${esc}\\][ \\t]*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

function tomlStrings(body: string, key: string): string[] {
  const m = body.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  return m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]) : [];
}

function tomlString(body: string, key: string): string | undefined {
  return body.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1];
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const rel = (root: string, dir: string): string => path.relative(root, dir).split(path.sep).join('/');

async function detectGoWorkspace(root: string): Promise<WorkspacePackage[]> {
  const work = readText(path.join(root, 'go.work'));
  if (!work) return [];
  // Comments go first: a `)` or a path followed by `// note` must not end a block or hide a `use`.
  const text = work.replace(/\/\/.*$/gm, '');
  const dirs = [
    ...[...text.matchAll(/^use\s*\(([\s\S]*?)\)/gm)].flatMap((m) => m[1].split('\n')),
    ...[...text.matchAll(/^use\s+([^\s(][^\s]*)\s*$/gm)].map((m) => m[1]),
  ]
    .map((l) => l.trim())
    .filter(Boolean);
  const out: WorkspacePackage[] = [];
  for (const d of dirs) {
    const dir = rel(root, path.resolve(root, d));
    const name = readText(path.join(root, dir, 'go.mod'))?.match(/^module\s+(\S+)/m)?.[1];
    if (!name || !dir) continue;
    out.push({ name, dir, framework: 'go-test', hasTestScript: true, ecosystem: 'go', testCommand: `cd ${dir} && go test ./...` });
  }
  return out;
}

async function detectCargoWorkspace(root: string): Promise<WorkspacePackage[]> {
  const text = readText(path.join(root, 'Cargo.toml'));
  const ws = text ? tomlTable(text, 'workspace') : null;
  if (!ws) return [];
  const members = tomlStrings(ws, 'members');
  const exclude = tomlStrings(ws, 'exclude').map((e) => `!${e.replace(/\/+$/, '')}/Cargo.toml`);
  const files = await expandGlobs([...members.map((m) => `${m.replace(/\/+$/, '')}/Cargo.toml`), ...exclude], root).catch(() => [] as string[]);
  const out: WorkspacePackage[] = [];
  for (const file of files) {
    const pkg = readText(file);
    const name = pkg ? tomlString(tomlTable(pkg, 'package') ?? '', 'name') : undefined;
    const dir = rel(root, path.dirname(file));
    if (name && dir) out.push({ name, dir, framework: 'cargo-test', hasTestScript: true, ecosystem: 'rust', testCommand: `cargo test -p ${name}` });
  }
  return out;
}

async function detectUvWorkspace(root: string): Promise<WorkspacePackage[]> {
  const text = readText(path.join(root, 'pyproject.toml'));
  const ws = text ? tomlTable(text, 'tool.uv.workspace') : null;
  if (!ws) return [];
  const members = tomlStrings(ws, 'members');
  const exclude = tomlStrings(ws, 'exclude').map((e) => `!${e.replace(/\/+$/, '')}/pyproject.toml`);
  const files = await expandGlobs([...members.map((m) => `${m.replace(/\/+$/, '')}/pyproject.toml`), ...exclude], root).catch(() => [] as string[]);
  const out: WorkspacePackage[] = [];
  for (const file of files) {
    const pkg = readText(file);
    const name = pkg ? tomlString(tomlTable(pkg, 'project') ?? '', 'name') : undefined;
    const dir = rel(root, path.dirname(file));
    if (name && dir) out.push({ name, dir, framework: 'pytest', hasTestScript: true, ecosystem: 'python', testCommand: `uv run --package ${name} pytest` });
  }
  return out;
}

/**
 * Detect a monorepo at `root`: a JS workspace and/or a Go, Cargo or uv one. A
 * repo can hold several; their packages are listed together. Null when none.
 */
export async function detectMonorepo(root: string): Promise<MonorepoInfo | null> {
  const js = await detectJsWorkspace(root);
  const others: Array<[WorkspaceTool, WorkspacePackage[]]> = [
    ['go', await detectGoWorkspace(root)],
    ['cargo', await detectCargoWorkspace(root)],
    ['uv', await detectUvWorkspace(root)],
  ];
  const found = others.filter(([, pkgs]) => pkgs.length > 0);
  if (!js && found.length === 0) return null;
  const packages = [...(js?.packages ?? []), ...found.flatMap(([, pkgs]) => pkgs)].sort((a, b) => a.dir.localeCompare(b.dir));
  return {
    packageManager: js?.packageManager ?? managerOf(root),
    tools: [...(js?.tools ?? []), ...found.map(([tool]) => tool)],
    packages,
  };
}

/** The shell command that runs one package's tests from the repo root. */
export function testCommandFor(info: MonorepoInfo, pkg: WorkspacePackage): string {
  if (pkg.testCommand) return pkg.testCommand;
  if (info.tools.includes('nx')) return `npx nx test ${pkg.name}`;
  if (info.tools.includes('turbo')) return `npx turbo run test --filter=${pkg.name}`;
  if (info.packageManager === 'pnpm') return `pnpm --filter ${pkg.name} test`;
  if (info.packageManager === 'yarn') return `yarn workspace ${pkg.name} test`;
  return `npm test --workspace=${pkg.name}`;
}

/** App name for a package: scope and punctuation folded into one kebab-case token. */
export function appNameFor(pkg: WorkspacePackage): string {
  return pkg.name.replace(/^@/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || path.basename(pkg.dir);
}
