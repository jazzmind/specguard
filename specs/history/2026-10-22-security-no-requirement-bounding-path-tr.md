---
id: 2026-10-22-security-no-requirement-bounding-path-tr
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No requirement bounding path traversal via manifest `path` fields or c"
affects:
  - workspaces
---
# Security: No requirement bounding path traversal via manifest `path` fields or c

## Decision

Resolved spec-level security finding "No requirement bounding path traversal via manifest `path` fields or contract block `specPath` values": Add a requirement that all path values in the manifest and all `specPath` values in contract blocks are validated to resolve strictly within the workspace root after symlink resolution; any path that escapes the root must be rejected with an error, not a warning, and no opt-out should permit reads outside the workspace root.

Note: contract-block specPath reads are confined to the repo; manifest repo paths deliberately may point at sibling repos outside the workspace root.
