# SpecGuard Extension Entry Point

<!-- module: specguard-extension/src/extension / type: vscode-extension / status: draft -->

## Overview

This module is the activation entry point for the SpecGuard VS Code / Cursor extension. On activation it initialises workspace state, registers a coverage tree view in the sidebar, optionally displays a status bar item showing spec coverage, and registers all extension commands. It also watches for changes to spec Markdown files to trigger automatic coverage refreshes, and offers first-time Cursor users the option to register the SpecGuard MCP server so AI agents can invoke SpecGuard tools directly.

## Acceptance Criteria

1. The extension activates without error and initialises workspace state and the extension path.
2. A tree view with ID `specguard.coverageView` is created with collapse-all support and a `CoverageProvider` as its data source.
3. When `specguard.showStatusBar` is `true` (default), a status bar item is visible on the left with the text `$(shield) SpecGuard`, tooltip `SpecGuard — click to view spec coverage`, and command `specguard.status`.
4. When `specguard.showStatusBar` is `false`, no status bar item is created or shown.
5. All extension commands are registered via `registerCommands`.
6. When `specguard.autoRefresh` is `true` (default), a file system watcher monitors `**/specs/**/*.md` and calls `coverageProvider.refresh()` on any create, change, or delete event.
7. When `specguard.autoRefresh` is `false`, no file system watcher is created.
8. An initial non-blocking coverage refresh is triggered immediately after activation.
9. On first activation inside Cursor, the user is shown a one-time information message offering MCP server registration; choosing "Register" invokes `registerMcpForCursor()`.
10. The MCP offer is shown at most once per global state; subsequent activations skip the prompt.
11. The MCP offer is never shown when the host application is not Cursor.
12. On deactivation, the status bar item is disposed if it was created.

## Scenarios

### Scenario 1: Activation with default settings in VS Code

**Steps:**
1. Open a workspace in VS Code (non-Cursor) with no prior SpecGuard global state.
2. Activate the SpecGuard extension.
3. Inspect the sidebar for a tree view with ID `specguard.coverageView`.
4. Inspect the status bar for an item with text `$(shield) SpecGuard`.
5. Inspect registered commands for all commands registered by `registerCommands`.
6. Observe that no MCP registration prompt appears.

**Expected Results:**
- The tree view `specguard.coverageView` is present and has collapse-all enabled.
- A status bar item is visible on the left side with text `$(shield) SpecGuard`, tooltip `SpecGuard — click to view spec coverage`, and command `specguard.status`.
- All commands from `registerCommands` are registered in the extension context.
- No information message regarding MCP registration is displayed.

---

### Scenario 2: Status bar hidden via configuration

**Steps:**
1. Set the workspace configuration `specguard.showStatusBar` to `false`.
2. Activate the SpecGuard extension.
3. Inspect the status bar for any SpecGuard item.

**Expected Results:**
- No status bar item with text `$(shield) SpecGuard` is created or visible.

---

### Scenario 3: Auto-refresh triggers coverage reload on spec file change

**Steps:**
1. Ensure `specguard.autoRefresh` is `true` (default).
2. Activate the SpecGuard extension.
3. Create a new file matching the glob `**/specs/**/*.md` in the workspace.
4. Modify the file.
5. Delete the file.

**Expected Results:**
- `coverageProvider.refresh()` is called once for the create event.
- `coverageProvider.refresh()` is called once for the change event.
- `coverageProvider.refresh()` is called once for the delete event.

---

### Scenario 4: Auto-refresh disabled via configuration

**Steps:**
1. Set the workspace configuration `specguard.autoRefresh` to `false`.
2. Activate the SpecGuard extension.
3. Create or modify a file matching `**/specs/**/*.md`.

**Expected Results:**
- No file system watcher is registered.
- `coverageProvider.refresh()` is not called in response to file system events (only the initial refresh on activation occurs).

---

### Scenario 5: MCP registration offered on first Cursor activation

**Steps:**
1. Ensure the global state key `specguard.mcpOfferShown` is absent or `false`.
2. Activate the extension in a Cursor environment (`vscode.env.appName` contains `cursor`).
3. Observe the information message displayed.
4. Click "Register".

**Expected Results:**
- An information message is shown with the text `SpecGuard: Register the MCP server with Cursor so AI agents can use specguard tools directly?` and buttons "Register" and "Not now".
- Clicking "Register" invokes `registerMcpForCursor()`.
- The global state key `specguard.mcpOfferShown` is set to `true`.

---

### Scenario 6: MCP registration offer dismissed and not repeated

**Steps:**
1. Ensure the global state key `specguard.mcpOfferShown` is absent or `false`.
2. Activate the extension in a Cursor environment.
3. Click "Not now" on the information message.
4. Deactivate and reactivate the extension.

**Expected Results:**
- `registerMcpForCursor()` is not called.
- On the second activation, no information message is shown.
- The global state key `specguard.mcpOfferShown` remains `true`.

---

### Scenario 7: MCP offer skipped in non-Cursor host

**Steps:**
1. Ensure the global state key `specguard.mcpOfferShown` is `false`.
2. Activate the extension in VS Code (app name does not contain `cursor`).

**Expected Results:**
- No information message regarding MCP registration is displayed.
- `registerMcpForCursor()` is not called.
- The global state key `specguard.mcpOfferShown` remains `false`.

---

### Scenario 8: Deactivation disposes status bar item

**Steps:**
1. Activate the extension with `specguard.showStatusBar` set to `true`.
2. Confirm the status bar item is visible.
3. Call the extension's `deactivate()` function.
4. Inspect the status bar for the SpecGuard item.

**Expected Results:**
- The status bar item is disposed and no longer visible after `deactivate()` is called.

---

### Scenario 9: Initial coverage refresh on activation

**Steps:**
1. Activate the SpecGuard extension.
2. Observe calls to `coverageProvider.refresh()` immediately after activation completes.

**Expected Results:**
- `coverageProvider.refresh()` is called once during activation (non-blocking, i.e., activation does not await its completion).

## Security Notes

- No secrets, API keys, or credentials are present in this module.
- The extension reads only workspace configuration and global state; it does not transmit data externally from this entry point.
- MCP registration is gated behind explicit user consent via an information message prompt.

## Dependencies

- `vscode` — VS Code extension API for tree views, status bar, file system watchers, configuration, and environment detection.
- `./sidebar.js` (`CoverageProvider`) — Provides tree view data for spec coverage.
- `./commands.js` (`registerCommands`) — Registers all SpecGuard commands with the extension context.
- `./mcp-registration.js` (`registerMcpForCursor`) — Handles MCP server registration for Cursor.
- `./workspace-state.js` (`initWorkspaceState`, `getActiveWorkspaceRoot`) — Initialises and manages workspace state.
- `./dashboard/cli.js` (`setExtensionPath`) — Configures the CLI with the extension installation path.