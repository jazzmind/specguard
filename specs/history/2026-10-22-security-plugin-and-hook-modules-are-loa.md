---
id: 2026-10-22-security-plugin-and-hook-modules-are-loa
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Plugin and hook modules are loaded without integrity or path-restricti"
affects:
  - platform-foundation
---
# Security: Plugin and hook modules are loaded without integrity or path-restricti

## Decision

Resolved spec-level security finding "Plugin and hook modules are loaded without integrity or path-restriction controls": Add a requirement that plugin and hook module paths must resolve to locations within the repository root (as exposed by config-validation), that relative paths are resolved relative to the config file, that absolute paths outside the repo root are an invalid-config error, and that no URL schemes are permitted.

Note: A redaction hook must be a file inside the project, symlinks resolved, no URLs (hook-path-inside-project) and fails closed (redaction-hook-fails-closed); npm plugins are listed by validated package name, installed locally only (plugin-package-names); built-ins are by name.
