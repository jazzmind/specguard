---
title: "The VS Code extension"
audience: user
order: 4
source: "specs/guides/vscode-extension.md"
generated: true
---
<a id="the-vs-code-extension"></a>
# The VS Code extension

<a id="goal"></a>
## Goal
Use SpecGuard from VS Code or Cursor: the repository dashboard, the workspace dashboard, the sidebar views, and this documentation inside the editor.

<a id="prerequisites"></a>
## Prerequisites
- The SpecGuard extension installed from the marketplace (or `make install-vsix` from a checkout).
- A folder open in the editor. The extension uses its bundled CLI, or the one you installed with `npm install -g specguard-ai`, and warns when an installed CLI is not the version the extension was built for.

<a id="steps"></a>
## Steps
<a id="set-up-a-repository"></a>
### Set up a repository
Run **SpecGuard: Initialize** from the Command Palette. It runs `specguard init`, which writes `.specguard/config.json` and a specs README and registers the MCP server. Run **SpecGuard: Set API Key** if you want the extension to call a model; the key is stored in VS Code's secret storage, and environment variables and project `.env` files keep working.

<a id="open-the-dashboard"></a>
### Open the dashboard
Run **SpecGuard: Open Dashboard**. It has four groups of tabs: Overview, Actions, Evidence and Settings.

<a id="repository-dashboard"></a>
## Repository dashboard
<a id="overview-tab"></a>
### Overview tab
The first screen. It summarises spec health for the repository and offers the next step when no specs exist yet: draft them from code, import a requirements document, or start from a template.

<a id="coverage-tab"></a>
### Coverage tab
Two numbers side by side: spec coverage (source files owned by a capability spec) and test coverage (owned files whose capability has tests), plus the overall figure.

<a id="actions-tab"></a>
### Actions tab
The pipeline as a row of steps you can run in order: create specs, generate tests, run them, scan for security problems, generate docs. The first button runs `specguard check` for the whole system: ownership, tests, proofs, gaps and drift.

<a id="plans-tab"></a>
### Plans tab
Implementation plans written to `.specguard/plans/` by gap analysis, each with a status you can move through (in progress, done, reopen) so an agent and you share one list of what is left.

<a id="findings-tab"></a>
### Findings tab
Code-quality and security findings, filterable by severity, with links that open the file at the line. The code-quality findings come from the `quality` plugin.

<a id="activity-tab"></a>
### Activity tab
A log of what the extension ran, with output, status and duration. Entries can be dismissed or cleared; the log is local runtime state and is never committed.

<a id="docs-tab"></a>
### Docs tab
Generated documentation for the repository, and a way into this documentation set.

<a id="specs-tab"></a>
### Specs tab
The spec inventory: every spec, the files and tests it owns, and **Organize features and specs** to group and order them for presentation. Reorganizing changes how things are shown, not the specs.

<a id="tests-tab"></a>
### Tests tab
The test files found in the configured test sources, and the latest run.

<a id="traceability-tab"></a>
### Traceability tab
The requirement-to-test matrix: each claim, the tests that carry its tag, and its proof state. It is the same data `specguard matrix` writes.

<a id="settings-tab"></a>
### Settings tab
Per-repository overrides of the model provider and team server. Shared defaults live in the workspace settings, and API keys and tokens are kept in secret storage.

<a id="workspace-dashboard"></a>
## Workspace dashboard
Open it with **SpecGuard: Open Dashboard** in a multi-root workspace, or from the Workspace view. It shows the whole system rather than one repository.

<a id="workspace-status"></a>
### Workspace status
Cards for repos specced, current specs, contract edges and ignored repos, plus a toolbar to sync folders with the `.code-workspace`, open or rebuild the test report, open business journeys and refresh all repos (`specguard check --workspace --refresh`).

<a id="repos-in-the-workspace"></a>
### Repos in the workspace
One card per repository: its role (provider, consumer, test, docs), capabilities, claims proven, catalog features, team-server status, and **Open dashboard**. An overlay repository is marked as shared evidence for the projects it supports. Ignored repos are listed separately with their reason.

<a id="cross-repo-drift"></a>
### Cross-repo drift
**Run Workspace Drift** checks every repository for spec drift through the contract edges (`specguard workspace drift`): a change in a provider flags the consumers that depend on it.

<a id="contracts-in-the-workspace"></a>
### Contracts in the workspace
The contracts bar shows edges, nodes and how many edges have gone unverified for more than 30 days. **Build Contracts** or **Rebuild Contracts** runs `specguard contracts`.

<a id="team-server-in-the-workspace"></a>
### Team server in the workspace
The team-server section shows whether this workspace is connected, which project it maps to, and the publish state. Use **SpecGuard: Sign in to Team Server** to connect.

<a id="workspace-settings"></a>
### Workspace settings
**SpecGuard: Workspace Settings** holds the defaults every repository inherits: provider, model, server and its project mapping.

<a id="sidebar-views"></a>
## Sidebar views
<a id="coverage-view"></a>
### Coverage view
The tree of capabilities with their claim, test and proof counts, and a Layers row when capabilities require test layers. Selecting an entry opens the spec.

<a id="pipelines-view"></a>
### Pipelines view
The actions you can run (generate, heal, validate, scan, docs). It shows only the actions of enabled plugins, so Quality Check needs the `quality` plugin, and it lists each enabled plugin's own commands.

<a id="plugins-view"></a>
### Plugins view
Built-in and npm plugins, on or off, with Enable, Disable, Add and Remove. Adding an npm plugin runs its code to check it is a plugin, so the extension asks first.

<a id="workspace-view"></a>
### Workspace view
The repositories of the workspace, with Ignore, Sync folders and Refresh all repos.

<a id="help-and-documentation"></a>
## Help and documentation
<a id="help-icons"></a>
### Help icons
Question-mark icons on tabs and cards open a short explanation and a link to the matching section of this documentation, which opens in the editor. The text comes from the `## Help Topics` section of the specs, so it is always the current wording.

<a id="open-the-docs"></a>
### Open the docs
Use the Help & Docs view in the sidebar, or the command **SpecGuard: Open Documentation**. Pages ship inside the extension, so they work offline.

<a id="outcome"></a>
## Outcome
You can run the whole loop from the editor, and any control you do not recognise has a help icon that explains it.

<a id="related"></a>
## Related
- [Quickstart: multiple repositories](multi-repo.md)
- [Collaborating with a team](team-collaboration.md)
- [Plugins](plugins.md)

<a id="reference-pages"></a>
## Reference pages

- [Integration Surfaces - CLI, Agents, CI, IDE and Plugins](./reference/integration-surfaces.md)
- [Workspaces - Multi-Repo and Monorepo](./reference/workspaces.md)
- [Documentation and API](./reference/documentation-api.md)
