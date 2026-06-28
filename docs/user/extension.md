---
title: "SpecGuard VS Code Extension"
sidebar_label: "SpecGuard VS Code Extension"
description: "The SpecGuard VS Code and Cursor extension brings spec coverage, pipeline status, and drift detection directly into your editor, with a sidebar, coverage tree view, and interactive dashboard panel."
category: "adapters"
order: 10
generated: true
---

# SpecGuard VS Code Extension

The SpecGuard extension for VS Code and Cursor brings your spec coverage, pipeline status, and drift detection directly into the editor — no context-switching required. Everything you need to understand and act on your specification health is available without leaving your IDE.

---

## What the Extension Provides

Once installed, the extension adds three main surfaces to your editor:

| Surface | What it does |
|---|---|
| **Activity Bar icon** | A dedicated SpecGuard icon in the activity bar opens the sidebar at any time. |
| **Coverage tree view** | A sidebar panel showing per-app spec and test counts, plus output summaries (Specs, Tests, Docs, and Traceability status). |
| **Dashboard webview panel** | A rich, interactive dashboard for exploring coverage, running pipelines, and reviewing drift findings. |

All operations are powered by the `specguard` CLI. The extension shells out to it for every action — no business logic is duplicated inside the extension itself.

---

## The Sidebar

Click the SpecGuard icon in the activity bar to open the sidebar. It is divided into two sections:

- **Coverage** — shows per-app spec and test counts at a glance.
- **Outputs** — shows aggregate counts for Specs, Tests, and Docs, along with the current Traceability status.

This gives you a live summary of your workspace's specification health without needing to open the full dashboard.

---

## The Dashboard

Run the **`specguard.openDashboard`** command (via the Command Palette or a keybinding) to open the full dashboard panel. The dashboard is a singleton — if it is already open, the existing panel is brought into focus rather than opening a duplicate.

### Workspace Info Bar

A workspace info bar is displayed at the top of every dashboard tab. It shows your folder name, path, configuration status, and the list of apps detected in your workspace.

### Overview Tab (Default)

The dashboard opens on the **Overview** tab by default. It surfaces:

- **Workspace name and path**
- **Coverage summary** — overall spec and test coverage at a glance
- **Spec / Test / Doc counts**
- **Last drift and matrix status**
- **Recent activity feed** — a running log of pipeline runs and drift checks
- **Getting Started guide** — shown automatically when no specs exist yet, to help you bootstrap your first specification

### Pipelines Tab

The Pipelines tab is organised as a set of workflow-oriented cards, grouped into three sections:

#### Bootstrap *(shown only when no specs exist)*
| Pipeline | Notes |
|---|---|
| `reverse` | Generates specs from your existing code. |
| `import` | Shown as a **disabled card** with a hint to use the terminal instead. |

#### Main Loop
Each of the following pipelines is shown as a card with a description, a last-run status chip, and a **Run** button:

`generate` · `security` · `validate` · `docs` · `drift` · `matrix` · `quality` · `deps`

#### Finalise
| Pipeline | Notes |
|---|---|
| `heal` | Repairs spec inconsistencies. |
| `commit` | Commits the current spec state. |

### Pipeline Cards

Every pipeline card shows:

- **Last run status** — `pass`, `fail`, or `never`
- **Time since last run** — e.g. "3 minutes ago"
- **Inline error tail** — when the last run failed, a short tail of the error output is shown directly on the card so you can diagnose issues without leaving the dashboard

After every pipeline run, a `pipeline:lastRun` event is recorded and stored, keeping the status chips and activity feed up to date.

---

## Drift Detection

The extension runs a background drift check automatically. Checks are **debounced to 30 seconds** to avoid unnecessary CLI invocations. The activity log is only updated when the drift state actually changes — so you won't see noise from repeated identical results.

---

## Multi-App Workspaces

When you run `specguard reverse` from the dashboard, it uses the `--all` flag to iterate over every app defined in your workspace configuration. You do not need to run reverse-engineering per app manually.

---

## How the Dashboard Communicates

The dashboard webview and the extension host communicate via VS Code's `postMessage` / `onDidReceiveMessage` API. The extension host translates dashboard actions (such as clicking **Run** on a pipeline card) into CLI invocations, and pushes the following events back to the dashboard:

| Event | Description |
|---|---|
| `workspace` | Emitted on startup; carries folder name, path, config status, and app list. |
| `coverage` | Updated spec and test coverage data. |
| `matrix` | Latest matrix run results. |
| `findings` | Drift or security findings. |
| `activity` | Recent activity log entries. |
| `pipeline:lastRun` | Emitted after every pipeline run with status and timing. |

This clean separation means the dashboard UI always reflects the true state of your CLI and workspace, with no stale or duplicated data.
