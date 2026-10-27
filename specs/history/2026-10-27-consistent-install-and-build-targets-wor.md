---
id: 2026-10-27-consistent-install-and-build-targets-wor
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Consistent install and build targets, workflow examples, and waiting for release CI"
affects:
  - integration-surfaces
---
# Consistent install and build targets, workflow examples, and waiting for release CI

## Decision

Make install installs the checkout for local usage by invoking install-cli and install-vsix; install-dev installs the locked development dependencies; build-vsix replaces vsix. Make help and the workflow guide include local install, development and publishing examples. release-check and publish select CI for the exact pushed main commit, watch queued or running CI until completion, proceed only on success, and report actual failures or unavailable CI without tagging.
