import { describe, it, expect } from 'vitest';
import { toMatrixModel } from './matrix-model.js';

const raw = {
  generatedAt: '2026-06-28T18:24:50.615Z',
  entries: [
    { specKey: 'cli', title: 'CLI Entrypoint', appName: 'specguard-core', tests: [], docs: [], sourceModule: 'src/cli/index.ts' },
    { specKey: 'config', title: 'Config Loader', appName: 'specguard-core', tests: ['/x/tests/core/config.test.ts'], docs: [], sourceModule: 'src/core/config.ts' },
  ],
};

describe('toMatrixModel', () => {
  it('maps entries to rows with test/doc coverage flags', () => {
    const m = toMatrixModel(raw);
    expect(m.generatedAt).toBe('2026-06-28T18:24:50.615Z');
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]).toMatchObject({ specKey: 'cli', hasTests: false, testCount: 0, hasDocs: false });
    expect(m.rows[1]).toMatchObject({ specKey: 'config', hasTests: true, testCount: 1 });
  });
  it('returns an empty model for malformed input', () => {
    expect(toMatrixModel(null)).toEqual({ generatedAt: null, rows: [] });
    expect(toMatrixModel({})).toEqual({ generatedAt: null, rows: [] });
  });
});
