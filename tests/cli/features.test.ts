import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectFeatures } from '../../src/cli/commands/features.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

function repoWithSpecs(specs: Record<string, string>): SpecGuardConfig {
  const dir = mkdtempSync(path.join(tmpdir(), 'sg-features-'));
  for (const [name, body] of Object.entries(specs)) {
    const file = path.join(dir, 'specs', `${name}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return {
    rootDir: dir,
    apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: { api: ['src/**/*.ts'] }, framework: 'vitest', testOutput: 'tests' }],
    llm: { provider: 'anthropic', model: 'claude', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  } as SpecGuardConfig;
}

const meta = (extra: string): string => `# X\n\n<!-- module: src/x.ts / type: page / status: draft${extra} -->\n\n## Acceptance Criteria\n\n- [ ] ok\n`;

describe('collectFeatures', () => {
  it('lists specs that carry feature ids and splits comma separated values', () => {
    const config = repoWithSpecs({
      'pages/a': meta(' / feature: design.a, design.b'),
      'pages/b': meta(' / feature: platform'),
    });
    expect(collectFeatures(config)).toEqual([
      { spec: 'app:pages/a', features: ['design.a', 'design.b'] },
      { spec: 'app:pages/b', features: ['platform'] },
    ]);
  });

  it('skips specs with no feature meta', () => {
    const config = repoWithSpecs({ 'pages/c': meta('') });
    expect(collectFeatures(config)).toEqual([]);
  });

  it('skips an app whose spec directory is missing', () => {
    const config = repoWithSpecs({ 'pages/a': meta(' / feature: x.y') });
    config.apps.push({ ...config.apps[0], name: 'ghost', specDir: 'nope' });
    expect(collectFeatures(config).map((row) => row.spec)).toEqual(['app:pages/a']);
  });
});
