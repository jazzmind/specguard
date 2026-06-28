/**
 * `specguard init` — scaffold a new SpecGuard config and specs directory.
 *
 * Creates `.specguard/config.json` and `specs/README.md` if absent. Never
 * overwrites existing files. Auto-detects the test framework from the nearest
 * `package.json` dependencies (playwright > jest > vitest default).
 */
import path from 'node:path';
import { fileExists, readFile } from '../../core/reader.js';
import { writeFile } from '../../core/writer.js';

export interface InitOpts {
  withPlaywright?: boolean;
}

type Framework = 'vitest' | 'jest' | 'playwright';

/** Inspect `package.json` deps to pick a sensible default framework. */
async function detectFramework(cwd: string): Promise<Framework> {
  const pkgPath = path.join(cwd, 'package.json');
  if (!(await fileExists(pkgPath))) return 'vitest';
  try {
    const pkg = JSON.parse(await readFile(pkgPath)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const has = (name: string): boolean =>
      Object.keys(deps).some((d) => d === name || d.startsWith(`${name}/`) || d.startsWith(`@${name}`));
    if (has('@playwright/test') || has('playwright')) return 'playwright';
    if (has('jest')) return 'jest';
    if (has('vitest')) return 'vitest';
  } catch {
    // Malformed package.json — fall through to the default.
  }
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

export async function initCommand(opts: InitOpts): Promise<void> {
  const cwd = process.cwd();
  const configPath = path.join(cwd, '.specguard', 'config.json');
  const specsReadmePath = path.join(cwd, 'specs', 'README.md');

  let framework = await detectFramework(cwd);
  if (opts.withPlaywright) framework = 'playwright';

  const created: string[] = [];
  const skipped: string[] = [];

  if (await fileExists(configPath)) {
    skipped.push('.specguard/config.json');
  } else {
    await writeFile(configPath, defaultConfig(framework));
    created.push('.specguard/config.json');
  }

  if (await fileExists(specsReadmePath)) {
    skipped.push('specs/README.md');
  } else {
    await writeFile(specsReadmePath, SPECS_README);
    created.push('specs/README.md');
  }

  // .cursor skill / mcp.json wiring is best-effort and optional in Phase 1.
  // Skipped here; surface a note so users know it's not automated yet.

  process.stdout.write(`specguard init (framework: ${framework})\n`);
  for (const f of created) process.stdout.write(`  created  ${f}\n`);
  for (const f of skipped) process.stdout.write(`  skipped  ${f} (already exists)\n`);
  process.stdout.write('  note     .cursor skill / mcp.json wiring not automated yet (Phase 1)\n');
  process.stdout.write('\nNext steps:\n');
  process.stdout.write('  1. Review .specguard/config.json and adjust app sources/globs\n');
  process.stdout.write('  2. Set your LLM API key env var (see config.llm.apiKeyEnv)\n');
  process.stdout.write('  3. Run `specguard reverse --app app` to generate your first specs\n');

  process.exit(0);
}
