import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  authenticate,
  clearSessionCache,
  redact,
  authRunner,
  type AuthResult,
} from "../src/adapters/auth-state-machine.js";
import type { SpecGuardConfig, AuthProfile } from "../src/core/types.js";
import type { BrowserHandle } from "../src/adapters/playwright.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_USERNAME = "test-user@example.com";
const TEST_PASSWORD = "S3cr3tP@ssw0rd!";
const TEST_PROFILE_NAME = "default";

const makeProfile = (overrides: Partial<AuthProfile> = {}): AuthProfile => ({
  name: TEST_PROFILE_NAME,
  loginUrl: "https://app.example.com/login",
  usernameEnvVar: "TEST_USERNAME",
  passwordEnvVar: "TEST_PASSWORD",
  ...overrides,
});

const makeConfig = (profile: AuthProfile = makeProfile()): SpecGuardConfig => ({
  auth: {
    profiles: [profile],
  },
} as unknown as SpecGuardConfig);

const makeBrowserHandle = (): BrowserHandle =>
  ({
    _page: {
      goto: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://app.example.com/dashboard"),
    },
  } as unknown as BrowserHandle);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setCredentialEnvVars() {
  process.env["TEST_USERNAME"] = TEST_USERNAME;
  process.env["TEST_PASSWORD"] = TEST_PASSWORD;
}

