---
id: 2026-10-22-security-evidence-screenshots-containing
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Evidence screenshots containing personal data have no defined retentio"
affects:
  - agentic-verification
---
# Security: Evidence screenshots containing personal data have no defined retentio

## Decision

Resolved spec-level security finding "Evidence screenshots containing personal data have no defined retention or access-control requirement": Add a requirement that evidence and saved login state files are written with restrictive file-system permissions (e.g., mode 0600), that a configurable retention period causes automatic deletion of evidence older than N days, and that the documentation normatively states these directories must not be stored in shared or world-readable locations.

Note: Evidence, saved-login and report folders are 0700, login files 0600, validate.evidenceRetentionDays prunes old evidence, and the commit command never stages them (evidence-retention, commit-never-secrets).
