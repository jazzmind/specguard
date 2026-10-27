---
id: 2026-10-27-hook-bundle-build-is-layout-independent
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Hook bundle build is layout-independent; committed bundle regenerated"
affects:
  - spec-first-changes
---
# Hook bundle build is layout-independent; committed bundle regenerated

## Decision

The hook bundle build is layout-independent: the sgCanonicalDeps plugin pins every bare import to one canonical copy (the pnpm virtual store first, the flat top-level copy second) and normalizeModuleLabels rewrites esbuild's module labels to node_modules/<name>/<subpath>, so an npm install and a pnpm install build byte-identical bundles instead of leaking the installer's node_modules layout into the bytes. The committed bundle was regenerated with npm run build:hook because it predated the current sources (fast-xml-parser now reaches the hook graph via src/core/coverage.ts) and was built by the old, layout-dependent script.
