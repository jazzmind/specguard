/**
 * The `git` plugin: commit what SpecGuard generated, and keep a changelog.
 *
 * Enabled with `"plugins": ["git"]`. It adds `specguard commit` and the
 * `specguard_commit` MCP tool. It stages only generated files (tests, docs,
 * specs, `.specguard/` reports) and never hand-written source. Requirement
 * history, not this changelog, is where the reasons for a change live.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { z } from 'zod';

import type { SpecGuardPlugin } from '../types.js';
import { runGitOps } from './git-ops.js';

export const plugin: SpecGuardPlugin = {
  id: 'git',
  commands: [
    {
      name: 'commit',
      description: 'stage and commit SpecGuard-generated files only (tests, docs, specs, .specguard reports); never source code',
      options: [
        { flags: '--dry-run', description: 'preview without staging or committing' },
        { flags: '--message <text>', description: 'commit message suffix' },
        { flags: '--app <name>', description: 'restrict to one app' },
        { flags: '--pipeline <name>', description: 'the pipeline that produced the output, for a descriptive message and the changelog' },
      ],
      mcpParams: {
        dryRun: z.boolean().optional().describe('Preview without staging/committing.'),
        message: z.string().optional().describe('Custom commit message suffix.'),
        app: z.string().optional().describe('Restrict to a single app.'),
      },
      async run({ config, opts }) {
        if (!config) throw new Error('commit needs a SpecGuard config');
        const pipeline = opts.pipeline as string | undefined;
        const message = opts.message as string | undefined;
        const result = await runGitOps(config, {
          dryRun: Boolean(opts.dryRun),
          message,
          app: opts.app as string | undefined,
          context: pipeline ? { pipeline, summary: message } : undefined,
        });
        result.messages.push(`commit: ${result.created} file(s) staged${opts.dryRun ? ' (dry-run)' : ''}`);
        return result;
      },
    },
  ],
};
