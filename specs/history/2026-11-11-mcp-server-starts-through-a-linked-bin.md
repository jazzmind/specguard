---
id: 2026-11-11-mcp-server-starts-through-a-linked-bin
date: 2026-11-11
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "MCP server starts through a linked bin"
affects:
  - integration-surfaces
---
# MCP server starts through a linked bin

## Decision

specguard-mcp compared import.meta.url with path.resolve(process.argv[1]). Under npx and npm/pnpm .bin links argv[1] is the symlink, so the server never started and exited silently; agents wired to it (Cursor's .cursor/mcp.json in jazzmind/it-shop) had no SpecGuard tools. The entry check now lives in src/mcp/entrypoint.ts and compares real paths, as the CLI's already did.
