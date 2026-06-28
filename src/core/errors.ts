import { ExitCode } from './exit-codes.js';

/**
 * Base error type for SpecGuard. Carries a process exit code so the CLI can
 * translate a thrown error into the correct exit status without a lookup table.
 */
export class SpecGuardError extends Error {
  /** Suggested process exit code. */
  readonly exitCode: number;
  /** Optional underlying cause. */
  readonly cause?: unknown;

  constructor(message: string, exitCode: number = ExitCode.InternalError, cause?: unknown) {
    super(message);
    this.name = 'SpecGuardError';
    this.exitCode = exitCode;
    this.cause = cause;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, SpecGuardError.prototype);
  }
}

/** Thrown when `.specguard/config.json` cannot be found. */
export class ConfigNotFoundError extends SpecGuardError {
  constructor(searchedFrom: string) {
    super(
      `No config found (searched from ${searchedFrom}). Run \`specguard init\` to create one.`,
      ExitCode.InternalError,
    );
    this.name = 'ConfigNotFoundError';
    Object.setPrototypeOf(this, ConfigNotFoundError.prototype);
  }
}

/** Thrown when config exists but fails schema validation. */
export class ConfigInvalidError extends SpecGuardError {
  constructor(message: string, cause?: unknown) {
    super(`Invalid config: ${message}`, ExitCode.InternalError, cause);
    this.name = 'ConfigInvalidError';
    Object.setPrototypeOf(this, ConfigInvalidError.prototype);
  }
}
