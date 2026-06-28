# SpecGuard Living Specifications

This directory is the **single source of truth** for SpecGuard's own modules and pipelines. Every `src/` file has a corresponding spec here. This is SpecGuard eating its own dogfood — we use the spec format to define the system that parses and generates from that format.

## Directory Structure

```
specs/
  core/
    spec-parser.md        # src/core/spec-parser.ts — parses .md spec files
    cli.md                # src/cli/*.ts — the specguard CLI entrypoint
    config.md             # src/core/config.ts — loads .specguard/config.json
    llm.md                # src/core/llm.ts — LLM adapter (ai-sdk wrapper)
    writer.md             # src/core/writer.ts — file write abstraction
    exit-codes.md         # src/core/exit-codes.ts — typed exit codes
  pipelines/
    reverse-generate.md   # specguard reverse
    forward-generate.md   # specguard generate
    validate.md           # specguard validate
    heal.md               # specguard heal
    security.md           # specguard security
    docs.md               # specguard docs
    drift.md              # specguard drift
    matrix.md             # specguard matrix
    import.md             # specguard import
  adapters/
    playwright.md         # Playwright browser runner adapter
    docker.md             # Docker container runner adapter
    semgrep.md            # Semgrep SAST adapter
    auth-state-machine.md # Deterministic login state machine
  README.md               # This file
```

## Spec Format

Every spec file follows this structure:

```markdown
# Module Title

<!--
  module: src/path/to/module.ts
  type: core | pipeline | adapter | cli
  status: draft | stable
-->

## Overview
What this module does and why it exists. 2-4 sentences.

## Acceptance Criteria
Testable bullets that define "done" for this module. Each bullet must be
verifiable by reading the code or running a test.

- [ ] ...

## Scenarios

### Scenario 1: <concise name>
**Steps:**
1. ...

**Expected Results:**
- ...

---

### Scenario 2: <concise name>
...

## Security Notes
Constraints this module must enforce. Omit section if not applicable.

## Dependencies
Other specs/modules this module depends on. Omit if none.
```

## Rules

- Specs are written **before or alongside** the code — not after
- If the code changes in a way that invalidates a spec scenario, **update the spec first**
- `status: draft` means the module is being designed; `status: stable` means the module matches the spec
- The SpecGuard Cursor Skill (`/.cursor/skills/specguard/SKILL.md`) checks this directory after each plan phase

## Coverage

Run `specguard status` (once built) to see which source files lack specs. Until then, the SpecGuard skill performs this check manually after each plan phase.
