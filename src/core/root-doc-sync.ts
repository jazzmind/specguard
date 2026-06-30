/**
 * Root document sync — keeps README.md, CLAUDE.md, and AGENTS.md in sync
 * with the current spec state.
 *
 * Uses HTML comment sentinels to update specific sections while leaving
 * hand-written content untouched:
 *
 *   <!-- specguard:architecture:start -->
 *   ...auto-generated content...
 *   <!-- specguard:architecture:end -->
 *
 * If AGENTS.md does not exist, it is created from a template.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SpecGuardConfig, ParsedSpec } from './types.js';
import { llmGenerateObject } from './llm.js';
import {
  applyTargetSections,
  SENTINEL_START,
  SENTINEL_END,
  type SentinelSection,
} from './sentinels.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @deprecated Use `SentinelSection` from `./sentinels.js`. */
export type RootSyncSection = SentinelSection;

export interface RootSyncTarget {
  filePath: string;
  sections: RootSyncSection[];
}

// ---------------------------------------------------------------------------
// LLM schemas for section content generation
// ---------------------------------------------------------------------------

const ArchitectureSectionSchema = z.object({
  architecture: z.string().describe('Markdown describing the architecture (modules, pipelines, config). 200–400 words.'),
  commands: z.string().describe('Markdown table or list of the main CLI commands with 1-line descriptions.'),
  pipelineReference: z.string().describe('Markdown table listing all pipelines with their purpose and when to use them.'),
  specLocationMapping: z.string().describe('Markdown showing where specs live relative to source modules. Use a table or code block.'),
});

type ArchitectureSection = z.infer<typeof ArchitectureSectionSchema>;

const AgentsGuideSchema = z.object({
  whenToRun: z.string().describe('Markdown guidance on when AI agents should invoke SpecGuard pipelines.'),
  availablePipelines: z.string().describe('Markdown table of all pipelines with the CLI command and recommended trigger condition.'),
  configApps: z.string().describe('Markdown summarising the apps array from config (names, specDirs, source globs).'),
  specFormat: z.string().describe('Short Markdown guide on the Living Spec format (frontmatter, sections, acceptance criteria).'),
  commonWorkflows: z.string().describe('Markdown list of 3-5 common agent workflows (e.g. after new feature: run reverse, validate, generate).'),
});

// ---------------------------------------------------------------------------
// Content generators
// ---------------------------------------------------------------------------

function buildContextPrompt(config: SpecGuardConfig, specs: ParsedSpec[]): string {
  const apps = config.apps.map((a) =>
    `- ${a.name}: specDir=${a.specDir}, sources=${JSON.stringify(a.sources)}`
  ).join('\n');

  const specSummary = specs.slice(0, 20).map((s) =>
    `- [${s.specKey}] ${s.title} (${s.scenarios.length} scenarios)`
  ).join('\n');

  const pipelines = [
    'reverse — generate Living Specs from source code',
    'gap-analysis — detect unimplemented specs, generate plans',
    'generate — generate test code from specs',
    'security — SAST + security test generation',
    'docs — generate user-facing documentation from specs',
    'validate — validate specs against running app (browser automation)',
    'drift — detect specs out of sync with source code',
    'matrix — traceability matrix: specs → tests → docs',
    'quality — ESLint + dead-code (Knip)',
    'deps — dependency vulnerability + unused dep audit',
    'heal — LLM-assisted self-healing of failing tests',
    'commit — stage and commit SpecGuard-generated files',
    'analyze — diagnose which pipelines need to run and why',
    'plan-fix — generate an agent-consumable fix plan from findings',
  ].join('\n');

  return [
    `Project root: ${config.rootDir ?? process.cwd()}`,
    `LLM provider: ${config.llm.provider} / model: ${config.llm.model}`,
    '',
    `Apps (${config.apps.length}):`,
    apps,
    '',
    `Total specs: ${specs.length}`,
    'Sample specs:',
    specSummary,
    '',
    'SpecGuard pipelines:',
    pipelines,
  ].join('\n');
}

async function generateArchitectureSections(
  config: SpecGuardConfig,
  specs: ParsedSpec[],
): Promise<ArchitectureSection> {
  return llmGenerateObject({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKeyEnv: config.llm.apiKeyEnv,
    system: [
      'You are a technical writer generating documentation sections for SpecGuard.',
      'Write in clear, concise Markdown for developers.',
      'Do not include section headings (## Architecture etc.) — output only the body content.',
      'Use present tense. Keep architecture section under 350 words.',
    ].join('\n'),
    prompt: `Based on this project context, generate documentation sections:\n\n${buildContextPrompt(config, specs)}`,
    schema: ArchitectureSectionSchema,
  });
}

async function generateAgentsGuide(
  config: SpecGuardConfig,
  specs: ParsedSpec[],
): Promise<z.infer<typeof AgentsGuideSchema>> {
  return llmGenerateObject({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKeyEnv: config.llm.apiKeyEnv,
    system: [
      'You are generating an AGENTS.md guide for AI coding agents (Claude, Cursor, Copilot).',
      'The guide should tell agents when and how to use SpecGuard to maintain spec coverage.',
      'Be concise and action-oriented. Write Markdown body content only (no top-level headings).',
    ].join('\n'),
    prompt: `Generate an AI agent guide for SpecGuard based on this context:\n\n${buildContextPrompt(config, specs)}`,
    schema: AgentsGuideSchema,
  });
}

// ---------------------------------------------------------------------------
// AGENTS.md template
// ---------------------------------------------------------------------------

