import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

vi.mock("../core/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../core/reader.js", () => ({
  readFile: vi.fn(),
}));

vi.mock("../core/writer.js", () => ({
  writeFile: vi.fn(),
}));

vi.mock("../core/spec-parser.js", () => ({
  parseSpecContent: vi.fn(),
}));

vi.mock("../pipelines/reverse-generate.js", () => ({ runReverseGenerate: vi.fn() }));
vi.mock("../pipelines/forward-generate.js", () => ({ runForwardGenerate: vi.fn() }));
vi.mock("../pipelines/heal.js", () => ({ runHeal: vi.fn() }));
vi.mock("../pipelines/status.js", () => ({ runStatus: vi.fn() }));
vi.mock("../pipelines/drift.js", () => ({ runDrift: vi.fn() }));
vi.mock("../pipelines/security.js", () => ({ runSecurity: vi.fn() }));
vi.mock("../pipelines/doc-generate.js", () => ({ runDocGenerate: vi.fn() }));
vi.mock("../pipelines/validate.js", () => ({ runValidate: vi.fn() }));
vi.mock("../pipelines/matrix.js", () => ({ runMatrix: vi.fn() }));
vi.mock("../pipelines/import.js", () => ({ runImport: vi.fn() }));
vi.mock("../pipelines/code-quality.js", () => ({ runCodeQuality: vi.fn() }));
vi.mock("../pipelines/dep-check.js", () => ({ runDepCheck: vi.fn() }));
vi.mock("../pipelines/git-ops.js", () => ({ runGitOps: vi.fn() }));
vi.mock("../mcp/activity-hook.js", () => ({ appendActivityLogEntry: vi.fn() }));
vi.mock("../mcp/format.js", async () => {
  const actual = await vi.importActual<typeof import("../mcp/format.js")>("../mcp/format.js");
  return actual;
});

import { loadConfig } from "../core/config.js";
import { readFile } from "../core/reader.js";
import { writeFile } from "../core/writer.js";
import { parseSpecContent } from "../core/spec-parser.js";
import { runReverseGenerate } from "../pipelines/reverse-generate.js";
import { runForwardGenerate } from "../pipelines/forward-generate.js";
import { runHeal } from "../pipelines/heal.js";
import { runStatus } from "../pipelines/status.js";
import { runDrift } from "../pipelines/drift.js";
import { runSecurity } from "../pipelines/security.js";
import { runDocGenerate } from "../pipelines/doc-generate.js";
import { runValidate } from "../pipelines/validate.js";
import { runMatrix } from "../pipelines/matrix.js";
import { runImport } from "../pipelines/import.js";
import { runCodeQuality } from "../pipelines/code-quality.js";
import { runDepCheck } from "../pipelines/dep-check.js";
import { runGitOps } from "../pipelines/git-ops.js";
import { buildServer } from "../mcp/server.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const FAKE_API_KEY = "sk-super-secret-key-12345";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    rootDir: "/project",
    llm: { apiKeyEnv: "LLM_API_KEY", model: "gpt-4o" },
    apps: [{ name: "myapp", specDir: "specs", srcDir: "src" }],
    ...overrides,
  };
}

function makePipelineResult(messages: string[] = ["ok"]) {
  return { messages, counts: { pass: 1, fail: 0, skip: 0 } };
}

