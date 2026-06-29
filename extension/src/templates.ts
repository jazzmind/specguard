/**
 * Canonical project file templates managed by the SpecGuard extension.
 *
 * These are written (or updated) into target projects when the extension
 * detects that the project's files are behind the current extension version.
 * Embed as string constants so esbuild bundles them with no extra build step.
 *
 * Each template includes a `<!-- specguard-managed: true -->` marker so the
 * updater can distinguish files it owns from user-authored ones.
 */

/**
 * AGENTS.md — universal AI agent instructions for projects using SpecGuard.
 * Understood by Claude Code, Cursor Agents, Codex, and similar tools.
 */
export const AGENTS_MD = `# AGENTS.md

<!-- specguard-managed: true -->

## SpecGuard Enforced

This repository uses **SpecGuard** for spec-driven QA. As an AI agent you **must**
follow this workflow before finishing any task:

### Workflow

1. **Edit** — make your code changes.
2. **Validate** — run the SpecGuard pipeline:
   \`\`\`bash
   npx specguard validate --all
   \`\`\`
3. **Repair** — if validation fails, fix the issues and re-run.
4. **Report** — include the pipeline output summary in your response.

### Available Pipelines

| Command | What it does |
|---------|-------------|
| \`specguard init\` | Scaffold \`.specguard/config.json\` and first specs |
| \`specguard reverse --all\` | Generate Living Specs from source code |
| \`specguard generate --all\` | Generate test files from specs |
| \`specguard validate --all\` | Validate specs against the running app |
| \`specguard drift\` | Detect specs out of sync with code |
| \`specguard heal --all\` | Auto-fix failing generated tests |
| \`specguard security --all\` | OWASP security tests and SAST |
| \`specguard deps\` | Dependency vulnerability audit |
| \`specguard quality\` | ESLint + dead-code checks |
| \`specguard matrix\` | Traceability matrix (spec → test → doc) |
| \`specguard docs --all\` | Generate user-facing docs from specs |
| \`specguard analyze\` | Smart diagnostics — start here when unsure |

### Artifacts

- Config: \`.specguard/config.json\`
- Specs: \`specs/<area>/<module>.md\`
- Generated tests: \`tests/\`
- Reports: \`.specguard/\`

### MCP Tools (Cursor / Claude with MCP enabled)

All pipelines are also available as MCP tools: \`specguard_reverse\`,
\`specguard_generate\`, \`specguard_validate\`, etc. Use these when available
instead of the CLI to get structured results.

### Safety Rules

- NO secrets or credentials in code.
- NO destructive shell commands (rm -rf, force push, etc.) unless explicitly approved.
- ALWAYS run \`specguard validate\` before marking a task complete.
- If a pipeline outputs findings, run \`specguard heal\` to fix before committing.
`;

/**
 * .cursor/skills/specguard/SKILL.md — Cursor Agent skill for SpecGuard.
 * Tells the Cursor composer agent how and when to invoke SpecGuard pipelines.
 */
export const SKILL_MD = `---
name: specguard
description: >-
  SpecGuard parallel QA agent. Maintains Living Specs as the single source of
  truth alongside coding work. Triggered automatically after each plan phase,
  when security-sensitive files change, or manually. Runs spec coverage checks,
  creates/updates spec files, generates tests, and flags security concerns.
  Use when the user completes a plan phase, asks to check spec coverage, wants
  tests generated from a spec, or asks to validate the live app against a spec.
---

<!-- specguard-managed: true -->

# SpecGuard Skill

The \`specguard\` CLI and MCP server handle all QA pipelines. Use \`npx specguard\`
or the MCP tools (\`specguard_*\`) depending on what is available.

## When to Run

Run automatically after any of these events:
- A plan phase completes (new module written, existing module changed)
- Security-sensitive files are changed (\`**/auth/**\`, \`**/middleware/**\`, \`**/api/**\`)
- The user asks for spec coverage, test generation, or validation

## Quick Reference

\`\`\`bash
# Analyze workspace and get pipeline recommendations (start here)
npx specguard analyze

# Generate/update specs from source code
npx specguard reverse --all

# Show spec + test coverage
npx specguard status

# Detect spec ↔ code drift
npx specguard drift

# Generate test files from specs
npx specguard generate --all

# Auto-heal failing tests
npx specguard heal --all

# Validate specs against the running app
npx specguard validate --all

# Security audit
npx specguard security --all
npx specguard deps

# Generate docs
npx specguard docs --all
\`\`\`

## Analyze → Plan → Fix Loop

When something is broken, use this sequence:

1. \`specguard analyze\` → prioritised recommendation list
2. \`specguard plan-fix --pipeline <name> --issues "..."\` → structured fix plan
3. Present plan to user and wait for approval
4. Execute \`run-pipeline\` steps, make \`edit-file\` changes
5. \`specguard analyze\` again → should return zero recommendations

**Never execute fix steps without user confirmation.**

## Commit After Heal

After \`specguard heal\` succeeds, commit automatically:
\`\`\`bash
npx specguard commit --pipeline heal
\`\`\`

## MCP Tools (when available)

All pipelines are exposed as \`specguard_*\` tools on the MCP server:
\`specguard_reverse\`, \`specguard_generate\`, \`specguard_validate\`,
\`specguard_heal\`, \`specguard_security\`, \`specguard_docs\`, \`specguard_drift\`,
\`specguard_matrix\`, \`specguard_status\`, \`specguard_analyze\`, \`specguard_deps\`,
\`specguard_quality\`, \`specguard_commit\`, \`specguard_import\`, \`specguard_gap_analysis\`.

Use MCP tools instead of CLI when available — they return structured JSON results.
`;
