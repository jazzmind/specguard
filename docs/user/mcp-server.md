---
title: "MCP Server"
sidebar_label: "MCP Server"
generated: true
---

# MCP Server

## Overview

The SpecGuard MCP Server exposes every SpecGuard pipeline as a tool over the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), so that MCP-capable clients — such as **Cursor** or **Claude Desktop** — can drive the same workflows you would normally run from the `specguard` CLI.

Once connected, your AI client can reverse-generate specs from code, forward-generate tests, heal drifted specs, check security, produce documentation, and more — all without leaving the conversation.

---

## Getting Started

The MCP server is available as the `specguard-mcp` binary. Point your MCP client at it using a `stdio` transport. For example, in a client configuration file you might add:

```json
{
  "mcpServers": {
    "specguard": {
      "command": "specguard-mcp"
    }
  }
}
```

Refer to your client's documentation for the exact configuration format. Once connected, all SpecGuard tools are immediately available to the model.

---

## Available Tools

Each tool corresponds directly to a SpecGuard pipeline — the same logic that runs when you use the CLI. The model can invoke any of the following tools on your behalf.

### `specguard_reverse`

Reverse-generates a Living Specification from existing source code.

| Input | Type | Required | Description |
|---|---|---|---|
| `app` | string | Yes | The application or module to reverse-generate from |
| `file` | string | No | Limit reverse generation to a specific file |
| `force` | boolean | No | Overwrite an existing spec |
| `cwd` | string | No | Working directory (defaults to the current directory) |

---

### `specguard_generate`

Forward-generates tests or artifacts from a Living Specification.

| Input | Type | Required | Description |
|---|---|---|---|
| `spec` | string | No | The spec key to generate from |
| `all` | boolean | No | Run generation for all specs |
| `framework` | string | No | Target test framework |
| `app` | string | No | Target application |
| `force` | boolean | No | Overwrite existing generated files |
| `cwd` | string | No | Working directory |

---

### `specguard_heal`

Heals a spec that has drifted from its implementation by attempting automatic reconciliation.

| Input | Type | Required | Description |
|---|---|---|---|
| `spec` | string | No | The spec key to heal |
| `all` | boolean | No | Heal all specs |
| `maxRetries` | number | No | Maximum number of heal attempts |
| `cwd` | string | No | Working directory |

---

### `specguard_status`

Reports the current status of all specs in the project — which are in sync, which have drifted, and which have never been generated.

| Input | Type | Required | Description |
|---|---|---|---|
| `cwd` | string | No | Working directory |

---

### `specguard_drift`

Detects drift between specs and their implementations, optionally scoped to changes since a given point in time or to a specific spec.

| Input | Type | Required | Description |
|---|---|---|---|
| `since` | string | No | A git ref or timestamp to compare against |
| `spec` | string | No | Limit drift detection to a specific spec |
| `cwd` | string | No | Working directory |

---

### `specguard_security`

Runs security checks against one or all specs, with an optional SAST (static analysis) pass.

| Input | Type | Required | Description |
|---|---|---|---|
| `spec` | string | No | The spec key to check |
| `all` | boolean | No | Check all specs |
| `withSast` | boolean | No | Include static analysis |
| `cwd` | string | No | Working directory |

---

### `specguard_docs`

Generates user-facing documentation from a Living Specification (this very document is an example of its output).

| Input | Type | Required | Description |
|---|---|---|---|
| `spec` | string | No | The spec key to document |
| `all` | boolean | No | Document all specs |
| `out` | string | No | Output path for generated docs |
| `cwd` | string | No | Working directory |

---

### `specguard_read_spec`

A utility tool that reads and returns the content of a spec, identified either by its spec key or by a file path.

| Input | Type | Required | Description |
|---|---|---|---|
| `specKey` | string | No | The spec key to read |
| `path` | string | No | A direct file path to the spec |
| `cwd` | string | No | Working directory |

---

### `specguard_write_spec`

A utility tool that writes content to a spec file at the given path. Useful for the model to persist spec changes it has composed.

| Input | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | The file path to write to |
| `content` | string | Yes | The spec content to write |

---

### `specguard_validate` *(coming soon)*

Validates specs against their implementations. This tool is registered and available to clients but is not yet implemented — it will return a "not yet implemented" message when called.

---

### `specguard_matrix` *(coming soon)*

Generates a coverage matrix across specs and implementations. This tool is registered and available to clients but is not yet implemented — it will return a "not yet implemented" message when called.

---

## Tool Responses

Every tool returns a plain-text summary of what happened, including:

- Any messages produced during the pipeline run
- Counts of items **created**, **updated**, **skipped**, and **failed**

If a tool encounters an error, it returns a descriptive error message rather than crashing the session, so the model can report the problem and you can take corrective action.

---

## Working Directory

Most tools accept an optional `cwd` argument. When provided, SpecGuard resolves your project configuration relative to that directory. When omitted, it defaults to the directory from which `specguard-mcp` was launched. This is useful when your MCP client is running from a different location than your project root.
