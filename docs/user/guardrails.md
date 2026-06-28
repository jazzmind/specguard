---
title: "Guardrails"
sidebar_label: "Guardrails"
generated: true
---

# Guardrails

The Guardrails adapter acts as a safety net during automated browser interactions. Before any action is executed by the validate or heal pipelines, Guardrails inspects it and decides whether it is safe to proceed. This check is fast, fully deterministic, and requires no network calls — it works entirely through keyword matching.

## How It Works

Every browser action is described in plain text (for example, `"delete the selected records"` or `"send an invitation email"`). Guardrails scans that description and assigns it one of three classifications:

| Classification | What it means |
|---|---|
| **safe** | The action is permitted to proceed — typical navigation, reading, filling forms, or clicking links. |
| **destructive** | The action could permanently remove or alter data. It will be blocked. |
| **outbound** | The action could send data or communications outside the system. It will be blocked. |

Matching is case-insensitive, so `Delete`, `DELETE`, and `delete` are all treated the same way.

### Destructive Actions

An action is classified as **destructive** if its description contains any of the following keywords:

`delete` · `remove` · `archive` · `purge` · `drop` · `destroy` · `reset` · `wipe` · `erase`

### Outbound Actions

An action is classified as **outbound** if its description contains any of the following keywords:

`send` · `invite` · `share` · `publish` · `pay` · `submit` · `transfer` · `broadcast` · `post` · `email`

### Safe Actions

If none of the above keywords are present, the action is classified as **safe** and allowed to continue.

## What Happens When an Action Is Blocked

Both **destructive** and **outbound** actions are blocked — they will not be executed. When a pipeline (validate or heal) encounters a blocked action, it records a `BLOCKED` verdict in its report, along with the classification and a human-readable reason explaining why the action was stopped.

Safe actions are never blocked.

## Dependencies

Guardrails has no external dependencies. It runs entirely within the pipeline with no third-party libraries or services required.
