/**
 * pip, poetry and uv adapters. Audits go through pip-audit (the manager exports a
 * requirements file for poetry and uv).
 *
 * Spec: specs/core/ecosystems.md
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeSeverity, severityFromCvss, type Advisory, type Candidate } from '../advisory.js';
import { candidatesFor, escapeRegExp, fingerprintFiles, hasFile, readText, writeText } from './common.js';
import { runTool, type CommandRunner, type EcosystemAdapter } from './types.js';

interface PipVuln {
  id?: string;
  description?: string;
  fix_versions?: string[];
  aliases?: string[];
  severity?: string;
  cvss?: number;
}

/** `pip-audit -f json`. pip-audit reports no severity by itself, so it is `unknown` unless present. */
export function parsePipAudit(text: string, source = 'pip-audit'): Advisory[] {
  const doc = JSON.parse(text) as { dependencies?: Array<{ name?: string; version?: string; vulns?: PipVuln[] }> } | Array<unknown>;
  const deps = Array.isArray(doc) ? (doc as Array<{ name?: string; version?: string; vulns?: PipVuln[] }>) : (doc.dependencies ?? []);
  const out: Advisory[] = [];
  for (const dep of deps) {
    for (const v of dep.vulns ?? []) {
      out.push({
        id: v.id ?? 'unknown',
        aliases: v.aliases ?? [],
        ecosystem: 'PyPI',
        package: (dep.name ?? '').toLowerCase(),
        installedVersion: dep.version ?? '',
        vulnerableRange: '',
        fixedVersions: v.fix_versions ?? [],
        severity: v.cvss ? severityFromCvss(v.cvss) : normalizeSeverity(v.severity),
        cvss: v.cvss,
        direct: true,
        dependencyPath: [],
        source,
        url: v.id?.startsWith('PYSEC') || v.id?.startsWith('GHSA') ? `https://osv.dev/vulnerability/${v.id}` : undefined,
        title: v.description?.slice(0, 200),
      });
    }
  }
  return out;
}

/** Rewrite a requirement line for `pkg` to `pkg==version` (or add a constraint). */
export function editRequirements(text: string, pkg: string, version: string): { text: string; changed: boolean } {
  const re = new RegExp(`^(\\s*${escapeRegExp(pkg).replace(/[-_.]/g, '[-_.]')})(\\[[^\\]]*\\])?\\s*(==|>=|~=|<=|>|<|!=)?\\s*[^\\s;#]*(.*)$`, 'im');
  if (re.test(text)) {
    const next = text.replace(re, (_m, name, extras, op, rest) => `${name}${extras ?? ''}${op === '>=' ? '>=' : '=='}${version}${rest}`);
    return { text: next, changed: next !== text };
  }
  return { text: `${text.replace(/\n*$/, '\n')}${pkg}>=${version}\n`, changed: true };
}

