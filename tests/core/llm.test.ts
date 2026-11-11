import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// Mock the ai-sdk core so no real network calls occur.
vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({ text: 'mocked-text' })),
  generateObject: vi.fn(async () => ({ object: { name: 'mocked-name' } })),
}));

// Mock provider factories so resolveModel does not need real SDK behaviour.
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (model: string) => ({ provider: 'anthropic', model })),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ chat: (model: string) => ({ provider: 'openai', model }) })),
}));
vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn(() => ({ chat: (model: string) => ({ provider: 'xai', model }) })),
}));
vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: vi.fn(() => (model: string) => ({ provider: 'bedrock', model })),
}));
vi.mock('@ai-sdk/amazon-bedrock/mantle', () => ({
  createBedrockMantle: vi.fn(() => ({ chat: (model: string) => ({ provider: 'mantle', model }) })),
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(() => async () => {
    throw new Error('leaked-secret-AKIAFAKEKEY');
  }),
}));

import { generateText, generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createBedrockMantle } from '@ai-sdk/amazon-bedrock/mantle';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { llmGenerateText, llmGenerateObject, resolveModel } from '../../src/core/llm.js';
import { SpecGuardError } from '../../src/core/errors.js';

const API_KEY_ENV = 'TEST_SPECGUARD_API_KEY';

function noObject(text: string, finishReason = 'stop') {
  return Object.assign(new Error('No object generated: could not parse the response.'), { name: 'AI_NoObjectGeneratedError', text, finishReason, usage: { inputTokens: 5, outputTokens: 7 } });
}

