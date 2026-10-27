import { existsSync, mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), generateObject: vi.fn() };
});
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: vi.fn(() => (model: string) => ({ provider: 'anthropic', model })) }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => ({ chat: (model: string) => ({ provider: 'openai', model }) })) }));

import { generateObject } from 'ai';
import {
  AgentWorkPendingError,
  answerAgentRequest,
  detectHostAgent,
  listAgentRequests,
  parseAnswerText,
  pendingThisRun,
  readAgentRequest,
  resetPending,
  resolveRequestHash,
} from '../../src/core/agent-work.js';
import { configureLlm, llmGenerateObject, llmGenerateText, resetLlmRuntime } from '../../src/core/llm.js';
import { replayKey } from '../../src/core/llm-replay.js';
import { SpecGuardError } from '../../src/core/errors.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import type { LlmConfig } from '../../src/core/types.js';

const go = generateObject as unknown as ReturnType<typeof vi.fn>;
const KEY = 'SG_HOST_TEST_KEY';
let root: string;

const Schema = z.object({ summary: z.string(), n: z.number() });
const ask = (over: Partial<Parameters<typeof llmGenerateObject<z.infer<typeof Schema>>>[0]> = {}) =>
  llmGenerateObject({ provider: 'host', model: 'host-agent', apiKeyEnv: KEY, pipeline: 'summarize', system: 'sys', prompt: 'describe it', schema: Schema, ...over });
const configure = (llm: Partial<LlmConfig> = {}) => configureLlm({ rootDir: root, llm: { provider: 'host', model: 'host-agent', apiKeyEnv: KEY, ...llm } });
const hashOf = (prompt = 'describe it', system: string | undefined = 'sys', kind: 'object' | 'text' = 'object') => replayKey(kind, system, prompt);
const replayDir = () => path.join(root, '.specguard', 'replay');

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  go.mockReset();
  resetLlmRuntime();
  resetPending();
  delete process.env[KEY];
  delete process.env.CLAUDECODE;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.SPECGUARD_HOST_AGENT;
  root = mkdtempSync(path.join(os.tmpdir(), 'sg-host-'));
  configure();
});
afterEach(() => {
  process.env = { ...savedEnv };
  resetLlmRuntime();
  resetPending();
});

