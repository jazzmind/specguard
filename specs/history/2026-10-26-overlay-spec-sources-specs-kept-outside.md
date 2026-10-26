---
id: 2026-10-26-overlay-spec-sources-specs-kept-outside
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Overlay spec sources: specs kept outside the app repository"
affects:
  - platform-foundation
  - integration-surfaces
  - workspaces
---
# Overlay spec sources: specs kept outside the app repository

## Decision

SpecGuard could only recognise a repository as configured when `.specguard/config.json` sat inside it. Teams that keep the specs, configs and results for a whole workspace in one separate overlay repository, and never write into the application repos, therefore saw every real repo as unconfigured: the CLI asked for `init`, `workspace sync` ignored the folders, the edit guard stayed silent, the MCP server failed and the editor extension showed nothing. The decision was to add overlay spec sources without changing anything for repos that have their own config. A per-user registry (`overlays.json`, derived from scans, mode 600) plus `SPECGUARD_OVERLAY` and `SPECGUARD_CONFIG` tell the config loader where a directory's specs live; the repo's own config always wins, the deepest matching repo wins among overlay entries, and two different configs for one repo are an error that names both rather than a guess. In overlay mode the config loads as if run from the overlay app's folder, so every artifact stays in the overlay. The edit guard resolves through the same registry with a light lookup and keys ownership to the real repository; the session-status script and the extension ask the CLI only when the config file is absent and an overlay may apply. `SPECGUARD_CONFIG` ranks after the repo's own config (an exported variable must not hijack repos that have their own), which reads "explicit beats everything" as "explicit beats discovery by overlay".
