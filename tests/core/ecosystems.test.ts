import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Advisory } from '../../src/core/advisory.js';
import {
  adapterForAuditRunner,
  createEcosystems,
  detectDependencyAdvisories,
  detectEcosystems,
  getEcosystem,
  ToolNotInstalledError,
  type CommandResult,
  type CommandRunner,
} from '../../src/core/ecosystems/index.js';
import { editPom, editGradle, parseCargoAudit, parseGovulncheck } from '../../src/core/ecosystems/native.js';
import { parseNpmAudit, parseAdvisoriesMap, parseYarnBerryAudit, parseYarnClassicAudit, yarnFlavor } from '../../src/core/ecosystems/node.js';
import { editPyproject, editRequirements, parsePipAudit } from '../../src/core/ecosystems/python.js';
import { parseOsvScanner } from '../../src/core/ecosystems/osv.js';
import { bumpKind, fixedFromRange, rankFixes } from '../../src/core/ecosystems/semver.js';

const fx = (name: string) => readFileSync(path.join(__dirname, '../fixtures/audit', name), 'utf8');

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-eco-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const PKG = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.20' } }, null, 2) + '\n';
const NPM_LOCK = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/minimist': { version: '1.2.5' } } });

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', status: 0 });
function canned(map: Record<string, CommandResult>): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    return hit ? hit[1] : { stdout: '', stderr: 'not found', status: null, error: 'ENOENT' };
  };
  return { run, calls };
}

describe('semver helpers', () => {
  it('ranks patch before minor before major', () => {
    // claim: smallest-fix
    const r = rankFixes('2.2.0', ['3.0.1', '2.3.0', '2.2.5', '1.0.0']);
    expect(r.map((x) => x.version)).toEqual(['2.2.5', '2.3.0', '3.0.1']);
    expect(r.map((x) => x.bump)).toEqual(['patch', 'minor', 'major']);
    expect(bumpKind('1.2.3', '2.0.0')).toBe('major');
    expect(fixedFromRange('>=1.0.0 <1.2.5 || >=2.0.0 <2.0.3')).toEqual(['1.2.5', '2.0.3']);
    expect(fixedFromRange('<=1.0.0')).toEqual([]);
  });
});

describe('detection', () => {
  it('detects by lockfile marker, most specific wins', () => {
    // claim: detect-lockfile
    expect(detectEcosystems(repo({ 'package.json': PKG, 'pnpm-lock.yaml': '' })).map((a) => a.id)).toEqual(['pnpm']);
    expect(detectEcosystems(repo({ 'package.json': PKG, 'yarn.lock': '' })).map((a) => a.id)).toEqual(['yarn']);
    expect(detectEcosystems(repo({ 'package.json': PKG, 'package-lock.json': NPM_LOCK })).map((a) => a.id)).toEqual(['npm']);
    expect(detectEcosystems(repo({ 'pyproject.toml': '', 'poetry.lock': '' })).map((a) => a.id)).toEqual(['poetry']);
    expect(detectEcosystems(repo({ 'pyproject.toml': '', 'uv.lock': '' })).map((a) => a.id)).toEqual(['uv']);
    expect(detectEcosystems(repo({ 'requirements.txt': '' })).map((a) => a.id)).toEqual(['pip']);
    expect(detectEcosystems(repo({ 'go.mod': 'module x' })).map((a) => a.id)).toEqual(['go']);
    expect(detectEcosystems(repo({ 'Cargo.toml': '' })).map((a) => a.id)).toEqual(['cargo']);
    expect(detectEcosystems(repo({ 'pom.xml': '<project/>' })).map((a) => a.id)).toEqual(['maven']);
    expect(detectEcosystems(repo({ 'build.gradle': '' })).map((a) => a.id)).toEqual(['gradle']);
    expect(detectEcosystems(repo({ 'package.json': PKG, 'requirements.txt': '' })).map((a) => a.id).sort()).toEqual(['npm', 'pip']);
  });

  it('tells yarn classic from berry', () => {
    // claim: yarn-flavors
    expect(yarnFlavor(repo({ 'yarn.lock': '# yarn lockfile v1\n' }))).toBe('classic');
    expect(yarnFlavor(repo({ 'yarn.lock': '__metadata:\n  version: 6\n' }))).toBe('berry');
  });

  it('keeps the legacy auditRunner strings working', () => {
    // claim: audit-runner-compat
    expect(adapterForAuditRunner('npm-audit', repo({ 'package.json': PKG, 'pnpm-lock.yaml': '' }))?.id).toBe('pnpm');
    expect(adapterForAuditRunner('pip-audit', repo({ 'requirements.txt': '' }))?.id).toBe('pip');
    expect(adapterForAuditRunner('unsupported', repo({}))).toBeUndefined();
  });
});

