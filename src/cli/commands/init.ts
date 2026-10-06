/**
 * `specguard init` — scaffold a SpecGuard config, specs directory, and the
 * agent-harness files (CLAUDE.md, skills, MCP wiring, /goal command).
 *
 * Thin wrapper over `runInit` in `src/pipelines/init.ts` — all logic (language
 * detection, config template, scaffolding) lives there so the CLI and MCP share
 * one implementation.
 */
import { runInit } from '../../pipelines/init.js';
import { loadConfig } from '../../core/config.js';
import { resolveProfile, type LanguageId } from '../../core/language-profiles.js';
import { scaffoldHarnessFiles, type Harness } from '../../core/scaffold.js';

export interface InitOpts {
  /** Force Playwright as the test framework (TypeScript convenience flag). */
  withPlaywright?: boolean;
  /** Target language; auto-detected when omitted. */
  language?: string;
  /** Which harness files to generate (claude|cursor|both). */
  harness?: string;
  /** One app even when a workspace is detected. */
  single?: boolean;
  runner?: string;
  runnerPath?: string;
  updateHooks?: boolean;
}

const RUNNERS = ['node', 'npx', 'path'];

function checkRunner(runner: string | undefined): 'node' | 'npx' | 'path' | undefined {
  if (runner === undefined) return undefined;
  if (!RUNNERS.includes(runner)) {
    process.stderr.write(`unknown --runner '${runner}'. Use node, npx, or path.\n`);
    process.exit(1);
  }
  return runner as 'node' | 'npx' | 'path';
}

export async function initCommand(opts: InitOpts): Promise<void> {
  const result = await runInit({
    framework: opts.withPlaywright ? 'playwright' : undefined,
    language: opts.language as LanguageId | undefined,
    harness: opts.harness as Harness | undefined,
    single: opts.single,
    runner: checkRunner(opts.runner),
    runnerPath: opts.runnerPath,
    updateHooks: opts.updateHooks,
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }

  process.stdout.write('\nNext steps:\n');
  process.stdout.write('  1. Review .specguard/config.json and adjust app sources/globs\n');
  process.stdout.write('  2. Add your Anthropic API key to .specguard/.env (it is git-ignored)\n');
  process.stdout.write('  3. Run `specguard gap-analysis` to plan the build, then `/goal` to start it\n');

  process.exit(result.exitCode);
}

export interface ScaffoldCmdOpts {
  harness?: string;
  runner?: string;
  runnerPath?: string;
  updateHooks?: boolean;
}

/** Regenerate agent-harness files for an already-initialised project. */
export async function scaffoldCommand(opts: ScaffoldCmdOpts): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const profile = resolveProfile(config.apps[0] ?? {});
  const result = await scaffoldHarnessFiles({
    cwd,
    profile,
    harness: opts.harness as Harness | undefined,
    runner: checkRunner(opts.runner),
    runnerPath: opts.runnerPath,
    updateHooks: opts.updateHooks,
  });

  process.stdout.write(`specguard scaffold (language: ${profile.id}, harness: ${opts.harness ?? 'both'})\n`);
  for (const line of result.messages) process.stdout.write(`${line}\n`);
  process.exit(0);
}
