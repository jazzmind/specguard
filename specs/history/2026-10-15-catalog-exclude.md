---
id: 2026-10-15-catalog-exclude
date: 2026-10-15
kind: decision
author: Wes Sonnenreich
source: cursor
title: Catalog directories can leave files out
affects:
  - integration-surfaces
---

# Catalog directories can leave files out

## Prompt

A catalog directory can hold YAML that is not a feature list. The generic loader was reading every `*.yaml` file, so those files either failed the catalog or showed up as features.

## Decision

`featureState.catalogExclude` is a list of file-name globs. Matching files are skipped before they are parsed. The layout stays in config; nothing about a particular catalog is built in.
