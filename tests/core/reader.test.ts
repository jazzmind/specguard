import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, fileExists, expandGlobs } from "specguard-core/reader";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "specguard-reader-test-"));
}

async function removeTempDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe("SpecGuard Core – File Reader Abstraction", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it("Reading an existing UTF-8 file", async () => {
    const filePath = path.join(tempDir, "hello.txt");
    await fsp.writeFile(filePath, "hello world", "utf-8");

    const result = await readFile(filePath);

    expect(result).toBe("hello world");
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it("Reading a non-existent file", async () => {
    const filePath = path.join(tempDir, "does-not-exist.txt");

    let caught: unknown = null;
    let resolved: unknown = undefined;

    try {
      resolved = await readFile(filePath);
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(resolved).toBeUndefined();
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it("Checking existence of an accessible path", async () => {
    const filePath = path.join(tempDir, "exists.txt");
    await fsp.writeFile(filePath, "content", "utf-8");

    const result = await fileExists(filePath);

    expect(result).toBe(true);
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it("Checking existence of a missing or inaccessible path", async () => {
    const filePath = path.join(tempDir, "missing.txt");

    const result = await fileExists(filePath);

    expect(result).toBe(false);
  });

  it("Expanding an empty patterns array", async () => {
    const result = await expandGlobs([], "/some/base/dir");

    expect(result).toEqual([]);
  });

  // [claims: capabilities/platform-foundation#default-glob-excludes]
  it("Expanding glob patterns relative to a base directory", async () => {
    const fileA = path.join(tempDir, "a.ts");
    const fileB = path.join(tempDir, "b.ts");
    const subDir = path.join(tempDir, "sub");
    const fileC = path.join(subDir, "c.ts");

    await fsp.writeFile(fileA, "", "utf-8");
    await fsp.writeFile(fileB, "", "utf-8");
    await fsp.mkdir(subDir, { recursive: true });
    await fsp.writeFile(fileC, "", "utf-8");

    const result = await expandGlobs(["**/*.ts"], tempDir);

    expect(result).toContain(fileA);
    expect(result).toContain(fileB);
    expect(result).toContain(fileC);

    for (const p of result) {
      expect(path.isAbsolute(p)).toBe(true);
    }

    const sorted = [...result].sort();
    expect(result).toEqual(sorted);

    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  // [claims: capabilities/platform-foundation#default-glob-excludes]
  it("Deduplication when multiple patterns match the same file", async () => {
    const filePath = path.join(tempDir, "index.ts");
    await fsp.writeFile(filePath, "", "utf-8");

    const result = await expandGlobs(["*.ts", "index.ts"], tempDir);

    const matches = result.filter((p) => p === filePath);
    expect(matches).toHaveLength(1);

    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  // [claims: capabilities/platform-foundation#default-glob-excludes]
  it("Dot-files are excluded from glob results", async () => {
    const hiddenFile = path.join(tempDir, ".hidden.ts");
    const visibleFile = path.join(tempDir, "visible.ts");

    await fsp.writeFile(hiddenFile, "", "utf-8");
    await fsp.writeFile(visibleFile, "", "utf-8");

    const result = await expandGlobs(["**/*.ts"], tempDir);

    expect(result).toContain(visibleFile);
    expect(result).not.toContain(hiddenFile);
  });

  // [claims: capabilities/platform-foundation#default-glob-excludes]
  it("Directories are excluded from glob results", async () => {
    const myDir = path.join(tempDir, "mydir");
    const myFile = path.join(tempDir, "myfile.ts");

    await fsp.mkdir(myDir, { recursive: true });
    await fsp.writeFile(myFile, "", "utf-8");

    const result = await expandGlobs(["**/*"], tempDir);

    expect(result).toContain(myFile);
    expect(result).not.toContain(myDir);
  });
});

describe('default glob ignores [default-ignores]', () => {
  // [claims: capabilities/platform-foundation#default-glob-excludes]
  it('never descends into node_modules, dist or .git [no-node-modules]', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-glob-'));
    for (const rel of ['src/a.test.ts', 'node_modules/zod/b.test.ts', 'packages/x/node_modules/y/c.test.ts', 'dist/d.test.ts', 'lib/build/e.test.ts', 'build/f.test.ts']) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), '');
    }
    const { expandGlobs } = await import('../../src/core/reader.js');
    const hits = (await expandGlobs(['**/*.test.ts'], dir)).map((f) => path.relative(dir, f));
    expect(hits.sort()).toEqual(['lib/build/e.test.ts', 'src/a.test.ts']);
  });
});

describe('parentheses in globs [route-groups]', () => {
  // [claims: capabilities/platform-foundation#glob-literal-parens]
  it('escapes literal parentheses and leaves extglob forms and escapes alone [escape]', async () => {
    const { escapeLiteralParens } = await import('../../src/core/reader.js');
    expect(escapeLiteralParens('app/(authenticated)/page.tsx')).toBe('app/\\(authenticated\\)/page.tsx');
    expect(escapeLiteralParens('src/!(mutations|queries)/**/*.ts')).toBe('src/!(mutations|queries)/**/*.ts');
    // A group holding a `|` is an alternation, not a folder name.
    expect(escapeLiteralParens('src/**/*.(ts|tsx)')).toBe('src/**/*.(ts|tsx)');
    expect(escapeLiteralParens('app/(auth)/**/*.(ts|tsx)')).toBe('app/\\(auth\\)/**/*.(ts|tsx)');
    expect(escapeLiteralParens('a/@(x|y)/(grp)/*.ts')).toBe('a/@(x|y)/\\(grp\\)/*.ts');
    expect(escapeLiteralParens('a/\\(already\\)/b')).toBe('a/\\(already\\)/b');
    expect(escapeLiteralParens('no/parens/here')).toBe('no/parens/here');
  });

  // [claims: capabilities/platform-foundation#glob-literal-parens]
  it('matches a Next.js route-group folder by its real name, and extglobs still work [match]', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { expandGlobs } = await import('../../src/core/reader.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-route-'));
    for (const rel of ['app/(authenticated)/training/page.tsx', 'app/(authenticated)/admin/page.tsx', 'app/login/page.tsx', 'src/mutations/a.ts', 'src/queries/b.ts', 'src/other/c.ts']) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), '');
    }
    const rel = (files: string[]) => files.map((f) => path.relative(dir, f)).sort();
    expect(rel(await expandGlobs(['app/(authenticated)/**/*.tsx'], dir))).toEqual(['app/(authenticated)/admin/page.tsx', 'app/(authenticated)/training/page.tsx']);
    expect(rel(await expandGlobs(['app/(authenticated)/training/page.tsx'], dir))).toEqual(['app/(authenticated)/training/page.tsx']);
    expect(rel(await expandGlobs(['src/!(mutations|queries)/**/*.ts'], dir))).toEqual(['src/other/c.ts']);
  });
});
