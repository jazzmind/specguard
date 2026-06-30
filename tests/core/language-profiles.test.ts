import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, afterAll } from 'vitest';

import {
  getProfile,
  resolveProfile,
  featureFromPath,
  detectLanguage,
  parseVitestJson,
  parsePytestJson,
} from '../../src/core/language-profiles.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'specguard-lang-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('getProfile', () => {
  it('returns the typescript profile with legacy-exact values', () => {
    const p = getProfile('typescript');
    expect(p.testExt).toBe('.test.ts');
    expect(p.testCommand).toBe('npm test');
    expect(p.testReporterArgs).toBe(' -- --reporter=json');
    expect(p.testFileCandidates('reader')).toEqual([
      'reader.test.ts',
      'reader.test.tsx',
      'reader.test.js',
      'reader.test.jsx',
      'reader.spec.ts',
      'reader.spec.tsx',
      'reader.spec.js',
      'reader.spec.jsx',
    ]);
    expect(p.sourceGlobs.routes).toEqual(['src/**/*.{ts,tsx,js,jsx}']);
  });

  it('marks python full and go/rust/java as stubs', () => {
    expect(getProfile('python').capability).toBe('full');
    expect(getProfile('go').capability).toBe('stub');
    expect(getProfile('rust').capability).toBe('stub');
    expect(getProfile('java').capability).toBe('stub');
  });

  it('throws on an unknown language', () => {
    expect(() => getProfile('cobol')).toThrow(/Unknown language/);
  });
});

describe('resolveProfile', () => {
  it('defaults to typescript when language is absent', () => {
    expect(resolveProfile({} as never).id).toBe('typescript');
  });
  it('honors an explicit language', () => {
    expect(resolveProfile({ language: 'python' } as never).id).toBe('python');
  });
});

describe('featureFromPath (legacy deriveFeature parity)', () => {
  const ts = getProfile('typescript');
  it('drops src + area segment and strips .ts', () => {
    expect(featureFromPath('/repo/src/core/sub/reader.ts', '/repo', ts)).toBe('sub/reader');
  });
  it('strips a .test.ts qualifier', () => {
    expect(featureFromPath('/repo/tests/core/reader.test.ts', '/repo', ts)).toBe('reader');
  });
  it('handles python _test.py and .py', () => {
    const py = getProfile('python');
    // Leading 'app' is not src/tests, so it is dropped as the area segment.
    expect(featureFromPath('/repo/app/api/board.py', '/repo', py)).toBe('api/board');
    // Leading 'tests' dropped, then 'api' (area) dropped, '_test.py' stripped.
    expect(featureFromPath('/repo/tests/api/board_test.py', '/repo', py)).toBe('board');
  });
});

describe('detectLanguage', () => {
  it('detects python by marker file', async () => {
    const d = makeTempDir();
    writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname="x"\n');
    writeFileSync(path.join(d, 'main.py'), 'print(1)\n');
    expect(await detectLanguage(d)).toBe('python');
  });
  it('detects typescript by package.json', async () => {
    const d = makeTempDir();
    writeFileSync(path.join(d, 'package.json'), '{}');
    expect(await detectLanguage(d)).toBe('typescript');
  });
  it('falls back to typescript with no markers', async () => {
    const d = makeTempDir();
    expect(await detectLanguage(d)).toBe('typescript');
  });
});

describe('parsers', () => {
  it('parseVitestJson extracts failing tests', () => {
    const out = JSON.stringify({
      testResults: [
        {
          name: '/r/foo.test.ts',
          assertionResults: [
            { status: 'failed', title: 'does x', failureMessages: ['boom'] },
            { status: 'passed', title: 'does y' },
          ],
        },
      ],
    });
    const f = parseVitestJson(out);
    expect(f).toEqual([{ file: '/r/foo.test.ts', name: 'does x', message: 'boom' }]);
  });
  it('parsePytestJson extracts failing tests from nodeids', () => {
    const out = JSON.stringify({
      tests: [
        { nodeid: 'tests/foo_test.py::test_x', outcome: 'failed', call: { longrepr: 'AssertionError' } },
        { nodeid: 'tests/foo_test.py::test_y', outcome: 'passed' },
      ],
    });
    const f = parsePytestJson(out);
    expect(f).toEqual([{ file: 'tests/foo_test.py', name: 'test_x', message: 'AssertionError' }]);
  });
  it('parsers return null on non-JSON output', () => {
    expect(parseVitestJson('no json here')).toBeNull();
    expect(parsePytestJson('no json here')).toBeNull();
  });
});
