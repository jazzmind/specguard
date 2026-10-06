/**
 * go (govulncheck), cargo (cargo audit), maven and gradle (via OSV) adapters.
 *
 * Spec: specs/core/ecosystems.md
 */
import { normalizeSeverity, type Advisory, type Candidate } from '../advisory.js';
import { candidatesFor, escapeRegExp, fingerprintFiles, hasFile, readText, writeText } from './common.js';
import { detectWithOsv } from './osv.js';
import { versionsIn } from './semver.js';
import { runTool, ToolNotInstalledError, type CommandRunner, type EcosystemAdapter } from './types.js';

/** Split concatenated top-level JSON objects (govulncheck -json emits a stream, not lines). */
export function splitJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* skip a corrupt object */
        }
        start = -1;
      }
    }
  }
  return out;
}

interface GoMsg {
  osv?: { id: string; aliases?: string[]; summary?: string; database_specific?: { url?: string } };
  finding?: { osv: string; fixed_version?: string; trace?: Array<{ module?: string; version?: string; package?: string; function?: string }> };
}

/** `govulncheck -json ./...`. Only findings that name a called symbol are reported. */
export function parseGovulncheck(text: string): Advisory[] {
  const msgs = splitJsonStream(text) as GoMsg[];
  const osvs = new Map(msgs.filter((m) => m.osv).map((m) => [m.osv!.id, m.osv!]));
  const out: Advisory[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    const f = m.finding;
    if (!f || !f.trace?.length) continue;
    if (!f.trace.some((t) => t.function)) continue; // module-level only: not reachable
    const top = f.trace[f.trace.length - 1];
    const mod = f.trace[0].module ?? top.module ?? '';
    const key = `${f.osv}|${mod}`;
    if (seen.has(key) || mod === 'stdlib') continue;
    seen.add(key);
    const osv = osvs.get(f.osv);
    out.push({
      id: f.osv,
      aliases: osv?.aliases ?? [],
      ecosystem: 'Go',
      package: mod,
      installedVersion: f.trace[0].version ?? '',
      vulnerableRange: '',
      fixedVersions: f.fixed_version ? [f.fixed_version.replace(/^v/, '')] : [],
      severity: 'unknown',
      direct: true,
      dependencyPath: f.trace.map((t) => t.package ?? t.module ?? '').filter(Boolean).slice(0, 4),
      source: 'govulncheck',
      url: osv?.database_specific?.url ?? `https://pkg.go.dev/vuln/${f.osv}`,
      title: osv?.summary,
    });
  }
  return out;
}

interface CargoAuditDoc {
  vulnerabilities?: {
    list?: Array<{
      advisory?: { id: string; package?: string; title?: string; aliases?: string[]; cvss?: string | null; url?: string; severity?: string };
      versions?: { patched?: string[] };
      package?: { name?: string; version?: string };
    }>;
  };
}

export function parseCargoAudit(text: string): Advisory[] {
  const doc = JSON.parse(text) as CargoAuditDoc;
  return (doc.vulnerabilities?.list ?? []).map((v) => ({
    id: v.advisory?.id ?? 'unknown',
    aliases: v.advisory?.aliases ?? [],
    ecosystem: 'crates.io',
    package: v.package?.name ?? v.advisory?.package ?? '',
    installedVersion: v.package?.version ?? '',
    vulnerableRange: '',
    fixedVersions: (v.versions?.patched ?? []).flatMap((p) => versionsIn(p).slice(0, 1)),
    severity: normalizeSeverity(v.advisory?.severity),
    direct: true,
    dependencyPath: [],
    source: 'cargo-audit',
    url: v.advisory?.url,
    title: v.advisory?.title,
  }));
}

// ---------------------------------------------------------------------------
// Maven / Gradle manifest edits
// ---------------------------------------------------------------------------

export function editPom(text: string, pkg: string, version: string): { text: string; changed: boolean } {
  const [group, artifact] = pkg.split(':');
  if (!artifact) return { text, changed: false };
  const re = new RegExp(
    `(<groupId>\\s*${escapeRegExp(group)}\\s*</groupId>\\s*<artifactId>\\s*${escapeRegExp(artifact)}\\s*</artifactId>\\s*<version>)[^<]*(</version>)`,
  );
  if (re.test(text)) return { text: text.replace(re, `$1${version}$2`), changed: true };
  // Transitive: pin through dependencyManagement.
  const dep = `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></dependency>`;
  if (/<dependencyManagement>[\s\S]*?<dependencies>/.test(text)) {
    return { text: text.replace(/(<dependencyManagement>[\s\S]*?<dependencies>)/, `$1\n      ${dep}`), changed: true };
  }
  return {
    text: text.replace(/<\/project>/, `  <dependencyManagement>\n    <dependencies>\n      ${dep}\n    </dependencies>\n  </dependencyManagement>\n</project>`),
    changed: true,
  };
}

export function editGradle(text: string, pkg: string, version: string): { text: string; changed: boolean } {
  const [group, artifact] = pkg.split(':');
  if (!artifact) return { text, changed: false };
  const re = new RegExp(`(['"]${escapeRegExp(group)}:${escapeRegExp(artifact)}:)[^'"]+(['"])`, 'g');
  if (re.test(text)) return { text: text.replace(re, `$1${version}$2`), changed: true };
  return { text, changed: false };
}

