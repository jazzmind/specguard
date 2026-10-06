# Advisory model

<!--
  module: src/core/advisory.ts
  type: core
  status: draft
-->

## Overview

One normalized shape for a known vulnerability, whatever tool reported it (npm audit, pip-audit, OSV-Scanner, govulncheck, cargo audit). Also defines the remediation candidate (one concrete change that could fix an advisory), severity ordering, de-duplication, and the suppression file `.specguard/vuln-ignore.json`.

## Acceptance Criteria

- [ ] An `Advisory` carries id, aliases (CVE, GHSA, OSV ids), ecosystem, package, installedVersion, vulnerableRange, fixedVersions, severity, optional cvss, direct, dependencyPath, source and optional url <!-- claim: advisory-shape -->
- [ ] Severities order critical > high > moderate > low > unknown, and `meetsThreshold` is true when an advisory is at or above the threshold <!-- claim: severity-order -->
- [ ] Advisories that share any id or alias for the same ecosystem and package are merged into one; the merged row keeps the highest severity and the union of aliases and fixed versions <!-- claim: dedupe-merge -->
- [ ] The ignore file lists id, reason and expires; an entry matches an advisory by its id or any alias <!-- claim: ignore-match -->
- [ ] An expired entry stops suppressing, and an entry with no `expires` or an unparseable one never suppresses nothing silently: it suppresses only when `expires` is a valid future date <!-- claim: ignore-expiry -->
- [ ] A missing ignore file yields no suppression and a malformed one is an error that names the file <!-- claim: ignore-malformed -->
- [ ] Advisories sort by severity (highest first) then package then id, deterministically <!-- claim: advisory-sort -->

## Scenarios

### Scenario 1: Same CVE from two tools

**Steps:**
1. Normalize an npm-audit row and an OSV row for the same CVE and package
2. Dedupe

**Expected Results:**
- One advisory remains with both sources' aliases and the highest severity

## Dependencies

- specs/core/ecosystems.md
