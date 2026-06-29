# Plan Writer

<!--
  module: src/core/plan-writer.ts
  type: core
  status: stable
-->

## Overview

`plan-writer.ts` is a shared utility that produces agent-consumable Markdown plan files whenever a pipeline detects issues.  Every pipeline that finds problems (drift, gap-analysis, quality, deps, security, validate, matrix) calls `writePlan` to emit a structured `.specguard/plans/<pipeline>-<timestamp>.md` file that a coding agent (Claude, Cursor, Copilot) can read and execute directly.

The file format is:
- YAML frontmatter: `pipeline`, `generatedAt`
- `# Title` — concise summary of the problem
- `> Summary` — 1–3 sentence description of findings and fix approach
- `## <Section>` blocks — one per finding category (e.g. Drifted Specs, Fix Steps)
- Agent attribution footer

## Scenarios

### Scenario 1: Write a plan file on pipeline failure

**Given:** A pipeline (e.g. drift) detects 3 drifted specs  
**When:** `writePlan` is called with pipeline, title, summary, and sections  
**Then:**  
- A file is created at `.specguard/plans/drift-<timestamp>.md`  
- The file contains frontmatter, title, summary, and all non-empty sections  
- The function returns the absolute path to the file

### Scenario 2: Skip empty sections

**Given:** Some sections in `PlanOpts.sections` have zero items  
**When:** `writePlan` is called  
**Then:** Sections with `items.length === 0` are omitted from the output

### Scenario 3: Ordered vs bullet lists

**Given:** A section has `ordered: true`  
**When:** `writePlan` renders it  
**Then:** Items are numbered (`1.`, `2.`, …) rather than bulleted (`-`)

### Scenario 4: Plans directory is created if absent

**Given:** `.specguard/plans/` does not exist  
**When:** `writePlan` is called  
**Then:** The directory is created recursively before the file is written

### Scenario 5: Best-effort — never throws on file system errors

**Given:** The plans directory cannot be created (e.g. permission error)  
**When:** `writePlan` is called from a pipeline  
**Then:** The error is caught silently; the pipeline's own result is unaffected

## Acceptance Criteria

- `writePlan(opts)` returns the absolute path of the written file
- File name format: `<pipeline>-<YYYYMMDD-HHmmss>.md` (ISO-like, no colons)
- Frontmatter contains `pipeline` and `generatedAt` keys
- Non-empty sections appear in the order supplied
- Empty sections are omitted
- Plans directory is auto-created with `mkdir -p` semantics
- Function is synchronous (no async); callers can `try/catch` without await
