# SpecGuard Extension

Living Specification QA agent — spec coverage, drift detection, test generation, and security analysis in your IDE.

## Features

- **Spec coverage** — track which specs have passing tests and generated docs.
- **Drift detection** — highlight specs that have drifted from the codebase.
- **Test generation** — scaffold test files from spec markdown.
- **Security scan** — flag security concerns in spec/test files.
- **MCP registration** — register the SpecGuard MCP server with Cursor.

## Dashboard

Run **SpecGuard: Open Dashboard** (or the graph icon in the SpecGuard Coverage view header)
to open a live, animated view of the pipelines. Click a pipeline node to run it; watch
specs/tests/docs appear in real time. Tabs: Flow · Matrix · Docs · Activity.

Dev: `cd extension && npm run build` (builds the webview into `media/` and the host into `dist/`).

## Workspace, outputs and setup updates

Use **Workspace → Workspace Settings** or the workspace dashboard's **Settings**
tab to set a shared AI provider, model, endpoint and team server. The scope picker
edits individual repository overrides; repository dashboards also link there.
Workspace defaults take precedence over existing project settings, and explicit
repo overrides take precedence over workspace defaults. Each repo keeps its own
server project mapping unless you supply another. Reset removes repo overrides
and its current stored API key, restoring workspace inheritance.

New API keys and server tokens are entered in native password prompts and stored
in VS Code secure storage. Shareable settings contain no credentials. Existing
environment variables and overlay project `.env` files remain supported as
fallbacks. Secure workspace keys are scoped to this workspace and provider
endpoint; repo keys apply only to their repo. These credentials are used by the
extension's CLI and local API processes. Standalone terminal and MCP sessions
continue to use their existing environment or CLI credential configuration.
Connection tests check model-list access (without generation) or server health,
authentication and access to the selected project.

The sidebar starts with **Workspace**, followed by **Coverage**, **Pipelines** and
**Plugins**. Workspace opens the cross-repo dashboard and remains available even
when coverage cannot be loaded.

The workspace dashboard shows each repo's catalogs and current content revision,
feature/spec links and missing mappings. It also separates the installed extension
version, the version that last generated setup files, the spec format, the current
Git revision and working changes, and the revision and SpecGuard engine version
recorded by the last check. Use **Refresh all repos** to check the current code.
Older check reports do not record an engine version and show it as unknown until
refreshed. Links to a spec show mapping coverage; they do not certify that the
spec's content has been reviewed against the latest catalog.

Under **Coverage → Outputs**, **Specs**, **Tests** and **Docs** open searchable
inventories inside VS Code. Configured directories and overlay specs are included;
tests can also live beside source code. Click an entry to open it in the editor.
When connected to a team server, specs and docs from that server are also listed
and opened through the authenticated API. Local files remain browsable offline.

Setup updates offer a per-file preview before running:

- **CLAUDE.md:** update SpecGuard sections while retaining surrounding custom rules.
- **Marked SpecGuard skills, commands and AGENTS.md:** replace the entire file,
  including any custom edits inside it.
- **Unmarked standalone files:** leave them unchanged.
- **JSON settings and MCP:** merge SpecGuard entries while preserving unrelated
  settings and servers; malformed files and conflicting existing wiring are left
  unchanged.

Cancel leaves files unchanged. A failed update does not advance the setup version.
