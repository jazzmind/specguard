/**
 * The `quality` plugin: ESLint, Knip and Ruff findings in one report.
 *
 * Enabled with `"plugins": ["quality"]`. It adds `specguard quality` and the
 * `specguard_quality` MCP tool, and writes `.specguard/code-quality.json`,
 * which the dashboard and CI gates read. Code quality is not one of
 * SpecGuard's pillars, so none of this is in core.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { z } from 'zod';

import { ExitCode } from '../../core/exit-codes.js';
import type { SpecGuardPlugin } from '../types.js';
import { runCodeQuality } from './code-quality.js';

export const plugin: SpecGuardPlugin = {
  id: 'quality',
  commands: [
    {
      name: 'quality',
      description: 'run code quality checks (ESLint, Knip, Ruff) and write .specguard/code-quality.json',
      options: [
        { flags: '--app <name>', description: 'limit to one app' },
        { flags: '--fix', description: 'auto-fix what the linters can fix' },
      ],
      mcpParams: {
        app: z.string().optional().describe('Limit to a single app by name.'),
        fix: z.boolean().optional().describe('Auto-fix fixable lint issues.'),
      },
      async run({ config, opts }) {
        if (!config) throw new Error('quality needs a SpecGuard config');
        const result = await runCodeQuality(config, { app: opts.app as string | undefined, fix: opts.fix as boolean | undefined });
        result.messages.push(`quality: ${result.created} finding(s) — ${result.failed} error(s)`);
        if (result.failed === 0) result.exitCode = ExitCode.Success;
        return result;
      },
    },
  ],
};