/** Edit a PEP 621 `dependencies` array or Poetry table entry in pyproject.toml. */
export function editPyproject(text: string, pkg: string, version: string, kind: 'poetry' | 'uv'): { text: string; changed: boolean } {
  const name = escapeRegExp(pkg).replace(/[-_.]/g, '[-_.]');
  // PEP 621: "pkg>=1.0" inside dependencies = [ ... ]
  const pep = new RegExp(`(["']${name})(\\[[^\\]]*\\])?\\s*(==|>=|~=)?\\s*[^"',;\\s]*(["'])`, 'i');
  if (pep.test(text)) {
    const next = text.replace(pep, (_m, a, extras, op, q) => `${a}${extras ?? ''}${op === '==' ? '==' : '>='}${version}${q}`);
    return { text: next, changed: next !== text };
  }
  // Poetry: pkg = "^1.0"
  const tbl = new RegExp(`^(\\s*${name}\\s*=\\s*)(["'])([\\^~]?)[^"']*(["'])`, 'im');
  if (tbl.test(text)) {
    const next = text.replace(tbl, (_m, a, q, caret, q2) => `${a}${q}${caret || '^'}${version}${q2}`);
    return { text: next, changed: next !== text };
  }
  // Transitive: constrain it.
  if (kind === 'uv') {
    if (/^\s*constraint-dependencies\s*=\s*\[/m.test(text)) {
      const next = text.replace(/^(\s*constraint-dependencies\s*=\s*\[)/m, `$1"${pkg}>=${version}", `);
      return { text: next, changed: true };
    }
    const next = /^\[tool\.uv\]/m.test(text)
      ? text.replace(/^\[tool\.uv\]\s*$/m, `[tool.uv]\nconstraint-dependencies = ["${pkg}>=${version}"]`)
      : `${text.replace(/\n*$/, '\n')}\n[tool.uv]\nconstraint-dependencies = ["${pkg}>=${version}"]\n`;
    return { text: next, changed: true };
  }
  const next = /^\[tool\.poetry\.dependencies\]/m.test(text)
    ? text.replace(/^\[tool\.poetry\.dependencies\]\s*$/m, `[tool.poetry.dependencies]\n${pkg} = ">=${version}"`)
    : text;
  return { text: next, changed: next !== text };
}

async function pipAuditRequirements(run: CommandRunner, repo: string, requirements: string, hint: string): Promise<Advisory[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-pipaudit-'));
  const file = path.join(dir, 'requirements.txt');
  writeFileSync(file, requirements);
  const res = await runTool(run, 'pip-audit', ['-r', file, '--no-deps', '--disable-pip', '-f', 'json'], { cwd: repo, timeoutMs: 180_000 }, hint);
  if (!res.stdout.trim()) throw new Error(`pip-audit produced no output: ${res.stderr.slice(0, 200)}`);
  return parsePipAudit(res.stdout);
}

const PIP_HINT = 'Install it with `pipx install pip-audit` (or `pip install pip-audit`).';

export function createPythonAdapters(run: CommandRunner): EcosystemAdapter[] {
  const common = (id: 'pip' | 'poetry' | 'uv') => ({
    id,
    osvEcosystem: 'PyPI',
    resolveFix: candidatesFor,
  });
  const poetry: EcosystemAdapter = {
    ...common('poetry'),
    detect: (repo) => hasFile(repo, 'poetry.lock'),
    lockfiles: () => ['poetry.lock'],
    manifests: () => ['pyproject.toml'],
    async audit(repo) {
      const exp = await runTool(run, 'poetry', ['export', '-f', 'requirements.txt', '--without-hashes'], { cwd: repo, timeoutMs: 120_000 }, 'Install poetry and the poetry-plugin-export plugin.');
      if (exp.status !== 0) throw new Error(`poetry export failed: ${exp.stderr.slice(0, 200)}`);
      return pipAuditRequirements(run, repo, exp.stdout, PIP_HINT);
    },
    async apply(repo, c: Candidate) {
      const text = readText(repo, 'pyproject.toml');
      if (text === null) throw new Error('pyproject.toml not found');
      const r = editPyproject(text, c.package, c.toVersion, 'poetry');
      if (!r.changed) return [];
      writeText(repo, 'pyproject.toml', r.text);
      return ['pyproject.toml'];
    },
    async install(repo) {
      const lock = await runTool(run, 'poetry', ['lock'], { cwd: repo, timeoutMs: 600_000 }, 'Install poetry.');
      if (lock.status !== 0) return { ok: false, output: `${lock.stdout}${lock.stderr}` };
      const res = await runTool(run, 'poetry', ['install'], { cwd: repo, timeoutMs: 600_000 }, 'Install poetry.');
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, ['poetry.lock', 'pyproject.toml']),
  };
  const uv: EcosystemAdapter = {
    ...common('uv'),
    detect: (repo) => hasFile(repo, 'uv.lock'),
    lockfiles: () => ['uv.lock'],
    manifests: () => ['pyproject.toml'],
    async audit(repo) {
      const exp = await runTool(run, 'uv', ['export', '--format', 'requirements-txt', '--no-hashes', '--frozen'], { cwd: repo, timeoutMs: 120_000 }, 'Install uv (https://docs.astral.sh/uv/).');
      if (exp.status !== 0) throw new Error(`uv export failed: ${exp.stderr.slice(0, 200)}`);
      return pipAuditRequirements(run, repo, exp.stdout, PIP_HINT);
    },
    async apply(repo, c) {
      const text = readText(repo, 'pyproject.toml');
      if (text === null) throw new Error('pyproject.toml not found');
      const r = editPyproject(text, c.package, c.toVersion, 'uv');
      if (!r.changed) return [];
      writeText(repo, 'pyproject.toml', r.text);
      return ['pyproject.toml'];
    },
    async install(repo) {
      const res = await runTool(run, 'uv', ['sync'], { cwd: repo, timeoutMs: 600_000 }, 'Install uv.');
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, ['uv.lock', 'pyproject.toml']),
  };
  const pip: EcosystemAdapter = {
    ...common('pip'),
    detect: (repo) => hasFile(repo, 'requirements.txt') && !hasFile(repo, 'poetry.lock') && !hasFile(repo, 'uv.lock'),
    lockfiles: () => ['requirements.txt', 'Pipfile.lock'],
    manifests: () => ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'setup.py'],
    async audit(repo) {
      const res = await runTool(run, 'pip-audit', ['-r', 'requirements.txt', '--disable-pip', '--no-deps', '-f', 'json'], { cwd: repo, timeoutMs: 180_000 }, PIP_HINT);
      if (!res.stdout.trim()) throw new Error(`pip-audit produced no output: ${res.stderr.slice(0, 200)}`);
      return parsePipAudit(res.stdout);
    },
    async apply(repo, c) {
      const text = readText(repo, 'requirements.txt');
      if (text === null) throw new Error('requirements.txt not found');
      const r = editRequirements(text, c.package, c.toVersion);
      if (!r.changed) return [];
      writeText(repo, 'requirements.txt', r.text);
      return ['requirements.txt'];
    },
    async install(repo) {
      const res = await runTool(run, 'pip', ['install', '-r', 'requirements.txt'], { cwd: repo, timeoutMs: 600_000 }, 'Install Python and pip.');
      return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
    },
    fingerprint: (repo) => fingerprintFiles(repo, ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Pipfile.lock']),
  };
  return [poetry, uv, pip];
}