describe('llm adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[API_KEY_ENV] = 'sk-test-secret-value';
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
  });

  describe('structured replies that are not clean JSON', () => {
    const schema = z.object({ name: z.string() });
    const call = (maxTokens?: number) => llmGenerateObject({ provider: 'anthropic', model: 'm', apiKeyEnv: API_KEY_ENV, schema, prompt: 'p', ...(maxTokens ? { maxTokens } : {}) });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('uses the JSON inside a fenced or chatty reply', async () => {
      (generateObject as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(noObject('Here you go:\n```json\n{"name":"ok"}\n```'));
      expect(await call()).toEqual({ name: 'ok' });
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('gives a reply cut off at the output limit more room once, then explains why it failed', async () => {
      const gen = generateObject as unknown as ReturnType<typeof vi.fn>;
      gen.mockRejectedValueOnce(noObject('{"name":"tru', 'length')).mockResolvedValueOnce({ object: { name: 'big' } });
      expect(await call(1000)).toEqual({ name: 'big' });
      expect(gen.mock.calls[1][0].maxOutputTokens).toBe(2000);
      gen.mockRejectedValueOnce(noObject('{"name":"tru', 'length'));
      await expect(call(40000)).rejects.toThrow(/cut off at the output limit \(40000 tokens\).*Start of the reply: \{"name":"tru/);
    });
  });

  describe('llmGenerateText', () => {
    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('returns the mocked text', async () => {
      const result = await llmGenerateText({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        prompt: 'hello',
        apiKeyEnv: API_KEY_ENV,
      });
      expect(result).toBe('mocked-text');
      expect(generateText).toHaveBeenCalledOnce();
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('throws SpecGuardError when the API key env var is missing', async () => {
      delete process.env[API_KEY_ENV];
      await expect(
        llmGenerateText({
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          prompt: 'hello',
          apiKeyEnv: API_KEY_ENV,
        }),
      ).rejects.toBeInstanceOf(SpecGuardError);
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('uses messages array when images are provided', async () => {
      const screenshot = Buffer.from('PNG_DATA');
      await llmGenerateText({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        prompt: 'describe this page',
        apiKeyEnv: API_KEY_ENV,
        images: [screenshot],
      });
      expect(generateText).toHaveBeenCalledOnce();
      const callArg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Must use messages (not prompt) for multimodal calls
      expect(callArg.messages).toBeDefined();
      expect(callArg.prompt).toBeUndefined();
      const content = callArg.messages[0].content as Array<{ type: string }>;
      expect(content[0].type).toBe('image');
      expect(content[1].type).toBe('text');
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('uses prompt (not messages) when no images are provided', async () => {
      await llmGenerateText({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        prompt: 'text only',
        apiKeyEnv: API_KEY_ENV,
      });
      const callArg = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.prompt).toBe('text only');
      expect(callArg.messages).toBeUndefined();
    });
  });

  describe('llmGenerateObject', () => {
    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('returns the mocked object and forwards the schema', async () => {
      const schema = z.object({ name: z.string() });
      const result = await llmGenerateObject({
        provider: 'openai',
        model: 'gpt-4o',
        prompt: 'give me a name',
        apiKeyEnv: API_KEY_ENV,
        schema,
      });
      expect(result).toEqual({ name: 'mocked-name' });
      expect(generateObject).toHaveBeenCalledOnce();
      const callArg = (generateObject as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.schema).toBe(schema);
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('uses messages array when images are provided', async () => {
      const schema = z.object({ name: z.string() });
      const screenshot = Buffer.from('PNG_DATA');
      await llmGenerateObject({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        prompt: 'analyse this screenshot',
        apiKeyEnv: API_KEY_ENV,
        schema,
        images: [screenshot],
      });
      const callArg = (generateObject as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.messages).toBeDefined();
      expect(callArg.prompt).toBeUndefined();
    });
  });

  describe('resolveModel', () => {
    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('builds an anthropic model via createAnthropic with the resolved key', () => {
      const model = resolveModel('anthropic', 'claude-3-5-sonnet', API_KEY_ENV);
      expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-test-secret-value' });
      expect(model).toMatchObject({ provider: 'anthropic', model: 'claude-3-5-sonnet' });
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('builds an openai model via createOpenAI with the resolved key', () => {
      const model = resolveModel('openai', 'gpt-4o', API_KEY_ENV);
      expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test-secret-value' });
      expect(model).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('throws SpecGuardError for an unknown provider', () => {
      expect(() => resolveModel('grok', 'whatever', API_KEY_ENV)).toThrow(SpecGuardError);
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('throws SpecGuardError when the API key env var is unset', () => {
      delete process.env[API_KEY_ENV];
      expect(() => resolveModel('anthropic', 'claude-3-5-sonnet', API_KEY_ENV)).toThrow(
        SpecGuardError,
      );
    });

    // [claims: capabilities/platform-foundation#llm-connectivity]
    it('builds an xAI model for xai and the cursor alias', () => {
      const model = resolveModel('cursor', 'grok-4.7', API_KEY_ENV);
      expect(createXai).toHaveBeenCalledWith({ apiKey: 'sk-test-secret-value' });
      expect(model).toMatchObject({ provider: 'xai', model: 'grok-4.7' });
      process.env.XAI_BASE_URL = 'https://proxy.example/v1';
      resolveModel('xai', 'grok-4.7', API_KEY_ENV);
      expect(createXai).toHaveBeenLastCalledWith({ apiKey: 'sk-test-secret-value', baseURL: 'https://proxy.example/v1' });
      delete process.env.XAI_BASE_URL;
    });

    // [claims: capabilities/platform-foundation#llm-connectivity]
    it('names XAI_API_KEY when the cursor alias has no key, and never the secret', () => {
      process.env.XAI_API_KEY = 'xai-secret-value';
      delete process.env.XAI_API_KEY;
      expect(() => resolveModel('cursor', 'grok-4.7', 'XAI_API_KEY')).toThrow(/XAI_API_KEY/);
      try {
        resolveModel('cursor', 'grok-4.7', 'XAI_API_KEY');
      } catch (err) {
        expect((err as Error).message).not.toContain('xai-secret-value');
      }
    });

    // [claims: capabilities/platform-foundation#llm-connectivity]
    it('builds Bedrock IAM with SigV4 and ignores a bearer token', () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = 'bearer-secret-value';
      process.env.AWS_REGION = 'us-west-2';
      const model = resolveModel('bedrock-iam', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'AWS_ACCESS_KEY_ID');
      expect(createAmazonBedrock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', region: 'us-west-2' }));
      const arg = vi.mocked(createAmazonBedrock).mock.calls[0][0] as { credentialProvider?: () => Promise<unknown> };
      expect(typeof arg.credentialProvider).toBe('function');
      expect(model).toMatchObject({ provider: 'bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0' });
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      delete process.env.AWS_REGION;
    });

    // [claims: capabilities/platform-foundation#llm-connectivity]
    it('names the AWS credential chain when IAM credentials cannot be resolved, and never the secret', async () => {
      resolveModel('bedrock-iam', 'm', 'AWS_ACCESS_KEY_ID');
      const arg = vi.mocked(createAmazonBedrock).mock.calls.at(-1)![0] as { credentialProvider: () => Promise<unknown> };
      await expect(arg.credentialProvider()).rejects.toThrow(/credential chain/);
      await expect(arg.credentialProvider()).rejects.not.toThrow(/leaked-secret-AKIAFAKEKEY/);
    });

    // [claims: capabilities/platform-foundation#llm-connectivity]
    it('uses a Mantle bearer token when set, and the IAM chain when it is not', () => {
      process.env.MANTLE_TOKEN = 'mantle-secret';
      resolveModel('bedrock-mantle', 'openai.gpt-oss-120b', 'MANTLE_TOKEN');
      expect(createBedrockMantle).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'mantle-secret' }));
      delete process.env.MANTLE_TOKEN;
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      resolveModel('bedrock-mantle', 'openai.gpt-oss-120b', 'MANTLE_TOKEN');
      const arg = vi.mocked(createBedrockMantle).mock.calls.at(-1)![0] as { apiKey?: string; credentialProvider?: unknown };
      expect(arg.apiKey).toBeUndefined();
      expect(typeof arg.credentialProvider).toBe('function');
    });

    // [claims: capabilities/platform-foundation#llm-provider-layer]
    it('does not leak the API key value in the missing-key error message', () => {
      process.env[API_KEY_ENV] = '';
      try {
        resolveModel('anthropic', 'claude-3-5-sonnet', API_KEY_ENV);
        throw new Error('expected resolveModel to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SpecGuardError);
        expect((err as Error).message).toContain(API_KEY_ENV);
      }
    });
  });
});
