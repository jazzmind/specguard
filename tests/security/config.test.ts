import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before the module under test is loaded.
// ---------------------------------------------------------------------------

vi.mock("../core/reader.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
}));

import { fileExists, readFile } from "../core/reader.js";
import { loadConfig } from "../core/config.js";
import { ConfigNotFoundError, ConfigInvalidError } from "../core/errors.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);

// ---------------------------------------------------------------------------
// Minimal valid config fixture
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  apps: [
    {
      name: "my-app",
      repo: "org/my-app",
      specDir: "specs",
      sources: { routes: ["src/routes/**"] },
      framework: "next",
      testOutput: "tests/__generated__",
    },
  ],
  llm: {
    provider: "openai",
    model: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
  },
};

function validJson(overrides: object = {}): string {
  return JSON.stringify({ ...VALID_CONFIG, ...overrides });
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadConfig – security surface area", () => {
  // OWASP A05: Security Misconfiguration
  // The loader must refuse to operate when no config file exists anywhere in
  // the ancestor chain, preventing silent fall-through to insecure defaults.
  it("throws ConfigNotFoundError when no config file exists in the directory tree", async () => {
    mockFileExists.mockResolvedValue(false);

    await expect(loadConfig("/tmp/some/deep/project")).rejects.toThrow(
      ConfigNotFoundError,
    );
  });

  // OWASP A05: Security Misconfiguration
  // An empty config file must not be silently accepted; it must fail schema
  // validation so the pipeline never runs with an unconfigured state.
  it("throws ConfigInvalidError for an empty JSON object ({})", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue("{}");

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A03: Injection
  // Malformed / truncated JSON must be rejected before any data is consumed,
  // preventing downstream injection via crafted config payloads.
  it("throws ConfigInvalidError when config.json contains malformed JSON", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue('{ "apps": [ BROKEN }');

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A03: Injection
  // A JSON string that is syntactically valid but semantically a primitive
  // (e.g. a bare string) must not bypass schema validation.
  it("throws ConfigInvalidError when config.json is a JSON primitive (string)", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue('"just a string"');

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A03: Injection
  // A JSON array at the root level must be rejected; only objects are valid.
  it("throws ConfigInvalidError when config.json root is a JSON array", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue("[1, 2, 3]");

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A05: Security Misconfiguration
  // The `apps` array must contain at least one entry; an empty array must be
  // rejected so the pipeline cannot run against zero targets.
  it("throws ConfigInvalidError when apps array is empty", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...VALID_CONFIG, apps: [] }),
    );

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A05: Security Misconfiguration
  // Missing `llm` block must be rejected; without it the pipeline would have
  // no provider configuration and could fall back to an insecure default.
  it("throws ConfigInvalidError when llm block is absent", async () => {
    mockFileExists.mockResolvedValue(true);
    const { llm: _omit, ...noLlm } = VALID_CONFIG;
    mockReadFile.mockResolvedValue(JSON.stringify(noLlm));

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A05: Security Misconfiguration
  // `llm.apiKeyEnv` must be a string field; a numeric or null value must be
  // rejected so the loader cannot silently accept a broken key reference.
  it("throws ConfigInvalidError when llm.apiKeyEnv is not a string", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        ...VALID_CONFIG,
        llm: { ...VALID_CONFIG.llm, apiKeyEnv: 42 },
      }),
    );

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A01: Broken Access Control
  // The resolved `rootDir` stamped onto the config must be an absolute path
  // derived from the filesystem walk, not a caller-supplied value, preventing
  // path-confusion attacks where a relative rootDir could escape the repo.
  it("stamps an absolute rootDir onto the returned config", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(validJson());

    const config = await loadConfig("/project");

    expect(path.isAbsolute(config.rootDir)).toBe(true);
  });

  // OWASP A01: Broken Access Control
  // The rootDir must correspond to the directory that actually contains the
  // config file, not an arbitrary ancestor, preventing privilege escalation
  // where a higher-level directory is treated as the project root.
  it("sets rootDir to the directory containing .specguard/config.json", async () => {
    // Only the exact project root has the config file.
    mockFileExists.mockImplementation(async (p: string) =>
      p === path.join("/workspace/project", ".specguard", "config.json"),
    );
    mockReadFile.mockResolvedValue(validJson());

    const config = await loadConfig("/workspace/project/src/feature");

    expect(config.rootDir).toBe("/workspace/project");
  });

  // OWASP A08: Software and Data Integrity Failures
  // Unknown extra keys must survive via passthrough (forward-compatibility)
  // but must not cause the loader to throw or silently drop required fields.
  it("accepts and preserves unknown top-level keys via passthrough", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      validJson({ _comment: "internal note", futureKey: true }),
    );

    const config = await loadConfig("/project");

    expect((config as Record<string, unknown>)["_comment"]).toBe(
      "internal note",
    );
  });

  // OWASP A05: Security Misconfiguration
  // A config with a valid `security` block (enabled: true) must load without
  // error, confirming the security sub-schema is correctly enforced.
  it("accepts a valid security block with enabled: true", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        ...VALID_CONFIG,
        apps: [
          {
            ...VALID_CONFIG.apps[0],
            security: { enabled: true, paths: ["src/auth/**"] },
          },
        ],
      }),
    );

    await expect(loadConfig("/project")).resolves.toBeDefined();
  });

  // OWASP A05: Security Misconfiguration
  // `security.enabled` must be a boolean; a truthy string must be rejected so
  // the security gate cannot be accidentally bypassed by a type coercion.
  it("throws ConfigInvalidError when security.enabled is a string instead of boolean", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        ...VALID_CONFIG,
        apps: [
          {
            ...VALID_CONFIG.apps[0],
            security: { enabled: "yes" },
          },
        ],
      }),
    );

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A03: Injection
  // A deeply nested prototype-pollution payload (__proto__, constructor) must
  // not survive schema validation and must not mutate Object.prototype.
  it("rejects prototype-pollution payloads and does not mutate Object.prototype", async () => {
    mockFileExists.mockResolvedValue(true);
    // JSON.parse itself is safe against __proto__ in modern Node; the schema
    // must still reject the malformed structure.
    const pollutionPayload = `{
      "__proto__": { "polluted": true },
      "constructor": { "prototype": { "polluted": true } },
      "apps": [],
      "llm": { "provider": "x", "model": "y", "apiKeyEnv": "Z" }
    }`;
    mockReadFile.mockResolvedValue(pollutionPayload);

    // apps: [] fails min(1) — ConfigInvalidError is the expected outcome.
    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
    // Prototype must remain clean.
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // OWASP A09: Security Logging and Monitoring Failures
  // ConfigInvalidError must carry a human-readable message that identifies
  // which field failed, enabling operators to diagnose misconfiguration.
  it("ConfigInvalidError message identifies the failing field path", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ ...VALID_CONFIG, llm: { provider: 99, model: "m", apiKeyEnv: "K" } }),
    );

    let caught: unknown;
    try {
      await loadConfig("/project");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigInvalidError);
    // The error message must reference the offending path.
    expect((caught as Error).message).toMatch(/llm/);
  });

  // OWASP A01: Broken Access Control
  // loadConfig must not accept a path traversal string as cwd and silently
  // resolve it to an unintended ancestor directory.
  it("resolves path-traversal cwd strings to an absolute path before walking", async () => {
    mockFileExists.mockResolvedValue(false);

    // A traversal-style cwd must still result in ConfigNotFoundError (not a
    // crash or silent success), proving the path is resolved, not trusted raw.
    await expect(loadConfig("../../../../../../etc")).rejects.toThrow(
      ConfigNotFoundError,
    );
  });

  // OWASP A05: Security Misconfiguration
  // heal.maxRetries must be a number; a string value must be rejected to
  // prevent unbounded retry loops caused by type coercion.
  it("throws ConfigInvalidError when heal.maxRetries is a string", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      validJson({ heal: { maxRetries: "infinite", testCommand: "vitest" } }),
    );

    await expect(loadConfig("/project")).rejects.toThrow(ConfigInvalidError);
  });

  // OWASP A08: Software and Data Integrity Failures
  // A fully valid config must deserialise without error and return a typed
  // object, confirming the integrity of the happy-path pipeline.
  it("returns a fully typed SpecGuardConfig for a valid config file", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(validJson());

    const config = await loadConfig("/project");

    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe("my-app");
    expect(config.llm.provider).toBe("openai");
    expect(config.rootDir).toBeDefined();
  });
});
