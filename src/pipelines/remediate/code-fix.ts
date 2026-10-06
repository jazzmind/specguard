/**
 * LLM-backed code fixer for Semgrep findings. Only the file named by the finding is sent and
 * patched; the LLM layer's budget and replay provider apply.
 *
 * Spec: specs/pipelines/remediate.md
 */
import { z } from 'zod';

import { llmGenerateObject } from '../../core/llm.js';
import type { SpecGuardConfig } from '../../core/types.js';
import type { CodeFixer } from './apply.js';

const FixSchema = z.object({
  fixable: z.boolean(),
  /** The complete new file content. Required when fixable. */
  content: z.string().optional(),
  explanation: z.string().default(''),
});

export function llmCodeFixer(config: SpecGuardConfig): CodeFixer {
  return async (issue, content) => {
    const out = await llmGenerateObject({
      provider: config.llm.provider,
      model: config.llm.model,
      apiKeyEnv: config.llm.apiKeyEnv,
      pipeline: 'remediate',
      temperature: 0,
      maxTokens: 8000,
      system:
        'You fix one static-analysis finding with the smallest possible change. Keep behavior identical for every other input. Never edit tests. Return the complete file or set fixable=false.',
      prompt: `Finding ${issue.ruleId} at ${issue.path}:${issue.line ?? '?'} (${issue.severity}): ${issue.message}\n\nFile ${issue.path}:\n${content}`,
      schema: FixSchema,
    });
    return out.fixable && out.content ? out.content : null;
  };
}
