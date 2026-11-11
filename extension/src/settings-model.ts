/** Non-secret settings and their inheritance. No editor or filesystem dependencies. */
export const AI_PROVIDERS = ['anthropic', 'openai', 'litellm', 'xai', 'cursor', 'bedrock-iam', 'bedrock-mantle'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  litellm: 'LiteLLM / compatible endpoint',
  xai: 'xAI',
  cursor: 'xAI (Cursor)',
  'bedrock-iam': 'Amazon Bedrock (IAM)',
  'bedrock-mantle': 'Amazon Bedrock Mantle',
};

/** Model and key variable filled in when the editor switches provider. */
export const AI_PROVIDER_DEFAULTS: Record<AiProvider, { model: string; apiKeyEnv: string; baseUrl: string }> = {
  anthropic: { model: 'claude-sonnet-4-6', apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrl: '' },
  openai: { model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: '' },
  litellm: { model: 'gpt-4', apiKeyEnv: 'LITELLM_API_KEY', baseUrl: 'http://localhost:4000' },
  xai: { model: 'grok-4.7', apiKeyEnv: 'XAI_API_KEY', baseUrl: '' },
  cursor: { model: 'grok-4.7', apiKeyEnv: 'XAI_API_KEY', baseUrl: '' },
  'bedrock-iam': { model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', apiKeyEnv: 'AWS_ACCESS_KEY_ID', baseUrl: '' },
  'bedrock-mantle': { model: 'openai.gpt-oss-120b', apiKeyEnv: 'AWS_BEARER_TOKEN_BEDROCK', baseUrl: '' },
};

/** LiteLLM and Bedrock can run without a stored key (local proxy, or the AWS credential chain). */
export function providerKeyOptional(provider: string): boolean {
  return provider === 'litellm' || provider === 'bedrock-iam' || provider === 'bedrock-mantle';
}

export interface AiSettings {
  provider: AiProvider;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
}
export interface ServerSettings { url: string; project?: string; mode: 'auto' | 'off' }
export interface SettingsLayer { llm?: AiSettings; server?: ServerSettings }
export const DEFAULT_AI: AiSettings = { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyEnv: 'ANTHROPIC_API_KEY' };
export const DEFAULT_SERVER: ServerSettings = { url: '', mode: 'auto' };

export function resolveSettings(legacy: SettingsLayer, workspace: SettingsLayer, repo: SettingsLayer) {
  const ai = { ...DEFAULT_AI, ...(repo.llm ?? workspace.llm ?? legacy.llm) };
  const server = { ...DEFAULT_SERVER, ...legacy.server, ...workspace.server, ...repo.server };
  return {
    llm: { provider: ai.provider, model: ai.model, apiKeyEnv: ai.apiKeyEnv, ...(ai.baseUrl ? { baseUrl: ai.baseUrl } : {}) },
    server: { mode: server.mode,
      url: repo.server?.url || workspace.server?.url || legacy.server?.url || '',
      project: repo.server?.project || workspace.server?.project || legacy.server?.project },
    llmSource: repo.llm ? 'Repo override' : workspace.llm ? 'Inherited from workspace' : legacy.llm ? 'Project config' : 'Built-in default',
    serverSource: repo.server ? 'Repo override' : workspace.server ? 'Inherited from workspace' : legacy.server ? 'Project config' : 'Built-in default',
  };
}

export function validateLayer(value: unknown): SettingsLayer {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings.');
  const raw = value as SettingsLayer;
  const result: SettingsLayer = {};
  if (raw.llm) {
    const v = raw.llm;
    if (!(AI_PROVIDERS as readonly string[]).includes(v.provider) || typeof v.model !== 'string' || !v.model.trim()) throw new Error('Choose an AI provider and model.');
    if (!/^[A-Z_][A-Z0-9_]*$/.test(v.apiKeyEnv)) throw new Error('Use a valid API key environment variable name.');
    if (v.baseUrl) validateUrl(v.baseUrl);
    result.llm = { provider: v.provider, model: v.model.trim(), apiKeyEnv: v.apiKeyEnv, ...(v.baseUrl ? { baseUrl: v.baseUrl.trim().replace(/\/+$/, '') } : {}) };
  }
  if (raw.server) {
    const v = raw.server;
    if (typeof v.url !== 'string' || !['auto', 'off'].includes(v.mode)) throw new Error('Invalid server settings.');
    if (v.url.trim()) validateUrl(v.url);
    result.server = { url: v.url.trim().replace(/\/+$/, ''), mode: v.mode, ...(v.project?.trim() ? { project: v.project.trim() } : {}) };
  }
  return result;
}

export function validateUrl(url: string): void {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Use an HTTP(S) URL without credentials, a query or a fragment.');
}
