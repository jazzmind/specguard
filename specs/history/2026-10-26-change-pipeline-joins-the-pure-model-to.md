---
id: 2026-10-26-change-pipeline-joins-the-pure-model-to
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Change pipeline joins the pure model to git and runs"
affects:
  - spec-first-changes
---
# Change pipeline joins the pure model to git and runs

## Decision

The change pipeline joins the pure change model to git and the test runner. A change is opened with one committed record that holds only declared intent, and every stage is detected from facts gathered at the time of the question: the changed claims against the base commit, the approvals a person recorded or a linked plan implies, the tests tagged to each changed requirement, hashes of the specs, tagged tests and owned source, and the newest red and green runs read from their run records. Run commands are thin wrappers over the claim-scoped test run; they leave a small pointer under the gitignored cache that names the run record and the hashes it saw, and the stage is never read from it. Red against code that already differs from base runs in a constructed tree so the user's tree is untouched. Local red stays provisional because CI proves it by construction. The pipeline lives in `src/pipelines/change.ts`, `change-run.ts` and `change-store.ts`, with the plan link added to history capture.
