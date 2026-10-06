/**
 * npm, pnpm and yarn (classic and berry) adapters.
 *
 * Spec: specs/core/ecosystems.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeSeverity, severityFromCvss, type Advisory, type Candidate, type Severity } from '../advisory.js';
import { candidatesFor, fingerprintFiles, hasFile, readJsonKeepFormat, readText, writeJsonKeepFormat } from './common.js';
import { fixedFromRange, versionsIn } from './semver.js';
import { runTool, type CommandRunner, type EcosystemAdapter, type EcosystemId } from './types.js';

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export type YarnFlavor = 'classic' | 'berry';

export function yarnFlavor(repo: string): YarnFlavor {
  const lock = readText(repo, 'yarn.lock') ?? '';
  if (/^__metadata:/m.test(lock)) return 'berry';
  if (hasFile(repo, '.yarnrc.yml')) return 'berry';
  return 'classic';
}

/** Installed version from whichever lockfile is present. */
export function installedNodeVersion(repo: string, pkg: string): string | undefined {
  const lockText = readText(repo, 'package-lock.json') ?? readText(repo, 'npm-shrinkwrap.json');
  if (lockText) {
    try {
      const lock = JSON.parse(lockText) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
      const hit = lock.packages?.[`node_modules/${pkg}`]?.version ?? lock.dependencies?.[pkg]?.version;
      if (hit) return hit;
    } catch {
      /* fall through */
    }
  }
  const pnpm = readText(repo, 'pnpm-lock.yaml');
  if (pnpm) {
    const m = new RegExp(`^\\s+/?'?${pkg.replace(/[/@.]/g, '\\$&')}@?/?(\\d[^\\s:(')]*)`, 'm').exec(pnpm);
    if (m) return m[1];
  }
  const yarn = readText(repo, 'yarn.lock');
  if (yarn) {
    const esc = pkg.replace(/[/@.]/g, '\\$&');
    const m = new RegExp(`^"?${esc}@[^\\n]*\\n\\s+version:? "?([^"\\n]+)"?`, 'm').exec(yarn);
    if (m) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parsers (pure; fixtures under tests/fixtures/audit/)
// ---------------------------------------------------------------------------

interface NpmVia {
  source?: number;
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
  range?: string;
  cvss?: { score?: number };
}
interface NpmVuln {
  name?: string;
  severity?: string;
  isDirect?: boolean;
  via?: Array<string | NpmVia>;
  effects?: string[];
  range?: string;
  fixAvailable?: boolean | { name?: string; version?: string; isSemVerMajor?: boolean };
}

function ghsaFrom(url: string | undefined): string | undefined {
  return /GHSA-[a-z0-9-]+/i.exec(url ?? '')?.[0];
}

/** `npm audit --json` (v2 report format). */
export function parseNpmAudit(text: string, repo: string): Advisory[] {
  const doc = JSON.parse(text) as { vulnerabilities?: Record<string, NpmVuln>; advisories?: Record<string, unknown> };
  if (doc.advisories) return parseAdvisoriesMap(text, 'npm', 'npm-audit');
  const out: Advisory[] = [];
  for (const [name, v] of Object.entries(doc.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via === 'string' || !via.source) continue;
      const pkg = via.name ?? name;
      const owner = doc.vulnerabilities?.[pkg] ?? v;
      const fixed = fixedFromRange(via.range ?? '');
      const fa = v.fixAvailable;
      if (fa && typeof fa === 'object' && fa.name === pkg && fa.version && !fixed.includes(fa.version)) fixed.push(fa.version);
      const sev: Severity = via.cvss?.score ? severityFromCvss(via.cvss.score) : normalizeSeverity(via.severity);
      out.push({
        id: ghsaFrom(via.url) ?? `npm:${via.source}`,
        aliases: [`npm:${via.source}`],
        ecosystem: 'npm',
        package: pkg,
        installedVersion: installedNodeVersion(repo, pkg) ?? '',
        vulnerableRange: via.range ?? v.range ?? '',
        fixedVersions: fixed,
        severity: normalizeSeverity(via.severity) === 'unknown' ? sev : normalizeSeverity(via.severity),
        cvss: via.cvss?.score || undefined,
        direct: owner.isDirect ?? v.isDirect ?? false,
        dependencyPath: [...(owner.effects ?? []).slice(0, 1), pkg].filter((x, i, a) => a.indexOf(x) === i),
        source: 'npm-audit',
        url: via.url,
        title: via.title,
      });
    }
  }
  return out;
}

interface AdvisoryV1 {
  id?: number;
  module_name?: string;
  title?: string;
  severity?: string;
  url?: string;
  github_advisory_id?: string;
  cves?: string[];
  vulnerable_versions?: string;
  patched_versions?: string;
  cvss?: { score?: number };
  findings?: Array<{ version?: string; paths?: string[] }>;
}

function fromV1(a: AdvisoryV1, ecosystem: string, source: string, direct?: boolean): Advisory {
  const patched = a.patched_versions && a.patched_versions !== '<0.0.0' ? versionsIn(a.patched_versions) : [];
  const finding = a.findings?.[0];
  const paths = finding?.paths ?? [];
  const first = paths[0]?.split('>') ?? [];
  return {
    id: a.github_advisory_id ?? ghsaFrom(a.url) ?? (a.cves?.[0] ?? `npm:${a.id}`),
    aliases: [...(a.cves ?? []), ...(a.id != null ? [`npm:${a.id}`] : [])],
    ecosystem,
    package: a.module_name ?? 'unknown',
    installedVersion: finding?.version ?? '',
    vulnerableRange: a.vulnerable_versions ?? '',
    fixedVersions: patched,
    severity: normalizeSeverity(a.severity) !== 'unknown' ? normalizeSeverity(a.severity) : severityFromCvss(a.cvss?.score ?? 0),
    cvss: a.cvss?.score || undefined,
    direct: direct ?? first.length <= 2,
    dependencyPath: first.filter((s) => s && s !== '.'),
    source,
    url: a.url,
    title: a.title,
  };
}

/** pnpm audit --json and npm audit v1: `{ advisories: { id: {...} } }`. */
export function parseAdvisoriesMap(text: string, ecosystem: string, source: string): Advisory[] {
  const doc = JSON.parse(text) as { advisories?: Record<string, AdvisoryV1> };
  return Object.values(doc.advisories ?? {}).map((a) => fromV1(a, ecosystem, source));
}

/** `yarn audit --json` (classic): one JSON object per line. */
export function parseYarnClassicAudit(text: string): Advisory[] {
  const out: Advisory[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let row: { type?: string; data?: { advisory?: AdvisoryV1; resolution?: { path?: string } } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'auditAdvisory' || !row.data?.advisory) continue;
    const adv = fromV1(row.data.advisory, 'npm', 'yarn-audit');
    const p = (row.data.resolution?.path ?? '').split('>');
    if (p.length) {
      adv.dependencyPath = p;
      adv.direct = p.length <= 2;
    }
    out.push(adv);
  }
  return out;
}

/** `yarn npm audit --json` (berry): one `{ value, children }` object per line. */
export function parseYarnBerryAudit(text: string): Advisory[] {
  const out: Advisory[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let row: { value?: string; children?: Record<string, unknown> };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const c = row.children as
      | { ID?: number | string; Issue?: string; URL?: string; Severity?: string; 'Vulnerable Versions'?: string; 'Tree Versions'?: string[]; Dependents?: string[] }
      | undefined;
    if (!row.value || !c) continue;
    out.push({
      id: ghsaFrom(c.URL) ?? `npm:${c.ID}`,
      aliases: c.ID != null ? [`npm:${c.ID}`] : [],
      ecosystem: 'npm',
      package: row.value,
      installedVersion: c['Tree Versions']?.[0] ?? '',
      vulnerableRange: c['Vulnerable Versions'] ?? '',
      fixedVersions: fixedFromRange(c['Vulnerable Versions'] ?? ''),
      severity: normalizeSeverity(c.Severity),
      direct: (c.Dependents ?? []).some((d) => !d.includes('@npm:') || /workspace|root/i.test(d)),
      dependencyPath: [...(c.Dependents ?? []).slice(0, 1), row.value],
      source: 'yarn-audit',
      url: c.URL,
      title: c.Issue,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function bumpRange(current: string, version: string): string {
  const prefix = /^[\^~]/.exec(current)?.[0] ?? '';
  return /^[\^~]?\d/.test(current) || current === '' ? `${prefix}${version}` : version;
}

/** Edit package.json for a candidate. Returns true when the file changed. */
export function applyNodeCandidate(repo: string, c: Candidate, overrideKey: 'overrides' | 'pnpm.overrides' | 'resolutions'): boolean {
  const f = readJsonKeepFormat(repo, 'package.json');
  if (!f) throw new Error('package.json not found');
  const before = JSON.stringify(f.data);
  let done = false;
  // A package listed in a dependency section is always bumped there, whatever the advisory said about directness.
  for (const section of DEP_SECTIONS) {
    const deps = f.data[section] as Record<string, string> | undefined;
    if (deps && c.package in deps) {
      deps[c.package] = bumpRange(deps[c.package], c.toVersion);
      done = true;
    }
  }
  if (!done) {
    // Transitive (or not found as a direct dependency): pin through the manager's override mechanism.
    if (overrideKey === 'pnpm.overrides') {
      const pnpm = (f.data.pnpm ?? {}) as Record<string, Record<string, string>>;
      pnpm.overrides = { ...(pnpm.overrides ?? {}), [c.package]: c.toVersion };
      f.data.pnpm = pnpm;
    } else {
      const cur = (f.data[overrideKey] ?? {}) as Record<string, string>;
      f.data[overrideKey] = { ...cur, [c.package]: c.toVersion };
    }
  }
  if (JSON.stringify(f.data) === before) return false;
  writeJsonKeepFormat(repo, 'package.json', f);
  return true;
}

function makeNode(
  id: 'npm' | 'pnpm' | 'yarn',
  run: CommandRunner,
  cfg: {
    lockfiles: string[];
    overrideKey: 'overrides' | 'pnpm.overrides' | 'resolutions';
    bin: string;
    hint: string;
  },
): EcosystemAdapter {
  const manifests = ['package.json', ...(id === 'yarn' ? ['.yarnrc.yml'] : [])];
  return {
    id: id as EcosystemId,
    osvEcosystem: 'npm',
    detect(repo) {
      if (!hasFile(repo, 'package.json')) return false;
      if (id === 'pnpm') return hasFile(repo, 'pnpm-lock.yaml');
      if (id === 'yarn') return hasFile(repo, 'yarn.lock') && !hasFile(repo, 'pnpm-lock.yaml');
      // npm: lockfile marker, or package.json alone when no other manager's lockfile exists
      return hasFile(repo, 'package-lock.json') || hasFile(repo, 'npm-shrinkwrap.json') || !(hasFile(repo, 'pnpm-lock.yaml') || hasFile(repo, 'yarn.lock'));
    },
    lockfiles: () => cfg.lockfiles,
    manifests: () => manifests,
    async audit(repo) {
      if (id === 'npm') {
        const res = await runTool(run, 'npm', ['audit', '--json'], { cwd: repo, timeoutMs: 120_000 }, cfg.hint);
        if (!res.stdout.trim()) throw new Error(`npm audit produced no output: ${res.stderr.slice(0, 200)}`);
        return parseNpmAudit(res.stdout, repo);
      }
      if (id === 'pnpm') {
        const res = await runTool(run, 'pnpm', ['audit', '--json'], { cwd: repo, timeoutMs: 120_000 }, cfg.hint);
        if (!res.stdout.trim()) throw new Error(`pnpm audit produced no output: ${res.stderr.slice(0, 200)}`);
        return parseAdvisoriesMap(res.stdout, 'npm', 'pnpm-audit').map((a) => ({ ...a, installedVersion: a.installedVersion || installedNodeVersion(repo, a.package) || '' }));
      }
      const berry = yarnFlavor(repo) === 'berry';
      const args = berry ? ['npm', 'audit', '--json', '--all', '--recursive'] : ['audit', '--json'];
      const res = await runTool(run, 'yarn', args, { cwd: repo, timeoutMs: 120_000 }, cfg.hint);
      return berry ? parseYarnBerryAudit(res.stdout) : parseYarnClassicAudit(res.stdout);
    },
    resolveFix: candidatesFor,
    async apply(repo, c) {
      return applyNodeCandidate(repo, c, id === 'yarn' ? 'resolutions' : cfg.overrideKey) ? ['package.json'] : [];
    },
    async install(repo) {
      const args =
        id === 'npm'
          ? ['install', '--no-audit', '--no-fund']
          : id === 'pnpm'
            ? ['install', '--no-frozen-lockfile']
            : yarnFlavor(repo) === 'berry'
              ? ['install', '--no-immutable']
              : ['install'];
      const res = await runTool(run, cfg.bin, args, { cwd: repo, timeoutMs: 600_000 }, cfg.hint);
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, [...cfg.lockfiles, ...manifests]),
  };
}

export function createNodeAdapters(run: CommandRunner): EcosystemAdapter[] {
  return [
    makeNode('pnpm', run, { lockfiles: ['pnpm-lock.yaml'], overrideKey: 'pnpm.overrides', bin: 'pnpm', hint: 'Install pnpm (corepack enable pnpm).' }),
    makeNode('yarn', run, { lockfiles: ['yarn.lock'], overrideKey: 'resolutions', bin: 'yarn', hint: 'Install yarn (corepack enable yarn).' }),
    makeNode('npm', run, { lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], overrideKey: 'overrides', bin: 'npm', hint: 'Install Node.js (npm ships with it).' }),
  ];
}

export function readPackageVersion(repo: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
