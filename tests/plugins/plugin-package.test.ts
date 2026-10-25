import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const plugin = path.join(root, 'plugins', 'specguard');
const json = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
const pkg = json(path.join(root, 'package.json'));
const minor = String(pkg.version).split('.').slice(0, 2).join('.');

function frontmatter(file: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'));
  expect(m, `${file} has frontmatter`).toBeTruthy();
  return Object.fromEntries((m as RegExpExecArray)[1].split('\n').filter((l) => /^[a-z-]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
}
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe('the SpecGuard plugin for Claude Code and Codex [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#plugin-distribution]
  it('is listed by both marketplaces and both manifests carry the package version', () => {
    const claude = json(path.join(root, '.claude-plugin', 'marketplace.json'));
    expect(claude.plugins.map((p: { name: string; source: string }) => [p.name, p.source])).toEqual([['specguard', './plugins/specguard']]);
    const codex = json(path.join(root, '.agents', 'plugins', 'marketplace.json'));
    expect(codex.plugins[0]).toMatchObject({ name: 'specguard', source: { source: 'local', path: './plugins/specguard' } });
    expect(json(path.join(plugin, '.claude-plugin', 'plugin.json'))).toMatchObject({ name: 'specguard', version: pkg.version });
    expect(json(path.join(plugin, '.codex-plugin', 'plugin.json'))).toMatchObject({ name: 'specguard', version: pkg.version, skills: './skills/', mcpServers: './.mcp.json' });
  });

  // [claims: capabilities/integration-surfaces#plugin-distribution]
  it('runs the package of the same minor version, never the unrelated `specguard` package', () => {
    const mcp = json(path.join(plugin, '.mcp.json')).mcpServers['specguard-mcp'];
    expect(mcp.command).toBe('npx');
    expect(mcp.args).toEqual(['-y', '-p', `specguard-ai@${minor}`, 'specguard-mcp']);
    expect(mcp.env.SPECGUARD_HOST_AGENT).toBe('1');
    expect(readFileSync(path.join(plugin, 'bin', 'specguard'), 'utf8')).toContain(`specguard-ai@\${SPECGUARD_VERSION:-${minor}}`);
    for (const file of walk(plugin)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/npx\s+(-y\s+)?specguard(\s|$)/);
  });

  // [claims: capabilities/integration-surfaces#plugin-distribution]
  it('ships skills and commands that are well-formed and name only things that exist', () => {
    for (const name of readdirSync(path.join(plugin, 'skills'))) {
      const fm = frontmatter(path.join(plugin, 'skills', name, 'SKILL.md'));
      expect(fm.name).toBe(name);
      expect(fm.description.length).toBeGreaterThan(40);
    }
    expect(readdirSync(path.join(plugin, 'skills')).sort()).toEqual(['specguard', 'specguard-agent-work']);
    for (const file of readdirSync(path.join(plugin, 'commands'))) expect(frontmatter(path.join(plugin, 'commands', file)).description).toBeTruthy();
    expect(readdirSync(path.join(plugin, 'commands')).sort()).toEqual(['check.md', 'start.md']);

    // Every `specguard <command>` the skills and commands tell the agent to run is a command the CLI has.
    const help = execFileSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli', 'index.ts'), '--help'], { encoding: 'utf8', cwd: root });
    const known = new Set([...help.matchAll(/^\s{2}([a-z-]+)[ |]/gm)].map((m) => m[1]));
    for (const file of walk(plugin).filter((f) => f.endsWith('.md'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/`specguard ([a-z-]+)/g)) expect(known.has(m[1]), `${path.relative(root, file)}: specguard ${m[1]}`).toBe(true);
    }
  }, 60_000);

  // [claims: capabilities/integration-surfaces#plugin-distribution]
  it('the specguard executable hands the host agent the model work and can run a local build', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-plugin-'));
    const fake = path.join(dir, 'cli.js');
    writeFileSync(fake, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), host: process.env.SPECGUARD_HOST_AGENT }));');
    const bin = path.join(plugin, 'bin', 'specguard');
    accessSync(bin, constants.X_OK);
    const run = (env: Record<string, string>) => JSON.parse(execFileSync(bin, ['check', '--gaps'], { env: { PATH: process.env.PATH ?? '', SPECGUARD_CLI: fake, ...env }, encoding: 'utf8' }));
    expect(run({})).toEqual({ args: ['check', '--gaps'], host: '1' });
    expect(run({ SPECGUARD_HOST_AGENT: '0' }).host).toBe('0'); // an explicit setting is kept
  });

  // [claims: capabilities/integration-surfaces#plugin-distribution]
  it('prints a status at session start only in a project that uses SpecGuard, and never fails the session', () => {
    const hooks = json(path.join(plugin, 'hooks', 'hooks.json')).hooks;
    expect(Object.keys(hooks)).toEqual(['SessionStart']);
    expect(hooks.SessionStart[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}');
    const script = path.join(plugin, 'scripts', 'session-status.sh');
    accessSync(script, constants.X_OK);

    const bare = mkdtempSync(path.join(os.tmpdir(), 'sg-bare-'));
    const quiet = spawnSync(script, { cwd: bare, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe('');

    // In a project with a config it prints `check`, and a failing CLI still leaves the session alone.
    const project = mkdtempSync(path.join(os.tmpdir(), 'sg-proj-'));
    execFileSync('mkdir', ['-p', path.join(project, '.specguard')]);
    writeFileSync(path.join(project, '.specguard', 'config.json'), '{}');
    const broken = path.join(project, 'cli.js');
    writeFileSync(broken, 'process.exit(3)');
    const failing = spawnSync(script, { cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SPECGUARD_CLI: broken } });
    expect(failing.status).toBe(0);
    expect(existsSync(path.join(project, '.specguard', 'config.json'))).toBe(true);
  });
});
