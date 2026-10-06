import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _appendChangelog } from '../../src/pipelines/git-ops.js';

describe('git-ops changelog', () => {
  it('writes the changelog under ESM (no require) and appends on later commits', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-cl-'));
    _appendChangelog(dir, { hash: 'abc1234', message: 'specguard: generated', pipeline: 'generate', files: ['tests/a.test.ts'], timestamp: '2026-01-01T00:00:00Z' });
    _appendChangelog(dir, { hash: 'def5678', message: 'specguard: docs', files: ['docs/a.md', 'docs/b.md'], timestamp: '2026-01-02T00:00:00Z' });
    const text = readFileSync(path.join(dir, '.specguard', 'changelog.md'), 'utf8');
    expect(text.startsWith('# SpecGuard Changelog')).toBe(true);
    expect(text).toContain('## abc1234 · 2026-01-01T00:00:00Z');
    expect(text).toContain('## def5678');
    expect(text).toContain('**Files committed (2):**');
    expect(text.match(/# SpecGuard Changelog/g)).toHaveLength(1);
  });
});
