import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn(), resolveTargets: vi.fn(() => [{ model: 'm' }]) }));

import { loadConfig } from '../../src/core/config.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { runCheck } from '../../src/pipelines/check.js';
import { runSpecTag } from '../../src/pipelines/spec-tag.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const mocked = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;
let repo: TmpRepo;
const read = (rel: string) => readFileSync(path.join(repo.dir, rel), 'utf8');
const run = async (opts: Parameters<typeof runSpecTag>[1] = {}) => runSpecTag(await loadConfig(repo.dir), opts);

/** A model answer: each match names a test and the requirements it proves, all with high confidence. */
const hi = (test: number, ...ids: string[]) => ({ test, claims: ids.map((id) => ({ id, confidence: 'high' as const })) });

const TESTS =
  "describe('auth', () => {\n" +
  "  it('signs in with a valid code', () => {});\n" +
  "  it('rejects a wrong code', () => {});\n" +
  "  it('formats the greeting', () => {});\n" +
  '});\n';

beforeEach(() => {
  mocked.mockReset();
  repo = makeV2Repo();
  // The fixture's auth spec lists tests/auth.test.ts, which already has one tagged test; replace it.
  repo.write('tests/auth.test.ts', TESTS);
  mocked.mockResolvedValue({ matches: [hi(0, 'login-valid-code')] });
});

