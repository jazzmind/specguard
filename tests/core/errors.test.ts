import { describe, it, expect } from "vitest";
import { SpecGuardError, ConfigNotFoundError, ConfigInvalidError, ExitCode } from "specguard-core/errors";

describe("SpecGuard Core Error Classes", () => {
  it("Constructing SpecGuardError with default exit code", () => {
    const error = new SpecGuardError("something went wrong");

    expect(error instanceof SpecGuardError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error.message).toBe("something went wrong");
    expect(error.exitCode).toBe(ExitCode.InternalError);
    expect(error.cause).toBeUndefined();
    expect(error.name).toBe("SpecGuardError");
  });

  it("Constructing SpecGuardError with explicit exit code and cause", () => {
    const rootCause = new TypeError("root cause");
    const error = new SpecGuardError("custom message", 42, rootCause);

    expect(error.exitCode).toBe(42);
    expect(error.cause).toBe(rootCause);
    expect(error.message).toBe("custom message");
  });

  it("ConfigNotFoundError message and prototype chain", () => {
    const error = new ConfigNotFoundError("/home/user/project");

    expect(error instanceof ConfigNotFoundError).toBe(true);
    expect(error instanceof SpecGuardError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error.message).toContain("/home/user/project");
    expect(error.message).toContain("specguard init");
    expect(error.name).toBe("ConfigNotFoundError");
  });

  it("ConfigInvalidError message, cause, and prototype chain", () => {
    const syntaxError = new SyntaxError("parse failure");
    const error = new ConfigInvalidError("missing required field 'rules'", syntaxError);

    expect(error instanceof ConfigInvalidError).toBe(true);
    expect(error instanceof SpecGuardError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error.message).toMatch(/^Invalid config:/);
    expect(error.message).toContain("missing required field 'rules'");
    expect(error.cause).toBe(syntaxError);
    expect(error.name).toBe("ConfigInvalidError");
  });

  it("ConfigInvalidError constructed without a cause", () => {
    const error = new ConfigInvalidError("unknown field 'foo'");

    expect(error.cause).toBeUndefined();
    expect(error.message).toBe("Invalid config: unknown field 'foo'");
  });
});
