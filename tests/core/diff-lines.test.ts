import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from '../../src/core/diff-lines.js';

describe('parseUnifiedDiff', () => {
  // [claims: capabilities/test-strength#diff-parser]
  it('parses a modified file with -U0 hunks and omitted counts', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3,2 @@ function f() {',
      '-old',
      '+new one',
      '+new two',
      '@@ -10,2 +11,0 @@',
      '-gone a',
      '-gone b',
      '',
    ].join('\n');
    const [f] = parseUnifiedDiff(diff);
    expect(f).toEqual({
      file: 'src/a.ts',
      status: 'modified',
      added: [3, 4],
      removed: [3, 10, 11],
      addedText: [
        { line: 3, text: 'new one' },
        { line: 4, text: 'new two' },
      ],
      binary: false,
    });
  });

  // [claims: capabilities/test-strength#diff-parser]
  it('handles added and deleted files with /dev/null', () => {
    const diff = [
      'diff --git a/n.ts b/n.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/n.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      'diff --git a/d.ts b/d.ts',
      'deleted file mode 100644',
      '--- a/d.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.file, f.status, f.added, f.removed])).toEqual([
      ['n.ts', 'added', [1, 2], []],
      ['d.ts', 'deleted', [], [1, 2]],
    ]);
  });

  // [claims: capabilities/test-strength#diff-parser]
  it('handles pure renames and renames with edits', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
      'diff --git a/p.ts b/q.ts',
      'similarity index 80%',
      'rename from p.ts',
      'rename to q.ts',
      '--- a/p.ts',
      '+++ b/q.ts',
      '@@ -2 +2 @@',
      '-a',
      '+b',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files[0]).toMatchObject({ file: 'new.ts', oldFile: 'old.ts', status: 'renamed', added: [] });
    expect(files[1]).toMatchObject({ file: 'q.ts', oldFile: 'p.ts', status: 'renamed', added: [2], removed: [2] });
  });

  // [claims: capabilities/test-strength#diff-parser]
  it('flags binary files', () => {
    const diff = ['diff --git a/i.png b/i.png', 'index 1..2 100644', 'Binary files a/i.png and b/i.png differ'].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: 'i.png', status: 'modified', added: [], removed: [], addedText: [], binary: true },
    ]);
  });

  // [claims: capabilities/test-strength#diff-parser]
  it('ignores "No newline at end of file" markers and strips CRLF', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
    ].join('\r\n');
    const [f] = parseUnifiedDiff(diff);
    expect(f?.added).toEqual([1]);
    expect(f?.removed).toEqual([1]);
    expect(f?.addedText).toEqual([{ line: 1, text: 'b' }]);
  });

  // [claims: capabilities/test-strength#diff-parser]
  it('decodes C-quoted paths and paths with spaces', () => {
    const diff = [
      'diff --git "a/sp\\303\\251c.ts" "b/sp\\303\\251c.ts"',
      '--- "a/sp\\303\\251c.ts"',
      '+++ "b/sp\\303\\251c.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/my dir/f.ts b/my dir/f.ts',
      'Binary files a/my dir/f.ts and b/my dir/f.ts differ',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.file)).toEqual(['spéc.ts', 'my dir/f.ts']);
  });

  // [claims: capabilities/test-strength#diff-parser]
  it('does not mistake removed lines starting with dashes for file headers', () => {
    const diff = [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -4,2 +4,1 @@',
      '--- not a header',
      '-x',
      '+++ not a header either',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.removed).toEqual([4, 5]);
    expect(files[0]?.added).toEqual([4]);
  });

  // [claims: capabilities/test-strength#diff-parser]
  it('parses plain unified diffs without git headers and returns [] for garbage', () => {
    const plain = ['--- a/x.ts\t2020-01-01', '+++ b/x.ts\t2020-01-02', '@@ -1 +1 @@', '-a', '+b', '--- a/y.ts', '+++ b/y.ts', '@@ -1 +1 @@', '-c', '+d'].join('\n');
    expect(parseUnifiedDiff(plain).map((f) => f.file)).toEqual(['x.ts', 'y.ts']);
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('hello\nworld')).toEqual([]);
  });
});
