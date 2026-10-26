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
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when `.specguard/config.json` cannot be found. */
export class ConfigNotFoundError extends SpecGuardError {
  /** An extra line for the person, when something other than a missing `init` explains it (an overlay that did not match). */
  readonly hint?: string;

  constructor(searchedFrom: string, hint?: string) {
    super(
      `No config found (searched from ${searchedFrom}). Run \`specguard init\` to create one.${hint ? `\n${hint}` : ''}`,
      ExitCode.InternalError,
    );
    this.name = 'ConfigNotFoundError';
    if (hint) this.hint = hint;
    Object.setPrototypeOf(this, ConfigNotFoundError.prototype);
  }
}

/** One overlay config that claims a directory. */
export interface AmbiguousCandidate {
  config: string;
  overlayRoot: string;
  app: string;
  /** The application folder the config points at. */
  repo?: string;
}

/**
 * Thrown when two overlay configs claim the same directory: SpecGuard never guesses which one is meant. `enclosing` is
 * set when they claim it as the git repository that encloses their own folders (a monorepo started at its root).
 */
export class ConfigAmbiguousError extends SpecGuardError {
  /** The overlay configs that claim the directory. */
  readonly candidates: AmbiguousCandidate[];

  constructor(dir: string, candidates: AmbiguousCandidate[], opts: { enclosing?: boolean } = {}) {
    const list = candidates.map((c) => `${c.config} (overlay ${c.overlayRoot}, app ${c.app})`).join(' and ');
    const apps = [...new Set(candidates.flatMap((c) => (c.repo ? [c.repo] : [])))];
    super(
      opts.enclosing
        ? `More than one overlay config covers the git repository ${dir}: ${list}. Start from inside one of the apps (${apps.join(', ')}) or pass --config <path> / SPECGUARD_CONFIG=<path>.`
        : `More than one overlay config covers ${dir}: ${list}. Pick one with --config <path> or SPECGUARD_CONFIG=<path>.`,
      ExitCode.InternalError,
    );
    this.name = 'ConfigAmbiguousError';
    this.candidates = candidates;
    Object.setPrototypeOf(this, ConfigAmbiguousError.prototype);
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

/** Thrown when a v2 spec's YAML frontmatter is malformed or has an invalid field. */
export class SpecFrontmatterError extends SpecGuardError {
  constructor(file: string, message: string, cause?: unknown) {
    super(`Invalid spec frontmatter in ${file}: ${message}`, ExitCode.InternalError, cause);
    this.name = 'SpecFrontmatterError';
    Object.setPrototypeOf(this, SpecFrontmatterError.prototype);
  }
}