export function createNativeAdapters(run: CommandRunner): EcosystemAdapter[] {
  const go: EcosystemAdapter = {
    id: 'go',
    osvEcosystem: 'Go',
    detect: (repo) => hasFile(repo, 'go.mod'),
    lockfiles: () => ['go.sum'],
    manifests: () => ['go.mod'],
    async audit(repo) {
      const res = await runTool(run, 'govulncheck', ['-json', './...'], { cwd: repo, timeoutMs: 300_000 }, 'Install it with `go install golang.org/x/vuln/cmd/govulncheck@latest`.');
      if (!res.stdout.trim()) throw new Error(`govulncheck produced no output: ${res.stderr.slice(0, 200)}`);
      return parseGovulncheck(res.stdout);
    },
    resolveFix: candidatesFor,
    async apply(repo, c: Candidate) {
      const res = await runTool(run, 'go', ['get', `${c.package}@v${c.toVersion.replace(/^v/, '')}`], { cwd: repo, timeoutMs: 300_000 }, 'Install Go.');
      if (res.status !== 0) throw new Error(`go get failed: ${res.stderr.slice(0, 300)}`);
      return ['go.mod', 'go.sum'].filter((f) => hasFile(repo, f));
    },
    async install(repo) {
      const res = await runTool(run, 'go', ['mod', 'download'], { cwd: repo, timeoutMs: 300_000 }, 'Install Go.');
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, ['go.sum', 'go.mod']),
  };
  const cargo: EcosystemAdapter = {
    id: 'cargo',
    osvEcosystem: 'crates.io',
    detect: (repo) => hasFile(repo, 'Cargo.toml'),
    lockfiles: () => ['Cargo.lock'],
    manifests: () => ['Cargo.toml'],
    async audit(repo) {
      const res = await runTool(run, 'cargo', ['audit', '--json'], { cwd: repo, timeoutMs: 300_000 }, 'Install it with `cargo install cargo-audit`.');
      if (/no such command: .audit./i.test(res.stderr)) throw new ToolNotInstalledError('cargo-audit', 'Install it with `cargo install cargo-audit`.');
      if (!res.stdout.trim()) throw new Error(`cargo audit produced no output: ${res.stderr.slice(0, 200)}`);
      return parseCargoAudit(res.stdout);
    },
    resolveFix: candidatesFor,
    async apply(repo, c) {
      const changed: string[] = [];
      const toml = readText(repo, 'Cargo.toml');
      if (toml && c.mode === 'direct') {
        const re = new RegExp(`^(\\s*${escapeRegExp(c.package)}\\s*=\\s*(?:\\{[^}]*version\\s*=\\s*)?")[^"]*(")`, 'm');
        if (re.test(toml)) {
          writeText(repo, 'Cargo.toml', toml.replace(re, `$1${c.toVersion}$2`));
          changed.push('Cargo.toml');
        }
      }
      const res = await runTool(run, 'cargo', ['update', '-p', c.package, '--precise', c.toVersion], { cwd: repo, timeoutMs: 300_000 }, 'Install Rust (rustup).');
      if (res.status !== 0) throw new Error(`cargo update failed: ${res.stderr.slice(0, 300)}`);
      if (hasFile(repo, 'Cargo.lock')) changed.push('Cargo.lock');
      return changed;
    },
    async install(repo) {
      const res = await runTool(run, 'cargo', ['fetch'], { cwd: repo, timeoutMs: 600_000 }, 'Install Rust (rustup).');
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, ['Cargo.lock', 'Cargo.toml']),
  };
  const maven: EcosystemAdapter = {
    id: 'maven',
    osvEcosystem: 'Maven',
    detect: (repo) => hasFile(repo, 'pom.xml'),
    lockfiles: () => [],
    manifests: () => ['pom.xml'],
    audit: (repo) => detectWithOsv({ run, repo, lockfile: 'pom.xml' }),
    resolveFix: candidatesFor,
    async apply(repo, c) {
      const text = readText(repo, 'pom.xml');
      if (text === null) throw new Error('pom.xml not found');
      const r = editPom(text, c.package, c.toVersion);
      if (!r.changed) return [];
      writeText(repo, 'pom.xml', r.text);
      return ['pom.xml'];
    },
    async install(repo) {
      const res = await runTool(run, 'mvn', ['-q', '-B', 'dependency:resolve'], { cwd: repo, timeoutMs: 600_000 }, 'Install Maven.');
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, ['pom.xml']),
  };
  const gradleFile = (repo: string) => ['build.gradle', 'build.gradle.kts'].find((f) => hasFile(repo, f));
  const gradle: EcosystemAdapter = {
    id: 'gradle',
    osvEcosystem: 'Maven',
    detect: (repo) => !hasFile(repo, 'pom.xml') && Boolean(gradleFile(repo)),
    lockfiles: () => ['gradle.lockfile'],
    manifests: () => ['build.gradle', 'build.gradle.kts', 'gradle.properties'],
    audit: (repo) => detectWithOsv({ run, repo, lockfile: hasFile(repo, 'gradle.lockfile') ? 'gradle.lockfile' : gradleFile(repo) }),
    resolveFix: candidatesFor,
    async apply(repo, c) {
      const file = gradleFile(repo);
      if (!file) throw new Error('build.gradle not found');
      const r = editGradle(readText(repo, file) ?? '', c.package, c.toVersion);
      if (!r.changed) return [];
      writeText(repo, file, r.text);
      return [file];
    },
    async install(repo) {
      const bin = hasFile(repo, 'gradlew') ? './gradlew' : 'gradle';
      const res = await runTool(run, bin, ['--no-daemon', 'dependencies', '--write-locks'], { cwd: repo, timeoutMs: 600_000 }, 'Install Gradle (or commit the wrapper).');
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, ['gradle.lockfile', 'build.gradle', 'build.gradle.kts', 'gradle.properties']),
  };
  return [go, cargo, maven, gradle];
}
