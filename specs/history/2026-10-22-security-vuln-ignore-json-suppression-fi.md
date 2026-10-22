---
id: 2026-10-22-security-vuln-ignore-json-suppression-fi
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: vuln-ignore.json suppression file has no integrity or authorization re"
affects:
  - security-and-remediation
---
# Security: vuln-ignore.json suppression file has no integrity or authorization re

## Decision

Resolved spec-level security finding "vuln-ignore.json suppression file has no integrity or authorization requirement": Add a requirement that modifications to `.specguard/vuln-ignore.json` are subject to the same review process as code changes (e.g., require PR review), that the scan logs all suppressed advisories with their suppression reason and expiry, that expired entries are treated as if absent and logged as warnings, and that entries without an expiry date are rejected.

Note: Expired and undated entries suppress nothing and are reported as warnings; suppressions are listed with reason and date (vuln-ignore-expiry). Review is the repository's own pull-request process.
