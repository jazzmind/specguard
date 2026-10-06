/**
 * Typed process exit codes for SpecGuard.
 *
 * Each pipeline returns one of these in `PipelineResult.exitCode`; the CLI
 * passes it to `process.exit`. Values are stable — CI and the MCP server
 * depend on them.
 */
export const ExitCode = {
  /** All checks passed / command succeeded. */
  Success: 0,
  /** Internal error (unexpected, config missing, bad args). */
  InternalError: 1,
  /** Validation failed (critical/major issues found). */
  ValidationFailed: 2,
  /** Drift detected (specs are stale). */
  DriftDetected: 3,
  /** Missing specs (uncovered features found by status). */
  MissingSpecs: 4,
  /** Security issues found. */
  SecurityIssues: 5,
  /** Heal failed (tests still broken after max retries). */
  HealFailed: 7,
  /** The LLM spend cap (`llm.budget`) was reached. */
  BudgetExceeded: 8,
} as const;

/**
 * Exit codes of `specguard remediate`. These are command-scoped: 8 is also
 * `ExitCode.BudgetExceeded` for the other commands, so under `remediate` a reached
 * LLM budget is reported as `RemediateExit.SetupError` (11) instead.
 * 5 (`ExitCode.SecurityIssues`) stays "findings present" for `--scan-only`.
 */
export const RemediateExit = {
  /** Branch/PR produced and behavior verdict PRESERVED. */
  Preserved: 8,
  /** Verdict CHANGED: draft PR opened or the change rolled back. */
  Changed: 9,
  /** Verdict INCONCLUSIVE (flaky tests, unparseable output, coverage gaps). */
  Inconclusive: 10,
  /** Baseline not green, or a tool/setup error. */
  SetupError: 11,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Human-readable label for an exit code (for logging). */
export function remediateExitLabel(code: number): string {
  switch (code) {
    case RemediateExit.Preserved:
      return 'preserved';
    case RemediateExit.Changed:
      return 'changed';
    case RemediateExit.Inconclusive:
      return 'inconclusive';
    case RemediateExit.SetupError:
      return 'baseline not green or setup error';
    default:
      return exitCodeLabel(code);
  }
}

export function exitCodeLabel(code: number): string {
  switch (code) {
    case ExitCode.Success:
      return 'success';
    case ExitCode.InternalError:
      return 'internal error';
    case ExitCode.ValidationFailed:
      return 'validation failed';
    case ExitCode.DriftDetected:
      return 'drift detected';
    case ExitCode.MissingSpecs:
      return 'missing specs';
    case ExitCode.SecurityIssues:
      return 'security issues';
    case ExitCode.HealFailed:
      return 'heal failed';
    case ExitCode.BudgetExceeded:
      return 'llm budget exceeded';
    default:
      return `unknown (${code})`;
  }
}
