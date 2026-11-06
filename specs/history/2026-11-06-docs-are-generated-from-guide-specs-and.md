---
id: 2026-11-06-docs-are-generated-from-guide-specs-and
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Docs are generated from guide specs and capability specs"
affects:
  - documentation-api
---
# Docs are generated from guide specs and capability specs

## Decision

Guides are kind: journey specs under specs/guides/ (frontmatter audience, order, useCase, related). docs build renders guides, index, manifest and help topics deterministically; capability reference pages go through DocService and are regenerated only when the spec hash recorded in the committed docs/manifest.json changes (--no-llm renders from the spec). Old hand-written docs are folded into guides and left as pointers; docs/user is removed. Help topics live in ## Help Topics sections and drive the dashboards' help icons.