describe('audit parsers', () => {
  it('parses npm audit v2, resolving installed versions from the lockfile', () => {
    // claim: audit-parse
    const dir = repo({ 'package.json': PKG, 'package-lock.json': NPM_LOCK });
    const list = parseNpmAudit(fx('npm-audit.json'), dir);
    expect(list.map((a) => a.package).sort()).toEqual(['lodash', 'minimist']);
    const lodash = list.find((a) => a.package === 'lodash')!;
    expect(lodash).toMatchObject({ id: 'GHSA-35jh-r3h4-6jhm', severity: 'high', installedVersion: '4.17.20', direct: true, fixedVersions: ['4.17.21'] });
    const mini = list.find((a) => a.package === 'minimist')!;
    expect(mini).toMatchObject({ severity: 'critical', direct: false, installedVersion: '1.2.5' });
    expect(mini.dependencyPath).toEqual(['mkdirp', 'minimist']);
  });

  it('parses pnpm, yarn classic and yarn berry', () => {
    const pnpm = parseAdvisoriesMap(fx('pnpm-audit.json'), 'npm', 'pnpm-audit');
    expect(pnpm).toHaveLength(2);
    expect(pnpm.find((a) => a.package === 'lodash')).toMatchObject({ id: 'GHSA-35jh-r3h4-6jhm', aliases: expect.arrayContaining(['CVE-2021-23337']), installedVersion: '4.17.20', fixedVersions: ['4.17.21'], direct: true });
    expect(pnpm.find((a) => a.package === 'minimist')!.direct).toBe(false);
    const classic = parseYarnClassicAudit(fx('yarn-classic-audit.ndjson'));
    expect(classic.map((a) => a.package)).toEqual(['lodash', 'minimist']);
    expect(classic[1].dependencyPath).toEqual(['mkdirp', 'minimist']);
    const berry = parseYarnBerryAudit(fx('yarn-berry-audit.ndjson'));
    expect(berry.map((a) => [a.package, a.severity, a.installedVersion])).toEqual([
      ['lodash', 'high', '4.17.20'],
      ['minimist', 'critical', '1.2.5'],
    ]);
  });

  it('parses pip-audit with unknown severity and fix versions', () => {
    const list = parsePipAudit(fx('pip-audit.json'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ package: 'django', installedVersion: '3.2.0', severity: 'unknown', ecosystem: 'PyPI' });
    expect(list[0].fixedVersions).toContain('3.2.1');
  });

  it('parses govulncheck streams, keeping only called symbols', () => {
    const list = parseGovulncheck(fx('govulncheck.jsonl'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'GO-2023-1987', package: 'golang.org/x/net', installedVersion: 'v0.12.0', fixedVersions: ['0.17.0'], aliases: ['CVE-2023-39325', 'GHSA-4374-p667-p6c8'] });
  });

  it('parses cargo audit and OSV-Scanner', () => {
    const cargo = parseCargoAudit(fx('cargo-audit.json'));
    expect(cargo[0]).toMatchObject({ id: 'RUSTSEC-2023-0044', package: 'openssl', fixedVersions: ['0.10.60'], ecosystem: 'crates.io' });
    const osv = parseOsvScanner(fx('osv-scanner.json'));
    expect(osv).toHaveLength(2);
    const log4j = osv.find((a) => a.package.includes('log4j'))!;
    expect(log4j).toMatchObject({ severity: 'critical', cvss: 10, ecosystem: 'Maven', installedVersion: '2.14.1' });
    expect(log4j.fixedVersions).toEqual(['2.3.1', '2.12.2', '2.15.0']);
    expect(osv.find((a) => a.package === 'lodash')).toMatchObject({ severity: 'high', ecosystem: 'npm', vulnerableRange: '<4.17.21' });
  });
});