function buildAgentsMd(guide: z.infer<typeof AgentsGuideSchema>): string {
  return [
    '# AGENTS.md — SpecGuard Integration Guide for AI Coding Agents',
    '',
    '> This file is maintained by SpecGuard. Sentinel sections are auto-updated by `specguard docs`.',
    '> Hand-written content outside sentinels is preserved.',
    '',
    '## Overview',
    '',
    'SpecGuard enforces Living Spec coverage — every source module must have a corresponding',
    'Markdown spec that defines its behaviour, acceptance criteria, and test scenarios.',
    'AI coding agents should use SpecGuard to maintain spec-source alignment as they work.',
    '',
    `${SENTINEL_START('agents:when-to-run')}`,
    '## When to Run SpecGuard',
    '',
    guide.whenToRun,
    `${SENTINEL_END('agents:when-to-run')}`,
    '',
    `${SENTINEL_START('agents:pipelines')}`,
    '## Available Pipelines',
    '',
    guide.availablePipelines,
    `${SENTINEL_END('agents:pipelines')}`,
    '',
    `${SENTINEL_START('agents:spec-format')}`,
    '## Living Spec Format',
    '',
    guide.specFormat,
    `${SENTINEL_END('agents:spec-format')}`,
    '',
    `${SENTINEL_START('agents:config-apps')}`,
    '## Configured Apps',
    '',
    guide.configApps,
    `${SENTINEL_END('agents:config-apps')}`,
    '',
    `${SENTINEL_START('agents:workflows')}`,
    '## Common Agent Workflows',
    '',
    guide.commonWorkflows,
    `${SENTINEL_END('agents:workflows')}`,
    '',
    '## Commands Reference',
    '',
    '```bash',
    'npx tsx src/cli/index.ts status          # check spec coverage',
    'npx tsx src/cli/index.ts analyze          # diagnose which pipelines to run',
    'npx tsx src/cli/index.ts reverse --all    # generate missing specs',
    'npx tsx src/cli/index.ts gap-analysis     # find unimplemented specs',
    'npx tsx src/cli/index.ts drift            # detect spec drift',
    'npx tsx src/cli/index.ts validate         # validate specs against live app',
    '```',
    '',
    '## Spec Location',
    '',
    '```',
    'specs/',
    '  core/       # Core module specs',
    '  pipelines/  # Pipeline specs',
    '  adapters/   # Adapter specs',
    '  cli/        # CLI command specs',
    '  mcp/        # MCP server specs',
    '  extension/  # VS Code extension specs',
    '```',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync sentinel sections in README.md and CLAUDE.md; create/update AGENTS.md.
 * Called from `runDocGenerate` after per-spec docs are written.
 */
export async function syncRootDocs(
  config: SpecGuardConfig,
  specs: ParsedSpec[],
  log: (line: string) => void,
): Promise<void> {
  const rootDir = config.rootDir ?? process.cwd();
  log('[root-sync] generating architecture sections…');

  let arch: ArchitectureSection;
  try {
    arch = await generateArchitectureSections(config, specs);
  } catch (err) {
    log(`[root-sync] architecture section generation failed: ${(err as Error).message}`);
    return;
  }

  // --- README.md sections ---
  const readmePath = path.join(rootDir, 'README.md');
  const readmeSections: RootSyncSection[] = [
    { sentinel: 'architecture', content: arch.architecture },
    { sentinel: 'commands', content: arch.commands },
    { sentinel: 'pipeline-reference', content: arch.pipelineReference },
  ];
  applyTargetSections(readmePath, readmeSections);
  log('[root-sync] README.md updated');

  // --- CLAUDE.md sections (create if missing, update sentinels if present) ---
  const claudePath = path.join(rootDir, 'CLAUDE.md');
  const claudeExisted = fs.existsSync(claudePath);
  const claudeSections: RootSyncSection[] = [
    { sentinel: 'architecture', content: arch.architecture },
    { sentinel: 'pipeline-reference', content: arch.pipelineReference },
    { sentinel: 'spec-location', content: arch.specLocationMapping },
  ];
  applyTargetSections(claudePath, claudeSections);
  log(`[root-sync] CLAUDE.md ${claudeExisted ? 'updated' : 'created'}`);

  // --- AGENTS.md (create if missing, update sentinel sections if present) ---
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  log('[root-sync] generating AGENTS.md guide…');

  let guide: z.infer<typeof AgentsGuideSchema>;
  try {
    guide = await generateAgentsGuide(config, specs);
  } catch (err) {
    log(`[root-sync] AGENTS.md guide generation failed: ${(err as Error).message}`);
    return;
  }

  if (!fs.existsSync(agentsPath)) {
    // Create from template
    fs.writeFileSync(agentsPath, buildAgentsMd(guide), 'utf8');
    log('[root-sync] AGENTS.md created');
  } else {
    // Update sentinel sections
    const agentsSections: RootSyncSection[] = [
      { sentinel: 'agents:when-to-run', content: `## When to Run SpecGuard\n\n${guide.whenToRun}` },
      { sentinel: 'agents:pipelines', content: `## Available Pipelines\n\n${guide.availablePipelines}` },
      { sentinel: 'agents:spec-format', content: `## Living Spec Format\n\n${guide.specFormat}` },
      { sentinel: 'agents:config-apps', content: `## Configured Apps\n\n${guide.configApps}` },
      { sentinel: 'agents:workflows', content: `## Common Agent Workflows\n\n${guide.commonWorkflows}` },
    ];
    applyTargetSections(agentsPath, agentsSections);
    log('[root-sync] AGENTS.md updated');
  }
}
