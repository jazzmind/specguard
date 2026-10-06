# Spec key

<!--
  module: src/core/spec-key.ts
  type: core
  status: draft
-->

## Overview

One canonical spec key for every pipeline. The key is the path of the spec file relative to the specs root (`paths.specsRoot`, default `specs`), without the `.md` extension, for example `api/services/messaging` for `specs/api/services/messaging.md`. It does not depend on which app owns the spec. Claims, tags, proof ingest, the drift registry, `matrix`, `align` and `status` all use it. When the specs root directory does not exist, or a spec lies outside it, the key is relative to the app's `specDir` (single-app layout, unchanged). The module also resolves a spec's declared `sources:` / `module:` files and migrates old drift-registry keys.

## Acceptance Criteria

- [ ] `canonicalSpecKey` returns the specs-root-relative path without extension for a spec under the specs root, whichever app's `specDir` it lives in <!-- claim: root-relative-key -->
- [ ] `canonicalSpecKey` falls back to the path relative to the owning `specDir` when the specs root does not exist or the spec is outside it <!-- claim: legacy-fallback -->
- [ ] `loadCanonicalSpecs` returns specs whose `specKey` is canonical and whose `localKey` is the `specDir`-relative key <!-- claim: load-canonical -->
- [ ] `declaredSources` reads the comma-separated `sources:` header and falls back to `module:` <!-- claim: declared-sources -->
- [ ] `resolveDeclaredSources` resolves globs relative to the owning app's `repo`, and accepts a pattern that matches only from the config root, warning once per pattern <!-- claim: sources-root-fallback -->
- [ ] `migrateRegistrySpecKeys` renames legacy registry keys (`<app>/<localKey>` and `<app>/<canonicalKey>`) to the canonical key, merging their file entries, and reports whether anything changed <!-- claim: migrate-registry -->

## Scenarios

### Scenario 1: Per-app spec dirs

**Steps:**
1. Config has app `api` with `specDir: specs/api` and `paths.specsRoot: specs`
2. Spec file `specs/api/services/messaging.md`

**Expected Results:**
- Canonical key is `api/services/messaging`; `localKey` is `services/messaging`
