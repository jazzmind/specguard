---
id: 2026-10-22-security-no-authorization-requirement-fo
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No authorization requirement for `GET /api/v1/units` endpoint"
affects:
  - workspaces
---
# Security: No authorization requirement for `GET /api/v1/units` endpoint

## Decision

Resolved spec-level security finding "No authorization requirement for `GET /api/v1/units` endpoint": Add a requirement that `GET /api/v1/units` enforces authentication (e.g., bearer token or local-only binding) and that the `serve` command documents its trust boundary and defaults to listening only on localhost unless explicitly configured otherwise.

Note: `serve` binds loopback unless --allow-remote is given, and says it has no authentication (serve-bind-loopback); the team server authenticates every route.
