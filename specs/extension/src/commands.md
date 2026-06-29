# SpecGuard VS Code Extension – Command Handlers

<!-- module: specguard-extension/src/commands / type: feature / status: draft -->

## Overview

This module registers all VS Code command handlers for the SpecGuard extension. Commands cover the full SpecGuard workflow: initialising a project, checking coverage status, detecting spec drift, generating tests, running security scans, switching the active workspace project, refreshing the coverage sidebar, registering the MCP integration for Cursor, and opening the dashboard panel. Each command resolves the active workspace root before acting and surfaces results either through VS Code information/error messages or by spawning a terminal. The CLI path used by commands is resolved from a user-configurable setting, a local `node_modules/.bin/specguard` binary, or falls back to `npx specguard`.

## Acceptance Criteria

1. All eight commands (`specguard.switchProject`, `specguard.init`, `specguard.status`, `specguard.drift`, `specguard.generateTests`, `specguard.securityScan`, `specguard.registerMcp`, `specguard.refreshCoverage`, `specguard.openDashboard`) are registered and appear in the VS Code command palette.
2. Commands that require an active workspace root display an error message and abort when none is set.
3. `specguard.init` watches the workspace for a `.specguard/config.json` file and refreshes the coverage view and shows a success message when the file appears; the watcher closes after 30 seconds regardless.
4. `specguard.status` refreshes coverage data, updates the status bar item text to `$(shield) SpecGuard <pct>%`, and shows an information message with the same percentage.
5. `specguard.generateTests` accepts an optional URI; when a URI is provided the spec key is derived from the file path relative to the workspace `specs/` directory; when no URI is provided the user is prompted for a spec key or may leave it blank to generate for all specs.
6. `specguard.securityScan` accepts an optional URI and derives the spec key the same way as `generateTests`; omitting a URI runs the scan across all specs.
7. `specguard.switchProject` prompts the user to pick a workspace root, sets it as active, refreshes coverage, shows a confirmation message with the folder name, and reopens the dashboard panel.
8. CLI path resolution honours the `specguard.cliPath` configuration setting; if unset it prefers a local `node_modules/.bin/specguard` binary and falls back to `npx specguard`.
9. No secret values (API keys, tokens, credentials) are passed through or logged by any command.

## Scenarios

### Scenario 1: Switch active project

**Steps:**
1. Invoke the `specguard.switchProject` command from the command palette.
2. A workspace-root picker appears; select a workspace folder.
3. Observe the VS Code notification area.
4. Observe the dashboard panel.

**Expected Results:**
- An information message matching `SpecGuard: switched to project "<folderName>"` is displayed, where `<folderName>` is the `path.basename` of the selected root.
- The coverage sidebar refreshes (provider `refresh()` is called).
- The dashboard panel opens or reopens pointing at the newly selected root.

### Scenario 2: Switch project cancelled by user

**Steps:**
1. Invoke `specguard.switchProject`.
2. Dismiss the workspace-root picker without selecting a folder.

**Expected Results:**
- No information message is shown.
- The active workspace root is unchanged.
- The coverage sidebar is not refreshed.

### Scenario 3: Init with no workspace open

**Steps:**
1. Ensure no active workspace root is set.
2. Invoke `specguard.init`.

**Expected Results:**
- An error message `No workspace folder open.` is displayed.
- No terminal is created.

### Scenario 4: Init detects config file and refreshes coverage

**Steps:**
1. Set an active workspace root.
2. Invoke `specguard.init`.
3. Observe that a terminal named `SpecGuard Init` is created and the CLI `init` command is sent to it.
4. Simulate the appearance of a file matching `*.specguard/config.json` inside the workspace within 30 seconds.

**Expected Results:**
- The terminal is shown with the correct init command.
- The coverage sidebar refreshes.
- An information message `SpecGuard initialized! Coverage view updated.` is displayed.
- The file watcher closes after the config file is detected.

### Scenario 5: Init watcher timeout

**Steps:**
1. Set an active workspace root.
2. Invoke `specguard.init`.
3. Allow 30 seconds to elapse without a `.specguard/config.json` file appearing.

**Expected Results:**
- The file watcher closes automatically after 30 seconds.
- No success message is shown.

### Scenario 6: Status command updates status bar and message

**Steps:**
1. Set an active workspace root with known coverage data.
2. Invoke `specguard.status`.
3. Observe the status bar item text.
4. Observe the VS Code notification area.

**Expected Results:**
- The coverage provider `refresh()` is called.
- The status bar item text is set to `$(shield) SpecGuard <pct>%` where `<pct>` matches `coverageProvider.getCoveragePercent()`.
- An information message `SpecGuard coverage: <pct>%` is displayed.

### Scenario 7: Drift command runs in terminal

**Steps:**
1. Set an active workspace root.
2. Invoke `specguard.drift`.
3. Observe the terminal created.

**Expected Results:**
- A terminal named `SpecGuard Drift` is created with its working directory set to the active workspace root.
- The command `npx specguard drift` is sent to the terminal.
- The terminal is shown.

### Scenario 8: Generate tests with a URI (spec file selected)

