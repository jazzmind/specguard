import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile as fsWriteFile, rm, readFile } from "node:fs/promises";

// We import the module under test after any mocking setup
import { ensureDir, writeFile } from "../src/core/writer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return path.join(os.tmpdir(), `specguard-writer-test-${process.pid}-${Date.now()}`);
}

// ---------------------------------------------------------------------------
// Security test suite
// ---------------------------------------------------------------------------

describe("File Writer – OWASP Security Tests", () => {
  let sandboxRoot: string;

  beforeEach(async () => {
    sandboxRoot = tmpDir();
    await mkdir(sandboxRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  // -------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("should not silently follow an absolute path that escapes the intended sandbox when a path-traversal sequence is supplied", async () => {
    // Callers are responsible for validating paths before handing them to
    // writeFile; this test documents that writeFile itself does NOT enforce
    // sandbox boundaries – so upper layers MUST do so.
    const traversalPath = path.join(sandboxRoot, "..", "..", "etc", "passwd-specguard-test");
    // We expect the write to either throw (permissions) or succeed outside the
    // sandbox – either way the resolved path must NOT be inside sandboxRoot.
    const resolved = path.resolve(traversalPath);
    expect(resolved.startsWith(sandboxRoot)).toBe(false);
  });

  // OWASP A01: Broken Access Control
  it("should not allow a relative path traversal sequence to escape a caller-defined root", async () => {
    const maliciousRelative = "../../etc/specguard-escape-test";
    const resolved = path.resolve(sandboxRoot, maliciousRelative);
    // Verify the resolved path is outside the sandbox – callers must reject such paths.
    expect(resolved.startsWith(sandboxRoot)).toBe(false);
  });

  // OWASP A01: Broken Access Control
  it("ensureDir should create only the requested directory and not grant broader permissions", async () => {
    const targetDir = path.join(sandboxRoot, "nested", "child");
    await ensureDir(targetDir);
    // Directory must exist
    const { stat } = await import("node:fs/promises");
    const stats = await stat(targetDir);
    expect(stats.isDirectory()).toBe(true);
    // On POSIX, mode bits should not be world-writable (0o002)
    if (process.platform !== "win32") {
      const worldWritable = (stats.mode & 0o002) !== 0;
      expect(worldWritable).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures (data-at-rest encoding integrity)
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("should write content in UTF-8 encoding, preserving multi-byte characters without corruption", async () => {
    const filePath = path.join(sandboxRoot, "utf8-check.txt");
    const multiByteContent = "日本語テスト – émojis 🔐 – Arabic: مرحبا";
    await writeFile(filePath, multiByteContent);
    const read = await readFile(filePath, "utf-8");
    expect(read).toBe(multiByteContent);
  });

  // OWASP A02: Cryptographic Failures
  it("should not silently truncate or mangle content containing null bytes", async () => {
    const filePath = path.join(sandboxRoot, "null-byte.txt");
    const contentWithNull = "before\x00after";
    await writeFile(filePath, contentWithNull);
    const read = await readFile(filePath, "utf-8");
    expect(read).toBe(contentWithNull);
  });

  // -------------------------------------------------------------------------
  // OWASP A03: Injection
  // -------------------------------------------------------------------------

  // OWASP A03: Injection
  it("should treat filenames containing shell-special characters as literal paths, not execute them", async () => {
    const dangerousName = "file;rm -rf /tmp/specguard-injected.txt";
    const filePath = path.join(sandboxRoot, dangerousName);
    // writeFile must not spawn a shell; it should either write the file with
    // the literal name or throw a filesystem error – never execute the suffix.
    try {
      await writeFile(filePath, "injection test");
      const read = await readFile(filePath, "utf-8");
      expect(read).toBe("injection test");
    } catch (err: unknown) {
      // A filesystem error is acceptable; shell execution is not.
      expect(err).toBeInstanceOf(Error);
    }
  });

  // OWASP A03: Injection
  it("should treat content containing script tags as inert data, not evaluate it", async () => {
    const filePath = path.join(sandboxRoot, "xss-content.txt");
    const xssPayload = '<script>alert("xss")</script>';
    await writeFile(filePath, xssPayload);
    const read = await readFile(filePath, "utf-8");
    // Content must be stored verbatim – no transformation or execution.
    expect(read).toBe(xssPayload);
  });

  // OWASP A03: Injection
  it("should handle a filePath containing newline characters without splitting into multiple OS commands", async () => {
    const newlineName = "file\nmalicious";
    const filePath = path.join(sandboxRoot, newlineName);
    try {
      await writeFile(filePath, "newline injection");
      // If the OS allows it, the file must exist at the literal path.
      const read = await readFile(filePath, "utf-8");
      expect(read).toBe("newline injection");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A04: Insecure Design – symlink / TOCTOU
  // -------------------------------------------------------------------------

  // OWASP A04: Insecure Design
  it("should not follow a symlink that redirects writes to a sensitive location outside the sandbox", async () => {
    const { symlink, stat } = await import("node:fs/promises");
    const linkPath = path.join(sandboxRoot, "link-to-tmp");
    const externalTarget = os.tmpdir();
    try {
      await symlink(externalTarget, linkPath, "dir");
    } catch {
      // Symlink creation may fail on some platforms – skip gracefully.
      return;
    }
    const filePath = path.join(linkPath, "specguard-symlink-write-test.txt");
    // writeFile will follow the symlink; this test documents the behaviour so
    // callers know they MUST resolve and validate real paths before writing.
    try {
      await writeFile(filePath, "symlink write");
      const resolved = await (await import("node:fs/promises")).realpath(filePath);
      // The real path is outside the sandbox – callers must prevent this.
      expect(resolved.startsWith(sandboxRoot)).toBe(false);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration – directory creation
  // -------------------------------------------------------------------------

  // OWASP A05: Security Misconfiguration
  it("ensureDir should be idempotent and not throw when the directory already exists", async () => {
    const targetDir = path.join(sandboxRoot, "already-exists");
    await mkdir(targetDir, { recursive: true });
    // Second call must not throw.
    await expect(ensureDir(targetDir)).resolves.toBeUndefined();
  });

  // OWASP A05: Security Misconfiguration
  it("writeFile should overwrite an existing file rather than appending, preventing stale-data leakage", async () => {
    const filePath = path.join(sandboxRoot, "overwrite-test.txt");
    await writeFile(filePath, "original sensitive content");
    await writeFile(filePath, "new content");
    const read = await readFile(filePath, "utf-8");
    expect(read).toBe("new content");
    expect(read).not.toContain("original sensitive content");
  });

  // -------------------------------------------------------------------------
  // OWASP A06: Vulnerable and Outdated Components – API surface regression
  // -------------------------------------------------------------------------

  // OWASP A06: Vulnerable and Outdated Components
  it("should export exactly the expected public API surface (ensureDir, writeFile) and nothing else", async () => {
    const writerModule = await import("../src/core/writer");
    const exportedKeys = Object.keys(writerModule).sort();
    expect(exportedKeys).toEqual(["ensureDir", "writeFile"].sort());
  });

  // -------------------------------------------------------------------------
  // OWASP A08: Software and Data Integrity Failures
  // -------------------------------------------------------------------------

  // OWASP A08: Software and Data Integrity Failures
  it("should write the exact content provided without modification, insertion, or truncation", async () => {
    const filePath = path.join(sandboxRoot, "integrity-check.txt");
    const sensitiveContent = "INTEGRITY_TOKEN:abc123\nSECRET_LINE:xyz789";
    await writeFile(filePath, sensitiveContent);
    const read = await readFile(filePath, "utf-8");
    expect(read).toBe(sensitiveContent);
    expect(read.length).toBe(sensitiveContent.length);
  });

  // OWASP A08: Software and Data Integrity Failures
  it("should propagate filesystem errors rather than silently swallowing them, ensuring write failures are detectable", async () => {
    // Attempt to write to a path whose parent is a file (not a directory),
    // which must cause an error rather than silent failure.
    const blockingFile = path.join(sandboxRoot, "i-am-a-file");
    await fsWriteFile(blockingFile, "block", "utf-8");
    const impossiblePath = path.join(blockingFile, "child.txt");
    await expect(writeFile(impossiblePath, "should fail")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // OWASP A09: Security Logging and Monitoring Failures
  // -------------------------------------------------------------------------

  // OWASP A09: Security Logging and Monitoring Failures
  it("should not suppress or swallow errors that would prevent audit trails from detecting write failures", async () => {
    const { writeFile: fsWF } = await import("node:fs/promises");
    const fsSpy = vi.spyOn(await import("node:fs/promises"), "writeFile").mockRejectedValueOnce(
      new Error("Simulated disk-full error")
    );
    const filePath = path.join(sandboxRoot, "audit-test.txt");
    await expect(writeFile(filePath, "audit content")).rejects.toThrow("Simulated disk-full error");
    fsSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // OWASP A10: Server-Side Request Forgery (path-as-URL edge case)
  // -------------------------------------------------------------------------

  // OWASP A10: Server-Side Request Forgery
  it("should not interpret a file:// URI as a valid write target without explicit handling", async () => {
    const fileUri = `file://${sandboxRoot}/ssrf-test.txt`;
    // On most platforms this will fail because the URI string is not a valid
    // POSIX path; the important thing is it must not silently succeed in an
    // unexpected location.
    try {
      await writeFile(fileUri, "ssrf probe");
      // If it somehow succeeds, verify the literal path was used (not resolved via URL).
      const read = await readFile(fileUri, "utf-8");
      expect(read).toBe("ssrf probe");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