function clearCredentialEnvVars() {
  delete process.env["TEST_USERNAME"];
  delete process.env["TEST_PASSWORD"];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Auth State Machine — Security Tests", () => {
  beforeEach(() => {
    clearSessionCache();
    clearCredentialEnvVars();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures — credential exposure in error messages
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("redact() replaces username occurrences with [REDACTED]", () => {
    setCredentialEnvVars();
    const profile = makeProfile();
    const input = `Attempted login with user ${TEST_USERNAME} failed.`;
    const output = redact(input, profile);
    expect(output).not.toContain(TEST_USERNAME);
    expect(output).toContain("[REDACTED]");
  });

  // OWASP A02: Cryptographic Failures
  it("redact() replaces password occurrences with [REDACTED]", () => {
    setCredentialEnvVars();
    const profile = makeProfile();
    const input = `Payload contained password=${TEST_PASSWORD}`;
    const output = redact(input, profile);
    expect(output).not.toContain(TEST_PASSWORD);
    expect(output).toContain("[REDACTED]");
  });

  // OWASP A02: Cryptographic Failures
  it("redact() replaces multiple occurrences of both credentials", () => {
    setCredentialEnvVars();
    const profile = makeProfile();
    const input = `user=${TEST_USERNAME} pass=${TEST_PASSWORD} again user=${TEST_USERNAME}`;
    const output = redact(input, profile);
    expect(output).not.toContain(TEST_USERNAME);
    expect(output).not.toContain(TEST_PASSWORD);
    const count = (output.match(/\[REDACTED\]/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  // OWASP A02: Cryptographic Failures
  it("redact() is a no-op when env vars are unset (no crash, no exposure)", () => {
    clearCredentialEnvVars();
    const profile = makeProfile();
    const input = "some benign log line";
    const output = redact(input, profile);
    expect(output).toBe(input);
  });

  // OWASP A02: Cryptographic Failures
  it("redact() does not expose credentials when they are empty strings", () => {
    process.env["TEST_USERNAME"] = "";
    process.env["TEST_PASSWORD"] = "";
    const profile = makeProfile();
    const input = "log line with no credentials";
    const output = redact(input, profile);
    expect(output).toBe(input);
  });

  // -------------------------------------------------------------------------
  // OWASP A02: Cryptographic Failures — credentials must not appear in AuthResult
  // -------------------------------------------------------------------------

  // OWASP A02: Cryptographic Failures
  it("authenticate() success result does not contain credential values", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const profile = makeProfile();
    const config = makeConfig(profile);

    vi.spyOn(authRunner, "fillAndSubmit").mockResolvedValue({ success: true });

    const result = await authenticate(handle, TEST_PROFILE_NAME, config);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TEST_USERNAME);
    expect(serialized).not.toContain(TEST_PASSWORD);
  });

  // OWASP A02: Cryptographic Failures
  it("authenticate() failure result error message does not contain raw credentials", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const profile = makeProfile();
    const config = makeConfig(profile);

    vi.spyOn(authRunner, "fillAndSubmit").mockResolvedValue({
      success: false,
      error: `Invalid credentials for ${TEST_USERNAME} with password ${TEST_PASSWORD}`,
    });

    const result = await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain(TEST_USERNAME);
    expect(result.error).not.toContain(TEST_PASSWORD);
    expect(result.error).toContain("[REDACTED]");
  });

  // OWASP A02: Cryptographic Failures
  it("authenticate() error message is redacted even when error contains only the password", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const profile = makeProfile();
    const config = makeConfig(profile);

    vi.spyOn(authRunner, "fillAndSubmit").mockResolvedValue({
      success: false,
      error: TEST_PASSWORD,
    });

    const result = await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(result.error).not.toContain(TEST_PASSWORD);
    expect(result.error).toContain("[REDACTED]");
  });

  // -------------------------------------------------------------------------
  // OWASP A07: Identification and Authentication Failures — env-var sourcing
  // -------------------------------------------------------------------------

  // OWASP A07: Identification and Authentication Failures
  it("authenticate() returns failure when username env var is missing", async () => {
    delete process.env["TEST_USERNAME"];
    process.env["TEST_PASSWORD"] = TEST_PASSWORD;

    const handle = makeBrowserHandle();
    const config = makeConfig();
    const fillSpy = vi.spyOn(authRunner, "fillAndSubmit");

    const result = await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TEST_USERNAME/);
    expect(fillSpy).not.toHaveBeenCalled();
  });

  // OWASP A07: Identification and Authentication Failures
  it("authenticate() returns failure when password env var is missing", async () => {
    process.env["TEST_USERNAME"] = TEST_USERNAME;
    delete process.env["TEST_PASSWORD"];

    const handle = makeBrowserHandle();
    const config = makeConfig();
    const fillSpy = vi.spyOn(authRunner, "fillAndSubmit");

    const result = await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TEST_PASSWORD/);
    expect(fillSpy).not.toHaveBeenCalled();
  });

  // OWASP A07: Identification and Authentication Failures
  it("authenticate() returns failure when both credential env vars are missing", async () => {
    clearCredentialEnvVars();
    const handle = makeBrowserHandle();
    const config = makeConfig();
    const fillSpy = vi.spyOn(authRunner, "fillAndSubmit");

    const result = await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(result.success).toBe(false);
    expect(fillSpy).not.toHaveBeenCalled();
  });

  // OWASP A07: Identification and Authentication Failures
  it("authenticate() does not pass config-level credential strings to fillAndSubmit", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const profile = makeProfile();
    const config = makeConfig(profile);

    const fillSpy = vi
      .spyOn(authRunner, "fillAndSubmit")
      .mockResolvedValue({ success: true });

    await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(fillSpy).toHaveBeenCalledOnce();
    const [, , usernameArg, passwordArg] = fillSpy.mock.calls[0];
    // Must equal the env-var values, not any hypothetical config-embedded values
    expect(usernameArg).toBe(TEST_USERNAME);
    expect(passwordArg).toBe(TEST_PASSWORD);
  });

  // -------------------------------------------------------------------------
  // OWASP A01: Broken Access Control — session cache isolation
  // -------------------------------------------------------------------------

  // OWASP A01: Broken Access Control
  it("session cache does not store credential data — only success/failure state", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const config = makeConfig();

    vi.spyOn(authRunner, "fillAndSubmit").mockResolvedValue({ success: true });

    const result = await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(result).not.toHaveProperty("username");
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("credentials");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TEST_USERNAME);
    expect(serialized).not.toContain(TEST_PASSWORD);
  });

  // OWASP A01: Broken Access Control
  it("session cache returns cached result without re-invoking fillAndSubmit", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const config = makeConfig();

    const fillSpy = vi
      .spyOn(authRunner, "fillAndSubmit")
      .mockResolvedValue({ success: true });

    await authenticate(handle, TEST_PROFILE_NAME, config);
    await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(fillSpy).toHaveBeenCalledOnce();
  });

  // OWASP A01: Broken Access Control
  it("session cache is isolated per profile name — one profile cannot access another's session", async () => {
    setCredentialEnvVars();
    process.env["OTHER_USERNAME"] = "other@example.com";
    process.env["OTHER_PASSWORD"] = "OtherPass!";

    const profileA = makeProfile({ name: "profileA" });
    const profileB = makeProfile({
      name: "profileB",
      usernameEnvVar: "OTHER_USERNAME",
      passwordEnvVar: "OTHER_PASSWORD",
    });
    const config: SpecGuardConfig = {
      auth: { profiles: [profileA, profileB] },
    } as unknown as SpecGuardConfig;

    const handle = makeBrowserHandle();
    const fillSpy = vi
      .spyOn(authRunner, "fillAndSubmit")
      .mockResolvedValue({ success: true });

    const resultA = await authenticate(handle, "profileA", config);
    const resultB = await authenticate(handle, "profileB", config);

    expect(resultA.profile).toBe("profileA");
    expect(resultB.profile).toBe("profileB");
    expect(fillSpy).toHaveBeenCalledTimes(2);

    delete process.env["OTHER_USERNAME"];
    delete process.env["OTHER_PASSWORD"];
  });

  // OWASP A01: Broken Access Control
  it("failed authentication result is NOT cached — subsequent attempt re-invokes fillAndSubmit", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const config = makeConfig();

    const fillSpy = vi
      .spyOn(authRunner, "fillAndSubmit")
      .mockResolvedValue({ success: false, error: "bad credentials" });

    await authenticate(handle, TEST_PROFILE_NAME, config);
    await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(fillSpy).toHaveBeenCalledTimes(2);
  });

  // OWASP A01: Broken Access Control
  it("clearSessionCache() removes all cached sessions, forcing re-authentication", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const config = makeConfig();

    const fillSpy = vi
      .spyOn(authRunner, "fillAndSubmit")
      .mockResolvedValue({ success: true });

    await authenticate(handle, TEST_PROFILE_NAME, config);
    clearSessionCache();
    await authenticate(handle, TEST_PROFILE_NAME, config);

    expect(fillSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // OWASP A07: Identification and Authentication Failures — unknown profile
  // -------------------------------------------------------------------------

  // OWASP A07: Identification and Authentication Failures
  it("authenticate() returns failure for an unknown profile name without throwing", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const config = makeConfig();

    const result = await authenticate(handle, "nonexistent-profile", config);

    expect(result.success).toBe(false);
    expect(result.profile).toBe("nonexistent-profile");
    expect(result.error).toMatch(/not found/i);
  });

  // OWASP A07: Identification and Authentication Failures
  it("authenticate() profile-not-found error does not expose credential values", async () => {
    setCredentialEnvVars();
    const handle = makeBrowserHandle();
    const config = makeConfig();

    const result = await authenticate(handle, "nonexistent-profile", config);

    expect(result.error).not.toContain(TEST_USERNAME);
    expect(result.error).not.toContain(TEST_PASSWORD);
  });

  // -------------------------------------------------------------------------
  // OWASP A09: Security Logging and Monitoring Failures — redact before logging
  // -------------------------------------------------------------------------

  // OWASP A09: Security Logging and Monitoring Failures
  it("redact() sanitises a string that exactly equals the username", () => {
    setCredentialEnvVars();
    const profile = makeProfile();
    const output = redact(TEST_USERNAME, profile);
    expect(output).toBe("[REDACTED]");
    expect(output).not.toContain(TEST_USERNAME);
  });

  // OWASP A09: Security Logging and Monitoring Failures
  it("redact() sanitises a string that exactly equals the password", () => {
    setCredentialEnvVars();
    const profile = makeProfile();
    const output = redact(TEST_PASSWORD, profile);
    expect(output).toBe("[REDACTED
