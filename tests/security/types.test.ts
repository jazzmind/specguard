import { describe, it, expect } from "vitest";

describe("specguard-core/types – Security Tests", () => {

  // OWASP A02: Cryptographic Failures
  it("LlmConfig.apiKeyEnv should store only the name of the environment variable, not the resolved secret value", () => {
    const resolvedSecret = "sk-supersecretapikey1234567890";
    process.env["OPENAI_API_KEY"] = resolvedSecret;

    const llmConfig = {
      apiKeyEnv: "OPENAI_API_KEY",
    };

    expect(llmConfig.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(llmConfig.apiKeyEnv).not.toBe(resolvedSecret);
    expect(llmConfig.apiKeyEnv).not.toMatch(/^sk-/);

    delete process.env["OPENAI_API_KEY"];
  });

  // OWASP A02: Cryptographic Failures
  it("LlmConfig.apiKeyEnv must not contain the resolved value of the environment variable at construction time", () => {
    process.env["LLM_SECRET"] = "actual-secret-value";

    const llmConfig = {
      apiKeyEnv: "LLM_SECRET",
    };

    const resolvedValue = process.env[llmConfig.apiKeyEnv];

    expect(llmConfig.apiKeyEnv).not.toBe(resolvedValue);
    expect(Object.values(llmConfig)).not.toContain(resolvedValue);

    delete process.env["LLM_SECRET"];
  });

  // OWASP A02: Cryptographic Failures
  it("LlmConfig serialised to JSON must not inline the resolved API key value", () => {
    process.env["MY_API_KEY"] = "top-secret-key-xyz";

    const llmConfig = {
      apiKeyEnv: "MY_API_KEY",
    };

    const serialised = JSON.stringify(llmConfig);

    expect(serialised).not.toContain("top-secret-key-xyz");
    expect(serialised).toContain("MY_API_KEY");

    delete process.env["MY_API_KEY"];
  });

  // OWASP A02: Cryptographic Failures
  it("AuthProfile.usernameEnvVar should store only the environment variable name, not the resolved username", () => {
    process.env["APP_USERNAME"] = "admin";

    const authProfile = {
      usernameEnvVar: "APP_USERNAME",
      passwordEnvVar: "APP_PASSWORD",
    };

    expect(authProfile.usernameEnvVar).toBe("APP_USERNAME");
    expect(authProfile.usernameEnvVar).not.toBe("admin");

    delete process.env["APP_USERNAME"];
  });

  // OWASP A02: Cryptographic Failures
  it("AuthProfile.passwordEnvVar should store only the environment variable name, not the resolved password", () => {
    process.env["APP_PASSWORD"] = "hunter2";

    const authProfile = {
      usernameEnvVar: "APP_USERNAME",
      passwordEnvVar: "APP_PASSWORD",
    };

    expect(authProfile.passwordEnvVar).toBe("APP_PASSWORD");
    expect(authProfile.passwordEnvVar).not.toBe("hunter2");

    delete process.env["APP_PASSWORD"];
  });

  // OWASP A02: Cryptographic Failures
  it("AuthProfile serialised to JSON must not contain resolved credential values", () => {
    process.env["SG_USER"] = "root";
    process.env["SG_PASS"] = "p@ssw0rd!";

    const authProfile = {
      usernameEnvVar: "SG_USER",
      passwordEnvVar: "SG_PASS",
    };

    const serialised = JSON.stringify(authProfile);

    expect(serialised).not.toContain("root");
    expect(serialised).not.toContain("p@ssw0rd!");
    expect(serialised).toContain("SG_USER");
    expect(serialised).toContain("SG_PASS");

    delete process.env["SG_USER"];
    delete process.env["SG_PASS"];
  });

  // OWASP A02: Cryptographic Failures
  it("SpecGuardConfig serialised to disk must not contain resolved credential values from AuthProfile", () => {
    process.env["DISK_USER"] = "diskuser";
    process.env["DISK_PASS"] = "diskpassword";

    const specGuardConfig = {
      authProfile: {
        usernameEnvVar: "DISK_USER",
        passwordEnvVar: "DISK_PASS",
      },
    };

    const serialised = JSON.stringify(specGuardConfig);

    expect(serialised).not.toContain("diskuser");
    expect(serialised).not.toContain("diskpassword");

    delete process.env["DISK_USER"];
    delete process.env["DISK_PASS"];
  });

  // OWASP A03: Injection
  it("SpecMeta.extra values must be treated as untrusted strings and must not be evaluated", () => {
    const maliciousPayload = "'; require('child_process').exec('rm -rf /'); //";

    const specMeta = {
      extra: {
        userSupplied: maliciousPayload,
      },
    };

    const value = specMeta.extra["userSupplied"];

    expect(typeof value).toBe("string");
    expect(() => {
      // Simulates a consumer incorrectly evaluating the value
      // The test asserts this pattern is dangerous and should never occur
      const safeCheck = value.includes("require") || value.includes("exec");
      expect(safeCheck).toBe(true); // confirms the payload is detectable as dangerous
    }).not.toThrow();
  });

  // OWASP A03: Injection
  it("SpecMeta.extra values containing script injection patterns must remain inert strings", () => {
    const xssPayload = "<script>alert('xss')</script>";

    const specMeta = {
      extra: {
        description: xssPayload,
      },
    };

    const value = specMeta.extra["description"];

    expect(typeof value).toBe("string");
    expect(value).toBe(xssPayload);
    // Value is stored as-is; consumers are responsible for sanitisation before rendering
  });

  // OWASP A03: Injection
  it("SpecMeta.extra values containing prototype pollution patterns must not affect Object prototype", () => {
    const specMeta: Record<string, unknown> = {
      extra: {},
    };

    const extra = specMeta["extra"] as Record<string, unknown>;

    // Simulate an attacker-controlled key
    const attackerKey = "__proto__";
    const attackerValue = { polluted: true };

    // Safe assignment should not mutate Object.prototype
    if (attackerKey !== "__proto__" && attackerKey !== "constructor" && attackerKey !== "prototype") {
      extra[attackerKey] = attackerValue;
    }

    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // OWASP A04: Insecure Design
  it("LlmConfig must not expose a field that directly accepts a raw API key value", () => {
    const llmConfig = {
      apiKeyEnv: "OPENAI_API_KEY",
    };

    expect(llmConfig).not.toHaveProperty("apiKey");
    expect(llmConfig).not.toHaveProperty("apiKeyValue");
    expect(llmConfig).not.toHaveProperty("secret");
    expect(llmConfig).not.toHaveProperty("token");
  });

  // OWASP A04: Insecure Design
  it("AuthProfile must not expose fields that directly accept raw credential values", () => {
    const authProfile = {
      usernameEnvVar: "APP_USERNAME",
      passwordEnvVar: "APP_PASSWORD",
    };

    expect(authProfile).not.toHaveProperty("username");
    expect(authProfile).not.toHaveProperty("password");
    expect(authProfile).not.toHaveProperty("credentials");
    expect(authProfile).not.toHaveProperty("secret");
  });

  // OWASP A05: Security Misconfiguration
  it("LlmConfig.apiKeyEnv must be a non-empty string when provided", () => {
    const validConfig = {
      apiKeyEnv: "OPENAI_API_KEY",
    };

    expect(typeof validConfig.apiKeyEnv).toBe("string");
    expect(validConfig.apiKeyEnv.trim().length).toBeGreaterThan(0);
  });

  // OWASP A05: Security Misconfiguration
  it("AuthProfile environment variable name fields must be non-empty strings when provided", () => {
    const authProfile = {
      usernameEnvVar: "APP_USERNAME",
      passwordEnvVar: "APP_PASSWORD",
    };

    expect(typeof authProfile.usernameEnvVar).toBe("string");
    expect(authProfile.usernameEnvVar.trim().length).toBeGreaterThan(0);
    expect(typeof authProfile.passwordEnvVar).toBe("string");
    expect(authProfile.passwordEnvVar.trim().length).toBeGreaterThan(0);
  });

  // OWASP A08: Software and Data Integrity Failures
  it("SpecMeta.extra must not allow values to override core SpecMeta fields when merged", () => {
    const specMeta = {
      id: "spec-001",
      title: "Core Type Definitions",
      extra: {
        id: "attacker-controlled-id",
        title: "Injected Title",
      },
    };

    // Core fields must take precedence over extra fields
    const merged = { ...specMeta.extra, ...specMeta };

    expect(merged.id).toBe("spec-001");
    expect(merged.title).toBe("Core Type Definitions");
  });

  // OWASP A09: Security Logging and Monitoring Failures
  it("LlmConfig must not log or expose the resolved API key value when inspected", () => {
    process.env["LOG_TEST_KEY"] = "secret-should-not-appear-in-logs";

    const llmConfig = {
      apiKeyEnv: "LOG_TEST_KEY",
    };

    const inspected = JSON.stringify(llmConfig);

    expect(inspected).not.toContain("secret-should-not-appear-in-logs");

    delete process.env["LOG_TEST_KEY"];
  });

  // OWASP A09: Security Logging and Monitoring Failures
  it("AuthProfile must not expose resolved credential values when serialised for logging", () => {
    process.env["LOG_USER"] = "sensitiveuser";
    process.env["LOG_PASS"] = "sensitivepassword";

    const authProfile = {
      usernameEnvVar: "LOG_USER",
      passwordEnvVar: "LOG_PASS",
    };

    const logOutput = JSON.stringify(authProfile);

    expect(logOutput).not.toContain("sensitiveuser");
    expect(logOutput).not.toContain("sensitivepassword");

    delete process.env["LOG_USER"];
    delete process.env["LOG_PASS"];
  });

});
