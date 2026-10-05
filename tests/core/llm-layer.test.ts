import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (model: string) => ({ provider: 'anthropic', model })),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ chat: (model: string) => ({ provider: 'openai', model }) })),
}));

import { generateObject, generateText } from 'ai';
import {
  budgetExceededMessage,
  configureLlm,
  llmClock,
  LlmBudgetExceededError,
  LlmDisabledError,
  llmGenerateObject,
  llmGenerateText,
  ReplayMissError,
  resetLlmRuntime,
  resolveTargets,
  runWithPipeline,
  setRecordMode,
} from '../../src/core/llm.js';
import { replayKey } from '../../src/core/llm-replay.js';
import { estimateUsd, priceFor, readUsageLog } from '../../src/core/llm-usage.js';
import { SpecGuardError } from '../../src/core/errors.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import type { LlmConfig } from '../../src/core/types.js';

const gt = generateText as unknown as ReturnType<typeof vi.fn>;
const go = generateObject as unknown as ReturnType<typeof vi.fn>;
const KEY = 'SG_LAYER_KEY';
let root: string;

const base: LlmConfig = { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyEnv: KEY };
const call = (over: Partial<Parameters<typeof llmGenerateText>[0]> = {}) =>
  llmGenerateText({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyEnv: KEY, prompt: 'p', ...over });
const ok = (text = 'hi', usage = { inputTokens: 1000, outputTokens: 500 }) => ({ text, usage });
const configure = (llm: Partial<LlmConfig> = {}) => configureLlm({ rootDir: root, llm: { ...base, backoffMs: 0, ...llm } });

beforeEach(() => {
  vi.clearAllMocks();
  gt.mockReset();
  go.mockReset();
  resetLlmRuntime();
  process.env[KEY] = 'sk-test-secret';
  root = mkdtempSync(path.join(os.tmpdir(), 'sg-llm-'));
  vi.spyOn(llmClock, 'sleep').mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env[KEY];
  vi.restoreAllMocks();
});

describe('per-pipeline overrides and fallback', () => {
  it('applies the override for the running pipeline, else the call-site target', async () => {
    configure({ pipelines: { align: { model: 'claude-haiku-4-5', provider: 'openai' } } });
    expect(resolveTargets({ provider: 'anthropic', model: 'm', apiKeyEnv: 'K', pipeline: 'align' })[0]).toMatchObject({ provider: 'openai', model: 'claude-haiku-4-5', apiKeyEnv: 'K' });
    expect(resolveTargets({ provider: 'anthropic', model: 'm', apiKeyEnv: 'K', pipeline: 'heal' })[0]).toMatchObject({ provider: 'anthropic', model: 'm' });
    gt.mockResolvedValue(ok());
    await runWithPipeline('align', () => call());
    expect(readUsageLog(root).byPipeline.align.calls).toBe(1);
    expect(readUsageLog(root).byModel['claude-haiku-4-5'].calls).toBe(1);
  });

  it('tries the fallback chain after the primary exhausts its attempts', async () => {
    configure({ retries: 1, fallback: [{ provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: KEY }] });
    gt.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { statusCode: 529 }))
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { statusCode: 529 }))
      .mockResolvedValueOnce(ok('from-fallback'));
    expect(await call()).toBe('from-fallback');
    expect(gt).toHaveBeenCalledTimes(3);
    expect(readUsageLog(root).byModel['gpt-4o-mini'].calls).toBe(1);
  });

  it('reports every target when all fail', async () => {
    configure({ retries: 0, fallback: [{ provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: KEY }] });
    gt.mockRejectedValue(Object.assign(new Error('bad request'), { statusCode: 400 }));
    await expect(call()).rejects.toThrow(/All LLM targets failed.*anthropic.*openai/);
  });
});

