import { describe, it, expect } from "vitest";
import { ExitCode, exitCodeLabel } from "src/core/exit-codes";

describe("Exit Codes", () => {
  it("Retrieving a known exit code value", () => {
    expect(ExitCode.Success).toBe(0);
    expect(ExitCode.InternalError).toBe(1);
    expect(ExitCode.ValidationFailed).toBe(2);
    expect(ExitCode.DriftDetected).toBe(3);
    expect(ExitCode.MissingSpecs).toBe(4);
    expect(ExitCode.SecurityIssues).toBe(5);
    expect(ExitCode.HealFailed).toBe(7);
  });

  it("Obtaining a label for each defined exit code", () => {
    expect(exitCodeLabel(0)).toBe("success");
    expect(exitCodeLabel(1)).toBe("internal error");
    expect(exitCodeLabel(2)).toBe("validation failed");
    expect(exitCodeLabel(3)).toBe("drift detected");
    expect(exitCodeLabel(4)).toBe("missing specs");
    expect(exitCodeLabel(5)).toBe("security issues");
    expect(exitCodeLabel(7)).toBe("heal failed");
  });

  it("Obtaining a label for an unknown exit code", () => {
    expect(exitCodeLabel(6)).toBe("unknown (6)");
    expect(exitCodeLabel(99)).toBe("unknown (99)");
    expect(exitCodeLabel(-1)).toBe("unknown (-1)");
  });

  it("Verifying no duplicate numeric values exist", () => {
    const values = Object.values(ExitCode);
    const uniqueValues = new Set(values);
    expect(values).toHaveLength(7);
    expect(uniqueValues.size).toBe(7);
  });

  it("Type safety prevents arbitrary number assignment", () => {
    // @ts-expect-error - 6 is not a valid ExitCode value
    const invalid: ExitCode = 6;
    void invalid;

    const valid: ExitCode = ExitCode.Success;
    expect(valid).toBe(0);
  });
});
