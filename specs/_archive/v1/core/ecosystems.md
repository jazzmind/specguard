# Ecosystem adapters

<!--
  module: src/core/ecosystems/index.ts
  type: core
  status: draft
-->

## Overview

An ecosystem adapter knows how one package manager detects itself (lockfile markers), audits, proposes fixes, applies a fix to the manifests, reinstalls and fingerprints. Adapters: npm, pnpm, yarn (classic and berry), pip, poetry, uv, go, cargo, maven, gradle. Every external command goes through an injectable command runner (`CommandRunner`), so tests use canned output; a missing tool raises a `ToolNotInstalledError` that names the tool and how to install it. OSV-Scanner (binary, or `docker run ghcr.io/google/osv-scanner`) is the universal detector when available; native audits are used otherwise. A language profile's `auditRunner` string is kept and maps to an adapter.

## Acceptance Criteria

- [ ] Detection is by lockfile marker and the most specific one wins (pnpm-lock.yaml, yarn.lock, package-lock.json; poetry.lock, uv.lock, requirements.txt; go.mod; Cargo.lock; pom.xml; build.gradle) <!-- claim: detect-lockfile -->
- [ ] yarn classic and yarn berry are told apart from the lockfile header <!-- claim: yarn-flavors -->
- [ ] `audit` parses canned npm, pnpm, yarn, pip-audit, govulncheck, cargo-audit and OSV output into normalized advisories <!-- claim: audit-parse -->
- [ ] A missing tool raises `ToolNotInstalledError` with the tool name, never a raw ENOENT <!-- claim: tool-not-installed -->
- [ ] `resolveFix` picks the smallest fixing version above the installed one: patch over minor over major, and a major bump is a candidate only when marked as major so the planner can refuse it <!-- claim: smallest-fix -->
- [ ] A direct dependency fix edits the manifest range; a transitive fix uses `overrides` (npm), `pnpm.overrides` (pnpm) or `resolutions` (yarn) <!-- claim: transitive-override -->
- [ ] `apply` returns exactly the changed files, all of them manifests or lockfiles <!-- claim: apply-changed-files -->
- [ ] `fingerprint` hashes the lockfiles and manifests of the ecosystem and changes when a dependency changes <!-- claim: fingerprint-changes -->
- [ ] The OSV detector parses OSV-Scanner JSON for every ecosystem and falls back to native audits when OSV is not installed <!-- claim: osv-universal -->
- [ ] The existing `profile.auditRunner` values keep working through `adapterForAuditRunner` <!-- claim: audit-runner-compat -->

## Dependencies

- specs/core/advisory.md
