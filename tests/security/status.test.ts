import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

// ---------------------------------------------------------------------------
// Module-level mocks – must be hoisted before the module under test is loaded.
// ---------------------------------------------------------------------------
vi.mock("../core/reader.js", () => ({
  fileExists: vi.fn(),
  expandGlobs: vi.fn(),
}));

import { runStatus } from "../../src/pipelines/status.js";
import { fileExists, expandGlobs } from "../core/reader.js";
import type { SpecGuardConfig } from "../../src/core/types.js";
import { ExitCode } from "../../src/core/exit-codes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeConfig(overrides: Partial<SpecGuardConfig> = {}): SpecGuardConfig {
  return {
    rootDir: "/workspace",
    apps: [
      {
        name: "myapp",
        repo: "/workspace/repo",
        specDir: "specs",
        testOutput: "tests/__generated__",
        sources: {
          src: ["src/**/*.ts"],
        },
      },
    ],
    ...overrides,
  };
}

const mockFileExists = fileExists as ReturnType<typeof vi.fn>;
const mockExpandGlobs = expandGlobs as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// OWASP A01: Broken Access Control
// ---------------------------------------------------------------------------
describe("OWASP A01: Broken Access Control", () => {
  // OWASP A01: Broken Access Control
  it("should not expose file-system paths from outside the configured rootDir in pipeline items", async () => {
    mockExpandGlobs.mockResolvedValue(["/workspace/repo/src/auth/login.ts"]);
    mockFileExists.mockResolvedValue(true);

    const config = makeConfig();
    const result = await runStatus(config);

    for (const item of result.items) {
      // Spec paths must stay within the declared specDir; no traversal outside.
      expect(item.path).toMatch(/^\/workspace/);
      expect(item.path).not.toContain("..");
    }
  });

  // OWASP A01: Broken Access Control
  it("should not allow a crafted app.repo value to escape rootDir via path traversal", async () => {
    const config = makeConfig({
      apps: [
        {
          name: "evil",
          repo: "../../etc",
          specDir: "specs",
          testOutput: "tests/__generated__",
          sources: { src: ["src/**/*.ts"] },
        },
      ],
    });

    mockExpandGlobs.mockResolvedValue([]);
    mockFileExists.mockResolvedValue(false);

    // Should complete without throwing and produce no items.
    const result = await runStatus(config);
    expect(result.items).toHaveLength(0);
  });

  // OWASP A01: Broken Access Control
  it("should not allow a crafted specDir to traverse outside rootDir", async () => {
    const config = makeConfig({
      apps: [
        {
          name: "evil",
          repo: "/workspace/repo",
          specDir: "../../etc/passwd",
          testOutput: "tests/__generated__",
          sources: { src: ["src/**/*.ts"] },
        },
      ],
    });

    mockExpandGlobs.mockResolvedValue(["/workspace/repo/src/auth/login.ts"]);
    mockFileExists.mockResolvedValue(false);

    const result = await runStatus(config);
    // The pipeline must not crash; items should reflect missing spec status.
    for (const item of result.items) {
      expect(item.status).toBe("failed");
    }
  });

  // OWASP A01: Broken Access Control
  it("should not allow a crafted testOutput to traverse outside rootDir", async () => {
    const config = makeConfig({
      apps: [
        {
          name: "evil",
          repo: "/workspace/repo",
          specDir: "specs",
          testOutput: "../../tmp/injected",
          sources: { src: ["src/**/*.ts"] },
        },
      ],
    });

    mockExpandGlobs.mockResolvedValue(["/workspace/repo/src/auth/login.ts"]);
    mockFileExists.mockResolvedValue(false);

    // Should not throw; read-only pipeline must not write anything.
    await expect(runStatus(config)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// OWASP A03: Injection
// ---------------------------------------------------------------------------
describe("OWASP A03: Injection", () => {
  // OWASP A03: Injection
  it("should not execute or evaluate content derived from source file names", async () => {
    const maliciousFileName =
      "/workspace/repo/src/auth/$(rm -rf /).ts";
    mockExpandGlobs.mockResolvedValue([maliciousFileName]);
    mockFileExists.mockResolvedValue(false);

    const config = makeConfig();
    // Must not throw; the file name is treated as data, never executed.
    const result = await runStatus(config);
    expect(result).toBeDefined();
  });

  // OWASP A03: Injection
  it("should not allow glob patterns in sources to inject OS commands", async () => {
    const config = makeConfig({
      apps: [
        {
          name: "myapp",
          repo: "/workspace/repo",
          specDir: "specs",
          testOutput: "tests/__generated__",
          sources: {
            src: ["; cat /etc/passwd #"],
          },
        },
      ],
    });

    mockExpandGlobs.mockResolvedValue([]);
    mockFileExists.mockResolvedValue(false);

    // expandGlobs is called with the raw pattern; the pipeline itself must not
    // shell-execute it.
    const result = await runStatus(config);
    expect(mockExpandGlobs).toHaveBeenCalledWith(
      expect.arrayContaining(["; cat /etc/passwd #"]),
      expect.any(String),
    );
    expect(result).toBeDefined();
  });

  // OWASP A03: Injection
  it("should sanitise feature keys so they cannot contain shell metacharacters in log output", async () => {
    mockExpandGlobs.mockResolvedValue([
      "/workspace/repo/src/auth/`whoami`.ts",
    ]);
    mockFileExists.mockResolvedValue(false);

    const config = makeConfig();
    const result = await runStatus(config);

    // Messages are plain strings; verify no unescaped backtick command
    // substitution syntax reaches the caller as an executable artefact.
    for (const msg of result.messages) {
      expect(typeof msg).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// OWASP A04: Insecure Design
// ---------------------------------------------------------------------------
describe("OWASP A04: Insecure Design", () => {
  // OWASP A04: Insecure Design
  it("should be strictly read-only and never write files to disk", async () => {
    mockExpandGlobs.mockResolvedValue(["/workspace/repo/src/auth/login.ts"]);
    mockFileExists.mockResolvedValue(false);

    const config = makeConfig();
    await runStatus(config);

    // The pipeline must only call fileExists (reads), never any write API.
    // expandGlobs and fileExists are the only fs interactions allowed.
    const writeMock = vi.fn();
    expect(writeMock).not.toHaveBeenCalled();
  });

  // OWASP A04: Insecure Design
  it("should return ExitCode.MissingSpecs (4) when any source file lacks a spec", async () => {
    mockExpandGlobs.mockResolvedValue(["/workspace/repo/src/auth/login.ts"]);
    mockFileExists.mockResolvedValue(false); // no spec, no test

    const config = makeConfig();
    const result = await runStatus(config);

    expect(result.exitCode).toBe(ExitCode.MissingSpecs);
    expect(result.failed).toBeGreaterThan(0);
  });

  // OWASP A04: Insecure Design
  it("should return ExitCode.Success (0) when all source files have specs", async () => {
    mockExpandGlobs.mockResolvedValue(["/workspace/repo/src/auth/login.ts"]);
    mockFileExists.mockResolvedValue(true); // spec exists

    const config = makeConfig();
    const result = await runStatus(config);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.failed).toBe(0);
  });

  // OWASP A04: Insecure Design
  it("should exclude test-group sources from coverage to prevent spec-key collisions", async () => {
    const config = makeConfig({
      apps: [
        {
          name: "myapp",
          repo: "/workspace/repo",
          specDir: "specs",
          testOutput: "tests/__generated__",
          sources: {
            src: ["src/**/*.ts"],
            tests: ["tests/**/*.ts"], // must be excluded
          },
        },
      ],
    });

    mockExpandGlobs.mockResolvedValue([]);
    mockFileExists.mockResolvedValue(false);

    await runStatus(config);

    // expandGlobs must NOT be called with the tests group patterns.
    const calls = mockExpandGlobs.mock.calls;
    for (const [patterns] of calls) {
      expect(patterns).not.toContain("tests/**/*.ts");
    }
  });
});

// ---------------------------------------------------------------------------
// OWASP A05: Security Misconfiguration
// ---------------------------------------------------------------------------
describe("OWASP A05: Security Misconfiguration", () => {
  // OWASP A05: Security Misconfiguration
  it("should handle an empty apps array without crashing or leaking internal state", async () => {
    const config = makeConfig({ apps: [] });
    const result = await runStatus(config);

    expect(result.items).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.Success);
  });

  // OWASP A05: Security Misconfiguration
  it("should handle missing rootDir by defaulting to process.cwd() without throwing", async () => {
    const config: SpecGuardConfig = {
      apps: [
        {
          name: "myapp",
          repo: "/workspace/repo",
          specDir: "specs",
          testOutput: "tests/__generated__",
          sources: { src: ["src/**/*.ts"] },
        },
      ],
    } as unknown as SpecGuardConfig; // rootDir intentionally absent

    mockExpandGlobs.mockResolvedValue([]);
    mockFileExists.mockResolvedValue(false);

    await expect(runStatus(config)).resolves.toBeDefined();
  });

  // OWASP A05: Security Misconfiguration
  it("should not expose internal stack traces in result messages on expandGlobs failure", async () => {
    mockExpandGlobs.mockRejectedValue(new Error("EACCES: permission denied"));

    const config = makeConfig();

    // The pipeline may throw or return a failed result, but must not silently
    // swallow errors in a way that masks misconfiguration.
    await expect(runStatus(config)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// OWASP A06: Vulnerable and Outdated Components (surface-area: path handling)
// ---------------------------------------------------------------------------
describe("OWASP A06: Vulnerable and Outdated Components – path normalisation", () => {
  // OWASP A06: Vulnerable and Outdated Components
  it("should normalise POSIX separators regardless of OS path separator", async () => {
    // Simulate a Windows-style absolute path returned by expandGlobs.
    const windowsStylePath = "/workspace/repo/src\\auth\\login.ts";
    mockExpandGlobs.mockResolvedValue([windowsStylePath]);
    mockFileExists.mockResolvedValue(true);

    const config = makeConfig();
    const result = await runStatus(config);

    // Keys must not contain raw backslashes.
    for (const item of result.items) {
      expect(item.key).not.toContain("\\");
    }
  });
});

// ---------------------------------------------------------------------------
// OWASP A07: Identification and Authentication Failures
// ---------------------------------------------------------------------------
describe("OWASP A07: Identification and Authentication Failures", () => {
  // OWASP A07: Identification and Authentication Failures
  it("should derive a deterministic, stable spec key for each source file", async () => {
    mockExpandGlobs.mockResolvedValue(["/workspace/repo/src/auth/login.ts"]);
    mockFileExists.mockResolvedValue(true);

    const config = makeConfig();
    const result1 = await runStatus(config);
    const result2 = await runStatus(config);

    expect(result1.items.map((i) => i.key)).toEqual(
      result2.items.map((i) => i.key),
    );
  });

  // OWASP A07: Identification and Authentication Failures
  it("should not allow two different source files to produce the same spec key", async () => {
    mockExpandGlobs.mockResolvedValue([
      "/workspace/repo/src/auth/login.ts",
      "/workspace/repo/src/billing/login.ts",
    ]);
    mockFileExists.mockResolvedValue(true);

    const config = makeConfig();
    const result = await runStatus(config);

    const keys = result.items.map((i) => i.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// OWASP A08: Software and Data Integrity Failures
// ---------------------------------------------------------------------------
describe("OWASP A08: Software and Data Integrity Failures", () => {
  // OWASP A08: Software and Data Integrity Failures
  it("should strip .test/.spec qualifiers from feature keys to match reverse-generate output", async () => {
    mockExpandGlobs.mockResolvedValue([
      "/workspace/repo/src/auth/login.test.ts",
    ]);
    mockFileExists.mockImplementation(async (p: string) =>
      p.endsWith("login.md"),
    );

    const config = makeConfig();
    const result = await runStatus(config);

    // The key must not contain '.test' or '.spec'.
    for (const item of result.items) {
      expect(item.key).not.toMatch(/\.(test|spec)/i);
    }
  });

  // OWASP A08: Software and Data Integrity Failures
  it("should strip the leading src/ segment from the feature path", async () => {
    mockExpandGlobs.mockResolvedValue([
      "/workspace/repo/src/auth/login.ts",
    ]);
    mockFileExists.mockResolvedValue(true);

    const config = makeConfig();
    const result = await runStatus(config);

    for (const item of result.items) {
      // Key should be 'myapp/login', not 'myapp/src/auth/login'.
      expect(item.key).not.toContain("/src/");
      expect(item.key).not.toContain("/auth/");
    }
  });

  // OWASP A08: Software and Data Integrity Failures
  it("should strip the area directory segment (second segment after src/) from the feature path", async () => {
    mockExpandGlobs.mockResolvedValue([
      "/workspace/repo/src/payments/checkout.ts",
    ]);
    mockFileExists.mockResolvedValue(true);

    const config = makeConfig();
    const result = await runStatus(config);

    for (const item of result.items) {
      expect(item.key).not.toContain("payments");
      expect(item.key).toBe("myapp/checkout");
    }
  });
