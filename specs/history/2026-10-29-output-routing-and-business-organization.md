---
id: 2026-10-29-output-routing-and-business-organization
date: 2026-10-29
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Explicit output destinations and workspace business organization"
affects:
  - integration-surfaces
  - workspaces
  - spec-authoring
  - conformance-testing
---
# Explicit output destinations and workspace business organization

The user asked that generation follow existing overlay/native conventions while allowing an explicit destination, and that cross-application business journeys belong to the workspace. Application feature catalogs and specs need logical grouping and ordering aligned with those journeys.

Persist output choices per application and artifact/test layer. Present input/output scope before editor generation. Keep spec keys and original files when switching roots; include generated test directories in discovery. Runtime ledgers/reports remain attached to their configuration rather than being moved with generated artifacts.

Persist business organization independently of source/spec filenames. Workspace journeys link qualified features, specs and claims. Application organization can inherit journey ordering. Automatic drafting writes an additive proposal for review, preserves human organization, rejects invented refs and refuses stale apply/save operations. Reviewed organization does not assert approved requirements or passing runtime proof.

Generated test prompts use the engine's canonical spec key so nested and relocated roots cite the same claims that checks/proofs resolve, rather than dropping the spec-directory prefix.
