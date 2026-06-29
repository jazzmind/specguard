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

  it("Reading an existing UTF-8 file", async () => {
    const filePath = path.join(tempDir, "hello.txt");
    await fsp.writeFile(filePath, "hello world", "utf-8");

    const result = await readFile(filePath);

    expect(result).toBe("hello world");
  });

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

  it("Checking existence of an accessible path", async () => {
    const filePath = path.join(tempDir, "exists.txt");
    await fsp.writeFile(filePath, "content", "utf-8");

    const result = await fileExists(filePath);

    expect(result).toBe(true);
  });

  it("Checking existence of a missing or inaccessible path", async () => {
    const filePath = path.join(tempDir, "missing.txt");

    const result = await fileExists(filePath);

    expect(result).toBe(false);
  });

  it("Expanding an empty patterns array", async () => {
    const result = await expandGlobs([], "/some/base/dir");

    expect(result).toEqual([]);
  });

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

  it("Deduplication when multiple patterns match the same file", async () => {
    const filePath = path.join(tempDir, "index.ts");
    await fsp.writeFile(filePath, "", "utf-8");

    const result = await expandGlobs(["*.ts", "index.ts"], tempDir);

    const matches = result.filter((p) => p === filePath);
    expect(matches).toHaveLength(1);

    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  it("Dot-files are excluded from glob results", async () => {
    const hiddenFile = path.join(tempDir, ".hidden.ts");
    const visibleFile = path.join(tempDir, "visible.ts");

    await fsp.writeFile(hiddenFile, "", "utf-8");
    await fsp.writeFile(visibleFile, "", "utf-8");

    const result = await expandGlobs(["**/*.ts"], tempDir);

    expect(result).toContain(visibleFile);
    expect(result).not.toContain(hiddenFile);
  });

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
