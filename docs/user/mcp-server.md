---
title: "MCP Server"
sidebar_label: "MCP Server"
description: "The SpecGuard MCP Server exposes every SpecGuard pipeline as a tool over the Model Context Protocol (MCP), letting AI-powered clients like Cursor or Claude Desktop drive pipelines directly without using the CLI."
category: "core"
order: 50
generated: true
---

# MCP Server

The SpecGuard MCP Server exposes every SpecGuard pipeline as a **Model Context Protocol (MCP) tool**, allowing any MCP-capable client — such as [Cursor](https://cursor.sh) or [Claude Desktop](https://claude.ai/download) — to drive the same pipelines that the `specguard` CLI drives, directly from within your AI-powered workflow.

---

## How It Works

The MCP server is a thin wiring layer built on top of the `@modelcontextprotocol/sdk` (v1), using `McpServer` and a `StdioServerTransport`. When launched, it registers one tool per SpecGuard pipeline (plus a couple of utility tools), and each tool:

1. Loads your project configuration via `loadConfig`, using the current working directory or an optional `cwd` argument you supply.
2. Maps the tool's input to the pipeline's typed options.
3. Calls the **exact same pipeline function** that the `specguard` CLI subcommand calls — no duplicated logic.
4. Returns the pipeline result as a human-readable text summary, including messages and counts (created / updated / skipped / failed).

If a tool encounters an error, it returns the error details as text content rather than throwing, so your MCP client always receives a well-formed response.

The server binary is available as `specguard-mcp`.

---

## Starting the Server

Run the server directly from your terminal (or configure it as an MCP server in your client's settings):

```bash
specguard-mcp
```

The server starts on a `StdioServerTransport` and listens for tool calls from your MCP client. Importing the server module programmatically does **not** start the transport — startup only happens when the module is run as the main entry point, so you can safely import it without side effects.

---

## Available Tools

The following tools are registered and available to any connected MCP client.

### Pipeline Tools

Each pipeline tool mirrors its corresponding `specguard` CLI subcommand exactly.

| Tool | What It Does | Inputs |
|---|---|---|
| `specguard_reverse` | Reverse-generates a spec from existing code | `app`, `file?`, `force?`, `cwd?` |
| `specguard_generate` | Forward-generates code from a spec | `spec?`, `all?`, `framework?`, `app?`, `force?`, `cwd?` |
| `specguard_heal` | Heals a spec by reconciling drift automatically | `spec?`, `all?`, `maxRetries?`, `cwd?` |
| `specguard_status` | Reports the current status of all specs | `cwd?` |
| `specguard_drift` | Detects drift between specs and code | `since?`, `spec?`, `cwd?` |
| `specguard_security` | Runs security checks against specs | `spec?`, `all?`, `withSast?`, `cwd?` |
| `specguard_docs` | Generates documentation from specs | `spec?`, `all?`, `out?`, `cwd?` |

> **Tip:** Parameters marked with `?` are optional. The `cwd?` parameter lets you point any tool at a specific project directory instead of the current working directory.

### Utility Tools

| Tool | What It Does | Inputs |
|---|---|---|
| `specguard_read_spec` | Reads and parses a spec file | `specKey?` or `path?`, `cwd?` |
| `specguard_write_spec` | Writes content to a spec file | `path`, `content` |

### Stub Tools (Not Yet Implemented)

The following tools are registered to keep the tool surface complete and consistent with the CLI, but they currently return a **"not yet implemented"** message:

| Tool | Status |
|---|---|
| `specguard_validate` | Coming soon |
| `specguard_matrix` | Coming soon |

---

## Tool Responses

Every tool returns a response in the following shape:

```
{ content: [{ type: 'text', text: '...' }] }
```

The `text` field contains a human-readable summary of the pipeline result, including any messages and counts (e.g., how many files were created, updated, skipped, or failed).

If something goes wrong, the response includes `isError: true` alongside the error details — your MCP client will never receive an unhandled exception from a tool call.

---

## Relationship to the CLI

The MCP server and the `specguard` CLI share the same underlying pipeline functions. There is no separate business logic in the MCP layer — it is purely a protocol adapter. This means:

- Behaviour is identical whether you run a pipeline via `specguard` or via an MCP tool call.
- Configuration is loaded the same way in both cases (see the [Config documentation](../core/config.md)).
- The spec parser used by `specguard_read_spec` is the same one used throughout the rest of SpecGuard.

---

## Configuring an MCP Client

To use the SpecGuard MCP server with a supported client, add it as an MCP server pointing to the `specguard-mcp` binary. Refer to your client's documentation for the exact configuration format. For example, in a JSON-based MCP config:

```json
{
  "mcpServers": {
    "specguard": {
      "command": "specguard-mcp"
    }
  }
}
```

Once connected, all registered tools will appear in your client's tool list and can be invoked by name.
