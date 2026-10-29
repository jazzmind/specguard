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
  // [claims: capabilities/platform-foundation#config-editor-ai-defaults]
  it('validates editor AI defaults without changing project paths, budgets or the config file', async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, '.specguard'));
    const raw = JSON.stringify({ apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' }], llm: { provider: 'anthropic', model: 'old', apiKeyEnv: 'OLD_KEY', baseUrl: 'https://old.test', budget: { maxCalls: 3 } } });
    writeFileSync(path.join(root, '.specguard/config.json'), raw);
    const override = { provider: 'openai', model: 'workspace-model', apiKeyEnv: 'WORKSPACE_KEY', rootDir: '/wrong', budget: { maxCalls: 999 } };
    const env = { SPECGUARD_IDE_LLM: JSON.stringify(override) };
    const config = await loadConfig(root, { env });
    expect(config.llm).toMatchObject({ provider: 'openai', model: 'workspace-model', apiKeyEnv: 'WORKSPACE_KEY', budget: { maxCalls: 3 } });
    expect(config.llm.baseUrl).toBeUndefined();
    expect(config.rootDir).toBe(root);
    expect(await readFile(path.join(root, '.specguard/config.json'))).toBe(raw);
    await expect(loadConfig(root, { env: { SPECGUARD_IDE_LLM: '{bad' } })).rejects.toBeInstanceOf(ConfigInvalidError);
    await expect(loadConfig(root, { env: { SPECGUARD_IDE_LLM: JSON.stringify({ model: 42 }) } })).rejects.toBeInstanceOf(ConfigInvalidError);
  });
  // [claims: capabilities/platform-foundation#config-discovery]
  it('loads the repo .specguard/config.json', async () => {
    const config = await loadConfig(REPO_ROOT);
    expect(config.apps.length).toBeGreaterThanOrEqual(1);
    expect(config.llm.provider).toBe('anthropic');
    expect(config.rootDir).toBe(REPO_ROOT);
  });

  // [claims: capabilities/platform-foundation#config-discovery]
  it('walks up from a nested subdirectory to find the config', async () => {
    const config = await loadConfig(path.join(REPO_ROOT, 'src', 'core'));
    expect(config.rootDir).toBe(REPO_ROOT);
    expect(config.apps.length).toBeGreaterThanOrEqual(1);
  });

  // [claims: capabilities/platform-foundation#config-discovery]
  it('throws ConfigNotFoundError when no config exists', async () => {
    const empty = makeTempDir();
    await expect(loadConfig(empty)).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  // [claims: capabilities/platform-foundation#config-validation]
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

  // [claims: capabilities/platform-foundation#config-validation]
  it('throws ConfigInvalidError on malformed JSON', async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    writeFileSync(path.join(root, '.specguard', 'config.json'), '{ not json');
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigInvalidError);
  });
});

