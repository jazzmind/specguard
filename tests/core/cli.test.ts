import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock factories so they are available before vi.mock() factories run.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runReverseGenerate: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  expandGlobs: vi.fn(),
}));

// Mock the config loader so tests don't hit the real filesystem for config.
vi.mock("../../src/core/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

// Mock the reverse-generate pipeline (actual module the CLI delegates to).
vi.mock("../../src/pipelines/reverse-generate.js", () => ({
  runReverseGenerate: mocks.runReverseGenerate,
}));

// Mock reader/writer used by the init command.
vi.mock("../../src/core/reader.js", () => ({
  fileExists: mocks.fileExists,
  readFile: mocks.readFile,
  expandGlobs: mocks.expandGlobs,
}));

vi.mock("../../src/core/writer.js", () => ({
  writeFile: mocks.writeFile,
}));

// Import the exported main function (module won't auto-run thanks to isMainModule guard).
import { main } from "../../src/cli/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CONFIG = {
  rootDir: "/fake/root",
  apps: [
    {
      name: "my-app",
      repo: ".",
      specDir: "specs/my-app",
      sources: { api: ["src/**/*.ts"] },
      framework: "vitest",
      testOutput: "tests/",
    },
  ],
  llm: { provider: "anthropic", model: "claude-test", apiKeyEnv: "TEST_KEY" },
  runners: {},
  heal: { maxRetries: 2, testCommand: "npm test" },
};

/**
 * Set process.argv, spy on process.exit, capture stdout/stderr, run main(),
 * then restore everything. The exit spy records the FIRST exit code only so
 * that a second call from main()'s catch block doesn't shadow the real code.
 */
async function runCLI(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const originalArgv = process.argv;
  let exitCode = 0;
  let exitSet = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    if (!exitSet) {
      exitCode = typeof code === "number" ? code : 0;
      exitSet = true;
    }
    throw new Error(`process.exit(${typeof code === "number" ? code : 0})`);
  });

  process.argv = ["node", "specguard", ...args];

  try {
    await main();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("process.exit(")) throw err;
  } finally {
    process.argv = originalArgv;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI Entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expandGlobs.mockResolvedValue([]);
  });

  it("Happy path — specguard reverse runs to completion", async () => {
    mocks.loadConfig.mockResolvedValue(FAKE_CONFIG);
    mocks.runReverseGenerate.mockResolvedValue({
      pipeline: "reverse",
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      exitCode: 0,
      messages: ["[reverse] created specs/my-app/foo.spec.md"],
      items: [],
    });

    const { exitCode } = await runCLI(["reverse", "--app", "my-app"]);

    expect(exitCode).toBe(0);
    expect(mocks.runReverseGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ rootDir: "/fake/root" }),
      expect.objectContaining({ app: "my-app" }),
    );
  });

  it("Config file not found", async () => {
    const { ConfigNotFoundError } = await import("../../src/core/errors.js");
    mocks.loadConfig.mockRejectedValue(
      new ConfigNotFoundError("/fake/root"),
    );

    const { exitCode, stderr } = await runCLI(["reverse", "--app", "my-app"]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no config found/i);
    expect(stderr).toMatch(/specguard init/i);
    expect(mocks.runReverseGenerate).not.toHaveBeenCalled();
  });

  it("init scaffolds correctly", async () => {
    // init command doesn't use loadConfig — it calls fileExists/writeFile directly.
    mocks.fileExists.mockResolvedValue(false);
    mocks.readFile.mockRejectedValue(new Error("not found"));
    mocks.writeFile.mockResolvedValue(undefined);

    const { exitCode } = await runCLI(["init"]);

    expect(exitCode).toBe(0);
    expect(mocks.writeFile).toHaveBeenCalled();
  });

  it("Subcommand --help", async () => {
    const { exitCode, stdout, stderr } = await runCLI(["validate", "--help"]);

    expect(exitCode).toBe(0);
    const allOutput = stdout + stderr;
    expect(allOutput).toMatch(/usage|validate|--/i);
  });
});
