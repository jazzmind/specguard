import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runInit } from '../../src/pipelines/init.js';
import { applyIgnoreBlock, GENERATED_STATE_PATHS, IGNORE_END, IGNORE_START } from '../../src/core/state-ignore.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'sg-init-'));

describe('generated state ignore', () => {
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

  it('never ignores config, rules, plans, or the proof ledger', () => {
    for (const keep of ['.specguard/config.json', '.specguard/plans/', '.specguard/rules/', '.specguard/proofs.json', '.specguard/replay/']) {
      expect(GENERATED_STATE_PATHS).not.toContain(keep);
    }
  });

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
