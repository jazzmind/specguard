import { describe, it, expect } from 'vitest';
import { parseCoverageText } from './coverage-parse.js';

const sample = `# specguard-core (specs/core)
  [ok] core/parser
  [missing-spec] core/llm
specguard-core: 2 source files, 1 specs (50%), 1 tests
`;

describe('parseCoverageText', () => {
  it('parses app name, items and summary percentage', () => {
    const apps = parseCoverageText(sample);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('specguard-core');
    expect(apps[0].percentage).toBe(50);
    expect(apps[0].items.find((i) => i.key === 'core/parser')?.hasSpec).toBe(true);
    expect(apps[0].items.find((i) => i.key === 'core/llm')?.hasSpec).toBe(false);
  });
});
