import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, afterAll } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { writeFile, ensureDir } from '../../src/core/writer.js';
import { readFile, expandGlobs, fileExists } from '../../src/core/reader.js';
import { ConfigNotFoundError, ConfigInvalidError } from '../../src/core/errors.js';

// Repo root is two levels up from tests/core/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'specguard-cfg-'));
  tempDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('loadConfig', () => {
  it('loads the repo .specguard/config.json', async () => {
    const config = await loadConfig(REPO_ROOT);
    expect(config.apps.length).toBeGreaterThanOrEqual(1);
    expect(config.llm.provider).toBe('anthropic');
    expect(config.rootDir).toBe(REPO_ROOT);
  });

  it('walks up from a nested subdirectory to find the config', async () => {
    const config = await loadConfig(path.join(REPO_ROOT, 'src', 'core'));
    expect(config.rootDir).toBe(REPO_ROOT);
    expect(config.apps.length).toBeGreaterThanOrEqual(1);
  });

  it('throws ConfigNotFoundError when no config exists', async () => {
    const empty = makeTempDir();
    await expect(loadConfig(empty)).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('throws ConfigInvalidError when the config fails schema validation', async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    // Missing required `llm` and empty apps -> schema failure.
    writeFileSync(
      path.join(root, '.specguard', 'config.json'),
      JSON.stringify({ apps: [] }),
    );
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigInvalidError);
  });

  it('throws ConfigInvalidError on malformed JSON', async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    writeFileSync(path.join(root, '.specguard', 'config.json'), '{ not json');
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigInvalidError);
  });
});

describe('writer + reader round-trip', () => {
  it('writeFile creates nested dirs and readFile reads it back', async () => {
    const root = makeTempDir();
    const target = path.join(root, 'a', 'b', 'c.txt');
    await writeFile(target, 'hello world');
    expect(await fileExists(target)).toBe(true);
    expect(await readFile(target)).toBe('hello world');
  });

  it('ensureDir is idempotent', async () => {
    const root = makeTempDir();
    const dir = path.join(root, 'x', 'y');
    await ensureDir(dir);
    await ensureDir(dir);
    expect(await fileExists(dir)).toBe(true);
  });
});

describe('expandGlobs', () => {
  it('finds src/core/*.ts as absolute, sorted, deduped paths', async () => {
    const matches = await expandGlobs(['src/core/*.ts'], REPO_ROOT);
    expect(matches.length).toBeGreaterThan(0);
    // All absolute.
    expect(matches.every((m) => path.isAbsolute(m))).toBe(true);
    // Includes config.ts.
    expect(matches.some((m) => m.endsWith(path.join('src', 'core', 'config.ts')))).toBe(true);
    // Sorted + deduped.
    const sorted = [...matches].sort();
    expect(matches).toEqual(sorted);
    expect(new Set(matches).size).toBe(matches.length);
  });

  it('returns empty array for empty patterns', async () => {
    expect(await expandGlobs([], REPO_ROOT)).toEqual([]);
  });
});
