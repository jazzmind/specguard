# MCP Registration Helper

<!-- module: specguard-extension/src/mcp-registration / type: feature / status: draft -->

## Overview

The MCP Registration Helper writes a `specguard-mcp` server entry into the Cursor MCP configuration file located at `.cursor/mcp.json` within the active workspace folder. It is invoked either by the `specguard.registerMcp` command or automatically on first activation inside a Cursor environment. The operation is idempotent: if a `specguard-mcp` entry already exists in the config, it is overwritten in place with the current resolved values. The helper resolves the MCP binary from the local workspace `node_modules/.bin/specguard-mcp` when available, falling back to `npx specguard-mcp`. After a successful write, the user is shown an information message with an optional action to open the config file directly.

## Acceptance Criteria

- AC-1: When no workspace folder is open, a warning message is displayed and no file system changes are made.
- AC-2: The `.cursor/` directory is created recursively if it does not already exist.
- AC-3: If `.cursor/mcp.json` exists and is valid JSON, its existing content is preserved and the `specguard-mcp` key under `mcpServers` is added or updated.
- AC-4: If `.cursor/mcp.json` exists but cannot be parsed, a warning is shown and a fresh config object is used (existing file content is overwritten).
- AC-5: When `node_modules/.bin/specguard-mcp` exists in the workspace, the registered entry uses that path as `command` with an empty `args` array.
- AC-6: When `node_modules/.bin/specguard-mcp` does not exist, the registered entry uses `npx` as `command` with `["specguard-mcp"]` as `args`.
- AC-7: The written `specguard-mcp` entry always includes an `env` field set to an empty object.
- AC-8: The config file is written as pretty-printed JSON (2-space indent) with a trailing newline.
- AC-9: An information message is shown after a successful write; selecting "Open Config" opens the config file in the editor.

## Scenarios

### Scenario 1: No workspace folder open

**Steps:**
1. Ensure no workspace folder is open in the VS Code/Cursor instance.
2. Execute the `specguard.registerMcp` command (or call `registerMcpForCursor()` directly).

**Expected Results:**
- A warning notification appears with the text `SpecGuard: No workspace folder open. Cannot register MCP.`
- No `.cursor/` directory is created.
- No `mcp.json` file is created or modified.

---

### Scenario 2: First-time registration with no existing config and local binary present

**Steps:**
1. Open a workspace folder that has no `.cursor/` directory.
2. Ensure `node_modules/.bin/specguard-mcp` exists in the workspace root.
3. Call `registerMcpForCursor()`.

**Expected Results:**
- The `.cursor/` directory is created.
- `.cursor/mcp.json` is created with content matching:
  ```json
  {
    "mcpServers": {
      "specguard-mcp": {
        "command": "<workspace>/node_modules/.bin/specguard-mcp",
        "args": [],
        "env": {}
      }
    }
  }
  ```
- The file ends with a newline character.
- An information message appears containing `SpecGuard MCP server registered in` and the path to `mcp.json`.

---

### Scenario 3: First-time registration with no existing config and no local binary

**Steps:**
1. Open a workspace folder that has no `.cursor/` directory.
2. Ensure `node_modules/.bin/specguard-mcp` does **not** exist in the workspace root.
3. Call `registerMcpForCursor()`.

**Expected Results:**
- The `.cursor/` directory is created.
- `.cursor/mcp.json` is created with `command` set to `"npx"` and `args` set to `["specguard-mcp"]`.
- The `env` field is present and equals `{}`.
- An information message appears containing the path to `mcp.json`.

---

### Scenario 4: Idempotent update of an existing valid config

**Steps:**
1. Open a workspace folder containing `.cursor/mcp.json` with a pre-existing `mcpServers` entry for a different server (e.g., `"other-server"`).
2. Call `registerMcpForCursor()`.

**Expected Results:**
- The `"other-server"` entry is still present in the written file.
- A `"specguard-mcp"` entry is added under `mcpServers`.
- The file is valid JSON with 2-space indentation and a trailing newline.

---

### Scenario 5: Re-registration overwrites existing specguard-mcp entry

**Steps:**
1. Open a workspace folder where `.cursor/mcp.json` already contains a `specguard-mcp` entry with stale values.
2. Call `registerMcpForCursor()`.

**Expected Results:**
- The `specguard-mcp` entry in the written file reflects the newly resolved `command` and `args` values.
- No duplicate `specguard-mcp` keys exist in the output JSON.

---

### Scenario 6: Existing config file is malformed JSON

**Steps:**
1. Place a `.cursor/mcp.json` file in the workspace containing invalid JSON (e.g., `{ broken`).
2. Call `registerMcpForCursor()`.

**Expected Results:**
- A warning notification appears containing `Could not parse` and the path to `mcp.json`.
- `.cursor/mcp.json` is overwritten with a valid JSON file containing only the new `specguard-mcp` entry under `mcpServers`.

---

### Scenario 7: User selects "Open Config" from the success notification

**Steps:**
1. Call `registerMcpForCursor()` in a valid workspace (so the success notification appears).
2. Click the `"Open Config"` button in the information message.

**Expected Results:**
- The `vscode.open` command is executed with a `vscode.Uri` pointing to `.cursor/mcp.json`.
- The file opens in the editor.

## Security Notes

- The `env` field written to the MCP config is always an empty object; no credentials, tokens, or secrets are written to the config file by this module.
- The resolved binary path (`node_modules/.bin/specguard-mcp`) is derived solely from the workspace root; no user-supplied input is interpolated into the path.
- The config file is written with the permissions of the running process; no explicit permission hardening is applied.

## Dependencies

- `vscode` — workspace folder resolution, notifications, and command execution (`vscode.open`).
- `fs` (Node.js built-in) — directory creation, file existence checks, read, and write operations.
- `path` (Node.js built-in) — cross-platform path construction.
- `specguard-mcp` binary — expected at `node_modules/.bin/specguard-mcp` or available via `npx`.
- Cursor IDE — consumer of `.cursor/mcp.json`; must be restarted after registration for the MCP server to activate.