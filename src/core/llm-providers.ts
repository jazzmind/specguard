/**
 * Provider factories for the model layer.
 *
 * `resolveModel` in `llm.ts` is the only caller. Pipelines never import a provider SDK.
 * A missing key or an unresolved AWS credential chain fails with the variable or chain
 * name. The secret value is never copied into the error.
 *
 * Spec: specs/capabilities/platform-foundation.md
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createBedrockMantle } from '@ai-sdk/amazon-bedrock/mantle';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';

import { SpecGuardError } from './errors.js';
import { ExitCode } from './exit-codes.js';
import { supportedProviderList } from './llm-provider-ids.js';

export { DEFAULT_KEY_ENV, KEYLESS_PROVIDERS, MODEL_PROVIDERS, supportedProviderList } from './llm-provider-ids.js';

function bedrockRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

/**
 * AWS credentials for Bedrock SigV4. Failures name the chain and never include
 * the upstream message, which can echo credential material.
 */
export async function iamCredentials(): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> {
  try {
    const creds = await fromNodeProviderChain()();
    if (!creds?.accessKeyId || !creds.secretAccessKey) throw new Error('incomplete');
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    };
  } catch {
    throw new SpecGuardError(
      'AWS credentials for Bedrock could not be resolved from the default credential chain ' +
        '(AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, AWS_PROFILE, AWS_WEB_IDENTITY_TOKEN_FILE, or container credentials). ' +
        'The credential value is never included in this error.',
      ExitCode.InternalError,
    );
  }
}

export function buildLanguageModel(args: {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
}): LanguageModel {
  const { provider, model, apiKey, baseURL } = args;
  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model);
    }
    case 'openai': {
      const resolved = baseURL || process.env.OPENAI_BASE_URL || undefined;
      const openai = createOpenAI({ apiKey, ...(resolved ? { baseURL: resolved } : {}) });
      return openai.chat(model);
    }
    case 'litellm': {
      const resolved = baseURL || process.env.LITELLM_BASE_URL || 'http://localhost:4000';
      const openai = createOpenAI({ apiKey: apiKey || 'nokey', baseURL: resolved });
      return openai.chat(model);
    }
    case 'xai':
    case 'cursor': {
      const resolved = baseURL || process.env.XAI_BASE_URL || undefined;
      const xai = createXai({ apiKey, ...(resolved ? { baseURL: resolved } : {}) });
      return xai.chat(model);
    }
    case 'bedrock-iam': {
      // An empty string is a set value, so the SDK does not read AWS_BEARER_TOKEN_BEDROCK.
      const bedrock = createAmazonBedrock({
        region: bedrockRegion(),
        apiKey: '',
        credentialProvider: iamCredentials,
        ...(baseURL ? { baseURL } : {}),
      });
      return bedrock(model);
    }
    case 'bedrock-mantle': {
      const bearer = apiKey?.trim() ? apiKey : undefined;
      const mantle = createBedrockMantle({
        region: bedrockRegion(),
        ...(bearer ? { apiKey: bearer } : { credentialProvider: iamCredentials }),
        ...(baseURL ? { baseURL } : {}),
      });
      return mantle.chat(model);
    }
    default:
      throw new SpecGuardError(
        `Unknown LLM provider: \`${provider}\`. Supported: ${supportedProviderList()}.`,
        ExitCode.InternalError,
      );
  }
}
