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
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Human-readable label for an exit code (for logging). */
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
    default:
      return `unknown (${code})`;
  }
}
