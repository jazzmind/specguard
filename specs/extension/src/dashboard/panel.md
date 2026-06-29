# SpecGuard Dashboard Panel

<!-- module: specguard-extension/src/dashboard/panel / type: feature / status: draft -->

## Overview

The Dashboard Panel feature opens and manages a VS Code WebviewPanel that hosts the SpecGuard Dashboard UI. It enforces a single-panel-per-workspace-root policy: if the panel is already open for the active workspace it is simply revealed, while a panel open for a different workspace is disposed and replaced. The panel loads its UI from bundled media assets (`main.js` and optionally `main.css`) served under a strict Content Security Policy. Bidirectional communication between the webview and the extension host is handled via `DashboardHost`, which receives `DashboardCommand` messages from the webview and emits `DashboardEvent` messages back. The panel and its host are fully cleaned up when the panel is disposed.

## Acceptance Criteria

1. Invoking `openDashboardPanel` without an open workspace folder displays an error message and does not open a panel.
2. Invoking `openDashboardPanel` with a valid workspace root creates and reveals a new WebviewPanel titled "SpecGuard Dashboard".
3. If a panel is already open for the same workspace root, a second invocation reveals the existing panel without creating a new one.
4. If a panel is already open for a different workspace root, the old panel is disposed and a new panel is created for the new root.
5. The rendered HTML includes a Content Security Policy that restricts `default-src` to `'none'`, allows scripts only via a per-load cryptographic nonce, and restricts styles and fonts to the webview's CSP source.
6. The nonce value used in the CSP meta tag and the script tag is unique per panel creation (16 random bytes, base64-encoded).
7. The `main.css` stylesheet link is included in the HTML only when the file exists on disk.
8. Messages received from the webview are forwarded to `DashboardHost.handle`.
9. `DashboardHost.start` is called once after the panel is created.
10. When the panel is disposed, `DashboardHost.dispose` is called and internal panel/host references are cleared.

## Scenarios

### Scenario 1: Open panel with no workspace folder

**Steps:**
1. Ensure no workspace folder is active (workspace state returns `undefined`).
2. Call `openDashboardPanel` with a valid extension context.

**Expected Results:**
- `vscode.window.showErrorMessage` is called with the message `'SpecGuard: open a workspace folder first.'`.
- No WebviewPanel is created.
- The module-level `panel` reference remains `undefined`.

---

### Scenario 2: Open panel for the first time with a valid workspace

**Steps:**
1. Set the active workspace root to `/projects/my-spec`.
2. Ensure no panel is currently open.
3. Call `openDashboardPanel` with a valid extension context.

**Expected Results:**
- `vscode.window.createWebviewPanel` is called with id `'specguard.dashboard'`, title `'SpecGuard Dashboard'`, column `vscode.ViewColumn.Active`, and options `{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [<media URI>] }`.
- `panel.webview.html` is set to a non-empty HTML string.
- `DashboardHost.start` is called exactly once.
- A `onDidReceiveMessage` listener is registered on the webview.

---

### Scenario 3: Reveal existing panel for the same workspace root

**Steps:**
1. Set the active workspace root to `/projects/my-spec`.
2. Call `openDashboardPanel` to open the panel (panel is now open for `/projects/my-spec`).
3. Call `openDashboardPanel` again with the same workspace root.

**Expected Results:**
- `panel.reveal()` is called on the existing panel.
- `vscode.window.createWebviewPanel` is called only once total (not a second time).
- `DashboardHost.start` is called only once total.

---

### Scenario 4: Replace panel when workspace root changes

**Steps:**
1. Set the active workspace root to `/projects/spec-a`.
2. Call `openDashboardPanel` to open a panel for `spec-a`.
3. Change the active workspace root to `/projects/spec-b`.
4. Call `openDashboardPanel` again.

**Expected Results:**
- `panel.dispose()` is called on the original panel before the new one is created.
- `vscode.window.createWebviewPanel` is called a second time for `spec-b`.
- The new `DashboardHost` is initialised with workspace root `/projects/spec-b`.
- `DashboardHost.start` is called for the new host.

---

### Scenario 5: HTML Content Security Policy and nonce correctness

**Steps:**
1. Open a panel with a valid workspace root.
2. Capture the `panel.webview.html` string set during panel creation.

**Expected Results:**
- The HTML contains `<meta http-equiv="Content-Security-Policy" ...>` with `default-src 'none'`.
- The CSP allows `script-src 'nonce-<VALUE>'` where `<VALUE>` is a base64 string of exactly 24 characters (16 bytes base64-encoded).
- The `<script>` tag carries a `nonce` attribute whose value matches the nonce in the CSP header exactly.
- The CSP `style-src` includes the webview's `cspSource` value.
- The CSP `font-src` includes the webview's `cspSource` value.
- Two separate panel-open calls produce two different nonce values.

---

### Scenario 6: Conditional CSS link inclusion

**Steps:**
1. Open a panel when `media/main.css` **does not** exist on disk.
2. Capture the rendered HTML.
3. Create `media/main.css` on disk, then open a new panel.
4. Capture the rendered HTML from the second panel.

**Expected Results:**
- HTML from step 2 does **not** contain a `<link rel="stylesheet">` tag.
- HTML from step 4 **does** contain `<link rel="stylesheet" href="...main.css">` pointing to a webview URI.

---

### Scenario 7: Panel disposal cleans up host and references

**Steps:**
1. Open a panel with a valid workspace root.
2. Trigger the panel's `onDidDispose` event (simulate panel close).

**Expected Results:**
- `DashboardHost.dispose` is called exactly once.
- The module-level `panel` reference is set to `undefined`.
- The module-level `currentHost` reference is set to `undefined`.

---

### Scenario 8: Webview message forwarding to DashboardHost

**Steps:**
1. Open a panel with a valid workspace root.
2. Simulate the webview posting a `DashboardCommand` message (e.g., `{ type: 'refresh' }`).

**Expected Results:**
- `DashboardHost.handle` is called with the exact message object received from the webview.
- No error is thrown or surfaced to the user.

## Security Notes

- The Content Security Policy sets `default-src 'none'`, minimising the attack surface of the webview.
- Scripts are permitted only via a per-load cryptographic nonce (16 random bytes from `crypto.randomBytes`); inline scripts without the nonce are blocked.
- Local resource access is restricted to the `media/` directory of the extension via `localResourceRoots`.
- No secret values, API keys, or credentials are present in this source file.
- The nonce must never be logged, stored, or reused across panel instances.

## Dependencies

- `vscode` — WebviewPanel creation, URI handling, message passing, and error display.
- `path` / `fs` — Resolving and checking existence of bundled media assets (`main.js`, `main.css`).
- `crypto` — Generating the per-load CSP nonce via `randomBytes`.
- `DashboardHost` (`./host`) — Manages business logic, handles inbound `DashboardCommand` messages, and emits `DashboardEvent` messages to the webview.
- `DashboardEvent` / `DashboardCommand` (`./protocol`) — Typed message contracts for webview ↔ host communication.
- `getActiveWorkspaceRoot` (`../workspace-state`) — Resolves the currently active workspace folder root path.