describe('tool availability and the OSV detector', () => {
  it('throws ToolNotInstalledError instead of ENOENT', async () => {
    // claim: tool-not-installed
    const { run } = canned({});
    const dir = repo({ 'go.mod': 'module x' });
    await expect(getEcosystem('go', run).audit(dir)).rejects.toBeInstanceOf(ToolNotInstalledError);
    await expect(getEcosystem('go', run).audit(dir)).rejects.toThrow(/govulncheck is not installed/);
  });

  it('uses OSV when available and merges with the native audit', async () => {
    // claim: osv-universal
    const dir = repo({ 'package.json': PKG, 'package-lock.json': NPM_LOCK });
    const { run } = canned({
      'osv-scanner': { stdout: fx('osv-scanner.json'), stderr: '', status: 1 },
      'npm audit': ok(fx('npm-audit.json')),
    });
    const det = await detectDependencyAdvisories(dir, { run });
    expect(det.sources).toEqual(['osv-scanner', 'npm-audit']);
    const lodash = det.advisories.filter((a) => a.package === 'lodash');
    expect(lodash).toHaveLength(1);
    expect(lodash[0].direct).toBe(true); // confirmed by the native audit
    expect(lodash[0].source).toBe('osv-scanner,npm-audit');
  });

  it('falls back to native audits, with a warning, when OSV is missing', async () => {
    const dir = repo({ 'package.json': PKG, 'package-lock.json': NPM_LOCK });
    const { run } = canned({ 'npm audit': ok(fx('npm-audit.json')) });
    const det = await detectDependencyAdvisories(dir, { run });
    expect(det.sources).toEqual(['npm-audit']);
    expect(det.warnings.join(' ')).toMatch(/osv-scanner is not installed/);
    expect(det.advisories).toHaveLength(2);
  });

  it('runs OSV through docker when the binary is missing', async () => {
    const dir = repo({ 'pom.xml': '<project/>' });
    const { run, calls } = canned({ docker: { stdout: fx('osv-scanner.json'), stderr: '', status: 1 } });
    const det = await detectDependencyAdvisories(dir, { run });
    expect(calls.some((c) => c.startsWith('docker run') && c.includes('ghcr.io/google/osv-scanner'))).toBe(true);
    expect(det.advisories.length).toBe(2);
  });
});

const adv = (over: Partial<Advisory>): Advisory => ({
  id: 'GHSA-x', aliases: [], ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.20', vulnerableRange: '<4.17.21',
  fixedVersions: ['4.17.21'], severity: 'high', direct: true, dependencyPath: [], source: 't', ...over,
});

