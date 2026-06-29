import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock factories so vi.mock() factories can reference them.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  runStatus: vi.fn(),
  loadConfig: vi.fn(),
  readFile: vi.fn(),
  parseSpecContent: vi.fn(),
  connect: vi.fn(),
  registerTool: vi.fn(),
  appendActivityLog: vi.fn(),
}));

// Mock the MCP SDK transport — we want to confirm connect() is never called.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: mocks.registerTool,
    connect: mocks.connect,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({ type: "stdio" })),
}));

// Mock the core config loader.
vi.mock("../../src/core/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

// Mock the status pipeline (used by specguard_status tool).
vi.mock("../../src/pipelines/status.js", () => ({
  runStatus: mocks.runStatus,
}));

// Mock reader + spec-parser (used by specguard_read_spec tool).
vi.mock("../../src/core/reader.js", () => ({
  readFile: mocks.readFile,
  fileExists: vi.fn().mockResolvedValue(true),
  expandGlobs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/core/spec-parser.js", () => ({
  parseSpecContent: mocks.parseSpecContent,
  loadAllSpecs: vi.fn().mockReturnValue([]),
}));

// Mock activity hook to avoid filesystem writes during tests.
vi.mock("../../src/mcp/activity-hook.js", () => ({
  appendActivityLogEntry: mocks.appendActivityLog,
}));

// Mock writer to avoid filesystem writes.
vi.mock("../../src/core/writer.js", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Stub out all other pipeline imports so the server module loads cleanly.
vi.mock("../../src/pipelines/reverse-generate.js", () => ({ runReverseGenerate: vi.fn() }));
vi.mock("../../src/pipelines/forward-generate.js", () => ({ runForwardGenerate: vi.fn() }));
vi.mock("../../src/pipelines/heal.js", () => ({ runHeal: vi.fn() }));
vi.mock("../../src/pipelines/drift.js", () => ({ runDrift: vi.fn() }));
vi.mock("../../src/pipelines/security.js", () => ({ runSecurity: vi.fn() }));
vi.mock("../../src/pipelines/doc-generate.js", () => ({ runDocGenerate: vi.fn() }));
vi.mock("../../src/pipelines/validate.js", () => ({ runValidate: vi.fn() }));
vi.mock("../../src/pipelines/matrix.js", () => ({ runMatrix: vi.fn() }));
vi.mock("../../src/pipelines/import.js", () => ({ runImport: vi.fn() }));
vi.mock("../../src/pipelines/code-quality.js", () => ({ runCodeQuality: vi.fn() }));
vi.mock("../../src/pipelines/dep-check.js", () => ({ runDepCheck: vi.fn() }));
vi.mock("../../src/pipelines/git-ops.js", () => ({ runGitOps: vi.fn() }));
vi.mock("../../src/pipelines/analyze.js", () => ({ runAnalyze: vi.fn() }));
vi.mock("../../src/pipelines/plan-fix.js", () => ({ runPlanFix: vi.fn() }));

import { buildServer } from "../../src/mcp/server.js";

// ---------------------------------------------------------------------------
// Helper: find a registered tool handler by name.
// ---------------------------------------------------------------------------
function getToolHandler(
  toolName: string,
): ((args: Record<string, unknown>) => Promise<unknown>) | undefined {
  for (const call of mocks.registerTool.mock.calls) {
    if (call[0] === toolName) {
      if (typeof call[2] === "function") return call[2] as (args: Record<string, unknown>) => Promise<unknown>;
      if (call[1] && typeof (call[1] as Record<string, unknown>).handler === "function") {
        return (call[1] as Record<string, unknown>).handler as (args: Record<string, unknown>) => Promise<unknown>;
      }
    }
  }
  return undefined;
}

const FAKE_CONFIG = {
  rootDir: "/fake/root",
  apps: [
    {
      name: "app",
      repo: ".",
      specDir: "specs",
      sources: { api: ["src/**/*.ts"] },
      framework: "vitest",
      testOutput: "tests/",
    },
  ],
  llm: { provider: "anthropic", model: "claude-test", apiKeyEnv: "TEST_KEY" },
  runners: {},
  heal: { maxRetries: 2, testCommand: "npm test" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockResolvedValue(FAKE_CONFIG);
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Module imports without starting transport
  // -------------------------------------------------------------------------
  it("Module imports without starting transport", () => {
    buildServer();

    // Tools should be registered when buildServer() is called.
    expect(mocks.registerTool).toHaveBeenCalled();

    // Transport must NOT be connected (server would hang in test context).
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 2: A pipeline tool returns a formatted result
  // -------------------------------------------------------------------------
  it("A pipeline tool returns a formatted result", async () => {
    const fakePipelineResult = {
      pipeline: "status",
      created: 0,
      updated: 0,
      skipped: 5,
      failed: 1,
      exitCode: 0,
      messages: ["4 of 5 specs passing"],
      items: [],
    };
    mocks.runStatus.mockResolvedValue(fakePipelineResult);

    buildServer();

    const handler = getToolHandler("specguard_status");
    expect(handler, "specguard_status tool should be registered").toBeDefined();

    const result = await handler!({ cwd: "/fake/root" });
    const typedResult = result as { content: Array<{ type: string; text: string }> };

    expect(typedResult).toHaveProperty("content");
    expect(Array.isArray(typedResult.content)).toBe(true);
    expect(typedResult.content.length).toBeGreaterThanOrEqual(1);

    const firstBlock = typedResult.content[0];
    expect(firstBlock.type).toBe("text");

    const text: string = firstBlock.text;
    expect(text).toMatch(/status/i);
    expect(text).toMatch(/passing/i);
    expect(typedResult).not.toHaveProperty("isError", true);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Config missing — tool reports an error
  // -------------------------------------------------------------------------
  it("Config missing — tool reports an error", async () => {
    const { ConfigNotFoundError } = await import("../../src/core/errors.js");
    mocks.loadConfig.mockRejectedValue(
      new ConfigNotFoundError("/fake/root"),
    );

    buildServer();

    const handler = getToolHandler("specguard_status");
    expect(handler, "specguard_status tool should be registered").toBeDefined();

    const result = await handler!({});
    const typedResult = result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(typedResult.isError).toBe(true);
    expect(Array.isArray(typedResult.content)).toBe(true);
    const firstBlock = typedResult.content[0];
    expect(firstBlock.type).toBe("text");
    expect(firstBlock.text).toMatch(/config|not found|\.specguard/i);

    // Server must not have started a transport.
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Utility read_spec returns content + parsed summary
  // -------------------------------------------------------------------------
  it("Utility read_spec returns content + parsed summary", async () => {
    const fakeContent = `# MCP Server\n\n## Overview\nThe MCP server.\n`;
    mocks.readFile.mockResolvedValue(fakeContent);
    mocks.parseSpecContent.mockReturnValue({
      title: "MCP Server",
      specKey: "specguard-core/mcp-server",
      scenarios: [1, 2, 3],
      meta: { type: "core", status: "stable", module: "src/mcp/server.ts" },
      filePath: "/fake/root/specs/mcp-server.md",
      acceptanceCriteria: [],
      securityNotes: [],
      overview: "",
    });

    buildServer();

    const handler = getToolHandler("specguard_read_spec");
    expect(handler, "specguard_read_spec tool should be registered").toBeDefined();

    const result = await handler!({
      path: "specs/mcp-server.md",
      cwd: "/fake/root",
    });

    const typedResult = result as { content: Array<{ type: string; text: string }> };
    expect(typedResult).toHaveProperty("content");
    expect(Array.isArray(typedResult.content)).toBe(true);

    const text: string = typedResult.content[0].text;
    expect(text).toContain("MCP Server");
    expect(text).toMatch(/specguard-core\/mcp-server/);
    expect(text).toMatch(/3|scenario/i);
    expect(typedResult).not.toHaveProperty("isError", true);
  });
});