**Steps:**
1. Set an active workspace root at `/repo`.
2. Invoke `specguard.generateTests` with a `vscode.Uri` whose `fsPath` is `/repo/specs/core/parser.md`.
3. Observe the terminal created.

**Expected Results:**
- No input box is shown.
- A terminal named `SpecGuard Generate` is created.
- The command `npx specguard generate --spec core/parser` is sent to the terminal.

### Scenario 9: Generate tests without URI – user enters spec key

**Steps:**
1. Set an active workspace root.
2. Invoke `specguard.generateTests` with no URI argument.
3. An input box with prompt `Enter spec key (e.g. core/parser) or leave blank for --all` and placeholder `core/parser` appears; enter `auth/login`.
4. Observe the terminal created.

**Expected Results:**
- A terminal named `SpecGuard Generate` is created.
- The command `npx specguard generate --spec auth/login` is sent to the terminal.

### Scenario 10: Generate tests without URI – user leaves input blank

**Steps:**
1. Set an active workspace root.
2. Invoke `specguard.generateTests` with no URI argument.
3. The input box appears; confirm with an empty value.
4. Observe the terminal created.

**Expected Results:**
- A terminal named `SpecGuard Generate` is created.
- The command `npx specguard generate --all` is sent to the terminal.

### Scenario 11: Security scan with a URI

**Steps:**
1. Set an active workspace root at `/repo`.
2. Invoke `specguard.securityScan` with a `vscode.Uri` whose `fsPath` is `/repo/specs/payments/checkout.md`.
3. Observe the terminal created.

**Expected Results:**
- A terminal named `SpecGuard Security` is created.
- The command `npx specguard security --spec payments/checkout` is sent to the terminal.

### Scenario 12: Security scan without URI runs across all specs

**Steps:**
1. Set an active workspace root.
2. Invoke `specguard.securityScan` with no URI argument.
3. Observe the terminal created.

**Expected Results:**
- A terminal named `SpecGuard Security` is created.
- The command `npx specguard security --all` is sent to the terminal.

### Scenario 13: Refresh coverage command

**Steps:**
1. Invoke `specguard.refreshCoverage`.

**Expected Results:**
- The coverage provider `refresh()` is called.
- No terminal is created and no message is shown.

### Scenario 14: Open dashboard command

**Steps:**
1. Invoke `specguard.openDashboard`.

**Expected Results:**
- The dashboard panel opens (or is brought to focus if already open).

### Scenario 15: CLI path resolution – custom setting takes priority

**Steps:**
1. Set the VS Code setting `specguard.cliPath` to a non-empty custom path (e.g. `/usr/local/bin/specguard`).
2. Invoke `specguard.init` (which calls `resolveCliPath`).
3. Observe the command sent to the terminal.

**Expected Results:**
- The terminal receives the custom path value followed by ` init`, not `npx specguard init`.

### Scenario 16: CLI path resolution – falls back to npx when local binary absent

**Steps:**
1. Ensure `specguard.cliPath` is empty and no `node_modules/.bin/specguard` exists in the workspace.
2. Invoke `specguard.init`.
3. Observe the command sent to the terminal.

**Expected Results:**
- The terminal receives `npx specguard init`.

### Scenario 17: URI outside specs directory yields no spec key

**Steps:**
1. Set an active workspace root at `/repo`.
2. Invoke `specguard.generateTests` with a `vscode.Uri` whose `fsPath` is `/repo/src/utils/helper.ts` (not under `specs/`).
3. Observe the terminal created.

**Expected Results:**
- A terminal named `SpecGuard Generate` is created.
- The command `npx specguard generate --all` is sent to the terminal (spec key is undefined, so `--all` is used).

## Security Notes

- No credentials, API keys, or tokens are handled or transmitted by any command in this module.
- The `specguard.cliPath` configuration value is used directly as a shell command; administrators should restrict this setting to trusted values to prevent arbitrary command execution.
- File-system watching is scoped to the active workspace root and closes automatically after 30 seconds to avoid resource leaks.
- Terminal commands are constructed from workspace-relative paths and user-supplied spec keys; inputs are not sanitised beyond path derivation — extension consumers should ensure workspace paths do not contain shell-injection characters.

## Dependencies

| Dependency | Role |
|---|---|
| `vscode` (VS Code Extension API) | Command registration, terminal creation, input boxes, notifications, status bar, workspace configuration |
| `child_process` (Node.js built-in) | Imported; not directly invoked in this module (terminals used instead) |
| `path` (Node.js built-in) | Path joining, basename extraction, relative path computation, spec key derivation |
| `fs` (Node.js built-in) | Checking local CLI binary existence; watching workspace directory for config file |
| `./sidebar` (`CoverageProvider`) | Refreshing coverage data and reading coverage percentage |
| `./mcp-registration` (`registerMcpForCursor`) | MCP registration for Cursor invoked by `specguard.registerMcp` |
| `./dashboard/panel` (`openDashboardPanel`) | Opens or focuses the dashboard WebView panel |
| `./workspace-state` | `getActiveWorkspaceRoot`, `pickWorkspaceRoot`, `setActiveWorkspaceRoot` – workspace root management |