function getToolHandler(server: ReturnType<typeof buildServer>, toolName: string) {
  // Access the internal tool registry via the registered tools map exposed by
  // the MCP SDK's McpServer. We reach into the private _registeredTools map
  // that the SDK maintains.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Map<string, { handler: (args: unknown) => unknown }> = (server as any)
    ._registeredTools;
  const tool = tools?.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not found on server`);
  return tool.handler;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MCP Server – security tests", () => {
  let server: ReturnType<typeof buildServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env["LLM_API_KEY"] = FAKE_API_KEY;
    vi.mocked(loadConfig).mockResolvedValue(makeConfig() as never);
    vi.mocked(runReverseGenerate).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runForwardGenerate).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runHeal).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runStatus).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runDrift).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runSecurity).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runDocGenerate).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runValidate).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runMatrix).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runImport).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runCodeQuality).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runDepCheck).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(runGitOps).mockResolvedValue(makePipelineResult() as never);
    vi.mocked(readFile).mockResolvedValue("# Spec\n## Scenarios\n" as never);
    vi.mocked(parseSpecContent).mockReturnValue({
      title: "Spec",
      specKey: "core/spec",
      meta: {},
      scenarios: [],
    } as never);
    vi.mocked(writeFile).mockResolvedValue(undefined as never);
    server = buildServer();
  });

  afterEach(() => {
    delete process.env["LLM_API_KEY"];
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures – API key must never appear in tool output
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("specguard_reverse tool result does not contain the LLM API key value", async () => {
    const handler = getToolHandler(server, "specguard_reverse");
    const result = await (handler as Function)({ app: "myapp" });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_API_KEY);
  });

  // OWASP A02: Cryptographic Failures
  it("specguard_generate tool result does not contain the LLM API key value", async () => {
    const handler = getToolHandler(server, "specguard_generate");
    const result = await (handler as Function)({ all: true });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_API_KEY);
  });

  // OWASP A02: Cryptographic Failures
  it("specguard_heal tool result does not contain the LLM API key value", async () => {
    const handler = getToolHandler(server, "specguard_heal");
    const result = await (handler as Function)({ all: true });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_API_KEY);
  });

  // OWASP A02: Cryptographic Failures
  it("specguard_status tool result does not contain the LLM API key value", async () => {
    const handler = getToolHandler(server, "specguard_status");
    const result = await (handler as Function)({});
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_API_KEY);
  });

  // OWASP A02: Cryptographic Failures
  it("specguard_security tool result does not contain the LLM API key value", async () => {
    const handler = getToolHandler(server, "specguard_security");
    const result = await (handler as Function)({ all: true });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_API_KEY);
  });

  // OWASP A02: Cryptographic Failures
  it("specguard_read_spec tool result does not contain the LLM API key value even when key appears in spec content", async () => {
    vi.mocked(readFile).mockResolvedValue(`# Spec\nkey: ${FAKE_API_KEY}\n` as never);
    const handler = getToolHandler(server, "specguard_read_spec");
    const result = await (handler as Function)({ path: "/project/specs/core/spec.md" });
    // The raw content IS returned (by design), but we assert the key was not
    // injected by the server itself (i.e. it only appears if the file contained it).
    // The important invariant: the server does not independently inject the env key.
    const serialised = JSON.stringify(result);
    // Count occurrences – should be at most the number of times readFile returned it.
    const occurrences = (serialised.match(new RegExp(FAKE_API_KEY, "g")) ?? []).length;
    // readFile mock returns the key once; the server must not add extra occurrences.
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  // OWASP A02: Cryptographic Failures
  it("error results from pipeline failures do not echo the LLM API key", async () => {
    vi.mocked(runStatus).mockRejectedValue(new Error(`auth failed: ${FAKE_API_KEY}`));
    const handler = getToolHandler(server, "specguard_status");
    const result = await (handler as Function)({});
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_API_KEY);
  });

  // OWASP A02: Cryptographic Failures
  it("tool result contains only PipelineResult data (messages/counts), not raw config", async () => {
    const handler = getToolHandler(server, "specguard_reverse");
    const result = await (handler as Function)({ app: "myapp" });
    const serialised = JSON.stringify(result);
    // Config internals like apiKeyEnv name must not leak into results
    expect(serialised).not.toContain("apiKeyEnv");
    expect(serialised).not.toContain("llm");
  });

  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control – path traversal via cwd / path inputs
  // -------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("specguard_write_spec resolves path relative to cwd and calls writeFile with the resolved absolute path", async () => {
    const handler = getToolHandler(server, "specguard_write_spec");
    await (handler as Function)({
      path: "specs/new-spec.md",
      content: "# New",
      cwd: "/project",
    });
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      "/project/specs/new-spec.md",
      "# New",
    );
  });

  // OWASP A01: Broken Access Control
  it("specguard_write_spec with a path-traversal sequence resolves to an absolute path (no sandbox bypass detection)", async () => {
    // The spec acknowledges no sandboxing; this test documents the behaviour:
    // path.resolve must be called so the final path is absolute and deterministic.
    const handler = getToolHandler(server, "specguard_write_spec");
    await (handler as Function)({
      path: "../../etc/passwd",
      content: "evil",
      cwd: "/project/sub",
    });
    const calledWith = vi.mocked(writeFile).mock.calls[0]?.[0] as string;
    // Must be an absolute path (path.resolve was applied)
    expect(calledWith).toMatch(/^\//);
    // Must resolve to the traversed absolute path, not a relative one
    expect(calledWith).toBe("/etc/passwd");
  });

  // OWASP A01: Broken Access Control
  it("specguard_read_spec with a path-traversal sequence resolves to an absolute path", async () => {
    const handler = getToolHandler(server, "specguard_read_spec");
    await (handler as Function)({
      path: "../../etc/shadow",
      cwd: "/project/sub",
    });
    const calledWith = vi.mocked(readFile).mock.calls[0]?.[0] as string;
    expect(calledWith).toMatch(/^\//);
    expect(calledWith).toBe("/etc/shadow");
  });

  // OWASP A01: Broken Access Control
  it("specguard_read_spec resolves specKey paths under the configured specDir, not arbitrary filesystem roots", async () => {
    const handler = getToolHandler(server, "specguard_read_spec");
    await (handler as Function)({ specKey: "core/spec-parser", cwd: "/project" });
    const calledWith = vi.mocked(readFile).mock.calls[0]?.[0] as string;
    // Must be rooted under the app's specDir
    expect(calledWith).toContain("specs");
    expect(calledWith).toContain("core/spec-parser.md");
  });

  // OWASP A01: Broken Access Control
  it("specguard_read_spec returns an error result when no apps are configured (no specKey resolution possible)", async () => {
    vi.mocked(loadConfig).mockResolvedValue(makeConfig({ apps: [] }) as never);
    const handler = getToolHandler(server, "specguard_read_spec");
    const result = await (handler as Function)({ specKey: "core/spec-parser", cwd: "/project" });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  // OWASP A01: Broken Access Control
  it("specguard_read_spec returns an error result when neither specKey nor path is provided", async () => {
    const handler = getToolHandler(server, "specguard_read_spec");
    const result = await (handler as Function)({ cwd: "/project" });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // OWASP A05: Security Misconfiguration – cwd resolution
  // -------------------------------------------------------------------------

  // OWASP A05: Security Misconfiguration
  it("resolveCwd falls back to process.cwd() when cwd is undefined", async () => {
    const handler = getToolHandler(server, "specguard_status");
    await (handler as Function)({});
    expect(vi.mocked(loadConfig)).toHaveBeenCalledWith(
