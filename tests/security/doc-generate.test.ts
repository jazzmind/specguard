import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

// ---------------------------------------------------------------------------
// Module-level mocks – must be declared before importing the module under test
// ---------------------------------------------------------------------------
vi.mock("../core/reader.js", () => ({
  readFile: vi.fn(),
  fileExists: vi.fn(),
}));

vi.mock("../core/writer.js", () => ({
  writeFile: vi.fn(),
}));

vi.mock("../core/spec-parser.js", () => ({
  parseSpecContent: vi.fn(),
  loadAllSpecs: vi.fn(),
}));

vi.mock("../core/llm.js", () => ({
  llmGenerateObject: vi.fn(),
}));

import { runDocGenerate, stripForDocs, DocsOpts } from "../../src/pipelines/doc-generate.js";
import { readFile, fileExists } from "../../src/core/reader.js";
import { writeFile } from "../../src/core/writer.js";
import { parseSpecContent, loadAllSpecs } from "../../src/core/spec-parser.js";
import { llmGenerateObject } from "../../src/core/llm.js";
import type { SpecGuardConfig } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------
const makeConfig = (overrides: Partial<SpecGuardConfig> = {}): SpecGuardConfig => ({
  rootDir: "/project",
  apps: [
    {
      name: "core",
      specDir: "specs/core",
      srcDir: "src/core",
    },
  ],
  llm: {
    provider: "openai",
    model: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  ...overrides,
});

const SAFE_SPEC_CONTENT = `<!-- meta: key=core/feature -->\n# Feature\n\n## Overview\n\nSome content.\n`;
const SAFE_PARSED_SPEC = { title: "Feature", filePath: "/project/specs/core/feature.md" };
const SAFE_LLM_OUTPUT = { description: "A safe feature.", body: "This feature does X." };

beforeEach(() => {
  vi.resetAllMocks();
  (fileExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_SPEC_CONTENT);
  (parseSpecContent as ReturnType<typeof vi.fn>).mockReturnValue(SAFE_PARSED_SPEC);
  (loadAllSpecs as ReturnType<typeof vi.fn>).mockReturnValue([
    { filePath: "/project/specs/core/feature.md" },
  ]);
  (llmGenerateObject as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_LLM_OUTPUT);
  (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// describe: stripForDocs – content sanitisation (OWASP A03 / injection surface)
// ---------------------------------------------------------------------------
describe("stripForDocs", () => {
  // OWASP A03: Injection – metadata comment leakage into user-facing output
  it("removes the leading HTML metadata comment block", () => {
    const input = `<!-- internal: secret=abc123 -->\n# Title\n\nBody.\n`;
    const result = stripForDocs(input);
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("secret=abc123");
    expect(result).toContain("Body.");
  });

  // OWASP A03: Injection – Scenarios section must not leak into user docs
  it("strips the ## Scenarios section entirely", () => {
    const input = `# Title\n\n## Scenarios\n\nGiven a user does X.\n\n## Overview\n\nPublic.\n`;
    const result = stripForDocs(input);
    expect(result).not.toContain("Scenarios");
    expect(result).not.toContain("Given a user does X");
    expect(result).toContain("Public.");
  });

  // OWASP A03: Injection – Security Notes must not leak into user docs
  it("strips the ## Security Notes section entirely", () => {
    const input = `# Title\n\n## Security Notes\n\nDo not expose the API key.\n\n## Usage\n\nPublic usage.\n`;
    const result = stripForDocs(input);
    expect(result).not.toContain("Security Notes");
    expect(result).not.toContain("Do not expose the API key");
    expect(result).toContain("Public usage.");
  });

  // OWASP A03: Injection – case-insensitive section stripping
  it("strips Security Notes regardless of heading capitalisation", () => {
    const input = `# Title\n\n## SECURITY NOTES\n\nSecret info.\n\n## Usage\n\nOK.\n`;
    const result = stripForDocs(input);
    expect(result).not.toContain("Secret info");
  });

  // OWASP A03: Injection – multiple metadata comments should all be stripped
  it("strips only the first HTML comment (does not leave subsequent ones)", () => {
    const input = `<!-- meta -->\n# Title\n\n<!-- second comment -->\n\nBody.\n`;
    const result = stripForDocs(input);
    expect(result).not.toContain("meta");
    // The second comment is not a metadata block; behaviour is deterministic
    expect(result).toContain("Body.");
  });

  // OWASP A03: Injection – empty content should not produce garbage output
  it("returns empty string for empty input without throwing", () => {
    expect(() => stripForDocs("")).not.toThrow();
    expect(stripForDocs("")).toBe("");
  });

  // OWASP A03: Injection – content with only stripped sections yields empty output
  it("returns empty string when all content is in stripped sections", () => {
    const input = `<!-- meta -->\n## Scenarios\n\nStep 1.\n## Security Notes\n\nNote.\n`;
    const result = stripForDocs(input);
    expect(result.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// describe: runDocGenerate – access control and input validation
// ---------------------------------------------------------------------------
describe("runDocGenerate", () => {
  // OWASP A01: Broken Access Control – unknown app name must be rejected
  it("throws when opts.app references an unknown application name", async () => {
    const config = makeConfig();
    await expect(
      runDocGenerate(config, { spec: "core/feature", app: "nonexistent" }),
    ).rejects.toThrow(/Unknown app/);
  });

  // OWASP A01: Broken Access Control – no spec and no --all must be rejected
  it("throws when neither --spec nor --all is provided", async () => {
    const config = makeConfig();
    await expect(runDocGenerate(config, {})).rejects.toThrow(/Nothing to do/);
  });

  // OWASP A05: Security Misconfiguration – output directory must not escape rootDir via path traversal in opts.out
  it("does not throw when opts.out is a relative path (resolved against rootDir)", async () => {
    const config = makeConfig();
    const opts: DocsOpts = { spec: "core/feature", out: "docs/user" };
    const result = await runDocGenerate(config, opts);
    // writeFile should have been called with a path inside rootDir
    const [writtenPath] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(writtenPath).toContain("/project/");
  });

  // OWASP A05: Security Misconfiguration – path traversal attempt in opts.out
  it("resolves opts.out path traversal sequences against rootDir without escaping", async () => {
    const config = makeConfig();
    const opts: DocsOpts = { spec: "core/feature", out: "../../etc" };
    // Should not throw; the resolved path is deterministic
    await runDocGenerate(config, opts);
    const [writtenPath] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    // The resolved path must be an absolute path (no unresolved traversal tokens)
    expect(path.isAbsolute(writtenPath)).toBe(true);
    expect(writtenPath).not.toContain("..");
  });

  // OWASP A05: Security Misconfiguration – path traversal attempt in opts.spec
  it("resolves opts.spec path traversal sequences to an absolute path", async () => {
    const config = makeConfig();
    (fileExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const opts: DocsOpts = { spec: "../../etc/passwd.md" };
    const result = await runDocGenerate(config, opts);
    // Should warn (file not found) rather than silently succeed or crash
    expect(result.messages.some((m) => m.includes("[warn]"))).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
  });

  // OWASP A02: Cryptographic Failures – API key must come from env, not hardcoded
  it("passes apiKeyEnv (not a literal key) to llmGenerateObject", async () => {
    const config = makeConfig();
    await runDocGenerate(config, { spec: "core/feature" });
    const [callArgs] = (llmGenerateObject as ReturnType<typeof vi.fn>).mock.calls;
    expect(callArgs[0]).toHaveProperty("apiKeyEnv", "OPENAI_API_KEY");
    // Must NOT contain a literal key value
    expect(callArgs[0]).not.toHaveProperty("apiKey");
  });

  // OWASP A03: Injection – LLM prompt must not include raw Security Notes content
  it("does not include Security Notes content in the LLM prompt", async () => {
    const specWithSecNotes =
      `<!-- meta -->\n# Feature\n\n## Security Notes\n\nDo not expose DB password.\n\n## Usage\n\nPublic.\n`;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(specWithSecNotes);
    await runDocGenerate(makeConfig(), { spec: "core/feature" });
    const [callArgs] = (llmGenerateObject as ReturnType<typeof vi.fn>).mock.calls;
    expect(callArgs[0].prompt).not.toContain("Do not expose DB password");
  });

  // OWASP A03: Injection – LLM prompt must not include raw Scenarios content
  it("does not include Scenarios content in the LLM prompt", async () => {
    const specWithScenarios =
      `<!-- meta -->\n# Feature\n\n## Scenarios\n\nGiven secret step.\n\n## Usage\n\nPublic.\n`;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(specWithScenarios);
    await runDocGenerate(makeConfig(), { spec: "core/feature" });
    const [callArgs] = (llmGenerateObject as ReturnType<typeof vi.fn>).mock.calls;
    expect(callArgs[0].prompt).not.toContain("Given secret step");
  });

  // OWASP A03: Injection – LLM prompt must not include the metadata HTML comment
  it("does not include the metadata HTML comment in the LLM prompt", async () => {
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_SPEC_CONTENT);
    await runDocGenerate(makeConfig(), { spec: "core/feature" });
    const [callArgs] = (llmGenerateObject as ReturnType<typeof vi.fn>).mock.calls;
    expect(callArgs[0].prompt).not.toContain("<!--");
  });

  // OWASP A03: Injection – LLM body wrapped in a code fence must be stripped before writing
  it("strips a wrapping Markdown code fence from the LLM body before writing", async () => {
    (llmGenerateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      description: "A feature.",
      body: "```markdown\nThis is the body.\n```",
    });
    await runDocGenerate(makeConfig(), { spec: "core/feature" });
    const [, writtenContent] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(writtenContent).not.toContain("```markdown");
    expect(writtenContent).toContain("This is the body.");
  });

  // OWASP A03: Injection – YAML frontmatter must escape double-quotes in title/description
  it("escapes double-quotes in title and description within YAML frontmatter", async () => {
    (parseSpecContent as ReturnType<typeof vi.fn>).mockReturnValue({
      title: 'Feature "quoted"',
      filePath: "/project/specs/core/feature.md",
    });
    (llmGenerateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      description: 'Desc with "quotes".',
      body: "Body.",
    });
    await runDocGenerate(makeConfig(), { spec: "core/feature" });
    const [, writtenContent] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    // Raw unescaped double-quotes inside a YAML quoted string would break parsing
    expect(writtenContent).toContain('\\"quoted\\"');
    expect(writtenContent).toContain('\\"quotes\\"');
  });

  // OWASP A04: Insecure Design – missing spec file must warn, not crash or write
  it("warns and skips when the spec file does not exist, writing nothing", async () => {
    (fileExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await runDocGenerate(makeConfig(), { spec: "core/feature" });
    expect(writeFile).not.toHaveBeenCalled();
    expect(result.messages.some((m) => m.includes("[warn]"))).toBe(true);
  });

  // OWASP A04: Insecure Design – LLM failure must not write partial/corrupt output
  it("does not write a doc file when the LLM call throws", async () => {
    (llmGenerateObject as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("LLM unavailable"),
    );
    const result = await runDocGenerate(makeConfig(), { spec: "core/feature" });
    expect(writeFile).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(result.created).toBe(0);
  });

  // OWASP A04: Insecure Design – read failure must not write partial/corrupt output
  it("does not write a doc file when reading the spec throws", async () => {
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("EACCES"));
    const result = await runDocGenerate(makeConfig(), { spec: "core/feature" });
    expect(writeFile).not.toHaveBeenCalled();
    expect(result.messages.some((m) => m.includes("[warn]"))).toBe(true);
  });

  // OWASP A04: Insecure Design – all-specs mode must not process specs outside app specDir
  it("only processes specs whose paths are owned by an app specDir in --all mode", async () => {
    (loadAllSpecs as ReturnType<typeof vi.fn>).mockReturnValue([
      { filePath: "/project/specs/core/feature.md" },
      { filePath: "/outside/other/spec.md" }, // outside any app specDir
    ]);
    (fileExists as Ret
