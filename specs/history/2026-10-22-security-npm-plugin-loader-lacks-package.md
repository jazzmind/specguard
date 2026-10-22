---
id: 2026-10-22-security-npm-plugin-loader-lacks-package
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: npm plugin loader lacks package-name validation against path/URL injec"
affects:
  - integration-surfaces
---
# Security: npm plugin loader lacks package-name validation against path/URL injec

## Decision

Resolved spec-level security finding "npm plugin loader lacks package-name validation against path/URL injection": Add a requirement: at config-load time, each npm plugin entry's `package` value MUST match the npm package-name regex (`^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$`); any entry that does not match MUST be rejected as a configuration error with exit code 1 before any plugin code is imported, and the error message MUST name the offending entry.

Note: already implemented; specified and tested in 0.3 hardening