describe('host agent provider [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('writes a request with the answer schema and raises AgentWorkPendingError instead of calling a model', async () => {
    const err = await ask().catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkPendingError);
    expect((err as AgentWorkPendingError).exitCode).toBe(ExitCode.AgentWorkPending);
    expect(go).not.toHaveBeenCalled();

    const hash = hashOf();
    const req = readAgentRequest(root, hash);
    expect(req).toMatchObject({ version: 1, kind: 'object', pipeline: 'summarize', system: 'sys', prompt: 'describe it', answerFile: `.specguard/replay/${hash}.json` });
    expect(req?.jsonSchema).toMatchObject({ type: 'object', required: ['summary', 'n'], properties: { summary: { type: 'string' }, n: { type: 'number' } } });
    expect(pendingThisRun().map((p) => p.hash)).toEqual([hash]);
    // The request holds the (masked) prompt: owner-only, like the other files that may carry project text.
    expect(statSync(path.join(root, '.specguard', 'agent-requests', `${hash}.json`)).mode & 0o077).toBe(0);
  });

  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('serves the answer the agent recorded, validated by the pipeline schema, and clears the request', async () => {
    await ask().catch(() => undefined);
    const hash = hashOf();
    answerAgentRequest(root, replayDir(), hash, { summary: 'does a thing', n: 3 });
    resetPending();
    await expect(ask()).resolves.toEqual({ summary: 'does a thing', n: 3 });
    expect(existsSync(path.join(root, '.specguard', 'agent-requests', `${hash}.json`))).toBe(false);
    expect(pendingThisRun()).toEqual([]);
  });

  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('sets an answer that fails the schema aside, records why on the request, and asks again', async () => {
    await ask().catch(() => undefined);
    const hash = hashOf();
    answerAgentRequest(root, replayDir(), hash, { summary: 'ok', n: 'not a number' });
    resetPending();
    const err = await ask().catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkPendingError);
    expect(existsSync(path.join(replayDir(), `${hash}.json`))).toBe(false);
    expect(existsSync(path.join(replayDir(), 'rejected', `${hash}.json`))).toBe(true);
    expect(readAgentRequest(root, hash)?.rejection).toMatch(/number/i);
    expect(pendingThisRun()[0].rejection).toBeTruthy();

    // Still waiting on a second run: the earlier refusal is kept, not rewritten away.
    resetPending();
    await ask().catch(() => undefined);
    expect(readAgentRequest(root, hash)?.rejection).toMatch(/number/i);
  });

  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('handles text requests, and masks credentials in the request it writes', async () => {
    const err = await llmGenerateText({ provider: 'host', model: 'host-agent', apiKeyEnv: KEY, pipeline: 'docs', prompt: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here' }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkPendingError);
    const [req] = listAgentRequests(root);
    expect(req.kind).toBe('text');
    expect(req.jsonSchema).toBeUndefined();
    expect(req.prompt).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    answerAgentRequest(root, replayDir(), req.hash, 'plain answer');
    await expect(llmGenerateText({ provider: 'host', model: 'host-agent', apiKeyEnv: KEY, pipeline: 'docs', prompt: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here' })).resolves.toBe('plain answer');
  });

  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('is chosen on its own for a keyed provider with no key inside an agent, and never when a key exists or it is switched off', async () => {
    configure({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    const keyed = () => ask({ provider: 'anthropic', model: 'claude-sonnet-4-6' });

    // No key and no agent: the usual missing-key error, not a request.
    await expect(keyed()).rejects.toThrow(/Missing API key/);
    expect(listAgentRequests(root)).toEqual([]);

    // No key inside Claude Code: the agent is asked.
    process.env.CLAUDECODE = '1';
    await expect(keyed()).rejects.toBeInstanceOf(AgentWorkPendingError);
    expect(listAgentRequests(root)).toHaveLength(1);

    // Switched off, it is the missing-key error again.
    process.env.SPECGUARD_HOST_AGENT = '0';
    await expect(keyed()).rejects.toThrow(/Missing API key/);

    // With a key, the model is called even inside an agent.
    delete process.env.SPECGUARD_HOST_AGENT;
    process.env[KEY] = 'sk-test';
    go.mockResolvedValue({ object: { summary: 'from the model', n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } });
    await expect(keyed()).resolves.toEqual({ summary: 'from the model', n: 1 });
  });

  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('leaves calls that opt out (hooks) alone, and refuses image calls it cannot hand over', async () => {
    process.env.CLAUDECODE = '1';
    configure({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    await expect(ask({ provider: 'anthropic', model: 'claude-sonnet-4-6', hostAgent: false })).rejects.toThrow(/Missing API key/);
    expect(listAgentRequests(root)).toEqual([]);

    configure();
    const err = await ask({ images: [Buffer.from('png')] }).catch((e) => e);
    expect(err).toBeInstanceOf(SpecGuardError);
    expect(err).not.toBeInstanceOf(AgentWorkPendingError);
    expect(String(err.message)).toMatch(/images/);
  });
});

describe('agent work helpers [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('detects an agent: Claude Code on its own, others by SPECGUARD_HOST_AGENT, either way switch-off-able', () => {
    expect(detectHostAgent({})).toBe(false);
    expect(detectHostAgent({ CLAUDECODE: '1' })).toBe(true);
    expect(detectHostAgent({ SPECGUARD_HOST_AGENT: '1' })).toBe(true);
    expect(detectHostAgent({ SPECGUARD_HOST_AGENT: '0', CLAUDECODE: '1' })).toBe(false);
  });

  // [claims: capabilities/platform-foundation#host-agent-provider]
  it('accepts answers by unique hash prefix, tolerates a code fence, and rejects a malformed answer', async () => {
    await ask().catch(() => undefined);
    const hash = hashOf();
    expect(resolveRequestHash(root, hash.slice(0, 10))).toBe(hash);
    expect(resolveRequestHash(root, hash.slice(0, 4))).toBeNull(); // too short to be unique
    expect(resolveRequestHash(root, 'ffffffffff')).toBeNull();

    expect(parseAnswerText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseAnswerText(' {"a":2} ')).toEqual({ a: 2 });
    expect(() => parseAnswerText('not json')).toThrow();

    expect(() => answerAgentRequest(root, replayDir(), hash, 'a string for an object request')).toThrow(/object/);
    expect(() => answerAgentRequest(root, replayDir(), 'a'.repeat(64), {})).toThrow(/No pending agent request/);
    expect(existsSync(path.join(replayDir(), `${hash}.json`))).toBe(false); // nothing recorded by the refused answers
  });
});
