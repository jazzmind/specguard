/**
 * OSV-Scanner parsing and the universal detector. Uses a local `osv-scanner` binary,
 * or `docker run ghcr.io/google/osv-scanner`, whichever is available.
 *
 * Spec: specs/core/ecosystems.md
 */
import { normalizeSeverity, severityFromCvss, type Advisory, type Severity } from '../advisory.js';
import { fixedFromRange } from './semver.js';
import { ToolNotInstalledError, type CommandRunner } from './types.js';

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  database_specific?: { severity?: string; url?: string };
  affected?: Array<{ package?: { name?: string; ecosystem?: string }; ranges?: Array<{ type?: string; events?: OsvEvent[] }> }>;
  references?: Array<{ url?: string }>;
}
interface OsvResults {
  results?: Array<{
    source?: { path?: string };
    packages?: Array<{
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: OsvVuln[];
      groups?: Array<{ ids?: string[]; max_severity?: string }>;
    }>;
  }>;
}

const ECOSYSTEM_IDS: Record<string, string> = { npm: 'npm', pypi: 'PyPI', go: 'Go', 'crates.io': 'crates.io', maven: 'Maven' };

export function parseOsvScanner(text: string): Advisory[] {
  const doc = JSON.parse(text) as OsvResults;
  const out: Advisory[] = [];
  for (const res of doc.results ?? []) {
    for (const p of res.packages ?? []) {
      const name = p.package?.name ?? '';
      const eco = p.package?.ecosystem ?? '';
      for (const v of p.vulnerabilities ?? []) {
        const fixed: string[] = [];
        let range = '';
        for (const a of v.affected ?? []) {
          if (a.package?.name && a.package.name !== name) continue;
          for (const r of a.ranges ?? []) {
            for (const e of r.events ?? []) if (e.fixed) fixed.push(e.fixed);
            const intro = r.events?.find((e) => e.introduced)?.introduced;
            const fx = r.events?.find((e) => e.fixed)?.fixed;
            if (fx) range = `${intro && intro !== '0' ? `>=${intro} ` : ''}<${fx}`;
          }
        }
        const group = p.groups?.find((g) => g.ids?.includes(v.id));
        const score = Number(group?.max_severity);
        let severity: Severity = Number.isFinite(score) && score > 0 ? severityFromCvss(score) : normalizeSeverity(v.database_specific?.severity);
        if (severity === 'unknown') severity = normalizeSeverity(v.database_specific?.severity);
        out.push({
          id: v.id,
          aliases: v.aliases ?? [],
          ecosystem: ECOSYSTEM_IDS[eco.toLowerCase()] ?? eco,
          package: name,
          installedVersion: p.package?.version ?? '',
          vulnerableRange: range,
          fixedVersions: [...new Set(fixed)],
          severity,
          cvss: Number.isFinite(score) && score > 0 ? score : undefined,
          // OSV does not say whether a package is direct; a native audit row that matches confirms it.
          direct: false,
          dependencyPath: [],
          source: 'osv-scanner',
          url: v.references?.[0]?.url ?? `https://osv.dev/${v.id}`,
          title: v.summary,
        });
      }
    }
  }
  return out;
}

export interface OsvDetectOpts {
  run: CommandRunner;
  repo: string;
  /** Force a lockfile/manifest, e.g. `pom.xml` (maven/gradle). */
  lockfile?: string;
}

/** Run osv-scanner (binary first, then the docker image). Throws ToolNotInstalledError when neither is available. */
export async function detectWithOsv(opts: OsvDetectOpts): Promise<Advisory[]> {
  const scanArgs = opts.lockfile ? ['--lockfile', opts.lockfile] : ['-r', '.'];
  let res = await opts.run('osv-scanner', ['--format', 'json', ...scanArgs], { cwd: opts.repo, timeoutMs: 300_000 });
  if (res.error === 'ENOENT') {
    res = await opts.run(
      'docker',
      ['run', '--rm', '-v', `${opts.repo}:/src:ro`, '-w', '/src', 'ghcr.io/google/osv-scanner', '--format', 'json', ...scanArgs],
      { cwd: opts.repo, timeoutMs: 300_000 },
    );
    if (res.error === 'ENOENT') {
      throw new ToolNotInstalledError('osv-scanner', 'Install it from https://google.github.io/osv-scanner/ or make Docker available (ghcr.io/google/osv-scanner).');
    }
  }
  // osv-scanner exits 1 when vulnerabilities were found; any JSON on stdout is a result.
  if (!res.stdout.trim().startsWith('{')) {
    if (/no package sources found|no lockfiles/i.test(`${res.stdout}${res.stderr}`)) return [];
    throw new Error(`osv-scanner failed (exit ${res.status}): ${res.stderr.slice(0, 300)}`);
  }
  return parseOsvScanner(res.stdout);
}

export { fixedFromRange };