describe('timeout and retry', () => {
  it('passes a timeout signal, retries retryable errors with growing backoff, and stops on auth errors', async () => {
    configure({ retries: 2, backoffMs: 100 });
    vi.spyOn(llmClock, 'random').mockReturnValue(1);
    gt.mockRejectedValueOnce(Object.assign(new Error('rate'), { statusCode: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
      .mockResolvedValueOnce(ok());
    expect(await call()).toBe('hi');
    expect(gt).toHaveBeenCalledTimes(3);
    expect(gt.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
    expect((llmClock.sleep as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([100, 200]);

    gt.mockReset();
    gt.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
    await expect(call()).rejects.toThrow('unauthorized');
    expect(gt).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing key', async () => {
    configure();
    delete process.env[KEY];
    await expect(call()).rejects.toBeInstanceOf(SpecGuardError);
    expect(gt).not.toHaveBeenCalled();
  });

  it('gives up after the retry budget', async () => {
    configure({ retries: 1 });
    gt.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    await expect(call()).rejects.toThrow('boom');
    expect(gt).toHaveBeenCalledTimes(2);
  });

  it('a real timeout aborts a hung call', async () => {
    configure({ retries: 0, timeoutMs: 20 });
    gt.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) =>
      new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))),
    );
    await expect(call()).rejects.toThrow('aborted');
  });
});

describe('usage log and pricing', () => {
  it('records tokens, calls and estimated cost in total, per pipeline and per model', async () => {
    configure();
    gt.mockResolvedValue(ok('x', { inputTokens: 2_000_000, outputTokens: 1_000_000 }));
    await runWithPipeline('reverse', () => call());
    await runWithPipeline('heal', () => call());
    const log = readUsageLog(root);
    // sonnet: $3 in + $15 out per MTok => 6 + 15 = 21 per call
    expect(log.totals).toMatchObject({ calls: 2, inputTokens: 4_000_000, outputTokens: 2_000_000, estimatedUsd: 42 });
    expect(log.byPipeline.reverse.estimatedUsd).toBe(21);
    expect(Object.keys(log.byPipeline).sort()).toEqual(['heal', 'reverse']);
    expect(existsSync(path.join(root, '.specguard', 'llm-usage.json'))).toBe(true);
  });

  it('uses overrides, counts unpriced models, and never charges for them', async () => {
    expect(priceFor('claude-opus-4')).toEqual({ inputPerMTok: 15, outputPerMTok: 75 });
    expect(priceFor('mystery')).toBeUndefined();
    expect(priceFor('mystery', { mystery: { inputPerMTok: 1, outputPerMTok: 2 } })).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(estimateUsd(1_000_000, 1_000_000, { inputPerMTok: 1, outputPerMTok: 2 })).toBe(3);
    configure({ model: 'mystery' });
    gt.mockResolvedValue(ok());
    await call({ model: 'mystery' });
    expect(readUsageLog(root).totals).toMatchObject({ unpricedCalls: 1, estimatedUsd: 0 });
  });
});

describe('budget', () => {
  it('maxCalls refuses the next call, flags the run, and carries exit code 8', async () => {
    configure({ budget: { maxCalls: 2 } });
    gt.mockResolvedValue(ok());
    await call();
    await call();
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(LlmBudgetExceededError);
    expect(err.exitCode).toBe(ExitCode.BudgetExceeded);
    expect(err.message).toMatch(/2 of 2 calls/);
    expect(gt).toHaveBeenCalledTimes(2);
    expect(budgetExceededMessage()).toMatch(/budget exceeded/);
  });

  it('maxUsd stops after the call that crosses it', async () => {
    configure({ budget: { maxUsd: 10 } });
    gt.mockResolvedValue(ok('x', { inputTokens: 2_000_000, outputTokens: 1_000_000 })); // $21
    await call();
    await expect(call()).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });

  it('maxTokens counts projected input as well as spent tokens', async () => {
    configure({ budget: { maxTokens: 1000 } });
    await expect(call({ prompt: 'x'.repeat(8000) })).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(gt).not.toHaveBeenCalled();
  });

  it('a budget error is never retried or sent to a fallback', async () => {
    configure({ budget: { maxCalls: 1 }, fallback: [{ provider: 'openai', model: 'gpt-4o', apiKeyEnv: KEY }] });
    gt.mockResolvedValue(ok());
    await call();
    await expect(call()).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(gt).toHaveBeenCalledTimes(1);
  });
});

describe('replay and record', () => {
  const schema = z.object({ name: z.string() });

  it('records with a real provider, then replays the same request offline', async () => {
    configure({ replay: { dir: 'rec' } });
    setRecordMode(true);
    gt.mockResolvedValue(ok('recorded text'));
    go.mockResolvedValue({ object: { name: 'recorded' }, usage: { inputTokens: 1, outputTokens: 1 } });
    expect(await call({ system: 'sys', prompt: 'hello' })).toBe('recorded text');
    expect(await llmGenerateObject({ provider: 'anthropic', model: 'm', apiKeyEnv: KEY, prompt: 'obj', schema })).toEqual({ name: 'recorded' });
    expect(readdirSync(path.join(root, 'rec'))).toHaveLength(2);

    resetLlmRuntime();
    gt.mockReset();
    go.mockReset();
    configureLlm({ rootDir: root, llm: { provider: 'replay', model: 'x', apiKeyEnv: 'NONE', replay: { dir: 'rec' } } });
    delete process.env[KEY];
    expect(await llmGenerateText({ provider: 'replay', model: 'x', apiKeyEnv: 'NONE', system: 'sys', prompt: 'hello' })).toBe('recorded text');
    expect(await llmGenerateObject({ provider: 'replay', model: 'x', apiKeyEnv: 'NONE', prompt: 'obj', schema })).toEqual({ name: 'recorded' });
    expect(gt).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(readUsageLog(root).totals.replayedCalls).toBe(2);
  });

  it('a miss names the hash and how to record; a changed prompt or image misses', async () => {
    configureLlm({ rootDir: root, llm: { provider: 'replay', model: 'x', apiKeyEnv: 'N', replay: { dir: 'rec' } } });
    const err = await llmGenerateText({ provider: 'replay', model: 'x', apiKeyEnv: 'N', prompt: 'unseen' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReplayMissError);
    expect(err.message).toContain(replayKey('text', undefined, 'unseen').slice(0, 16));
    expect(err.message).toMatch(/--record/);
    expect(replayKey('text', 's', 'p')).not.toBe(replayKey('text', 's', 'p2'));
    expect(replayKey('text', 's', 'p', [Buffer.from('a')])).not.toBe(replayKey('text', 's', 'p', [Buffer.from('b')]));
    expect(replayKey('text', 's', 'p')).not.toBe(replayKey('object', 's', 'p'));
  });

  it('a recording that no longer fits the schema is an error, not a silent pass', async () => {
    configure({ replay: { dir: 'rec' } });
    setRecordMode(true);
    go.mockResolvedValue({ object: { wrong: 1 }, usage: {} });
    await llmGenerateObject({ provider: 'anthropic', model: 'm', apiKeyEnv: KEY, prompt: 'o', schema: z.any() });
    resetLlmRuntime();
    configureLlm({ rootDir: root, llm: { provider: 'replay', model: 'x', apiKeyEnv: 'N', replay: { dir: 'rec' } } });
    await expect(llmGenerateObject({ provider: 'replay', model: 'x', apiKeyEnv: 'N', prompt: 'o', schema })).rejects.toThrow();
  });
});

describe('provider none and allowImages', () => {
  it('none throws LlmDisabledError without touching the SDK', async () => {
    configure({ provider: 'none' });
    await expect(call({ provider: 'none' })).rejects.toBeInstanceOf(LlmDisabledError);
    expect(gt).not.toHaveBeenCalled();
  });

  it('allowImages:false rejects a call with images and lets text through', async () => {
    configure({ allowImages: false });
    gt.mockResolvedValue(ok());
    await expect(call({ images: [Buffer.from('png')] })).rejects.toThrow(/allowImages/);
    expect(await call()).toBe('hi');
  });
});
