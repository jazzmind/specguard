import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpecGuardConfig, AppConfig } from "../../src/core/types.js";
import type { SecurityOpts, SastResult, SastFinding } from "../../src/pipelines/security.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const makeApp = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  name: "test-app",
  repo: "/repo/test-app",
  specDir: "specs",
  testOutput: "tests",
  ...overrides,
});

const makeConfig = (overrides: Partial<SpecGuardConfig> = {}): SpecGuardConfig => ({
  rootDir: "/workspace",
  apps: [makeApp()],
  llm: {
    provider: "openai",
    model: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted so vitest can intercept imports)
// ---------------------------------------------------------------------------

vi.mock("../../src/core/reader.js", () => ({
  readFile: vi.fn(),
  fileExists: vi.fn(),
}));

vi.mock("../../src/core/writer.js", () => ({
  writeFile: vi.fn(),
}));

vi.mock("../../src/core/spec-parser.js", () => ({
  parseSpecContent: vi.fn(),
  loadAllSpecs: vi.fn(),
  extractSection: vi.fn(),
}));

vi.mock("../../src/core/llm.js", () => ({
  llmGenerateText: vi.fn(),
}));

vi.mock("../../src/adapters/docker.js", () => ({
  runContainer: vi.fn(),
}));

vi.mock("../../src/adapters/npm-audit.js", () => ({
  runNpmAudit: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks are registered)
// ---------------------------------------------------------------------------

const getModules = async () => {
  const security = await import("../../src/pipelines/security.js");
  const reader = await import("../../src/core/reader.js");
  const writer = await import("../../src/core/writer.js");
  const specParser = await import("../../src/core/spec-parser.js");
  const llm = await import("../../src/core/llm.js");
  const docker = await import("../../src/adapters/docker.js");
  const npmAudit = await import("../../src/adapters/npm-audit.js");
  return { security, reader, writer, specParser, llm, docker, npmAudit };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Security Pipeline — security.ts", () => {

  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control
  // -------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("throws SpecGuardError when an unknown app name is supplied via opts.app", async () => {
    const { security } = await getModules();
    const config = makeConfig();
    const opts: SecurityOpts = { spec: "core/spec-parser", app: "nonexistent-app" };

    await expect(security.runSecurity(config, opts)).rejects.toThrow(
      /Unknown app `nonexistent-app`/,
    );
  });

  // OWASP A01: Broken Access Control
  it("restricts spec resolution to the app named in opts.app and does not process other apps", async () => {
    const { security, reader } = await getModules();
    const appA = makeApp({ name: "app-a", specDir: "specs/a" });
    const appB = makeApp({ name: "app-b", specDir: "specs/b" });
    const config = makeConfig({ apps: [appA, appB] });

    vi.mocked(reader.fileExists).mockResolvedValue(false);

    const result = await security.runSecurity(config, { all: true, app: "app-a" });

    // No items should reference app-b
    for (const item of result.items) {
      expect(item.key).not.toMatch(/^app-b\//);
    }
  });

  // OWASP A01: Broken Access Control
  it("does not write security test files outside the tests/security/ directory", async () => {
    const { security, reader, writer, specParser, llm } = await getModules();
    const config = makeConfig();

    vi.mocked(reader.fileExists).mockResolvedValue(true);
    vi.mocked(reader.readFile).mockResolvedValue("# Spec\n## Security Notes\n- note");
    vi.mocked(specParser.parseSpecContent).mockReturnValue({
      title: "Test Spec",
      meta: { module: "src/pipelines/security.ts" },
      securityNotes: "- note",
      filePath: "/workspace/specs/core/spec-parser.md",
    } as any);
    vi.mocked(specParser.extractSection).mockReturnValue("- note");
    vi.mocked(llm.llmGenerateText).mockResolvedValue(
      'import { describe, it, expect } from "vitest";\n',
    );
    vi.mocked(writer.writeFile).mockResolvedValue(undefined);

    await security.runSecurity(config, { spec: "core/spec-parser" });

    const writeCalls = vi.mocked(writer.writeFile).mock.calls;
    for (const [filePath] of writeCalls) {
      expect(filePath).toMatch(/tests[\\/]security[\\/]/);
    }
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("never passes the raw API key value to llmGenerateText — only the env-var name is forwarded", async () => {
    const { security, reader, writer, specParser, llm } = await getModules();
    const config = makeConfig({
      llm: { provider: "openai", model: "gpt-4o", apiKeyEnv: "OPENAI_API_KEY" },
    });

    vi.mocked(reader.fileExists).mockResolvedValue(true);
    vi.mocked(reader.readFile).mockResolvedValue("# Spec\n## Security Notes\n- note");
    vi.mocked(specParser.parseSpecContent).mockReturnValue({
      title: "Test Spec",
      meta: {},
      securityNotes: "- note",
      filePath: "/workspace/specs/core/spec-parser.md",
    } as any);
    vi.mocked(specParser.extractSection).mockReturnValue("- note");
    vi.mocked(llm.llmGenerateText).mockResolvedValue("// stub\n");
    vi.mocked(writer.writeFile).mockResolvedValue(undefined);

    await security.runSecurity(config, { spec: "core/spec-parser" });

    const calls = vi.mocked(llm.llmGenerateText).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [callArgs] of calls) {
      // apiKeyEnv must be the env-var name, not a resolved secret value
      expect(callArgs.apiKeyEnv).toBe("OPENAI_API_KEY");
      // The call args object must not contain a field named `apiKey` with a resolved value
      expect((callArgs as any).apiKey).toBeUndefined();
    }
  });

  // OWASP A02: Cryptographic Failures
  it("does not log the API key value in pipeline result messages", async () => {
    const { security, reader, writer, specParser, llm } = await getModules();
    const fakeSecret = "sk-supersecret-12345";
    process.env["OPENAI_API_KEY"] = fakeSecret;

    const config = makeConfig();

    vi.mocked(reader.fileExists).mockResolvedValue(true);
    vi.mocked(reader.readFile).mockResolvedValue("# Spec\n## Security Notes\n- note");
    vi.mocked(specParser.parseSpecContent).mockReturnValue({
      title: "Test Spec",
      meta: {},
      securityNotes: "- note",
      filePath: "/workspace/specs/core/spec-parser.md",
    } as any);
    vi.mocked(specParser.extractSection).mockReturnValue("- note");
    vi.mocked(llm.llmGenerateText).mockResolvedValue("// stub\n");
    vi.mocked(writer.writeFile).mockResolvedValue(undefined);

    const result = await security.runSecurity(config, { spec: "core/spec-parser" });

    for (const msg of result.messages) {
      expect(msg).not.toContain(fakeSecret);
    }

    delete process.env["OPENAI_API_KEY"];
  });

  // -------------------------------------------------------------------------
  // OWASP A03: Injection
  // -------------------------------------------------------------------------

  // OWASP A03: Injection
  it("SAST seam returns { findings: [], ok: false } when Docker binary is missing (no throw)", async () => {
    const { security } = await getModules();
    const docker = await import("../../src/adapters/docker.js");

    vi.mocked(docker.runContainer).mockRejectedValue(
      new Error("spawn docker ENOENT"),
    );

    const result = await security.sast.run("/some/repo");

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  // OWASP A03: Injection
  it("SAST seam returns { findings: [], ok: false } when Semgrep image is unavailable (no throw)", async () => {
    const { security } = await getModules();
    const docker = await import("../../src/adapters/docker.js");

    vi.mocked(docker.runContainer).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Unable to find image 'semgrep/semgrep:1.78.0'",
      exitCode: 125,
    } as any);

    const result = await security.sast.run("/some/repo");

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  // OWASP A03: Injection
  it("SAST seam does not propagate exceptions from malformed JSON output", async () => {
    const { security } = await getModules();
    const docker = await import("../../src/adapters/docker.js");

    vi.mocked(docker.runContainer).mockResolvedValue({
      ok: true,
      stdout: "NOT_VALID_JSON{{{{",
      stderr: "",
      exitCode: 0,
    } as any);

    const result = await security.sast.run("/some/repo");

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
  });

  // OWASP A03: Injection
  it("SAST seam does not throw when runContainer rejects with a non-Error value", async () => {
    const { security } = await getModules();
    const docker = await import("../../src/adapters/docker.js");

    vi.mocked(docker.runContainer).mockRejectedValue("string rejection");

    await expect(security.sast.run("/some/repo")).resolves.toMatchObject({
      ok: false,
      findings: [],
    });
  });

  // OWASP A03: Injection
  it("pipeline logs SAST unavailability as [warn] and does not throw", async () => {
    const { security, reader, writer, specParser, llm } = await getModules();
    const docker = await import("../../src/adapters/docker.js");

    vi.mocked(docker.runContainer).mockRejectedValue(new Error("docker not found"));
    vi.mocked(reader.fileExists).mockResolvedValue(true);
    vi.mocked(reader.readFile).mockResolvedValue("# Spec\n## Security Notes\n- note");
    vi.mocked(specParser.parseSpecContent).mockReturnValue({
      title: "Test Spec",
      meta: {},
      securityNotes: "- note",
      filePath: "/workspace/specs/core/spec-parser.md",
    } as any);
    vi.mocked(specParser.extractSection).mockReturnValue("- note");
    vi.mocked(llm.llmGenerateText).mockResolvedValue("// stub\n");
    vi.mocked(writer.writeFile).mockResolvedValue(undefined);

    const result = await security.runSecurity(config, {
      spec: "core/spec-parser",
      withSast: true,
    });

    const warnMessages = result.messages.filter((m) => m.startsWith("[warn]"));
    expect(warnMessages.some((m) => /SAST unavailable/i.test(m))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration
  // -------------------------------------------------------------------------

  // OWASP A05: Security Misconfiguration
  it("throws SpecGuardError when neither --spec nor --all is provided", async () => {
    const { security } = await getModules();
    const config = makeConfig();

    await expect(security.runSecurity(config, {})).rejects.toThrow(
      /Nothing to do/,
    );
  });

  // OWASP A05: Security Misconfiguration
  it("exits with ExitCode.SecurityIssues (5) when --with-sast is set and real findings exist", async () => {
    const { security, reader, writer, specParser, llm } = await getModules();
    const docker = await import("../../src/adapters/docker.js");
    const npmAudit = await import("../../src/adapters/npm-audit.js");

    const finding: SastFinding = {
      ruleId: "semgrep.injection",
      path: "src/foo.ts",
      line: 42,
      message: "Potential injection",
      severity: "ERROR",
    };

    vi.mocked(docker.runContainer).mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        results: [
          {
            check_id: finding.ruleId,
            path: finding.path,
            start: { line: finding.line },
            extra: { message: finding.message, severity: finding.severity },
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
    } as any);

    vi.mocked(npmAudit.runNpmAudit).mockResolvedValue({ ok: true, findings: [] } as any);
    vi.mocked(reader.fileExists).mockResolvedValue(true);
    vi.mocked(reader.readFile).mockResolvedValue("# Spec\n## Security Notes\n- note");
    vi.mocked(specParser.parseSpecContent).mockReturnValue({
      title: "Test Spec",
      meta: {},
      securityNotes: "- note",
      filePath: "/workspace/specs/core/spec-parser.md",
    } as any);
    vi.mocked(specParser.extractSection).mockReturnValue("- note");
    vi.mocked(llm.llmGenerateText).mockResolvedValue("// stub\n");
    vi.mocked(writer.writeFile).mockResolvedValue(undefined);

    const result = await security.runSecurity(makeConfig(), {
      spec: "core/spec-parser",
      withSast: true,
    });

    expect(result.exitCode).toBe(5); // ExitCode.SecurityIssues
  });

  // OWASP A05: Security Misconfiguration
  it("exits with ExitCode 0 (success) when stubs are generated and --with-sast is not set
