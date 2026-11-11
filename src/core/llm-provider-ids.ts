/**
 * Provider names and the key variable each one uses.
 *
 * Kept separate from the provider SDKs so config loading and the edit-guard hook
 * do not pull those packages into their bundle.
 *
 * Spec: specs/capabilities/platform-foundation.md
 */

/** Key variable filled in when config names a provider and no `apiKeyEnv`. */
export const DEFAULT_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  litellm: 'LITELLM_API_KEY',
  xai: 'XAI_API_KEY',
  cursor: 'XAI_API_KEY',
  'bedrock-iam': 'AWS_ACCESS_KEY_ID',
  'bedrock-mantle': 'AWS_BEARER_TOKEN_BEDROCK',
};

/**
 * Providers that authenticate without a stored API key. A missing key must not
 * hand the call to the host agent: Bedrock uses the AWS credential chain, and
 * LiteLLM may run with no key.
 */
export const KEYLESS_PROVIDERS = new Set(['litellm', 'bedrock-iam', 'bedrock-mantle']);

/** Providers `resolveModel` can build, in the order named by an unknown-provider error. */
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'litellm', 'xai', 'cursor', 'bedrock-iam', 'bedrock-mantle'] as const;

export function supportedProviderList(): string {
  return [...MODEL_PROVIDERS, 'host', 'replay', 'none'].join(', ');
}
