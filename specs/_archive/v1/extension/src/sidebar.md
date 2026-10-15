# Coverage Sidebar Tree View

<!-- module: specguard-extension/src/sidebar / type: feature / status: draft -->

## Overview

The Coverage Sidebar provides a VS Code TreeView panel that displays per-application spec coverage by invoking the `specguard status` CLI command against the active workspace root. The tree is divided into two top-level sections: **Coverage**, which lists each application with its spec coverage percentage and individual spec-item status, and **Outputs**, which summarises artifact counts (specs, tests, docs) and the traceability matrix status from the `.specguard/` directory. Each application node is collapsible and shows child items indicating whether a spec and test file exist for every tracked key. Clicking a spec item with a resolved path opens the corresponding spec file in the editor. The tree refreshes on demand and shows transient loading and error states at the root level.

## Acceptance Criteria

1. The sidebar renders a **Loading…** root item while the CLI invocation is in progress.
2. On CLI failure (non-zero exit code other than 4), the sidebar renders a single **Error: \<message\>** root item.
3. On success, the root contains exactly two section nodes: **Coverage** (shield icon) and **Outputs** (package icon), both expanded by default.
4. The Coverage section lists one app node per application returned by `specguard status`; each node label follows the pattern `<name> (<percentage>%)` with a description `<specCount>/<sourceCount> specs`.
5. App nodes with coverage ≥ 80 % display a `pass` (green) icon; those below 80 % display a `warning` (red) icon.
6. Each app node expands to show spec-item children with keys and status descriptions: `✓`, `⚠ missing spec`, or `∅ no test`.
7. A spec item whose `specPath` is set provides a `vscode.open` command that opens the file when clicked.
8. The Outputs section always shows four child items: **Specs**, **Tests**, **Docs**, and **Traceability**.
9. The Docs count reflects the number of `.md` files present in `<workspaceRoot>/docs/user/`; if the directory is absent the count is 0.
10. The Traceability item reports `present` when `<workspaceRoot>/.specguard/traceability.json` exists and includes a human-readable age (`Xm ago` or `Xh ago`); otherwise it reports `missing`.
11. `getCoveragePercent()` returns 0 when no apps are loaded, 100 when total source count is 0, and `round(specCount / sourceCount * 100)` otherwise.
12. Exit code 4 from the CLI is treated as success (not an error).

## Scenarios

### Scenario 1: Initial load — CLI succeeds with coverage data

**Steps:**
1. Open a workspace with a valid `specguard` CLI available at the resolved path.
2. Activate the sidebar panel (trigger `refresh()`).
3. Observe the tree root immediately after `refresh()` is called but before the CLI resolves.
4. Wait for the CLI to complete successfully.
5. Observe the tree root after loading completes.

**Expected Results:**
- During step 3, the root contains exactly one item with label `Loading…` and type `loading`.
- After step 5, the root contains exactly two items: one with label `Coverage` and one with label `Outputs`.
- Both section nodes have `collapsibleState` set to `Expanded`.

---

### Scenario 2: CLI exits with a non-zero, non-4 code

**Steps:**
1. Configure the CLI to exit with code 1.
2. Trigger `refresh()` on the provider.
3. Wait for the promise to settle.
4. Inspect the root-level tree items.

**Expected Results:**
- The root contains exactly one item whose label starts with `Error:`.
- The item type is `error`.
- No Coverage or Outputs section nodes are present.

---

### Scenario 3: CLI exits with code 4 (treated as success)

**Steps:**
1. Configure the CLI to exit with code 4 and emit valid coverage text on stdout.
2. Trigger `refresh()` and wait for completion.
3. Inspect the root-level tree items.

**Expected Results:**
- No error item is rendered.
- The root contains the `Coverage` and `Outputs` section nodes.

---

### Scenario 4: Coverage section — app node icons based on percentage

**Steps:**
1. Load coverage data containing two apps: one with `percentage = 80` and one with `percentage = 79`.
2. Expand the Coverage section.
3. Inspect the `iconPath` of each app node.

**Expected Results:**
- The app with 80 % has a `pass` ThemeIcon with colour `testing.iconPassed`.
- The app with 79 % has a `warning` ThemeIcon with colour `testing.iconFailed`.

---

### Scenario 5: Spec-item child rendering and click-to-open

