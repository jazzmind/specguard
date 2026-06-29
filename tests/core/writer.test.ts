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

  it("Write to a nested path", async () => {
    const nestedPath = path.join(tmpDir, "dir", "a", "b", "c.txt");
    const content = "hello from specguard";

    await writeFile(nestedPath, content);

    const exists = fs.existsSync(path.join(tmpDir, "dir", "a", "b"));
    expect(exists).toBe(true);

    const readBack = fs.readFileSync(nestedPath, "utf-8");
    expect(readBack).toBe(content);
  });

  it("ensureDir is idempotent", async () => {
    const dirPath = path.join(tmpDir, "some", "nested", "dir");

    await ensureDir(dirPath);

    await expect(ensureDir(dirPath)).resolves.not.toThrow();

    expect(fs.existsSync(dirPath)).toBe(true);
  });
});
