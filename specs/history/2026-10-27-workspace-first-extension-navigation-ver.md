---
id: 2026-10-27-workspace-first-extension-navigation-ver
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Workspace-first extension navigation, version and catalog visibility, output browsing and explicit update previews"
affects:
  - integration-surfaces
---
# Workspace-first extension navigation, version and catalog visibility, output browsing and explicit update previews

## Decision

Put Workspace above Coverage, Pipelines and Plugins. Show every repo catalog and its links to current specs, plus current Git revision, last checked revision, spec format and SpecGuard harness setup version. Do not infer semantic catalog alignment from timestamps or link coverage: report it as unverified when no review evidence exists. Open output inventories inside VS Code using configured and overlay directories, with local files and authenticated team-server documents. Explain CLAUDE section preservation and full replacement of marked harness files in a per-file preview, and never record a successful setup version after scaffold fails.
