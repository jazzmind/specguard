# Stub Command Handlers

<!-- module: specguard-cli/commands/stubs / type: utility / status: draft -->

## Overview

The `stubs` module provides a factory function, `makeStub`, that generates placeholder async command handlers for CLI subcommands whose full pipelines have not yet been implemented. Each generated stub, when invoked, writes a human-readable "not yet implemented" message to standard output and exits the process with code 0. This allows the complete command surface and `--help` output to be available to users while individual subcommand pipelines are delivered incrementally. No error state is signalled; the exit is always clean.

## Acceptance Criteria

- `makeStub(name)` returns an async function with signature `() => Promise<void>`.
- When the returned handler is called, it writes exactly `"<name>: not yet implemented\n"` to `process.stdout`, where `<name>` is the string passed to `makeStub`.
- After writing the message, the process exits with code `0`.
- The handler does not throw, reject, or write to `process.stderr`.
- Multiple distinct stub names produce independent handlers, each printing their own name.

## Scenarios

### Scenario 1: Stub handler prints correct message for a given name

**Steps:**
1. Call `makeStub("generate")` to obtain a handler function.
2. Spy on `process.stdout.write` and `process.exit`.
3. Invoke the returned handler (await the returned Promise).

**Expected Results:**
- `process.stdout.write` is called exactly once with the argument `"generate: not yet implemented\n"`.
- `process.exit` is called exactly once with the argument `0`.
- `process.stderr.write` is never called.

---

### Scenario 2: Stub handler uses the exact name passed to the factory

**Steps:**
1. Call `makeStub("validate")` to obtain a handler function.
2. Spy on `process.stdout.write` and `process.exit`.
3. Invoke the returned handler.

**Expected Results:**
- `process.stdout.write` is called with `"validate: not yet implemented\n"` (not any other name).
- `process.exit` is called with `0`.

---

### Scenario 3: Multiple stubs are independent

**Steps:**
1. Call `makeStub("lint")` to obtain `handlerA`.
2. Call `makeStub("publish")` to obtain `handlerB`.
3. Spy on `process.stdout.write` and `process.exit`.
4. Invoke `handlerA`.
5. Reset spies.
6. Invoke `handlerB`.

**Expected Results:**
- After step 4: `process.stdout.write` is called with `"lint: not yet implemented\n"`.
- After step 6: `process.stdout.write` is called with `"publish: not yet implemented\n"`.
- Each invocation calls `process.exit(0)` independently.

---

### Scenario 4: Stub handler exits with code 0, not a non-zero code

**Steps:**
1. Call `makeStub("sync")` to obtain a handler function.
2. Spy on `process.exit`.
3. Invoke the returned handler.

**Expected Results:**
- `process.exit` is called with exactly `0`.
- `process.exit` is not called with `1` or any other non-zero value.

## Security Notes

- No secrets, credentials, or sensitive values are accepted or emitted by this module.
- The `name` parameter is written directly to stdout; callers must ensure stub names are controlled strings originating from the CLI command registry, not from external user input, to avoid unintended output content.

## Dependencies

- Node.js built-in `process` global (`process.stdout.write`, `process.exit`).
- No third-party runtime dependencies.
- Consumed by the CLI command registration layer to register placeholder handlers for unimplemented subcommands.