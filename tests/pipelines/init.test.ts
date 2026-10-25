import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runInit } from '../../src/pipelines/init.js';
import { applyIgnoreBlock, GENERATED_STATE_PATHS, IGNORE_END, IGNORE_START } from '../../src/core/state-ignore.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sg-init-'));

describe('generated state ignore', () => {
  // [claims: capabilities/integration-surfaces#init-bootstrap]
  it('applyIgnoreBlock is idempotent and preserves surrounding lines', () => {
    const once = applyIgnoreBlock('node_modules/\ndist/');
    expect(once.startsWith('node_modules/\ndist/\n')).toBe(true);
    expect(once).toContain('.specguard/drift-registry.json');
    expect(applyIgnoreBlock(once)).toBe(once);
    const edited = applyIgnoreBlock(`a\n${IGNORE_START}\nstale\n${IGNORE_END}\nb\n`);
    expect(edited).not.toContain('stale');
    expect(edited).toContain('a\n');
    expect(edited.trimEnd().endsWith('b')).toBe(true);
  });

  // [claims: capabilities/integration-surfaces#init-bootstrap]
  it('never ignores config, rules, plans, or the proof ledger', () => {
    for (const keep of ['.specguard/config.json', '.specguard/plans/', '.specguard/rules/', '.specguard/proofs.json', '.specguard/replay/']) {
      expect(GENERATED_STATE_PATHS).not.toContain(keep);
    }
  });

  // [claims: capabilities/integration-surfaces#init-bootstrap]
  it('init writes the block, does not seed a drift registry, and is stable on re-run', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    const first = await runInit({ cwd: dir, harness: 'claude' });
    expect(first.exitCode).toBe(0);
    const gi = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules/');
    expect(gi).toContain('.specguard/activity-log.json');
    expect(existsSync(path.join(dir, '.specguard', 'drift-registry.json'))).toBe(false);
    await runInit({ cwd: dir, harness: 'claude' });
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(gi);
  });

  // [claims: capabilities/integration-surfaces#init-bootstrap]
  it('prints the untrack command for generated files git already tracks', async () => {
    const dir = tmp();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(path.join(dir, '.specguard'), { recursive: true });
    writeFileSync(path.join(dir, '.specguard', 'gaps.json'), '{}');
    execFileSync('git', ['add', '-f', '.specguard/gaps.json'], { cwd: dir });
    const result = await runInit({ cwd: dir, harness: 'claude' });
    expect(result.messages.join('\n')).toContain('git rm --cached .specguard/gaps.json');
  });
});

describe('minimal init [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#init-bootstrap]
  it('writes a config and a specs README only: no key file, no llm block, no agent files unless asked', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    const result = await runInit({ cwd: dir });
    expect(result.exitCode).toBe(0);
    for (const rel of ['.specguard/config.json', 'specs/README.md', '.gitignore']) expect(existsSync(path.join(dir, rel))).toBe(true);
    for (const rel of ['.specguard/.env', 'CLAUDE.md', 'AGENTS.md', '.claude', '.cursor', '.mcp.json']) expect(existsSync(path.join(dir, rel))).toBe(false);
    const config = JSON.parse(readFileSync(path.join(dir, '.specguard/config.json'), 'utf8'));
    expect(config.llm).toBeUndefined();
    expect(readFileSync(path.join(dir, 'specs/README.md'), 'utf8')).toContain('capabilities/<id>.md');
  });

  // [claims: capabilities/integration-surfaces#init-bootstrap]
  it('a harness is written only when named, and Claude Code gets its MCP server in .mcp.json', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    await runInit({ cwd: dir, harness: 'claude' });
    expect(existsSync(path.join(dir, '.claude/skills/specguard/SKILL.md'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers['specguard-mcp']).toBeTruthy();
    expect(existsSync(path.join(dir, '.cursor'))).toBe(false);
  });

  // [claims: capabilities/integration-surfaces#init-bootstrap]
  it('matches code kept at the repo root, where the src/-anchored globs would find nothing', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    writeFileSync(path.join(dir, 'cart.ts'), 'export const total = 1;\n');
    writeFileSync(path.join(dir, 'cart.test.ts'), 'export {};\n');
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'lib', 'util.ts'), 'export const u = 1;\n');
    await runInit({ cwd: dir });
    const { expandGlobs } = await import('../../src/core/reader.js');
    const sources = JSON.parse(readFileSync(path.join(dir, '.specguard/config.json'), 'utf8')).apps[0].sources;
    const rel = async (globs: string[]) => (await expandGlobs(globs, dir)).map((f) => path.relative(dir, f)).sort();
    expect(await rel(sources.routes)).toEqual(['cart.ts', 'lib/util.ts']);
    expect(await rel(sources.tests)).toContain('cart.test.ts');

    // With a src/ folder the usual globs stay.
    const withSrc = tmp();
    mkdirSync(path.join(withSrc, 'src'));
    writeFileSync(path.join(withSrc, 'package.json'), '{"name":"x"}');
    await runInit({ cwd: withSrc });
    expect(JSON.parse(readFileSync(path.join(withSrc, '.specguard/config.json'), 'utf8')).apps[0].sources.routes).toEqual(['src/**/*.{ts,tsx,js,jsx}']);
  });
});
