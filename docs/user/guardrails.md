---
title: "Guardrails"
sidebar_label: "Guardrails"
description: "The Guardrails adapter classifies browser actions as safe, destructive, or outbound before they are executed, blocking harmful or unintended operations during automated browser interaction."
category: "adapters"
order: 20
generated: true
---

# Guardrails

The Guardrails adapter acts as a safety net during automated browser interaction. Before any action is executed by the **validate** or **heal** pipelines, Guardrails inspects it and decides whether it is safe to proceed. Classification is keyword-based and fully deterministic — no LLM call is involved — making it fast, predictable, and auditable.

---

## How It Works

Every browser action has a plain-text description (e.g. `"delete all archived records"`). Guardrails scans that description for known keywords and assigns one of three classifications:

| Classification | What it means | Example keywords |
|---|---|---|
| **safe** | The action is permitted to run | navigate, read, fill, click |
| **destructive** | The action could cause irreversible data loss | `delete`, `remove`, `archive`, `purge`, `drop`, `destroy`, `reset`, `wipe`, `erase` |
| **outbound** | The action could trigger external communication or a financial transaction | `send`, `invite`, `share`, `publish`, `pay`, `submit`, `transfer`, `broadcast`, `post`, `email` |

Keyword matching is **case-insensitive**, so `Delete`, `DELETE`, and `delete` are all treated identically. If no keywords match, the action is classified as **safe**.

---

## Blocked Actions

Any action classified as `destructive` or `outbound` is **blocked** — it will not be executed. Blocked actions appear in pipeline reports with a `BLOCKED` verdict that includes:

- The original action description
- The classification that triggered the block (`destructive` or `outbound`)
- A human-readable reason string explaining why the action was stopped

`safe` actions are never blocked and proceed normally through the pipeline.

---

## Classifications at a Glance

### Safe
Actions that navigate, read content, fill in form fields, or click navigation elements are considered safe and will always be allowed through.

### Destructive
Actions whose descriptions contain any of the following keywords are classified as destructive and blocked:

`delete` · `remove` · `archive` · `purge` · `drop` · `destroy` · `reset` · `wipe` · `erase`

### Outbound
Actions whose descriptions contain any of the following keywords are classified as outbound and blocked:

`send` · `invite` · `share` · `publish` · `pay` · `submit` · `transfer` · `broadcast` · `post` · `email`

---

## Pipeline Integration

Guardrails runs automatically as part of the **validate** and **heal** pipelines — no additional configuration is required. When a blocked action is encountered, the pipeline records a `BLOCKED` verdict in its report and moves on; it does not crash or halt the entire run.

---

## Dependencies

The Guardrails adapter has **no external dependencies**. It is entirely self-contained and requires no network access, API keys, or third-party packages.
