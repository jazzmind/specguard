/**
 * Builds the end-to-end remediate fixtures in a temp dir: a small npm project with a vulnerable
 * dependency, a vitest suite, a local bare git remote, a fake registry (vendored package versions
 * copied by a stubbed `npm install`), canned `npm audit` output, and a fake `gh`.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { CommandRunner, CommandResult } from '../../../src/core/ecosystems/index.js';
import { compareVer } from '../../../src/core/ecosystems/semver.js';
import type { Exec, RemediateDeps } from '../../../src/pipelines/remediate/types.js';
import type { SpecGuardConfig } from '../../../src/core/types.js';
import { loadConfig } from '../../../src/core/config.js';
import { realGit } from '../../../src/pipelines/remediate/git.js';

const VITEST = path.resolve(__dirname, '../../../node_modules/vitest/vitest.mjs');

export type Variant = 'safe' | 'breaking' | 'flaky';

export interface Fixture {
  dir: string;
  remote: string;
  deps: Partial<RemediateDeps>;
  ghCalls: Array<{ args: string[]; body?: string }>;
  config: () => Promise<SpecGuardConfig>;
  git: (...args: string[]) => string;
  commandsRun: string[];
}

const w = (dir: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

const VULN = {
  auditReportVersion: 2,
  vulnerabilities: {
    vulnlib: {
      name: 'vulnlib',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 424242,
          name: 'vulnlib',
          dependency: 'vulnlib',
          title: 'Prototype pollution in vulnlib',
          url: 'https://github.com/advisories/GHSA-test-vuln-0001',
          severity: 'high',
          cvss: { score: 7.5 },
          range: '<1.0.1',
        },
      ],
      effects: [],
      range: '<1.0.1',
      nodes: ['node_modules/vulnlib'],
      fixAvailable: { name: 'vulnlib', version: '1.0.1', isSemVerMajor: false },
    },
  },
};

function lock(version: string): string {
  return JSON.stringify({ name: 'fixture-app', lockfileVersion: 3, packages: { '': { name: 'fixture-app' }, 'node_modules/vulnlib': { version } } }, null, 2) + '\n';
}

export function makeFixture(variant: Variant, opts: { testCommand?: string; extraTest?: boolean } = {}): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), `sg-rem-${variant}-`));
  const remote = path.join(mkdtempSync(path.join(os.tmpdir(), 'sg-rem-remote-')), 'origin.git');
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  // vendored "registry"
  w(dir, 'vendor/vulnlib@1.0.0/package.json', JSON.stringify({ name: 'vulnlib', version: '1.0.0', main: 'index.js' }));
  w(dir, 'vendor/vulnlib@1.0.0/index.js', "exports.parse = (s) => String(s).trim();\nexports.version = '1.0.0';\n");
  w(dir, 'vendor/vulnlib@1.0.1/package.json', JSON.stringify({ name: 'vulnlib', version: '1.0.1', main: 'index.js' }));
  w(
    dir,
    'vendor/vulnlib@1.0.1/index.js',
    variant === 'breaking'
      ? "exports.parse = (s) => String(s).trim().toUpperCase();\nexports.version = '1.0.1';\n"
      : "exports.parse = (s) => String(s).trim();\nexports.version = '1.0.1';\n",
  );

  w(dir, 'package.json', JSON.stringify({ name: 'fixture-app', version: '1.0.0', private: true, dependencies: { vulnlib: '^1.0.0' } }, null, 2) + '\n');
  w(dir, 'package-lock.json', lock('1.0.0'));
  w(dir, '.gitignore', 'node_modules/\n.specguard/runs/\n.specguard/remediation/\n.specguard/remediate.lock\n.specguard/llm-usage.json\n');
  w(dir, 'vitest.config.mjs', 'export default { test: { globals: true, include: ["test/**/*.test.mjs"] } };\n');
  w(dir, 'src/app.mjs', "import lib from 'vulnlib';\nexport const clean = (s) => lib.parse(s);\n");
  w(
    dir,
    'test/app.test.mjs',
    `import lib from 'vulnlib';
import { clean } from '../src/app.mjs';
describe('app', () => {
  it('trims input @claim:app/clean#trims', () => { expect(clean('  hi  ')).toBe('hi'); });
  it('keeps case @claim:app/clean#keeps-case', () => { expect(lib.parse(' Hello ')).toBe('Hello'); });
});
`,
  );
  if (variant === 'flaky') {
    w(
      dir,
      'test/flaky.test.mjs',
      `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import lib from 'vulnlib';
const f = path.join(os.tmpdir(), 'sg-flaky-' + crypto.createHash('sha1').update(process.cwd()).digest('hex'));
describe('flaky', () => {
  it('alternates', () => {
    const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
    fs.writeFileSync(f, String(n + 1));
    expect(lib.parse(' x ') && n % 2 === 0).toBe(true);
  });
});
`,
    );
  }
  w(
    dir,
    'specs/app/clean.md',
    `# Clean

<!-- module: src/app.mjs / type: core / status: draft -->

## Acceptance Criteria

- [ ] Input is trimmed <!-- claim: trims -->
- [ ] Case is kept <!-- claim: keeps-case -->
`,
  );
  w(
    dir,
    '.specguard/config.json',
    JSON.stringify({
      apps: [
        {
          name: 'app',
          repo: '.',
          specDir: 'specs',
          sources: { tests: ['test/**/*.mjs'] },
          framework: 'vitest',
          testOutput: 'test/',
          test: { command: opts.testCommand ?? `node ${VITEST} run`, reporter: 'vitest' },
        },
      ],
      llm: { provider: 'none', model: 'none', apiKeyEnv: 'NONE' },
      remediate: { minSeverity: 'high', semgrep: false, gitleaks: false, osv: false },
    }),
  );

  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  mkdirSync(path.dirname(remote), { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');

  const commandsRun: string[] = [];
  const ghCalls: Fixture['ghCalls'] = [];

  const run: CommandRunner = async (cmd, args, o): Promise<CommandResult> => {
    commandsRun.push([cmd, ...args].join(' '));
    const out = (stdout: string): CommandResult => ({ stdout, stderr: '', status: 0 });
    if (cmd === 'npm' && args[0] === 'audit') {
      const version = existsSync(path.join(o.cwd, 'package-lock.json'))
        ? (JSON.parse(readFileSync(path.join(o.cwd, 'package-lock.json'), 'utf8')).packages['node_modules/vulnlib'].version as string)
        : '1.0.0';
      return { stdout: JSON.stringify(compareVer(version, '1.0.1') < 0 ? VULN : { auditReportVersion: 2, vulnerabilities: {} }), stderr: '', status: compareVer(version, '1.0.1') < 0 ? 1 : 0 };
    }
    if (cmd === 'npm' && args[0] === 'install') {
      const pkg = JSON.parse(readFileSync(path.join(o.cwd, 'package.json'), 'utf8'));
      const ver = String(pkg.dependencies.vulnlib).replace(/^[\^~]/, '');
      const src = path.join(o.cwd, 'vendor', `vulnlib@${ver}`);
      if (!existsSync(src)) return { stdout: '', stderr: `no such version ${ver}`, status: 1 };
      rmSync(path.join(o.cwd, 'node_modules', 'vulnlib'), { recursive: true, force: true });
      mkdirSync(path.join(o.cwd, 'node_modules'), { recursive: true });
      cpSync(src, path.join(o.cwd, 'node_modules', 'vulnlib'), { recursive: true });
      writeFileSync(path.join(o.cwd, 'package-lock.json'), lock(ver));
      return out('installed');
    }
    if (cmd === 'node' || cmd === 'npm') return out('v22.0.0');
    return { stdout: '', stderr: `${cmd}: not found`, status: null, error: 'ENOENT' };
  };

  const gh: Exec = (args, cwd) => {
    const bodyFile = args[args.indexOf('--body-file') + 1];
    ghCalls.push({ args, body: bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : undefined });
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', status: 0 };
    if (args[0] === 'pr' && args[1] === 'create') return { stdout: 'https://example.test/acme/fixture/pull/7\n', stderr: '', status: 0 };
    void cwd;
    return { stdout: '', stderr: 'unexpected gh call', status: 1 };
  };

  const deps: Partial<RemediateDeps> = {
    run,
    git: realGit,
    gh,
    http: async () => ({ status: 404, text: '' }),
    sast: async () => ({ ok: true, findings: [] }),
    now: () => new Date('2026-10-06T12:00:00Z'),
    llm: false,
  };
  void copyFileSync;
  void createHash;
  return { dir, remote, deps, ghCalls, config: () => loadConfig(dir), git, commandsRun };
}
