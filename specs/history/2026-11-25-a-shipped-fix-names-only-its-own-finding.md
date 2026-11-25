---
id: 2026-11-25-a-shipped-fix-names-only-its-own-finding
date: 2026-11-25
kind: decision
author: "Cursor Agent"
source: manual
title: "A shipped fix names only its own findings"
affects:
  - security-and-remediation
---
# A shipped fix names only its own findings

## Decision

A remediation run fixes several plan items, and each shipped commit was naming every selected finding, including ones that failed or were skipped. The commit and the pull request name only the findings that item resolves. The executor receives a map from the plan item's advisory id to its finding ids and selects inside its loop. A fix for something that is not in the plan gets no trailer and no block.

A fingerprint is kept only when it is 6 to 64 lower-case hex digits. Anything else, including a newline, a quote, or -->, is dropped, and one log line says so without the value. Origin is also read from ssh://git@host/owner/repo.git and ssh://git@host:22/owner/repo.git. Owner and repo are lower-cased, and a segment of . or .. is not read.
