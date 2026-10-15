# SpecGuard Core Error Classes

<!-- module: specguard-core/errors / type: library / status: draft -->

## Overview

This module defines the base and specialised error classes used throughout the SpecGuard core. `SpecGuardError` extends the native `Error` class and attaches a numeric exit code so the CLI layer can translate any thrown error directly into the correct process exit status. `ConfigNotFoundError` is raised when the `.specguard/config.json` file cannot be located during a directory search. `ConfigInvalidError` is raised when a config file is found but fails schema validation. All classes restore the prototype chain explicitly to ensure `instanceof` checks work correctly across transpilation targets.

## Acceptance Criteria

- AC-1: `SpecGuardError` must be an instance of both `Error` and `SpecGuardError` after construction.
- AC-2: `SpecGuardError` must expose a readonly `exitCode` property set to the value passed at construction, defaulting to `ExitCode.InternalError` when omitted.
- AC-3: `SpecGuardError` must expose a readonly `cause` property that holds the optional underlying error or value passed at construction.
- AC-4: `SpecGuardError#name` must equal `"SpecGuardError"`.
- AC-5: `ConfigNotFoundError` must be an instance of `SpecGuardError`, `ConfigNotFoundError`, and `Error`.
- AC-6: `ConfigNotFoundError` must produce a message containing the `searchedFrom` path and the hint to run `specguard init`.
- AC-7: `ConfigNotFoundError#name` must equal `"ConfigNotFoundError"`.
- AC-8: `ConfigInvalidError` must be an instance of `SpecGuardError`, `ConfigInvalidError`, and `Error`.
- AC-9: `ConfigInvalidError` must produce a message prefixed with `"Invalid config:"` followed by the supplied message fragment.
- AC-10: `ConfigInvalidError` must forward an optional `cause` value to the base class.
- AC-11: `ConfigInvalidError#name` must equal `"ConfigInvalidError"`.

## Scenarios

### Scenario 1: Constructing SpecGuardError with default exit code

**Steps:**
1. Import `SpecGuardError` from `src/core/errors.ts`.
2. Construct `new SpecGuardError("something went wrong")`.
3. Assert `error instanceof SpecGuardError` is `true`.
4. Assert `error instanceof Error` is `true`.
5. Assert `error.message` equals `"something went wrong"`.
6. Assert `error.exitCode` equals the value of `ExitCode.InternalError`.
7. Assert `error.cause` is `undefined`.
8. Assert `error.name` equals `"SpecGuardError"`.

**Expected Results:**
- All assertions pass without throwing.

---

### Scenario 2: Constructing SpecGuardError with explicit exit code and cause

**Steps:**
1. Import `SpecGuardError` from `src/core/errors.ts`.
2. Construct `new SpecGuardError("custom message", 42, new TypeError("root cause"))`.
3. Assert `error.exitCode` equals `42`.
4. Assert `error.cause` is the `TypeError` instance passed as the third argument.
5. Assert `error.message` equals `"custom message"`.

**Expected Results:**
- `exitCode` reflects the explicitly supplied value.
- `cause` holds the supplied underlying error.

---

### Scenario 3: ConfigNotFoundError message and prototype chain

**Steps:**
1. Import `ConfigNotFoundError` from `src/core/errors.ts`.
2. Construct `new ConfigNotFoundError("/home/user/project")`.
3. Assert `error instanceof ConfigNotFoundError` is `true`.
4. Assert `error instanceof SpecGuardError` is `true`.
5. Assert `error instanceof Error` is `true`.
6. Assert `error.message` contains the string `"/home/user/project"`.
7. Assert `error.message` contains the string `` `specguard init` ``.
8. Assert `error.name` equals `"ConfigNotFoundError"`.

**Expected Results:**
- Prototype chain is intact across all three classes.
- Message includes both the searched path and the remediation hint.

---

### Scenario 4: ConfigInvalidError message, cause, and prototype chain

**Steps:**
1. Import `ConfigInvalidError` from `src/core/errors.ts`.
2. Construct `new ConfigInvalidError("missing required field 'rules'", new SyntaxError("parse failure"))`.
3. Assert `error instanceof ConfigInvalidError` is `true`.
4. Assert `error instanceof SpecGuardError` is `true`.
5. Assert `error instanceof Error` is `true`.
6. Assert `error.message` starts with `"Invalid config:"`.
7. Assert `error.message` contains `"missing required field 'rules'"`.
8. Assert `error.cause` is the `SyntaxError` instance supplied as the second argument.
9. Assert `error.name` equals `"ConfigInvalidError"`.

**Expected Results:**
- Prototype chain is intact across all three classes.
- Message is correctly prefixed and includes the supplied detail.
- `cause` is forwarded to the base class.

---

### Scenario 5: ConfigInvalidError constructed without a cause

**Steps:**
1. Import `ConfigInvalidError` from `src/core/errors.ts`.
2. Construct `new ConfigInvalidError("unknown field 'foo'")`.
3. Assert `error.cause` is `undefined`.
4. Assert `error.message` equals `"Invalid config: unknown field 'foo'"`.

**Expected Results:**
- `cause` is `undefined` when not supplied.
- Message is still correctly formed.

## Security Notes

- No credentials, tokens, API keys, or other secret values are handled by this module.
- The `searchedFrom` path embedded in `ConfigNotFoundError` messages originates from the local filesystem; callers must ensure this value is not derived from untrusted external input before surfacing it in user-facing output.

## Dependencies

- `ExitCode` enum imported from `./exit-codes.js` — provides the default `InternalError` exit code value used by all error classes in this module.