**Steps:**
1. Load an app containing three spec items: one with `hasSpec=true, hasTest=true, specPath='/abs/path/spec.md'`; one with `hasSpec=false`; one with `hasSpec=true, hasTest=false`.
2. Expand the app node.
3. Inspect each child item's `description`, `iconPath`, and `command`.

**Expected Results:**
- Item 1 description is `✓`; icon is `pass-filled` (green); `command.command` is `vscode.open` with argument `vscode.Uri.file('/abs/path/spec.md')`.
- Item 2 description is `⚠ missing spec`; icon is `circle-slash` (red); no `command` is set.
- Item 3 description is `∅ no test`; icon is `circle-outline` (queued colour); no `command` is set.

---

### Scenario 6: Outputs section — Docs count from filesystem

**Steps:**
1. Create a workspace root with `docs/user/` containing two `.md` files and one `.txt` file.
2. Load the sidebar (any coverage data).
3. Expand the Outputs section.
4. Inspect the **Docs** child item.

**Expected Results:**
- The Docs item label is `Docs: 2`.
- The item icon is `file-text`.
- The item description is `user-facing docs`.

---

### Scenario 7: Outputs section — Docs directory absent

**Steps:**
1. Use a workspace root where `docs/user/` does not exist.
2. Expand the Outputs section.
3. Inspect the **Docs** child item.

**Expected Results:**
- The Docs item label is `Docs: 0`.
- The item icon is `circle-outline`.
- The item description is `run docs`.

---

### Scenario 8: Outputs section — Traceability file present with age

**Steps:**
1. Place a file at `<workspaceRoot>/.specguard/traceability.json` with `mtime` set to 30 minutes ago.
2. Expand the Outputs section.
3. Inspect the **Traceability** child item.

**Expected Results:**
- The item label is `Traceability: present`.
- The item icon is `list-tree`.
- The item description matches the pattern `updated 30m ago` (within ±1 minute tolerance).

---

### Scenario 9: Outputs section — Traceability file absent

**Steps:**
1. Ensure `<workspaceRoot>/.specguard/traceability.json` does not exist.
2. Expand the Outputs section.
3. Inspect the **Traceability** child item.

**Expected Results:**
- The item label is `Traceability: missing`.
- The item icon is `circle-outline`.
- The item description is `run matrix`.

---

### Scenario 10: getCoveragePercent edge cases

**Steps:**
1. Call `getCoveragePercent()` when `_apps` is empty.
2. Load an app with `sourceCount=0, specCount=0`; call `getCoveragePercent()`.
3. Load apps with total `sourceCount=10, specCount=7`; call `getCoveragePercent()`.

**Expected Results:**
- Step 1 returns `0`.
- Step 2 returns `100`.
- Step 3 returns `70`.

---

### Scenario 11: No active workspace root

**Steps:**
1. Ensure `getActiveWorkspaceRoot()` returns `undefined` or `null`.
2. Trigger `refresh()` and wait for completion.
3. Inspect the root-level tree items.

**Expected Results:**
- `_apps` is set to an empty array.
- The Coverage section child shows the item with label `No specs found` and type `info`.
- No error item is rendered.

## Security Notes

- No credentials, API keys, or tokens are present in this module.
- The CLI path is resolved via `resolveCliPath`; the resolved path must not be user-supplied without validation to prevent arbitrary code execution.
- Filesystem reads (`fs.existsSync`, `fs.readdirSync`, `fs.statSync`) are scoped to the active workspace root; paths are constructed with `path.join` to reduce traversal risk, but callers should ensure `workspaceRoot` is a trusted, canonicalised path.

## Dependencies

| Dependency | Role |
|---|---|
| `vscode` (TreeDataProvider, TreeItem, EventEmitter, ThemeIcon, ThemeColor, Uri) | VS Code extension API for tree rendering |
| `fs` (Node built-in) | Filesystem checks for docs directory and traceability file |
| `path` (Node built-in) | Path construction for docs and `.specguard/` directories |
| `./dashboard/protocol.ts` → `AppCoverage` | Shared type describing per-app coverage data |
| `./dashboard/coverage-parse.ts` → `parseCoverageText`, `augmentCoverageFromDisk` | Parses CLI stdout and enriches coverage data from disk |
| `./dashboard/cli.ts` → `resolveCliPath`, `spawnCli` | Locates and spawns the `specguard` CLI process |
| `./workspace-state.ts` → `getActiveWorkspaceRoot` | Provides the current workspace root path |