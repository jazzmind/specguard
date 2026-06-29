# Workspace State Management

<!-- module: specguard-extension/src/workspace-state / type: feature / status: draft -->

## Overview

This module manages the "active workspace root" for the SpecGuard VS Code extension, determining which folder the extension operates on in a multi-root workspace. It persists the user's selection across sessions using VS Code's `workspaceState` API under the key `specguard.activeWorkspaceRoot`. When only one workspace folder is open, the active root is resolved trivially without user interaction. When multiple folders are present, the user may switch the active project via a Quick Pick interface. The module validates stored paths against currently open folders and falls back to the first folder when the stored value is stale or absent.

## Acceptance Criteria

- AC-1: `initWorkspaceState` must be called with a valid `ExtensionContext` before any other function in this module is used.
- AC-2: `getActiveWorkspaceRoot` returns `undefined` when no workspace folders are open.
- AC-3: `getActiveWorkspaceRoot` returns the stored path when it exists on disk and matches an open workspace folder.
- AC-4: `getActiveWorkspaceRoot` falls back to the first workspace folder's path when the stored path is missing, no longer on disk, or no longer in the open folder list.
- AC-5: `setActiveWorkspaceRoot` persists the given path to workspace state under the key `specguard.activeWorkspaceRoot`.
- AC-6: `pickWorkspaceRoot` shows an error message and returns `undefined` when no workspace folders are open.
- AC-7: `pickWorkspaceRoot` skips the Quick Pick and immediately returns the single folder's path when exactly one workspace folder is open.
- AC-8: `pickWorkspaceRoot` presents all open workspace folders in a Quick Pick when multiple folders are open, annotating the current project with a checkmark detail and SpecGuard-configured folders with a shield detail.
- AC-9: `pickWorkspaceRoot` returns `undefined` when the user dismisses the Quick Pick without selecting an item.
- AC-10: A folder is considered "SpecGuard-configured" if and only if `.specguard/config.json` exists at its root.

## Scenarios

### Scenario 1: No workspace folders open

**Steps:**
1. Ensure VS Code reports zero workspace folders (`vscode.workspace.workspaceFolders` is empty or undefined).
2. Call `getActiveWorkspaceRoot()`.

**Expected Results:**
- The return value is `undefined`.

---

### Scenario 2: Single workspace folder — active root resolved without picker

**Steps:**
1. Open exactly one workspace folder.
2. Call `initWorkspaceState(context)` with a valid extension context.
3. Call `getActiveWorkspaceRoot()`.

**Expected Results:**
- The return value equals the `fsPath` of the single open workspace folder.
- No Quick Pick UI is displayed.

---

### Scenario 3: Stored path is valid and matches an open folder

**Steps:**
1. Open two or more workspace folders.
2. Call `initWorkspaceState(context)`.
3. Call `setActiveWorkspaceRoot(folders[1].uri.fsPath)` to persist the second folder.
4. Confirm the second folder's path exists on disk.
5. Call `getActiveWorkspaceRoot()`.

**Expected Results:**
- The return value equals `folders[1].uri.fsPath`.

---

### Scenario 4: Stored path no longer matches any open folder — fallback to first

**Steps:**
1. Open two workspace folders.
2. Call `initWorkspaceState(context)`.
3. Manually write an arbitrary non-existent path into workspace state under key `specguard.activeWorkspaceRoot`.
4. Call `getActiveWorkspaceRoot()`.

**Expected Results:**
- The return value equals `folders[0].uri.fsPath` (the first open folder).

---

### Scenario 5: Stored path exists on disk but is not in the open folder list — fallback to first

**Steps:**
1. Open one workspace folder.
2. Call `initWorkspaceState(context)`.
3. Persist a path via `setActiveWorkspaceRoot` that exists on disk but is not among the currently open workspace folders.
4. Call `getActiveWorkspaceRoot()`.

**Expected Results:**
- The return value equals `folders[0].uri.fsPath`.

---

### Scenario 6: `pickWorkspaceRoot` with no open folders shows error

**Steps:**
1. Ensure no workspace folders are open.
2. Call `pickWorkspaceRoot()`.

**Expected Results:**
- `vscode.window.showErrorMessage` is called with the message `'SpecGuard: open a workspace folder first.'`.
- The return value is `undefined`.

---

### Scenario 7: `pickWorkspaceRoot` with a single folder skips Quick Pick

**Steps:**
1. Open exactly one workspace folder.
2. Call `initWorkspaceState(context)`.
3. Call `pickWorkspaceRoot()`.

**Expected Results:**
- `vscode.window.showQuickPick` is **not** called.
- The return value equals the single folder's `fsPath`.

---

### Scenario 8: `pickWorkspaceRoot` with multiple folders — item annotations

**Steps:**
1. Open three workspace folders: `folderA` (current active, no config), `folderB` (has `.specguard/config.json`), `folderC` (no config, not current).
2. Call `initWorkspaceState(context)` and `setActiveWorkspaceRoot(folderA.uri.fsPath)`.
3. Call `pickWorkspaceRoot()`.
4. Inspect the items passed to `vscode.window.showQuickPick`.

**Expected Results:**
- The Quick Pick title is `'SpecGuard: Switch Project'`.
- The item for `folderA` has `detail` equal to `'$(check) current project'`.
- The item for `folderB` has `detail` equal to `'$(shield) configured'`.
- The item for `folderC` has an empty `detail` string.
- Each item's `description` equals the folder's `fsPath`.

---

### Scenario 9: `pickWorkspaceRoot` — user selects a folder

**Steps:**
1. Open two workspace folders.
2. Call `initWorkspaceState(context)`.
3. Stub `vscode.window.showQuickPick` to resolve with the Quick Pick item representing `folders[1]`.
4. Call `pickWorkspaceRoot()`.

**Expected Results:**
- The return value equals `folders[1].uri.fsPath`.

---

### Scenario 10: `pickWorkspaceRoot` — user cancels the Quick Pick

**Steps:**
1. Open two workspace folders.
2. Call `initWorkspaceState(context)`.
3. Stub `vscode.window.showQuickPick` to resolve with `undefined` (user pressed Escape).
4. Call `pickWorkspaceRoot()`.

**Expected Results:**
- The return value is `undefined`.

---

### Scenario 11: `setActiveWorkspaceRoot` persists the path

**Steps:**
1. Call `initWorkspaceState(context)`.
2. Call `setActiveWorkspaceRoot('/path/to/my-project')`.
3. Read the value stored in `context.workspaceState` under key `specguard.activeWorkspaceRoot`.

**Expected Results:**
- The stored value equals `'/path/to/my-project'`.

## Security Notes

- No credentials, tokens, or secrets are handled by this module.
- Stored workspace root paths are file-system paths only; they are validated against `fs.existsSync` and the current open folder list before use, preventing stale or injected paths from being acted upon.
- The module does not expose workspace state contents to any external service or network endpoint.

## Dependencies

- `vscode` — Extension API for workspace folder enumeration, workspace state persistence (`ExtensionContext.workspaceState`), Quick Pick UI (`window.showQuickPick`), and error messages (`window.showErrorMessage`).
- `path` (Node.js built-in) — Used to construct the `.specguard/config.json` path for configuration detection.
- `fs` (Node.js built-in) — Used to verify that stored paths and SpecGuard config files exist on disk.