---
id: 2026-11-25-finding-links-on-remediation-commits
date: 2026-11-25
kind: decision
author: "Cursor Agent"
source: manual
title: "Finding links on remediation commits"
affects:
  - security-and-remediation
---
# Finding links on remediation commits

## Decision

A fix shipped for a remediation-plan item has to name the finding it resolves, in a form another system can read without parsing prose. The id is sg:<owner>/<repo>:<fingerprint>: owner and repo come from the origin remote (git@host:owner/repo.git or https://host/owner/repo, with or without .git), and the fingerprint is the plan item's. security fix passes that id to the remediate executor. The commit ends with one Resolves-Finding trailer per id, and the pull request body ends with a finding-links block holding the same ids as a JSON array. With no id, a plain remediate and an app repair keep today's commit message and body. If origin cannot be read or parsed, the fix still ships, with one log line and no trailer or block. At most 50 ids, in a stable order, with no duplicates.
