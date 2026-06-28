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
