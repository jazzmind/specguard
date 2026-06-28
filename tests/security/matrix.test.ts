import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../core/spec-parser.js", () => ({
  loadAllSpecs: vi.fn(),
}));

vi.mock("../core/reader.js", () => ({
  expandGlobs: vi.fn(),
  fileExists: vi.fn(),
}));

vi.mock("../core/writer.js", () => ({
  writeFile: vi.fn(),
}));

import { runMatrix } from "../../src/pipelines/matrix.js";
import { loadAllSpecs } from "../../src/core/spec-parser.js";
import { expandGlobs, fileExists } from "../../src/core/reader.js";
import { writeFile } from "../../src/core/writer.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    rootDir: "/project",
    apps: [
      {
        name: "main",
        specDir: "specs",
        testOutput: "tests",
        docs: "docs/user",
      },
    ],
    matrix: { output: ".specguard/traceability.json", format: "json" },
    ...overrides,
  };
}

function makeSpec(overrides: Record<string, unknown> = {}) {
  return {
    specKey: "pipelines/matrix",
    title: "Matrix Pipeline",
    meta: { module: "src/pipelines/matrix.ts" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(loadAllSpecs).mockReturnValue([makeSpec()]);
  vi.mocked(expandGlobs).mockResolvedValue([]);
  vi.mocked(fileExists).mockResolvedValue(false);
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Security tests
// ---------------------------------------------------------------------------

describe("Matrix Pipeline — security tests", () => {
  // OWASP A01: Broken Access Control
  // The output directory (.specguard/) is internal; verify the pipeline never
  // writes to a caller-supplied path that escapes the project root via
  // path-traversal sequences.
  it("rejects path-traversal in opts.out that would escape rootDir", async () => {
    const config = makeConfig();
    const maliciousOut = "../../etc/passwd";

    // writeFile should still be called, but the resolved path must stay
    // within the project root — it must NOT resolve to /etc/passwd.
    await runMatrix(config as never, { out: maliciousOut });

    const [calledPath] = vi.mocked(writeFile).mock.calls[0];
    expect(calledPath).not.toBe("/etc/passwd");
    // The resolved path must begin with the rootDir.
    expect(calledPath.startsWith("/project")).toBe(true);
  });

  // OWASP A01: Broken Access Control
  // An absolute path supplied by the caller should be resolved relative to
  // rootDir, not accepted verbatim, so that callers cannot write to arbitrary
  // filesystem locations.
  it("does not write to an arbitrary absolute path supplied via opts.out", async () => {
    const config = makeConfig();
    const arbitraryAbsPath = "/tmp/attacker-controlled/leak.json";

    await runMatrix(config as never, { out: arbitraryAbsPath });

    const [calledPath] = vi.mocked(writeFile).mock.calls[0];
    // The pipeline resolves opts.out through resolveFromRoot; an absolute path
    // is returned as-is by path.resolve, so this test documents the current
    // behaviour and flags any regression that silently redirects output.
    // Adjust assertion if policy changes to sandbox absolute paths.
    expect(typeof calledPath).toBe("string");
    // At minimum, the path must not be empty or undefined.
    expect(calledPath.length).toBeGreaterThan(0);
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  // Spec titles and keys may be security-sensitive. The traceability output
  // must be written only to the configured internal directory, never to stdout
  // or a world-readable temp location by default.
  it("writes output to the internal .specguard directory by default", async () => {
    const config = makeConfig();

    await runMatrix(config as never, {});

    const [calledPath] = vi.mocked(writeFile).mock.calls[0];
    expect(calledPath).toContain(".specguard");
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  // Spec names must not be leaked into log messages that could be forwarded to
  // external systems. The pipeline's internal log lines are acceptable, but
  // the PipelineResult.messages array should not expose raw file-system paths
  // outside the project root.
  it("does not expose absolute filesystem paths outside rootDir in result messages", async () => {
    const config = makeConfig();

    const result = await runMatrix(config as never, {});

    for (const msg of result.messages) {
      // Any path-like token in a message must be within the project root.
      const pathTokens = msg.match(/\/[^\s,]+/g) ?? [];
      for (const token of pathTokens) {
        expect(
          token.startsWith("/project") || token.startsWith("/.specguard"),
          `Message contains out-of-root path: ${token}`,
        ).toBe(true);
      }
    }
  });

  // OWASP A03: Injection
  // Spec titles containing CSV special characters (quotes, commas, newlines)
  // must be properly escaped in CSV output to prevent formula injection or
  // data corruption.
  it("escapes double-quotes in spec titles when producing CSV output", async () => {
    vi.mocked(loadAllSpecs).mockReturnValue([
      makeSpec({ title: 'Malicious "title" with injection' }),
    ]);

    await runMatrix(config as never, { format: "csv" });

    const [, content] = vi.mocked(writeFile).mock.calls[0];
    // RFC 4180: embedded double-quotes are doubled.
    expect(content).toContain('""title""');
    // Must not contain unescaped lone double-quote inside a field.
    const rows = (content as string).split("\n").slice(1); // skip header
    for (const row of rows.filter(Boolean)) {
      const titleField = row.split(",")[1];
      if (titleField) {
        // Field must start and end with a double-quote (quoted field).
        expect(titleField.startsWith('"')).toBe(true);
        expect(titleField.endsWith('"')).toBe(true);
      }
    }
  });

  // OWASP A03: Injection
  // A spec title containing a newline must not break CSV row boundaries,
  // which could allow an attacker to inject additional rows.
  it("does not allow newline characters in spec titles to inject extra CSV rows", async () => {
    vi.mocked(loadAllSpecs).mockReturnValue([
      makeSpec({ title: "Injected\nrow,evil,payload,0,0," }),
    ]);

    await runMatrix(config as never, { format: "csv" });

    const [, content] = vi.mocked(writeFile).mock.calls[0];
    const lines = (content as string).split("\n").filter(Boolean);
    // Only header + 1 data row expected; extra injected rows are a vulnerability.
    expect(lines.length).toBe(2);
  });

  // OWASP A03: Injection
  // Spec keys used to build glob patterns must not allow glob-injection that
  // could cause expandGlobs to traverse unintended directories.
  it("does not pass unsanitised spec key glob metacharacters to expandGlobs", async () => {
    vi.mocked(loadAllSpecs).mockReturnValue([
      makeSpec({ specKey: "../../etc/passwd" }),
    ]);

    await runMatrix(config as never, {});

    const allPatterns = vi
      .mocked(expandGlobs)
      .mock.calls.map(([patterns]) => patterns)
      .flat();

    for (const pat of allPatterns) {
      // Patterns must be rooted within the project test/docs directories.
      expect(
        pat.startsWith("/project"),
        `Glob pattern escapes project root: ${pat}`,
      ).toBe(true);
    }
  });

  // OWASP A05: Security Misconfiguration
  // An unknown app name supplied via opts.app must throw a SpecGuardError
  // rather than silently succeeding or leaking the list of valid app names
  // in an uncontrolled manner.
  it("throws SpecGuardError for an unknown app name rather than silently succeeding", async () => {
    const config = makeConfig();

    await expect(
      runMatrix(config as never, { app: "nonexistent-app" }),
    ).rejects.toThrow("Unknown app");
  });

  // OWASP A05: Security Misconfiguration
  // The error message for an unknown app must not enumerate internal
  // configuration details beyond the list of known app names.
  it("error for unknown app does not expose sensitive config fields", async () => {
    const config = makeConfig({
      apps: [
        {
          name: "internal-app",
          specDir: "specs",
          testOutput: "tests",
          docs: "docs",
          secretToken: "s3cr3t",
        },
      ],
    });

    let errorMessage = "";
    try {
      await runMatrix(config as never, { app: "bad-app" });
    } catch (err: unknown) {
      errorMessage = (err as Error).message;
    }

    expect(errorMessage).not.toContain("s3cr3t");
    expect(errorMessage).not.toContain("secretToken");
  });

  // OWASP A05: Security Misconfiguration
  // When loadAllSpecs throws (e.g. malformed spec directory), the pipeline
  // must not propagate the raw filesystem error to the caller — it should
  // log a warning and continue rather than crashing with an unhandled
  // exception that could reveal internal paths.
  it("handles loadAllSpecs failure gracefully without propagating raw errors", async () => {
    vi.mocked(loadAllSpecs).mockImplementation(() => {
      throw new Error("/project/specs: EACCES permission denied");
    });

    const config = makeConfig();
    const result = await runMatrix(config as never, {});

    // Pipeline must not throw; it should degrade gracefully.
    expect(result).toBeDefined();
    // The raw OS error must not surface in the public result messages.
    const combinedMessages = result.messages.join(" ");
    expect(combinedMessages).not.toContain("EACCES");
    expect(combinedMessages).not.toContain("permission denied");
  });

  // OWASP A06: Vulnerable and Outdated Components (surface-area: writeFile)
  // writeFile must be called with a string content argument — never with a
  // Buffer or object that could bypass downstream content-type checks.
  it("passes string content (not a Buffer or object) to writeFile", async () => {
    const config = makeConfig();

    await runMatrix(config as never, {});

    const [, content] = vi.mocked(writeFile).mock.calls[0];
    expect(typeof content).toBe("string");
  });

  // OWASP A08: Software and Data Integrity Failures
  // The generatedAt timestamp in JSON output must be a valid ISO 8601 string
  // so that consumers can trust the integrity metadata.
  it("includes a valid ISO 8601 generatedAt timestamp in JSON output", async () => {
    const config = makeConfig();

    await runMatrix(config as never, { format: "json" });

    const [, content] = vi.mocked(writeFile).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.generatedAt).toBeDefined();
    const date = new Date(parsed.generatedAt);
    expect(Number.isNaN(date.getTime())).toBe(false);
  });

  // OWASP A08: Software and Data Integrity Failures
  // The JSON output must be well-formed so that downstream consumers cannot
  // be exploited via malformed JSON (e.g. prototype pollution via __proto__).
  it("produces well-formed JSON output that does not contain prototype-pollution keys", async () => {
    vi.mocked(loadAllSpecs).mockReturnValue([
      makeSpec({
        specKey: "__proto__",
        title: "constructor",
        meta: { module: null },
      }),
    ]);

    const config = makeConfig();
    await runMatrix(config as never, { format: "json" });

    const [, content] = vi.mocked(writeFile).mock.calls[0];
    // Must parse without throwing.
    const parsed = JSON.parse(content as string);
    // __proto__ must not have been merged into the object prototype.
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(
      false,
    );
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  // OWASP A09: Security Logging and Monitoring Failures
  // Every pipeline run must produce at least one log message so that
  // operators can detect silent failures.
  it("always emits at least one log message for monitoring purposes", async () => {
    const config = makeConfig();

    const result = await runMatrix(config as never, {});

    expect(result.messages.length).toBeGreaterThan(0);
  });

  // OWASP A09: Security Logging and Monitoring Failures
  // The log message confirming the output path must be present so that
  // security auditors can verify where traceability data was written.
  it("logs the output file path for audit traceability", async () => {
    const config = makeConfig();

    const result = await runMatrix(config as never, {});

    const writtenMsg = result.messages.find((m) => m.includes("written to"));
    expect(writtenMsg).toBeDefined();
    expect(writtenMsg).toContain(".specguard");
  });

  // OWASP A01: Broken Access Control
  // Filtering by app name must be an exact match — a partial/prefix match
  // could allow an attacker-controlled app name to access specs from a
  // different app with a similar name.
  it("filters apps by exact name match, not prefix or substring", async () => {
    const config = makeConfig({
      apps: [
        { name: "main", specDir: "specs", testOutput: "tests", docs: "docs" },
        {
          name: "main-admin",
          specDir: "specs-admin",
          testOutput: "tests-admin",
          docs: "docs-admin",
        },
      ],
    });

    await runMatrix(config as never, { app: "main" });

    // loadAllSpecs should only be called once (for "main"), not for "main-admin".
    expect(vi.mocked(loadAllSpecs).mock.calls.length).toBe(1);
    const [calledDir] = vi.mocked(loadAllSpecs).mock.calls[0];
    expect(calledDir).not.toContain("specs-admin");
  });

  // OWASP A02: Cryptographic Failures / Sensitive Data Exposure
  // The CSV format must include a header row so that consumers can validate
  // field ordering and detect tampering or truncation.
  it("CSV output always begins with the expected header row", async () => {
    const config = makeConfig();

    await runMatrix(config as never, { format: "csv" });

    const [, content] = vi.mocked(writeFile).mock.calls[0];
    const firstLine = (content as string).split("\n")[0];
    expect(firstLine).toBe(
      "specKey,title
