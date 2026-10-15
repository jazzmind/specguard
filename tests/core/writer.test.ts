import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, ensureDir } from "src/core/writer.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("File Writer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-writer-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it("Write to a nested path", async () => {
    const nestedPath = path.join(tmpDir, "dir", "a", "b", "c.txt");
    const content = "hello from specguard";

    await writeFile(nestedPath, content);

    const exists = fs.existsSync(path.join(tmpDir, "dir", "a", "b"));
    expect(exists).toBe(true);

    const readBack = fs.readFileSync(nestedPath, "utf-8");
    expect(readBack).toBe(content);
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it("ensureDir is idempotent", async () => {
    const dirPath = path.join(tmpDir, "some", "nested", "dir");

    await ensureDir(dirPath);

    await expect(ensureDir(dirPath)).resolves.not.toThrow();

    expect(fs.existsSync(dirPath)).toBe(true);
  });
});

describe("File Writer atomicity [writer-atomic]", () => {
  // [claims: capabilities/platform-foundation#filesystem-access]
  it("replaces a file without ever exposing a partial write, and leaves no temp files behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-atomic-"));
    try {
      const file = path.join(dir, "plan.json");
      const big = JSON.stringify({ rows: Array.from({ length: 20000 }, (_, i) => ({ i })) });
      await writeFile(file, "{}");
      let torn = 0;
      let writing = true;
      const reader = (async () => {
        while (writing) {
          try {
            JSON.parse(fs.readFileSync(file, "utf-8"));
          } catch {
            torn += 1;
          }
          await new Promise((r) => setImmediate(r));
        }
      })();
      for (let i = 0; i < 20; i += 1) await writeFile(file, i % 2 ? big : "{}");
      writing = false;
      await reader;
      expect(torn).toBe(0);
      expect(fs.readdirSync(dir)).toEqual(["plan.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // [claims: capabilities/platform-foundation#filesystem-access]
  it("cleans up its temp file and keeps the old content when the write fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-atomic-"));
    try {
      const target = path.join(dir, "taken");
      fs.mkdirSync(target);
      await expect(writeFile(target, "x")).rejects.toThrow();
      expect(fs.readdirSync(dir)).toEqual(["taken"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
