/**
 * Init pipeline.
 *
 * Scaffolds `.specguard/config.json`, `specs/README.md`, `.specguard/.env`,
 * and `.specguard/drift-registry.json` in the target directory when they are
 * missing. Never overwrites existing files. Returns a `PipelineResult`
 * describing what was created and what was skipped.
 *
 * This is the pure-logic counterpart to `cli/commands/init.ts`, which wraps
 * this function with stdout messages and `process.exit`.
 */
import path from 'node:path';

import type { PipelineResult } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { ExitCode } from '../core/exit-codes.js';
import { fileExists, readFile } from '../core/reader.js';
import { writeFile } from '../core/writer.js';

export interface InitOpts {
  /** Auto-detect framework from package.json when not set (default: auto). */
  framework?: 'vitest' | 'jest' | 'playwright';
  /** Override the target directory (default: process.cwd()). */
  cwd?: string;
}

export interface InitResult extends PipelineResult {
  created: number;
  skipped: number;
  /** Paths that were newly created. */
  createdFiles: string[];
  /** Paths that already existed and were not overwritten. */
  skippedFiles: string[];
}

type Framework = 'vitest' | 'jest' | 'playwright';

async function detectFramework(cwd: string): Promise<Framework> {
  const pkgPath = path.join(cwd, 'package.json');
  if (!(await fileExists(pkgPath))) return 'vitest';
  try {
    const pkg = JSON.parse(await readFile(pkgPath)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const has = (name: string) =>
      Object.keys(deps).some((d) => d === name || d.startsWith(`${name}/`) || d.startsWith(`@${name}`));
    if (has('@playwright/test') || has('playwright')) return 'playwright';
    if (has('jest')) return 'jest';
    if (has('vitest')) return 'vitest';
  } catch { /* malformed package.json */ }
  return 'vitest';
}

function defaultConfig(framework: Framework): string {
  const config = {
    apps: [
      {
        name: 'app',
        repo: '.',
        specDir: 'specs',
        sources: {
          routes: ['src/**/*.{ts,tsx,js,jsx}'],
          api: ['src/api/**/*.{ts,js}'],
          tests: ['tests/**/*.test.{ts,js}'],
        },
        framework,
        testOutput: 'tests/',
        security: { enabled: false },
        docs: false,
      },
    ],
    runners: {
      playwright: 'local',
      semgrep: 'auto',
      bandit: 'auto',
      testRunner: 'local',
    },
    llm: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    heal: {
      maxRetries: 2,
      testCommand: framework === 'playwright' ? 'npx playwright test' : 'npm test',
    },
    matrix: {
      format: 'json',
      output: '.specguard/traceability.json',
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

const SPECS_README = `# Living Specifications

This directory holds SpecGuard's Living Specifications — the source of truth
for each module's behavior. One spec file per module, mirroring your source
layout.

## Format

Each spec is Markdown with a metadata comment block and these sections:

\`\`\`markdown
# <Module Title>

<!--
  module: src/path/to/module.ts
  type: core | pipeline | adapter | cli
  status: draft | stable
-->

## Overview
## Acceptance Criteria
## Scenarios
## Security Notes
## Dependencies
\`\`\`

## Workflow

- \`specguard reverse --app <name>\` — generate specs from existing source
- \`specguard generate --all\` — generate tests from specs
- \`specguard validate --all\` — run specs against the running app
- \`specguard status\` — report spec coverage
`;

const DOT_ENV_TEMPLATE = `# SpecGuard environment variables — git-ignored.
# Uncomment and fill in the key for your chosen LLM provider.

# Anthropic (default)
ANTHROPIC_API_KEY=your-key-here

# OpenAI
# OPENAI_API_KEY=your-key-here

# LiteLLM (local — default base URL: http://localhost:4000)
# LITELLM_BASE_URL=http://localhost:4000
`;

/**
 * Scaffold the SpecGuard configuration and supporting files in `cwd`.
 * Never overwrites existing files.
 */
export async function runInit(opts: InitOpts = {}): Promise<InitResult> {
  const result = emptyResult('init') as InitResult;
  result.createdFiles = [];
  result.skippedFiles = [];

  const cwd = opts.cwd ?? process.cwd();
  const framework = opts.framework ?? (await detectFramework(cwd));

  const configPath = path.join(cwd, '.specguard', 'config.json');
  const specsReadmePath = path.join(cwd, 'specs', 'README.md');
  const dotEnvPath = path.join(cwd, '.specguard', '.env');
  const driftRegistryPath = path.join(cwd, '.specguard', 'drift-registry.json');
  const gitignorePath = path.join(cwd, '.gitignore');

  const tryCreate = async (filePath: string, content: string): Promise<void> => {
    const rel = path.relative(cwd, filePath);
    if (await fileExists(filePath)) {
      result.messages.push(`  skipped  ${rel} (already exists)`);
      result.skippedFiles.push(filePath);
      result.skipped += 1;
    } else {
      await writeFile(filePath, content);
      result.messages.push(`  created  ${rel}`);
      result.createdFiles.push(filePath);
      result.created += 1;
    }
  };

  await tryCreate(configPath, defaultConfig(framework));
  await tryCreate(specsReadmePath, SPECS_README);
  await tryCreate(dotEnvPath, DOT_ENV_TEMPLATE);
  await tryCreate(driftRegistryPath, '{}\n');

  // Best-effort: ensure .gitignore lists .specguard/.env
  try {
    let gitignoreContent = (await fileExists(gitignorePath))
      ? await readFile(gitignorePath)
      : '';
    if (!gitignoreContent.includes('.specguard/.env')) {
      gitignoreContent += (gitignoreContent.endsWith('\n') ? '' : '\n') + '.specguard/.env\n';
      await writeFile(gitignorePath, gitignoreContent);
      result.messages.push('  updated  .gitignore (.specguard/.env added)');
    }
  } catch { /* best-effort */ }

  result.messages.unshift(`specguard init (framework: ${framework})`);
  result.exitCode = ExitCode.Success;
  return result;
}
