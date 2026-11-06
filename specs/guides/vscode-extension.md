---
id: vscode-extension
kind: journey
title: "The VS Code extension"
audience: user
order: 4
related:
  - integration-surfaces
  - workspaces
  - documentation-api
---

# The VS Code extension

## Goal
Use SpecGuard from VS Code or Cursor: the repository dashboard, the workspace dashboard, the sidebar views, and this documentation inside the editor.

## Prerequisites
- The SpecGuard extension installed from the marketplace (or `make install-vsix` from a checkout).
- A folder open in the editor. The extension uses its bundled CLI, or the one you installed with `npm install -g specguard-ai`, and warns when an installed CLI is not the version the extension was built for.

## Steps
### Set up a repository
Run **SpecGuard: Initialize** from the Command Palette. It runs `specguard init`, which writes `.specguard/config.json` and a specs README and registers the MCP server. Run **SpecGuard: Set API Key** if you want the extension to call a model; the key is stored in VS Code's secret storage, and environment variables and project `.env` files keep working.

### Open the dashboard
Run **SpecGuard: Open Dashboard**. It has four groups of tabs: Overview, Actions, Evidence and Settings.

## Repository dashboard
### Overview tab
The first screen. It summarises spec health for the repository and offers the next step when no specs exist yet: draft them from code, import a requirements document, or start from a template.

### Coverage tab
Two numbers side by side: spec coverage (source files owned by a capability spec) and test coverage (owned files whose capability has tests), plus the overall figure.

### Actions tab
The pipeline as a row of steps you can run in order: create specs, generate tests, run them, scan for security problems, generate docs. The first button runs `specguard check` for the whole system: ownership, tests, proofs, gaps and drift.

### Plans tab
Implementation plans written to `.specguard/plans/` by gap analysis, each with a status you can move through (in progress, done, reopen) so an agent and you share one list of what is left.

### Findings tab
Code-quality and security findings, filterable by severity, with links that open the file at the line. The code-quality findings come from the `quality` plugin.

### Activity tab
A log of what the extension ran, with output, status and duration. Entries can be dismissed or cleared; the log is local runtime state and is never committed.

### Docs tab
Generated documentation for the repository, and a way into this documentation set.

### Specs tab
The spec inventory: every spec, the files and tests it owns, and **Organize features and specs** to group and order them for presentation. Reorganizing changes how things are shown, not the specs.

### Tests tab
The test files found in the configured test sources, and the latest run.

### Traceability tab
The requirement-to-test matrix: each claim, the tests that carry its tag, and its proof state. It is the same data `specguard matrix` writes.

### Settings tab
Per-repository overrides of the model provider and team server. Shared defaults live in the workspace settings, and API keys and tokens are kept in secret storage.

## Workspace dashboard
Open it with **SpecGuard: Open Dashboard** in a multi-root workspace, or from the Workspace view. It shows the whole system rather than one repository.

### Workspace status
Cards for repos specced, current specs, contract edges and ignored repos, plus a toolbar to sync folders with the `.code-workspace`, open or rebuild the test report, open business journeys and refresh all repos (`specguard check --workspace --refresh`).

### Repos in the workspace
One card per repository: its role (provider, consumer, test, docs), capabilities, claims proven, catalog features, team-server status, and **Open dashboard**. An overlay repository is marked as shared evidence for the projects it supports. Ignored repos are listed separately with their reason.

### Cross-repo drift
**Run Workspace Drift** checks every repository for spec drift through the contract edges (`specguard workspace drift`): a change in a provider flags the consumers that depend on it.

### Contracts in the workspace
The contracts bar shows edges, nodes and how many edges have gone unverified for more than 30 days. **Build Contracts** or **Rebuild Contracts** runs `specguard contracts`.

### Team server in the workspace
The team-server section shows whether this workspace is connected, which project it maps to, and the publish state. Use **SpecGuard: Sign in to Team Server** to connect.

### Workspace settings
**SpecGuard: Workspace Settings** holds the defaults every repository inherits: provider, model, server and its project mapping.

## Sidebar views
### Coverage view
The tree of capabilities with their claim, test and proof counts, and a Layers row when capabilities require test layers. Selecting an entry opens the spec.

### Pipelines view
The actions you can run (generate, heal, validate, scan, docs). It shows only the actions of enabled plugins, so Quality Check needs the `quality` plugin, and it lists each enabled plugin's own commands.

### Plugins view
Built-in and npm plugins, on or off, with Enable, Disable, Add and Remove. Adding an npm plugin runs its code to check it is a plugin, so the extension asks first.

### Workspace view
The repositories of the workspace, with Ignore, Sync folders and Refresh all repos.

## Help and documentation
### Help icons
Question-mark icons on tabs and cards open a short explanation and a link to the matching section of this documentation, which opens in the editor. The text comes from the `## Help Topics` section of the specs, so it is always the current wording.

### Open the docs
Use the Help & Docs view in the sidebar, or the command **SpecGuard: Open Documentation**. Pages ship inside the extension, so they work offline.

## Outcome
You can run the whole loop from the editor, and any control you do not recognise has a help icon that explains it.

## Related
- [Quickstart: multiple repositories](multi-repo.md)
- [Collaborating with a team](team-collaboration.md)
- [Plugins](plugins.md)

## Help Topics
- `dashboard.overview` → Overview tab: Spec health for this repository at a glance, with the next step when no specs exist yet.
- `dashboard.coverage` → Coverage tab: Spec coverage (source files a spec owns) and test coverage (owned files whose capability has tests).
- `dashboard.flow` → Actions tab: The pipeline as steps you can run in order: create specs, generate and run tests, scan, generate docs.
- `dashboard.plans` → Plans tab: Implementation plans from gap analysis, each with a status so you and an agent share one list of what is left.
- `dashboard.findings` → Findings tab: Code-quality and security findings, filterable by severity, with links to the file and line.
- `dashboard.activity` → Activity tab: A local log of what the extension ran, with output, status and duration.
- `dashboard.docs` → Docs tab: Generated documentation for this repository, and the way into the SpecGuard docs.
- `dashboard.specs` → Specs tab: Every spec with the files and tests it owns; organize them into groups for presentation.
- `dashboard.tests` → Tests tab: The test files found in the configured test sources and the latest run.
- `dashboard.traceability` → Traceability tab: Each claim with the tests that carry its tag and its proof state.
- `dashboard.settings` → Settings tab: Per-repository overrides of the model provider and team server; keys stay in secret storage.
- `workspace.status` → Workspace status: Repos specced, current specs, contract edges and ignored repos, with refresh and report actions.
- `workspace.repos` → Repos in the workspace: One card per repository with its role, capabilities, claims proven and a link to its dashboard.
- `workspace.drift` → Cross-repo drift: Checks every repository for spec drift through the contract edges.
- `workspace.settings` → Workspace settings: Defaults every repository inherits: provider, model, server and project mapping.
- `workspace.teamServer` → Team server in the workspace: Whether this workspace is connected to a team server and what was last published.
- `sidebar.coverage` → Coverage view: Capabilities with their claim, test and proof counts; select one to open its spec.
- `sidebar.pipelines` → Pipelines view: The actions you can run, limited to those of enabled plugins, plus each plugin's own commands.
- `sidebar.plugins` → Plugins view: Built-in and npm plugins, on or off; enable, disable, add or remove them here.
