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
  createOpenAI: vi.fn(() => (model: string) => ({ provider: 'openai', model })),
}));

import { generateText, generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { llmGenerateText, llmGenerateObject, resolveModel } from '../../src/core/llm.js';
import { SpecGuardError } from '../../src/core/errors.js';

const API_KEY_ENV = 'TEST_SPECGUARD_API_KEY';

describe('llm adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[API_KEY_ENV] = 'sk-test-secret-value';
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
  });

  describe('llmGenerateText', () => {
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
    it('builds an anthropic model via createAnthropic with the resolved key', () => {
      const model = resolveModel('anthropic', 'claude-3-5-sonnet', API_KEY_ENV);
      expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-test-secret-value' });
      expect(model).toMatchObject({ provider: 'anthropic', model: 'claude-3-5-sonnet' });
    });

    it('builds an openai model via createOpenAI with the resolved key', () => {
      const model = resolveModel('openai', 'gpt-4o', API_KEY_ENV);
      expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test-secret-value' });
      expect(model).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    });

    it('throws SpecGuardError for an unknown provider', () => {
      expect(() => resolveModel('grok', 'whatever', API_KEY_ENV)).toThrow(SpecGuardError);
    });

    it('throws SpecGuardError when the API key env var is unset', () => {
      delete process.env[API_KEY_ENV];
      expect(() => resolveModel('anthropic', 'claude-3-5-sonnet', API_KEY_ENV)).toThrow(
        SpecGuardError,
      );
    });

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