describe('spec tag [spec-tag]', () => {
  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('is a dry run unless --yes: it reports and writes nothing [dry-run]', async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.messages.join('\n')).toContain('would tag 1 test(s) in 1 file(s); rerun with --yes to write');
    expect(read('tests/auth.test.ts')).toBe(TESTS);
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('writes the tag above the matched test, at its indentation, and the check then sees the claim as tested [write]', async () => {
    const r = await run({ yes: true });
    expect(r.created).toBe(1);
    expect(read('tests/auth.test.ts')).toContain("  // [claims: capabilities/auth#login-valid-code]\n  it('signs in with a valid code'");
    expect(read('tests/auth.test.ts')).not.toContain("[claims: capabilities/auth#login-valid-code]\n  it('rejects");
    const gaps = await runCheck(await loadConfig(repo.dir), { view: 'gaps' });
    const text = gaps.messages.join('\n');
    expect(text).not.toContain('[untested-claim] capabilities/auth#login-valid-code');
    expect(text).toContain('[untested-claim] capabilities/auth#logout-clears-session');
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('shows the model the requirements and only the untagged tests, and says which requirements no test covers [prompt-and-report]', async () => {
    const r = await run();
    const call = mocked.mock.calls[0][0];
    expect(call.pipeline).toBe('tag');
    expect(call.prompt).toContain('login-valid-code: Login succeeds with a valid code');
    expect(call.prompt).toContain('0. tests/auth.test.ts — signs in with a valid code');
    expect(r.messages.join('\n')).toContain('1 of 1 requirement(s) now cited'.replace('1 of 1', '1 of 2'));
    expect(r.messages.join('\n')).toContain('no test found for: logout-clears-session');
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('is idempotent: a second run finds nothing left to tag [idempotent]', async () => {
    await run({ yes: true });
    mocked.mockClear();
    mocked.mockResolvedValue({ matches: [] });
    const again = await run({ yes: true });
    expect(again.created).toBe(0);
    expect(read('tests/auth.test.ts').match(/\[claims:/g)).toHaveLength(1);
    // Two tests remain untagged, so they are offered again; the already tagged one is not.
    expect(mocked.mock.calls[0][0].prompt).not.toContain('signs in with a valid code');
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('ignores ids and test numbers the model made up, and a test it matched to nothing real [validation]', async () => {
    mocked.mockResolvedValue({
      matches: [
        hi(0, 'not-a-requirement'),
        hi(99, 'login-valid-code'),
        hi(1, 'login-invalid-code-ghost', 'logout-clears-session'),
      ],
    });
    await run({ yes: true });
    const text = read('tests/auth.test.ts');
    expect(text).toContain("  // [claims: capabilities/auth#logout-clears-session]\n  it('rejects a wrong code'");
    expect(text).not.toContain('not-a-requirement');
    expect(text.match(/\[claims:/g)).toHaveLength(1);
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('ignores links the model marks as medium confidence, since they would overstate what a test proves [high-only]', async () => {
    mocked.mockResolvedValue({
      matches: [
        { test: 0, claims: [{ id: 'login-valid-code', confidence: 'medium' }] },
        { test: 1, claims: [{ id: 'logout-clears-session', confidence: 'high' }, { id: 'login-valid-code', confidence: 'medium' }] },
      ],
    });
    await run({ yes: true });
    const text = read('tests/auth.test.ts');
    expect(text).toContain("  // [claims: capabilities/auth#logout-clears-session]\n  it('rejects a wrong code'");
    expect(text.match(/\[claims:/g)).toHaveLength(1);
    expect(text).not.toContain('capabilities/auth#login-valid-code');
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('splits a long test list across several calls [chunking]', async () => {
    mocked.mockResolvedValue({ matches: [] });
    await run({ chunkSize: 2 });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[0][0].prompt).toContain('1. tests/auth.test.ts — rejects a wrong code');
    expect(mocked.mock.calls[1][0].prompt).toContain('0. tests/auth.test.ts — formats the greeting');
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('merges tags when two capabilities cite the same test [merge]', async () => {
    repo.write('specs/capabilities/shop.md', read('specs/capabilities/shop.md').replace('  - "src/shop/**"\n', '  - "src/shop/**"\n') .replace('---\n# Shop', 'tests:\n  - "tests/auth.test.ts"\n---\n# Shop'));
    mocked.mockImplementation(async (o: { prompt: string }) =>
      o.prompt.includes('(auth)') || o.prompt.includes('Capability: Auth') ? { matches: [hi(0, 'login-valid-code')] } : { matches: [hi(0, 'cart-totals')] },
    );
    await run({ yes: true });
    expect(read('tests/auth.test.ts')).toContain('// [claims: capabilities/auth#login-valid-code, capabilities/shop#cart-totals]');
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('lists each tagged test with its requirements for review when asked [list]', async () => {
    const r = await run({ list: true });
    expect(r.messages).toContain('  tests/auth.test.ts:2  signs in with a valid code  ->  capabilities/auth#login-valid-code');
    expect((await run()).messages.some((m) => m.includes('signs in with a valid code  ->'))).toBe(false);
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('limits itself to one capability and rejects an unknown one [scope]', async () => {
    const one = await run({ spec: 'auth' });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(one.exitCode).toBe(0);
    const bad = await run({ spec: 'ghost' });
    expect(bad.exitCode).toBe(1);
  });

  // [claims: capabilities/spec-authoring#spec-tag-links-tests]
  it('skips a capability with no tests listed, saying so [no-tests]', async () => {
    const r = await run();
    expect(r.messages.join('\n')).toContain('[skip] shop: no tests listed');
  });
});

describe('spec tag --index [spec-tag-index]', () => {
  const INDEX = 'specs/tag-index.md';
  const exists = (rel: string) => existsSync(path.join(repo.dir, rel));

  // [claims: capabilities/spec-authoring#spec-tag-index-mode]
  it('writes the index and leaves test sources untouched [index-write]', async () => {
    const r = await run({ yes: true, index: INDEX });
    expect(r.created).toBe(1);
    expect(read('tests/auth.test.ts')).toBe(TESTS);
    expect(read(INDEX)).toBe('tests/auth.test.ts:2 :: signs in with a valid code  [claims: capabilities/auth#login-valid-code]\n');
    expect(r.messages.join('\n')).toContain('indexed 1 test(s) in specs/tag-index.md; test sources untouched');
  });

  // [claims: capabilities/spec-authoring#spec-tag-index-mode]
  it('is a dry run without --yes and writes no index [index-dry-run]', async () => {
    const r = await run({ index: INDEX });
    expect(r.messages.join('\n')).toContain('would index 1 test(s) in specs/tag-index.md; rerun with --yes to write');
    expect(exists(INDEX)).toBe(false);
  });

  // [claims: capabilities/spec-authoring#spec-tag-index-mode]
  it('the check counts an indexed test as proving the claim when the index is a listed test file [index-check]', async () => {
    repo.write('specs/capabilities/auth.md', read('specs/capabilities/auth.md').replace('  - "tests/auth.test.ts"\n', '  - "tests/auth.test.ts"\n  - "specs/tag-index.md"\n'));
    await run({ yes: true, index: INDEX });
    const gaps = await runCheck(await loadConfig(repo.dir), { view: 'gaps' });
    const text = gaps.messages.join('\n');
    expect(text).not.toContain('[untested-claim] capabilities/auth#login-valid-code');
    expect(text).toContain('[untested-claim] capabilities/auth#logout-clears-session');
  });

  // [claims: capabilities/spec-authoring#spec-tag-index-mode]
  it('re-runs without duplicating: indexed tests are skipped, new ones are merged in sorted order, other lines stay [index-merge]', async () => {
    await run({ yes: true, index: INDEX });
    repo.write(INDEX, `# hand-written note\nzzz/other.java:3 :: kept  [claims: a/b#c]\n${read(INDEX)}`);
    mocked.mockClear();
    mocked.mockResolvedValue({ matches: [hi(0, 'logout-clears-session')] });
    const again = await run({ yes: true, index: INDEX });
    // The already indexed test is not offered again; "rejects a wrong code" is the first one left.
    const prompt = mocked.mock.calls[0][0].prompt;
    expect(prompt).not.toContain('signs in with a valid code');
    expect(prompt).toContain('0. tests/auth.test.ts — rejects a wrong code');
    expect(again.created).toBe(1);
    expect(read(INDEX)).toBe(
      '# hand-written note\n' +
        'tests/auth.test.ts:2 :: signs in with a valid code  [claims: capabilities/auth#login-valid-code]\n' +
        'tests/auth.test.ts:3 :: rejects a wrong code  [claims: capabilities/auth#logout-clears-session]\n' +
        'zzz/other.java:3 :: kept  [claims: a/b#c]\n',
    );
    expect(read('tests/auth.test.ts')).toBe(TESTS);
    // A third run finds nothing new and leaves the file as it is.
    const before = read(INDEX);
    mocked.mockResolvedValue({ matches: [] });
    expect((await run({ yes: true, index: INDEX })).created).toBe(0);
    expect(read(INDEX)).toBe(before);
  });

  // [claims: capabilities/spec-authoring#spec-tag-index-mode]
  it('still skips an indexed test after its line moved, by file and title [index-drift]', async () => {
    await run({ yes: true, index: INDEX });
    repo.write('tests/auth.test.ts', `// header\n// more\n${TESTS}`);
    mocked.mockClear();
    mocked.mockResolvedValue({ matches: [] });
    await run({ yes: true, index: INDEX });
    expect(mocked.mock.calls[0][0].prompt).not.toContain('signs in with a valid code');
  });

  // [claims: capabilities/spec-authoring#spec-tag-index-mode]
  it('indexes Java tests in a sibling repo, with a ../ path, using the display name [index-java-sibling]', async () => {
    const other = makeV2Repo();
    {
      other.write('svc/src/test/java/LoginTest.java', 'class LoginTest {\n    @Test\n    @DisplayName("Login works")\n    void login() {}\n}\n');
      const rel = path.relative(repo.dir, path.join(other.dir, 'svc/src/test/java/LoginTest.java')).split(path.sep).join('/');
      expect(rel.startsWith('../')).toBe(true);
      repo.write('specs/capabilities/auth.md', read('specs/capabilities/auth.md').replace('  - "tests/auth.test.ts"\n', `  - "${rel}"\n`));
      mocked.mockResolvedValue({ matches: [hi(0, 'login-valid-code')] });
      await run({ yes: true, index: INDEX });
      expect(read(INDEX)).toBe(`${rel}:4 :: Login works  [claims: capabilities/auth#login-valid-code]\n`);
      expect(readFileSync(path.join(other.dir, 'svc/src/test/java/LoginTest.java'), 'utf8')).not.toContain('claims');
    }
  });
});

