/**
 * Pure parser for unified diffs (`git diff -U0 ...` output): which files changed
 * and which new-side lines were added and old-side lines removed. Shared by
 * coverage evidence (changed-line coverage) and the weakening scan (added test
 * source). No I/O; the caller supplies the diff text.
 * Spec: specs/capabilities/test-strength.md
 */

export interface ChangedFile {
  /** new path, repo-relative POSIX; the old path for a deletion */
  file: string;
  oldFile?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** new-side line numbers that were added or changed, sorted unique */
  added: number[];
  /** old-side line numbers removed */
  removed: number[];
  /** added lines with text, for the weakening source scans */
  addedText: Array<{ line: number; text: string }>;
  binary: boolean;
}

interface Draft {
  oldPath?: string;
  newPath?: string;
  headerOld?: string;
  headerNew?: string;
  renameFrom?: string;
  renameTo?: string;
  /** a `+++` line was read, so a further `---` begins another file */
  sawPlus: boolean;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  added: number[];
  removed: number[];
  addedText: Array<{ line: number; text: string }>;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const SIMPLE_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };

/** Decode a git C-quoted path body (the text between the quotes): octal bytes are UTF-8, `\n`, `\"`, `\\` and friends are single characters. */
function decodeQuoted(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-3]/.test(next) && /^[0-7]{3}/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next !== undefined && next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next]!);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Read one path from the start of `text`: a C-quoted token or plain text up to a tab. Returns the path and the rest. */
function readPath(text: string): { path: string; rest: string } {
  if (text.startsWith('"')) {
    let i = 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    return { path: decodeQuoted(text.slice(1, i)), rest: text.slice(i + 1) };
  }
  const tab = text.indexOf('\t');
  return tab < 0 ? { path: text, rest: '' } : { path: text.slice(0, tab), rest: text.slice(tab) };
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/** Split the paths of `diff --git a/x b/y`, which is ambiguous when names hold spaces. */
function parseGitHeader(rest: string): { oldPath: string; newPath: string } | undefined {
  if (rest.startsWith('"')) {
    const first = readPath(rest);
    const second = readPath(first.rest.trimStart());
    return { oldPath: stripPrefix(first.path, 'a/'), newPath: stripPrefix(second.path, 'b/') };
  }
  if (!rest.startsWith('a/')) return undefined;
  const body = rest.slice(2);
  // Unchanged name: `a/X b/X` splits exactly in the middle.
  const mid = (body.length - 3) / 2;
  if (Number.isInteger(mid) && mid > 0 && body.slice(mid, mid + 3) === ' b/' && body.slice(0, mid) === body.slice(mid + 3)) {
    return { oldPath: body.slice(0, mid), newPath: body.slice(mid + 3) };
  }
  const cut = body.indexOf(' b/');
  if (cut < 0) return undefined;
  return { oldPath: body.slice(0, cut), newPath: body.slice(cut + 3) };
}

function newDraft(): Draft {
  return { sawPlus: false, isNew: false, isDeleted: false, binary: false, added: [], removed: [], addedText: [] };
}

function finish(d: Draft): ChangedFile | undefined {
  const renamed = d.renameFrom !== undefined && d.renameTo !== undefined && d.renameFrom !== d.renameTo;
  const oldPath = d.oldPath ?? d.renameFrom ?? d.headerOld;
  const newPath = d.newPath ?? d.renameTo ?? d.headerNew;
  let status: ChangedFile['status'] = 'modified';
  if (d.isNew) status = 'added';
  else if (d.isDeleted) status = 'deleted';
  else if (renamed) status = 'renamed';
  const file = status === 'deleted' ? (oldPath ?? newPath) : (newPath ?? oldPath);
  if (file === undefined) return undefined;
  const out: ChangedFile = {
    file,
    status,
    added: [...new Set(d.added)].sort((a, b) => a - b),
    removed: [...new Set(d.removed)].sort((a, b) => a - b),
    addedText: d.addedText,
    binary: d.binary,
  };
  if (status === 'renamed' && oldPath !== undefined) out.oldFile = oldPath;
  return out;
}

/**
 * Parse unified diff text into one entry per changed file. Tolerates CRLF line
 * endings, `\ No newline at end of file`, omitted hunk counts (one line), C-quoted
 * paths, renames with and without edits, and binary files. Garbage input yields [].
 */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: Draft | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  const flush = (): void => {
    if (!cur) return;
    const f = finish(cur);
    if (f) files.push(f);
    cur = undefined;
  };

  for (const line of text.split(/\r?\n/)) {
    if ((oldLeft > 0 || newLeft > 0) && cur) {
      const tag = line[0];
      if (tag === '\\') continue;
      if (tag === '+' && newLeft > 0) {
        cur.added.push(newNo);
        cur.addedText.push({ line: newNo, text: line.slice(1) });
        newNo += 1;
        newLeft -= 1;
        continue;
      }
      if (tag === '-' && oldLeft > 0) {
        cur.removed.push(oldNo);
        oldNo += 1;
        oldLeft -= 1;
        continue;
      }
      if ((tag === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      // Anything else ends the hunk early (counts were wrong); reprocess the line as a header.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith('diff --git ')) {
      flush();
      cur = newDraft();
      const header = parseGitHeader(line.slice('diff --git '.length));
      if (header) {
        cur.headerOld = header.oldPath;
        cur.headerNew = header.newPath;
      }
      continue;
    }
    // A `---` header after a finished file's `+++` (or with no `diff --git` line) starts a plain-diff file.
    if (line.startsWith('--- ') && (!cur || cur.sawPlus)) {
      flush();
      cur = newDraft();
    }
    if (!cur) continue;

    if (line.startsWith('--- ')) {
      const { path } = readPath(line.slice(4));
      if (path === '/dev/null') cur.isNew = true;
      else cur.oldPath = stripPrefix(path, 'a/');
    } else if (line.startsWith('+++ ')) {
      cur.sawPlus = true;
      const { path } = readPath(line.slice(4));
      if (path === '/dev/null') cur.isDeleted = true;
      else cur.newPath = stripPrefix(path, 'b/');
    } else if (line.startsWith('rename from ')) {
      cur.renameFrom = readPath(line.slice('rename from '.length)).path;
    } else if (line.startsWith('rename to ')) {
      cur.renameTo = readPath(line.slice('rename to '.length)).path;
    } else if (line.startsWith('new file mode')) {
      cur.isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      cur.isDeleted = true;
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
    } else {
      const m = HUNK.exec(line);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[3]);
        oldLeft = m[2] === undefined ? 1 : Number(m[2]);
        newLeft = m[4] === undefined ? 1 : Number(m[4]);
      }
    }
  }
  flush();
  return files;
}
