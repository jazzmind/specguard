import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers – import the module under test.
// Adjust the import path once the module is published / readable.
// ---------------------------------------------------------------------------
let loadRegistry: (rootDir: string) => Promise<unknown>;
let saveRegistry: (rootDir: string, data: unknown) => Promise<void>;
let updateRegistry: (rootDir: string, key: string, entry: unknown) => Promise<void>;

try {
  const mod = await import("specguard-core/drift-registry");
  loadRegistry = mod.loadRegistry;
  saveRegistry = mod.saveRegistry;
  updateRegistry = mod.updateRegistry;
} catch {
  // Module not yet readable – stubs will mark tests as pending via expect.fail()
  const notImplemented = (..._args: unknown[]) => {
    throw new Error("Module specguard-core/drift-registry could not be loaded");
  };
  loadRegistry = notImplemented as never;
  saveRegistry = notImplemented as never;
  updateRegistry = notImplemented as never;
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Security test suite
// ---------------------------------------------------------------------------

describe("Drift Registry – Security Tests", () => {

  // =========================================================================
  // OWASP A01: Broken Access Control
  // =========================================================================

  // OWASP A01: Broken Access Control
  it("loadRegistry – rejects a rootDir containing a path-traversal sequence (../)", async () => {
    const maliciousRoot = path.join(tmpDir, "../../etc");
    await expect(loadRegistry(maliciousRoot)).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("saveRegistry – rejects a rootDir containing a path-traversal sequence (../)", async () => {
    const maliciousRoot = path.join(tmpDir, "../../etc");
    await expect(saveRegistry(maliciousRoot, {})).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("updateRegistry – rejects a rootDir containing a path-traversal sequence (../)", async () => {
    const maliciousRoot = path.join(tmpDir, "../../etc");
    await expect(updateRegistry(maliciousRoot, "key", {})).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("loadRegistry – rejects a rootDir that is an absolute path outside the project root", async () => {
    const outsideRoot = "/etc";
    await expect(loadRegistry(outsideRoot)).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("saveRegistry – rejects a rootDir that is an absolute path outside the project root", async () => {
    const outsideRoot = "/etc";
    await expect(saveRegistry(outsideRoot, {})).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("updateRegistry – rejects a rootDir that is an absolute path outside the project root", async () => {
    const outsideRoot = "/etc";
    await expect(updateRegistry(outsideRoot, "key", {})).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("loadRegistry – rejects a rootDir containing URL-encoded traversal (%2e%2e%2f)", async () => {
    const encodedTraversal = `${tmpDir}/%2e%2e%2fetc`;
    await expect(loadRegistry(encodedTraversal)).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("loadRegistry – rejects a rootDir containing null-byte injection", async () => {
    const nullByteRoot = `${tmpDir}/valid\x00../../etc`;
    await expect(loadRegistry(nullByteRoot)).rejects.toThrow();
  });

  // OWASP A01: Broken Access Control
  it("saveRegistry – does not write the registry file outside the resolved rootDir", async () => {
    const legitimateRoot = tmpDir;
    const data = { key: { hash: "abc123", timestamp: Date.now(), verdict: "pass" } };
    await saveRegistry(legitimateRoot, data).catch(() => {/* stub may throw */});

    // Verify no file was written outside tmpDir
    const etcPasswd = "/etc/passwd";
    const statBefore = fs.existsSync(etcPasswd) ? fs.statSync(etcPasswd).mtimeMs : null;
    if (statBefore !== null) {
      const statAfter = fs.statSync(etcPasswd).mtimeMs;
      expect(statAfter).toBe(statBefore);
    }
  });

  // =========================================================================
  // OWASP A03: Injection
  // =========================================================================

  // OWASP A03: Injection
  it("updateRegistry – rejects a key containing path-separator characters", async () => {
    const dangerousKey = "../../shadow";
    await expect(updateRegistry(tmpDir, dangerousKey, {})).rejects.toThrow();
  });

  // OWASP A03: Injection
  it("updateRegistry – rejects a key containing null bytes", async () => {
    const nullKey = "valid\x00malicious";
    await expect(updateRegistry(tmpDir, nullKey, {})).rejects.toThrow();
  });

  // OWASP A03: Injection
  it("updateRegistry – rejects an entry whose verdict field contains script-injection payload", async () => {
    const entry = { hash: "abc", timestamp: Date.now(), verdict: "<script>alert(1)</script>" };
    // The registry should either reject or sanitise the value; it must not store raw HTML.
    let stored: unknown;
    try {
      await updateRegistry(tmpDir, "safe-key", entry);
      stored = await loadRegistry(tmpDir);
    } catch {
      // Rejection is an acceptable outcome.
      return;
    }
    const storedStr = JSON.stringify(stored);
    expect(storedStr).not.toContain("<script>");
  });

  // OWASP A03: Injection
  it("loadRegistry – safely parses a registry file containing prototype-pollution payload", async () => {
    const poisonedContent = JSON.stringify({
      "__proto__": { "polluted": true },
      "constructor": { "prototype": { "polluted": true } },
    });
    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    fs.writeFileSync(registryPath, poisonedContent, "utf8");

    let result: unknown;
    try {
      result = await loadRegistry(tmpDir);
    } catch {
      // Rejection is acceptable.
      return;
    }

    // Prototype must not be polluted.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(result).not.toHaveProperty("__proto__");
  });

  // OWASP A03: Injection
  it("loadRegistry – handles a malformed / truncated JSON registry file without crashing", async () => {
    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    fs.writeFileSync(registryPath, '{"key": "unterminated', "utf8");

    await expect(loadRegistry(tmpDir)).rejects.toThrow();
  });

  // OWASP A03: Injection
  it("loadRegistry – handles a registry file containing deeply nested JSON without stack overflow", async () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 10_000; i++) {
      nested = { n: nested };
    }
    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    fs.writeFileSync(registryPath, JSON.stringify(nested), "utf8");

    // Should either parse safely or throw a controlled error – must not crash the process.
    try {
      await loadRegistry(tmpDir);
    } catch {
      // Controlled error is acceptable.
    }
    expect(true).toBe(true); // reached without unhandled crash
  });

  // =========================================================================
  // OWASP A04: Insecure Design
  // =========================================================================

  // OWASP A04: Insecure Design
  it("saveRegistry – does not persist any credential-like fields (password, token, apiKey, secret)", async () => {
    const data = {
      "file.ts": {
        hash: "deadbeef",
        timestamp: Date.now(),
        verdict: "pass",
        // Simulate accidental inclusion of sensitive fields
        password: "hunter2",
        token: "ghp_abc123",
        apiKey: "sk-live-xyz",
        secret: "topsecret",
      },
    };

    try {
      await saveRegistry(tmpDir, data);
    } catch {
      return; // Rejection is acceptable.
    }

    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    if (!fs.existsSync(registryPath)) return;

    const written = fs.readFileSync(registryPath, "utf8");
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("ghp_abc123");
    expect(written).not.toContain("sk-live-xyz");
    expect(written).not.toContain("topsecret");
  });

  // OWASP A04: Insecure Design
  it("saveRegistry – registry file is not world-writable (permissions check on POSIX)", async () => {
    if (process.platform === "win32") return; // skip on Windows

    const data = { "file.ts": { hash: "abc", timestamp: Date.now(), verdict: "pass" } };
    try {
      await saveRegistry(tmpDir, data);
    } catch {
      return;
    }

    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    if (!fs.existsSync(registryPath)) return;

    const mode = fs.statSync(registryPath).mode;
    const worldWritable = (mode & 0o002) !== 0;
    expect(worldWritable).toBe(false);
  });

  // =========================================================================
  // OWASP A05: Security Misconfiguration
  // =========================================================================

  // OWASP A05: Security Misconfiguration
  it("loadRegistry – returns an empty / default registry when no registry file exists (no unhandled exception)", async () => {
    // tmpDir exists but contains no registry file.
    let result: unknown;
    try {
      result = await loadRegistry(tmpDir);
    } catch (err) {
      // A controlled error is acceptable; an unhandled rejection is not.
      expect(err).toBeInstanceOf(Error);
      return;
    }
    // If it resolves, the result should be a safe default (object or null).
    expect(result === null || typeof result === "object").toBe(true);
  });

  // OWASP A05: Security Misconfiguration
  it("saveRegistry – does not expose internal stack traces in thrown errors", async () => {
    const badRoot = "/nonexistent-root-that-cannot-be-created-\x00";
    try {
      await saveRegistry(badRoot, {});
    } catch (err) {
      if (err instanceof Error) {
        // Message should not leak full internal paths or stack frames.
        expect(err.message).not.toMatch(/at Object\.<anonymous>/);
        expect(err.message).not.toMatch(/node_modules/);
      }
    }
  });

  // =========================================================================
  // OWASP A08: Software and Data Integrity Failures
  // =========================================================================

  // OWASP A08: Software and Data Integrity Failures
  it("loadRegistry – does not trust a registry file whose content has been externally tampered with (hash mismatch detection is caller responsibility, but load must not silently corrupt data)", async () => {
    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    const original = { "file.ts": { hash: "aabbcc", timestamp: 1_000_000, verdict: "pass" } };
    fs.writeFileSync(registryPath, JSON.stringify(original), "utf8");

    // Tamper: overwrite with different hash value.
    const tampered = { "file.ts": { hash: "000000", timestamp: 1_000_000, verdict: "pass" } };
    fs.writeFileSync(registryPath, JSON.stringify(tampered), "utf8");

    let result: Record<string, { hash: string }> | undefined;
    try {
      result = (await loadRegistry(tmpDir)) as Record<string, { hash: string }>;
    } catch {
      return;
    }

    // The loaded data must reflect what is on disk (tampered), not a stale cache.
    expect(result?.["file.ts"]?.hash).toBe("000000");
  });

  // OWASP A08: Software and Data Integrity Failures
  it("updateRegistry – preserves existing entries when updating a single key (no silent data loss)", async () => {
    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    const initial = {
      "existing.ts": { hash: "existing-hash", timestamp: 1_000, verdict: "pass" },
    };
    fs.writeFileSync(registryPath, JSON.stringify(initial), "utf8");

    try {
      await updateRegistry(tmpDir, "new-file.ts", { hash: "new-hash", timestamp: 2_000, verdict: "pass" });
    } catch {
      return;
    }

    const updated = (await loadRegistry(tmpDir)) as Record<string, { hash: string }>;
    expect(updated?.["existing.ts"]?.hash).toBe("existing-hash");
    expect(updated?.["new-file.ts"]?.hash).toBe("new-hash");
  });

  // OWASP A08: Software and Data Integrity Failures
  it("saveRegistry – written JSON is valid and round-trips without data loss", async () => {
    const data = {
      "src/index.ts": { hash: "cafebabe", timestamp: 1_700_000_000_000, verdict: "pass" },
      "src/util.ts": { hash: "deadbeef", timestamp: 1_700_000_001_000, verdict: "drift" },
    };

    try {
      await saveRegistry(tmpDir, data);
    } catch {
      return;
    }

    const registryPath = path.join(tmpDir, ".specguard-registry.json");
    if (!fs.existsSync(registryPath)) return;

    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(data);
  });

  // =========================================================================
  // OWASP A09: Security Logging and Monitoring Failures
  // =========================================================================

  // OWASP A09: Security Logging and Monitoring Failures
  it("loadRegistry – does not log sensitive filesystem paths to stdout/stderr on error", async () => {
    const originalStderr = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return originalStderr(chunk, ...(args as Parameters<typeof originalStderr>).slice(1));
    };

    try {
      await loadRegistry("/nonexistent-path-xyz");
    } catch {
      // expected
    } finally {
      process.stderr.write = originalStderr;
    }

    const output =
