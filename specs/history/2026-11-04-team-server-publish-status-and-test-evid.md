---
id: 2026-11-04-team-server-publish-status-and-test-evid
date: 2026-11-04
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "team server publish status and test evidence"
affects:
  - team-server
  - integration-surfaces
  - traceability-and-drift
---
# team server publish status and test evidence

## Decision

Wes wants the VS Code workspace dashboard to publish to the team server, tell whether a publish is needed (a content-digest diff, not a commit compare, because overlay repos share one commit), and optionally publish test evidence including all video and traces. Built locally with the file backend, nothing deployed to the shared server. Blobs bypass the string-only API, upload in chunks under the proxy's 1 MB limit, dedupe by sha256 per project, and the server renders the same report HTML from client-built report data.
