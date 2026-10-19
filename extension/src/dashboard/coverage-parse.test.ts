import { describe, it, expect } from 'vitest';
import { parseCoverageText } from './coverage-parse.js';

const sample = `# specguard-core (specs/core)
  [ok] core/parser
  [missing-spec] core/llm
specguard-core: 2 source files, 1 specs (50%), 1 tests
`;

describe('parseCoverageText', () => {
  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('parses app name, items and summary percentage', () => {
    const apps = parseCoverageText(sample);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('specguard-core');
    expect(apps[0].percentage).toBe(50);
    expect(apps[0].items.find((i) => i.key === 'core/parser')?.hasSpec).toBe(true);
    expect(apps[0].items.find((i) => i.key === 'core/llm')?.hasSpec).toBe(false);
  });

  // [claims: capabilities/integration-surfaces#vscode-dashboard]
  it('folds a functional status report into one capability list', () => {
    const apps = parseCoverageText(`# docs [capability] 4 files, 0 tests, 3 claims (0 proven, 0 stale, 0 failed, 3 unproven)
# api [component] 2 files, 1 tests, 1 claims (1 proven, 0 stale, 0 failed, 0 unproven)
# unit . [repo] 9 source files, 1 unowned, 2 capabilities (docs, api)
  [missing-spec] src/orphan.ts
TOTAL: 9 source files, 8 specs (89%), 8 tests (89%), 1 missing specs
`);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('capabilities');
    expect(apps[0].percentage).toBe(89);
    expect(apps[0].sourceCount).toBe(9);
    expect(apps[0].specCount).toBe(2);
    expect(apps[0].basis).toBe('capability');
    expect(apps[0].items.map((item) => item.key)).toEqual(['docs', 'api', 'src/orphan.ts']);
    expect(apps[0].items[0].hasTest).toBe(false);
    expect(apps[0].items[1].hasTest).toBe(true);
  });
});