describe('apply', () => {
  it('bumps a direct npm dependency keeping the range prefix and formatting', async () => {
    // claim: apply-changed-files
    const dir = repo({ 'package.json': PKG, 'package-lock.json': NPM_LOCK });
    const npm = getEcosystem('npm');
    const [c] = npm.resolveFix(adv({}));
    expect(c).toMatchObject({ toVersion: '4.17.21', bump: 'patch', mode: 'direct' });
    expect(await npm.apply(dir, c)).toEqual(['package.json']);
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(PKG.replace('^4.17.20', '^4.17.21'));
  });

  it('pins transitive fixes through overrides, pnpm.overrides and resolutions', async () => {
    // claim: transitive-override
    const t = adv({ package: 'minimist', installedVersion: '1.2.5', fixedVersions: ['1.2.6'], direct: false });
    for (const [id, lock] of [['npm', 'package-lock.json'], ['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock']] as const) {
      const dir = repo({ 'package.json': PKG, [lock]: '' });
      const eco = getEcosystem(id);
      await eco.apply(dir, eco.resolveFix(t)[0]);
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (id === 'npm') expect(pkg.overrides).toEqual({ minimist: '1.2.6' });
      if (id === 'pnpm') expect(pkg.pnpm.overrides).toEqual({ minimist: '1.2.6' });
      if (id === 'yarn') expect(pkg.resolutions).toEqual({ minimist: '1.2.6' });
    }
  });

  it('edits requirements.txt, pyproject.toml, pom.xml and build.gradle', () => {
    expect(editRequirements('django==3.2.0\nrequests==2.31.0\n', 'Django', '3.2.1').text).toBe('django==3.2.1\nrequests==2.31.0\n');
    expect(editRequirements('requests==2.0\n', 'urllib3', '1.26.5').text).toBe('requests==2.0\nurllib3>=1.26.5\n');
    expect(editPyproject('[tool.poetry.dependencies]\ndjango = "^3.2.0"\n', 'django', '3.2.1', 'poetry').text).toContain('django = "^3.2.1"');
    expect(editPyproject('dependencies = ["django>=3.2.0"]\n', 'django', '3.2.1', 'uv').text).toContain('"django>=3.2.1"');
    expect(editPyproject('[project]\nname="x"\n', 'urllib3', '1.26.5', 'uv').text).toContain('constraint-dependencies = ["urllib3>=1.26.5"]');
    const pom = '<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.0</version></dependency></dependencies></project>';
    expect(editPom(pom, 'g:a', '1.1').text).toContain('<version>1.1</version>');
    expect(editPom(pom, 'g:b', '2.0').text).toContain('<dependencyManagement>');
    expect(editGradle("implementation 'g:a:1.0'", 'g:a', '1.1').text).toBe("implementation 'g:a:1.1'");
  });

  it('go apply goes through the command runner and reports go.mod/go.sum', async () => {
    const dir = repo({ 'go.mod': 'module x', 'go.sum': '' });
    const { run, calls } = canned({ 'go get': ok('') });
    const go = getEcosystem('go', run);
    const files = await go.apply(dir, go.resolveFix(adv({ ecosystem: 'Go', package: 'golang.org/x/net', installedVersion: 'v0.12.0', fixedVersions: ['0.17.0'] }))[0]);
    expect(files).toEqual(['go.mod', 'go.sum']);
    expect(calls[0]).toBe('go get golang.org/x/net@v0.17.0');
  });
});

describe('fingerprint', () => {
  it('changes when a lockfile or manifest changes', () => {
    // claim: fingerprint-changes
    const dir = repo({ 'package.json': PKG, 'package-lock.json': NPM_LOCK });
    const before = getEcosystem('npm').fingerprint(dir);
    expect(getEcosystem('npm').fingerprint(dir)).toBe(before);
    writeFileSync(path.join(dir, 'package-lock.json'), NPM_LOCK.replace('4.17.20', '4.17.21'));
    expect(getEcosystem('npm').fingerprint(dir)).not.toBe(before);
  });

  it('exposes every ecosystem with the full interface', () => {
    const ids = createEcosystems().map((a) => a.id);
    expect(ids.sort()).toEqual(['cargo', 'go', 'gradle', 'maven', 'npm', 'pip', 'pnpm', 'poetry', 'uv', 'yarn']);
    for (const a of createEcosystems()) {
      for (const fn of ['detect', 'lockfiles', 'audit', 'resolveFix', 'apply', 'install', 'fingerprint'] as const) expect(typeof a[fn]).toBe('function');
    }
  });
});
