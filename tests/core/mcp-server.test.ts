import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks – must be declared before any dynamic imports of the module
// ---------------------------------------------------------------------------

const mockRunStatus = vi.fn();
const mockLoadConfig = vi.fn();
const mockReadSpec = vi.fn();
const mockRegisterTool = vi.fn();
const mockConnect = vi.fn();

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  return {
    McpServer: vi.fn().mockImplementation(() => ({
      registerTool: mockRegisterTool,
      connect: mockConnect,
    })),
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  return {
    StdioServerTransport: vi.fn().mockImplementation(() => ({
      type: "stdio",
    })),
  };
});

// Mock pipeline functions
vi.mock("src/pipelines/status.ts", () => ({
  runStatus: mockRunStatus,
}));

vi.mock("src/pipelines/status.js", () => ({
  runStatus: mockRunStatus,
}));

// Mock config loader
vi.mock("src/config/loader.ts", () => ({
  loadConfig: mockLoadConfig,
  ConfigNotFoundError: class ConfigNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ConfigNotFoundError";
    }
  },
}));

vi.mock("src/config/loader.js", () => ({
  loadConfig: mockLoadConfig,
  ConfigNotFoundError: class ConfigNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ConfigNotFoundError";
    }
  },
}));

// Mock spec reader utility
vi.mock("src/utils/readSpec.ts", () => ({
  readSpec: mockReadSpec,
}));

vi.mock("src/utils/readSpec.js", () => ({
  readSpec: mockReadSpec,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds the handler registered for a given tool name by inspecting the calls
 * made to `mockRegisterTool`.
 */
function getToolHandler(toolName: string): ((...args: unknown[]) => unknown) | undefined {
  for (const call of mockRegisterTool.mock.calls) {
    if (call[0] === toolName) {
      // registerTool(name, schema, handler) or registerTool(name, { description, inputSchema, handler })
      if (typeof call[2] === "function") return call[2] as (...args: unknown[]) => unknown;
      if (call[1] && typeof (call[1] as Record<string, unknown>).handler === "function") {
        return (call[1] as Record<string, unknown>).handler as (...args: unknown[]) => unknown;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: loadConfig resolves successfully
    mockLoadConfig.mockResolvedValue({
      specDir: ".specguard",
      outputDir: "dist",
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Module imports without starting transport
  // -------------------------------------------------------------------------
  it("Module imports without starting transport", async () => {
    // Act – import the module; it should NOT call connect() at import time
    // because the bin entry-point guard (`if (require.main === module)` or
    // `if (import.meta.url === …)`) prevents auto-start in test context.
    await import("src/mcp/server.ts");

    // Assert – the module loaded and registered tools
    expect(mockRegisterTool).toHaveBeenCalled();

    // Assert – transport was NOT connected (process would hang otherwise)
    expect(mockConnect).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 2: A pipeline tool returns a formatted result
  // -------------------------------------------------------------------------
  it("A pipeline tool returns a formatted result", async () => {
    // Arrange – set up a realistic PipelineResult from runStatus
    const fakePipelineResult = {
      pipeline: "status",
      counts: { total: 5, passing: 4, failing: 1, pending: 0 },
      message: "4 of 5 specs passing",
      lines: ["spec-a: OK", "spec-b: FAIL"],
      ok: false,
    };
    mockRunStatus.mockResolvedValue(fakePipelineResult);

    // Import module so tools are registered
    await import("src/mcp/server.ts");

    // Find the specguard_status handler
    const handler = getToolHandler("specguard_status");
    expect(handler, "specguard_status tool should be registered").toBeDefined();

    // Act
    const result = await (handler as (args: Record<string, unknown>) => Promise<unknown>)({});

    // Assert – single text content block
    const typedResult = result as { content: Array<{ type: string; text: string }> };
    expect(typedResult).toHaveProperty("content");
    expect(Array.isArray(typedResult.content)).toBe(true);
    expect(typedResult.content.length).toBeGreaterThanOrEqual(1);

    const firstBlock = typedResult.content[0];
    expect(firstBlock.type).toBe("text");

    // Assert – text contains pipeline name, counts, and message lines
    const text: string = firstBlock.text;
    expect(text).toMatch(/status/i);
    expect(text).toMatch(/5|4|1/); // counts
    expect(text).toMatch(/passing|failing/i);

    // Assert – no exception escaped
    expect(typedResult).not.toHaveProperty("isError", true);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Config missing — tool reports an error
  // -------------------------------------------------------------------------
  it("Config missing — tool reports an error", async () => {
    // Arrange – loadConfig throws ConfigNotFoundError
    const { ConfigNotFoundError } = await import("src/config/loader.ts");
    mockLoadConfig.mockRejectedValue(
      new ConfigNotFoundError("No .specguard/config.json found in current directory"),
    );

    // Import module so tools are registered
    await import("src/mcp/server.ts");

    const handler = getToolHandler("specguard_status");
    expect(handler, "specguard_status tool should be registered").toBeDefined();

    // Act
    const result = await (handler as (args: Record<string, unknown>) => Promise<unknown>)({});

    // Assert – isError flag set
    const typedResult = result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(typedResult.isError).toBe(true);

    // Assert – text block describes the failure
    expect(Array.isArray(typedResult.content)).toBe(true);
    const firstBlock = typedResult.content[0];
    expect(firstBlock.type).toBe("text");
    expect(firstBlock.text).toMatch(/config|not found|\.specguard/i);

    // Assert – server stays up: registerTool was called (server object still intact)
    expect(mockRegisterTool).toHaveBeenCalled();
    // connect was never called (server did not crash / exit)
    expect(mockConnect).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Utility read_spec returns content + parsed summary
  // -------------------------------------------------------------------------
  it("Utility read_spec returns content + parsed summary", async () => {
    // Arrange – readSpec returns raw content and a parsed summary
    const fakeSpecContent = `---
specKey: specguard-core/mcp-server
title: MCP Server
---

## Scenario 1: First scenario
## Scenario 2: Second scenario
## Scenario 3: Third scenario
`;
    const fakeSummary = {
      title: "MCP Server",
      specKey: "specguard-core/mcp-server",
      scenarioCount: 3,
    };
    mockReadSpec.mockResolvedValue({
      content: fakeSpecContent,
      summary: fakeSummary,
    });

    // Import module so tools are registered
    await import("src/mcp/server.ts");

    const handler = getToolHandler("specguard_read_spec");
    expect(handler, "specguard_read_spec tool should be registered").toBeDefined();

    // Act
    const result = await (
      handler as (args: Record<string, unknown>) => Promise<unknown>
    )({ path: ".specguard/specs/mcp-server.md" });

    // Assert – content block present
    const typedResult = result as { content: Array<{ type: string; text: string }> };
    expect(typedResult).toHaveProperty("content");
    expect(Array.isArray(typedResult.content)).toBe(true);
    expect(typedResult.content.length).toBeGreaterThanOrEqual(1);

    const text: string = typedResult.content[0].text;

    // Assert – raw file content is included
    expect(text).toContain("MCP Server");

    // Assert – parsed summary fields are present
    expect(text).toMatch(/specguard-core\/mcp-server/);
    expect(text).toMatch(/3|scenario/i);

    // Assert – no error
    expect(typedResult).not.toHaveProperty("isError", true);
  });
});
