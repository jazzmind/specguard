---
id: 2026-10-22-security-shared-env-file-containing-secr
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Shared `.env` file containing secrets has no confidentiality or integr"
affects:
  - workspaces
---
# Security: Shared `.env` file containing secrets has no confidentiality or integr

## Decision

Resolved spec-level security finding "Shared `.env` file containing secrets has no confidentiality or integrity requirements beyond git-ignore": Add requirements that (1) `init` creates `.specguard/.env` with owner-read-only permissions, (2) no command prints `.env` values in output or logs, (3) secret values are masked in any diagnostic output, and (4) the file's presence and permissions are reported as a configuration health item in `workspace status`.

Note: The CLI warns when .env is readable by other users and names the fix; no command prints a value; the commit command never stages it (env-permission-warning, commit-never-secrets).
