/**
 * `specguard start`: from an existing project to a first answer in one resumable command.
 *
 * Sets the project up if needed, drafts the specs from the code, links the tests to the requirements
 * they prove, runs the tests and reports where things stand. Each step is idempotent, so the command
 * can be run again after the host coding agent has answered the model requests a step is waiting for
 * (exit code 12), and it carries on from there.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { AgentWorkPendingError } from '../core/agent-work.js';
import { loadConfig } from '../core/config.js';
import { ConfigNotFoundError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { specsRootDir } from '../core/spec-key.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { runCheck } from './check.js';
import { runInit } from './init.js';
import { runSpecDraft } from './spec-draft.js';
import { runSpecTag } from './spec-tag.js';
import { runTestRun } from './test-run.js';

export interface StartOpts {
  cwd?: string;
  /** Do not run the project's tests (they may be slow or need services). */
  skipTests?: boolean;
  onLog?: (line: string) => void;
}

export async function runStart(opts: StartOpts = {}): Promise<PipelineResult> {
  const cwd = opts.cwd ?? process.cwd();
  const result = emptyResult('start');
  const log = (line: string): void => {
    result.messages.push(line);
    opts.onLog?.(line);
  };
  const step = (n: number, what: string): void => log(`[${n}/5] ${what}`);
  const stop = (what: string): PipelineResult => {
    log(`stopped at: ${what}. Run \`specguard start\` again once that is done; it continues from here.`);
    return result;
  };

  step(1, 'project setup');
  let config: SpecGuardConfig;
  try {
    config = await loadConfig(cwd);
    log('  found .specguard/config.json');
  } catch (err) {
    if (!(err instanceof ConfigNotFoundError)) throw err;
    const init = await runInit({ cwd });
    for (const line of init.messages) log(`  ${line.trim()}`);
    config = await loadConfig(cwd);
  }

  step(2, 'specs from the code');
  if (existsSync(path.join(specsRootDir(config), 'system.md'))) {
    log('  specs already drafted (specs/system.md exists)');
  } else {
    try {
      const draft = await runSpecDraft(config, { yes: true });
      for (const line of draft.messages) log(`  ${line}`);
      if (draft.exitCode === ExitCode.AgentWorkPending) {
        result.exitCode = ExitCode.AgentWorkPending;
        return stop('the specs wait for the host agent (see the pending requests)');
      }
      if (draft.failed > 0) {
        result.failed += draft.failed;
        result.exitCode = draft.exitCode;
        return stop('drafting the specs failed');
      }
    } catch (err) {
      if (err instanceof AgentWorkPendingError) {
        result.exitCode = ExitCode.AgentWorkPending;
        return stop('the specs wait for the host agent (see the pending requests)');
      }
      throw err;
    }
  }

  step(3, 'link tests to requirements');
  try {
    const tag = await runSpecTag(config, { yes: true });
    for (const line of tag.messages) log(`  ${line}`);
  } catch (err) {
    if (err instanceof AgentWorkPendingError) {
      result.exitCode = ExitCode.AgentWorkPending;
      return stop('test tagging waits for the host agent (see the pending requests)');
    }
    throw err;
  }

  step(4, 'run the tests');
  if (opts.skipTests) {
    log('  skipped (--skip-tests)');
  } else {
    try {
      const run = await runTestRun(config, {});
      for (const line of run.messages.slice(-6)) log(`  ${line}`);
      if (run.exitCode !== ExitCode.Success) log('  the test run did not pass cleanly; requirements it could not prove show as unproven below');
    } catch (err) {
      log(`  could not run the tests: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  step(5, 'where things stand');
  const check = await runCheck(config, {});
  for (const line of check.messages) log(`  ${line}`);
  result.created = check.created;
  log('Next: review the drafted specs in specs/capabilities/ (they describe what the code does today, which may not be what it should do), then `specguard check --gaps` lists what nothing proves yet.');
  result.exitCode = ExitCode.Success;
  return result;
}
