import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => ''),
  llmGenerateObject: vi.fn(),
  resolveTargets: vi.fn((o: { model: string }) => [{ provider: 'p', model: o.model }]),
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {},
}));

import { llmGenerateText } from '../../src/core/llm.js';
import { loadWorkspaceWithConfigs } from '../../src/core/workspace.js';
import { DEFAULT_MAX_LLM_SPECS, runContracts } from '../../src/pipelines/contracts.js';

const llm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;

function workspace(specCount: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-cllm-'));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  put('ws/.specguard/workspace.json', JSON.stringify({ version: '1', name: 'ws', repos: { a: { path: '../a', role: 'consumer' }, b: { path: '../b', role: 'provider' } } }));
  const config = JSON.stringify({ apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }], llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' } });
  put('a/.specguard/config.json', config);
  put('b/.specguard/config.json', config);
  for (let i = 0; i < specCount; i += 1) {
    put(`a/specs/s${i}.md`, `# Spec ${i}\n\n<!-- module: src/s${i}.ts / type: core / status: draft -->\n\n## Overview\nx\n\n## Dependencies\nCalls the provider's API: POST /thing${i}. SECRET-MARKER-${i}\n\n## Scenarios\n\n### Scenario 1: x\n**Steps:**\n1. y\n\n**Expected Results:**\n- z\n`);
  }
  return path.join(dir, 'ws');
}

beforeEach(() => llm.mockClear());

describe('what contracts --with-llm sends to the model [contracts-llm-cap]', () => {
  // [claims: capabilities/workspaces#contracts-llm-cap]
  it('sends only the Dependencies text of each spec, says so and lists them, and stops at the cap', async () => {
    const ws = workspace(5);
    const { manifest, repos } = await loadWorkspaceWithConfigs(ws);
    const res = await runContracts(manifest, repos, { withLlm: true, maxLlmSpecs: 2 }, repos[0].specGuardConfig!);
    expect(llm).toHaveBeenCalledTimes(2);
    const out = res.messages.join('\n');
    expect(out).toContain('Only each spec\'s Dependencies section is sent, to anthropic/m, for at most 2 spec(s)');
    expect(out.match(/\[send\] a::/g)).toHaveLength(2);
    expect(out.match(/\[cap\] a::/g)).toHaveLength(3);
    for (const call of llm.mock.calls) {
      const prompt = (call[0] as { prompt: string }).prompt;
      expect(prompt).toContain('Dependencies section text');
      expect(prompt).not.toContain('## Overview'); // not the rest of the spec
      expect(prompt).not.toContain('Scenario 1');
    }
  });

  // [claims: capabilities/workspaces#contracts-llm-cap]
  it('sends nothing without --with-llm, and defaults the cap to 50', async () => {
    const ws = workspace(3);
    const { manifest, repos } = await loadWorkspaceWithConfigs(ws);
    await runContracts(manifest, repos, {}, repos[0].specGuardConfig!);
    expect(llm).not.toHaveBeenCalled();
    expect(DEFAULT_MAX_LLM_SPECS).toBe(50);
  });
});
