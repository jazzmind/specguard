---
title: "SpecGuard VS Code Extension"
sidebar_label: "SpecGuard VS Code Extension"
generated: true
---

# SpecGuard VS Code Extension

The SpecGuard extension for VS Code and Cursor brings spec coverage, pipeline management, and drift detection directly into your editor. Everything you need to understand and maintain your specification health is available without leaving the IDE.

---

## Getting Started

After installing the extension, a **SpecGuard icon** appears in the Activity Bar on the left side of VS Code. Click it to open the SpecGuard sidebar, which gives you a live view of your workspace's spec coverage at a glance.

To open the full dashboard, run the **SpecGuard: Open Dashboard** command from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`). The dashboard opens as a panel in your editor. If you open it again while it's already open, VS Code will bring the existing panel into focus rather than opening a second one.

---

## The Sidebar

The sidebar organises information into two sections:

- **Coverage** — shows per-application spec and test counts, so you can quickly see which parts of your codebase have strong or weak coverage.
- **Outputs** — shows aggregate counts for Specs, Tests, and Docs across your workspace, along with the current Traceability status.

The sidebar updates using the same `specguard` CLI that powers the rest of the extension — there is no separate data source to keep in sync.

---

## The Dashboard

The dashboard is a rich panel that gives you a full picture of your workspace's specification health. A **workspace info bar** runs across the top of every tab, showing your folder name, path, configuration status, and the list of apps the extension has detected.

### Overview Tab

The dashboard opens on the **Overview** tab by default. Here you'll find:

- Your **workspace name** and a **coverage summary** for the whole project.
- **Spec, test, and doc counts** at a glance.
- The **last known drift and matrix status**, so you know whether your specs are in sync with your code.
- A **recent activity feed** showing what has run and when.
- A **Getting Started guide** that appears automatically when no specs exist yet, walking you through your first steps with SpecGuard.

### Pipelines Tab

The **Pipelines tab** is where you run SpecGuard operations. It is organised into three workflow-oriented sections rather than a flat list, reflecting the natural order of working with specs.

**Bootstrap** (visible only when no specs exist yet)
This section surfaces the tools you need to get started — including the `reverse` command to generate specs from existing code, and `import` to bring in specs from another source. Note that `import` is shown as a disabled card with a hint to use the terminal directly, since it requires interactive input that works best outside the extension.

**Main Loop**
Once you have specs, this section is your day-to-day workspace. Each of the following operations appears as a card:

| Operation | What it does |
|-----------|--------------|
| **generate** | Creates or updates spec files |
| **security** | Runs security-focused spec checks |
| **validate** | Validates specs against your codebase |
| **docs** | Generates documentation from specs |
| **drift** | Checks for drift between specs and code |
| **matrix** | Runs the coverage matrix |
| **quality** | Assesses spec quality |
| **deps** | Analyses dependency coverage |

Each card shows a description of the operation, a status chip indicating whether the last run **passed**, **failed**, or has **never been run**, and how long ago that run occurred. If a run failed, the card also displays the tail of the error output inline so you can diagnose the problem without switching to a terminal. A **Run** button on each card lets you trigger the operation immediately.

**Finalise**
This section contains the **heal** and **commit** operations for wrapping up a spec cycle.

---

## Drift Detection

SpecGuard monitors your workspace for drift in the background. Checks are debounced so that a check runs no more than once every **30 seconds**, keeping resource usage low. The activity feed in the Overview tab is only updated when the drift state actually changes — you won't see noise from repeated checks that find nothing new.

---

## How the Extension Works

The extension shells out to the `specguard` CLI for all operations. No business logic is duplicated inside the extension itself, which means the behaviour you see in the IDE is always consistent with running `specguard` commands directly in your terminal.

The dashboard communicates with the extension host using VS Code's standard message-passing API. When you click **Run** on a pipeline card, the dashboard sends a command to the host, which invokes the appropriate CLI operation and streams results — coverage data, matrix output, findings, activity events, and workspace information — back to the dashboard as they arrive.