describe('writer + reader round-trip', () => {
  // [claims: capabilities/platform-foundation#filesystem-access]
  it('writeFile creates nested dirs and readFile reads it back', async () => {
    const root = makeTempDir();
    const target = path.join(root, 'a', 'b', 'c.txt');
    await writeFile(target, 'hello world');
    expect(await fileExists(target)).toBe(true);
    expect(await readFile(target)).toBe('hello world');
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it('ensureDir is idempotent', async () => {
    const root = makeTempDir();
    const dir = path.join(root, 'x', 'y');
    await ensureDir(dir);
    await ensureDir(dir);
    expect(await fileExists(dir)).toBe(true);
  });
});

describe('expandGlobs', () => {
  // [claims: capabilities/platform-foundation#default-glob-excludes]
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

describe('loadConfig repo boundary and extends', () => {
  const base = {
    apps: [{ name: 'a', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' }],
    llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' },
  };
  const put = (root: string, rel: string, body: unknown) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };

  // [claims: capabilities/platform-foundation#config-discovery]
  it('does not inherit a parent repo config across a .git boundary', async () => {
    const parent = makeTempDir();
    put(parent, '.git/HEAD', 'ref: refs/heads/main');
    put(parent, '.specguard/config.json', base);
    put(parent, 'child/.git/HEAD', 'ref: refs/heads/main');
    put(parent, 'child/src/x.ts', '');
    await expect(loadConfig(path.join(parent, 'child', 'src'))).rejects.toBeInstanceOf(ConfigNotFoundError);
    // the parent itself still loads, and a subdirectory of the same repo walks up to it
    expect((await loadConfig(path.join(parent))).rootDir).toBe(parent);
    put(parent, 'pkg/deep/y.ts', '');
    expect((await loadConfig(path.join(parent, 'pkg', 'deep'))).rootDir).toBe(parent);
  });

  // [claims: capabilities/platform-foundation#config-extends]
  it('inherits a parent config only through extends, merging one level deep', async () => {
    const parent = makeTempDir();
    put(parent, '.git/HEAD', '');
    put(parent, '.specguard/config.json', { ...base, runners: { semgrep: 'docker' }, paths: { docsOut: 'documentation' } });
    put(parent, 'child/.git/HEAD', '');
    put(parent, 'child/.specguard/config.json', {
      extends: '../.specguard/config.json',
      apps: [{ name: 'child', repo: '.', specDir: 'specs', sources: {}, framework: 'jest', testOutput: 'tests/' }],
      paths: { specsRoot: 'spec' },
    });
    const config = await loadConfig(path.join(parent, 'child'));
    expect(config.rootDir).toBe(path.join(parent, 'child'));
    expect(config.apps.map((a) => a.name)).toEqual(['child']);
    expect(config.llm.model).toBe('m');
    expect(config.runners?.semgrep).toBe('docker');
    expect(config.paths).toEqual({ docsOut: 'documentation', specsRoot: 'spec' });
  });

  // [claims: capabilities/platform-foundation#config-extends]
  it('accepts a directory as the extends target and rejects cycles and missing targets', async () => {
    const root = makeTempDir();
    put(root, 'a/.specguard/config.json', base);
    put(root, 'b/.specguard/config.json', { extends: '../a' });
    expect((await loadConfig(path.join(root, 'b'))).apps[0].name).toBe('a');
    put(root, 'c/.specguard/config.json', { extends: '../d' });
    put(root, 'd/.specguard/config.json', { extends: '../c' });
    await expect(loadConfig(path.join(root, 'c'))).rejects.toThrow(/cycle/);
    put(root, 'e/.specguard/config.json', { extends: '../nope' });
    await expect(loadConfig(path.join(root, 'e'))).rejects.toThrow(/not found/);
  });

  // [claims: capabilities/platform-foundation#config-apps-and-defaults]
  it('accepts paths, stripPrefix, entryPoints, plugins and featureState', async () => {
    const root = makeTempDir();
    put(root, '.specguard/config.json', {
      ...base,
      apps: [{ ...base.apps[0], stripPrefix: ['src/features/', 'lib/'], entryPoints: ['src/main.ts'] }],
      paths: { specsRoot: 's', docsOut: 'd', securityTests: 't', proofLedger: 'p.json' },
      plugins: ['x'],
      featureState: { catalog: 'c' },
    });
    const config = await loadConfig(root);
    expect(config.apps[0].stripPrefix).toEqual(['src/features/', 'lib/']);
    expect(config.paths?.proofLedger).toBe('p.json');
    expect(config.featureState?.catalog).toBe('c');
  });
});


describe('the llm block is optional [platform-foundation]', () => {
  const app = { name: 'a', repo: '.', specDir: 'specs', sources: { routes: ['src/**/*.ts'] }, framework: 'vitest', testOutput: 'tests/' };
  const configIn = (llm?: unknown): string => {
    const root = makeTempDir();
    mkdirSync(path.join(root, '.specguard'), { recursive: true });
    writeFileSync(path.join(root, '.specguard/config.json'), JSON.stringify({ apps: [app], ...(llm === undefined ? {} : { llm }) }));
    return root;
  };

  // [claims: capabilities/platform-foundation#config-apps-and-defaults]
  it('defaults to Anthropic with ANTHROPIC_API_KEY when there is no llm block', async () => {
    const config = await loadConfig(configIn());
    expect(config.llm).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyEnv: 'ANTHROPIC_API_KEY' });
  });

  // [claims: capabilities/platform-foundation#config-apps-and-defaults]
  it('fills in a partial llm block, with the key variable that goes with the provider', async () => {
    expect((await loadConfig(configIn({ provider: 'openai', model: 'gpt-x' }))).llm.apiKeyEnv).toBe('OPENAI_API_KEY');
    expect((await loadConfig(configIn({ provider: 'host' }))).llm).toMatchObject({ provider: 'host', model: 'claude-sonnet-4-6' });
    expect((await loadConfig(configIn({ provider: 'anthropic', apiKeyEnv: 'MY_KEY' }))).llm.apiKeyEnv).toBe('MY_KEY');
  });
});
