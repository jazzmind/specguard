/**
 * Ecosystem registry: detection by lockfile marker, audit-runner compatibility, and
 * the combined detector (OSV when available, native audits otherwise).
 *
 * Spec: specs/core/ecosystems.md
 */
import { dedupeAdvisories, type Advisory } from '../advisory.js';
import { createNativeAdapters } from './native.js';
import { createNodeAdapters } from './node.js';
import { detectWithOsv } from './osv.js';
import { createPythonAdapters } from './python.js';
import { defaultRunner, ToolNotInstalledError, type CommandRunner, type EcosystemAdapter, type EcosystemId } from './types.js';

export * from './types.js';
export { parseOsvScanner, detectWithOsv } from './osv.js';

/** Most specific first: lockfile-backed managers before the manifest-only fallbacks. */
export function createEcosystems(run: CommandRunner = defaultRunner): EcosystemAdapter[] {
  const [pnpm, yarn, npm] = createNodeAdapters(run);
  const [poetry, uv, pip] = createPythonAdapters(run);
  const [go, cargo, maven, gradle] = createNativeAdapters(run);
  return [pnpm, yarn, npm, poetry, uv, pip, go, cargo, maven, gradle];
}

/** Every ecosystem whose marker files are present, in priority order; one per language family for node/python. */
export function detectEcosystems(repo: string, run: CommandRunner = defaultRunner): EcosystemAdapter[] {
  const found: EcosystemAdapter[] = [];
  const taken = new Set<string>();
  for (const a of createEcosystems(run)) {
    const family = ['pnpm', 'yarn', 'npm'].includes(a.id) ? 'node' : ['poetry', 'uv', 'pip'].includes(a.id) ? 'python' : a.id;
    if (taken.has(family) || !a.detect(repo)) continue;
    taken.add(family);
    found.push(a);
  }
  return found;
}

export function getEcosystem(id: EcosystemId, run: CommandRunner = defaultRunner): EcosystemAdapter {
  const a = createEcosystems(run).find((x) => x.id === id);
  if (!a) throw new Error(`Unknown ecosystem '${id}'`);
  return a;
}

/** Map a language profile's legacy `auditRunner` string onto an adapter. */
export function adapterForAuditRunner(runner: string, repo: string, run: CommandRunner = defaultRunner): EcosystemAdapter | undefined {
  if (runner === 'npm-audit') return detectEcosystems(repo, run).find((a) => ['npm', 'pnpm', 'yarn'].includes(a.id)) ?? getEcosystem('npm', run);
  if (runner === 'pip-audit') return detectEcosystems(repo, run).find((a) => ['pip', 'poetry', 'uv'].includes(a.id)) ?? getEcosystem('pip', run);
  return undefined;
}

export interface DependencyDetection {
  advisories: Advisory[];
  /** Notes about tools that were skipped or failed (never silent). */
  warnings: string[];
  /** Which detectors produced results. */
  sources: string[];
}

/**
 * Detect dependency advisories: OSV-Scanner when installed (universal), plus the native audit of
 * each detected ecosystem. A missing tool becomes a warning, not a crash, unless nothing at all ran.
 */
export async function detectDependencyAdvisories(
  repo: string,
  opts: { run?: CommandRunner; useOsv?: boolean; useNative?: boolean } = {},
): Promise<DependencyDetection> {
  const run = opts.run ?? defaultRunner;
  const warnings: string[] = [];
  const sources: string[] = [];
  const all: Advisory[] = [];
  const ecos = detectEcosystems(repo, run);
  if (opts.useOsv !== false) {
    try {
      all.push(...(await detectWithOsv({ run, repo })));
      sources.push('osv-scanner');
    } catch (err) {
      warnings.push(err instanceof ToolNotInstalledError ? `${err.message} Falling back to native audits.` : `osv-scanner failed: ${(err as Error).message}`);
    }
  }
  if (opts.useNative !== false) {
    for (const eco of ecos) {
      if (eco.id === 'maven' || eco.id === 'gradle') {
        if (!sources.includes('osv-scanner')) warnings.push(`${eco.id} dependencies are only audited through osv-scanner, which was not available.`);
        continue;
      }
      try {
        all.push(...(await eco.audit(repo)));
        sources.push(`${eco.id}-audit`);
      } catch (err) {
        warnings.push(err instanceof ToolNotInstalledError ? err.message : `${eco.id} audit failed: ${(err as Error).message}`);
      }
    }
  }
  // OSV does not know direct/transitive; native audits do. Merge keeps the native flag via dedupe's OR,
  // so mark OSV rows as direct only when a native row confirms it.
  return { advisories: dedupeAdvisories(all), warnings, sources };
}
