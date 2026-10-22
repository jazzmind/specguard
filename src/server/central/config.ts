/**
 * The team server's settings, read from the environment (which is how the sandbox injects them) and command-line
 * flags, flags winning.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { rateLimitsFromEnv, type RateLimitConfig } from './rate-limit.js';
import path from 'node:path';

import type { LlmConfig } from '../../core/types.js';
import type { AuthConfig } from './auth.js';
import type { Backend } from './backend.js';
import { fileBackend } from './file-backend.js';

export interface GithubSource {
  /** `owner/name` of the repository. */
  repo: string;
  /** Project name on this server. */
  project: string;
}

export interface CentralSettings {
  port: number;
  host: string;
  basePath: string;
  dataDir: string;
  databaseUrl?: string;
  llm: LlmConfig;
  auth: Omit<AuthConfig, 'backend'>;
  rateLimit: RateLimitConfig;
  github: {
    token?: string;
    sources: GithubSource[];
    pollSeconds: number;
    /** Name of the artifact the SpecGuard Action uploads. */
    artifact: string;
    /** API base, for GitHub Enterprise. */
    apiUrl: string;
  };
}

export interface CentralFlags {
  port?: string;
  host?: string;
  basePath?: string;
  dataDir?: string;
}

const list = (value: string | undefined): string[] => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** `owner/name=project,owner/other` → sources; a repo without `=project` uses its own name. */
export function parseGithubSources(value: string | undefined): GithubSource[] {
  return list(value).map((entry) => {
    const [repo, project] = entry.split('=').map((s) => s.trim());
    return { repo, project: project || repo.split('/')[1] };
  });
}

export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(withSlash) || withSlash.split('/').some((p) => p === '.' || p === '..')) throw new Error(`invalid base path "${raw}"`);
  return withSlash;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv, flags: CentralFlags = {}): CentralSettings {
  const port = Number(flags.port ?? env.PORT ?? env.SPECGUARD_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port "${flags.port ?? env.PORT}"`);
  return {
    port,
    host: flags.host ?? env.SPECGUARD_HOST ?? '0.0.0.0',
    basePath: normalizeBasePath(flags.basePath ?? env.SPECGUARD_BASE_PATH),
    dataDir: path.resolve(flags.dataDir ?? env.SPECGUARD_DATA_DIR ?? '.specguard-server'),
    ...(env.DATABASE_URL || env.SPECGUARD_DATABASE_URL ? { databaseUrl: env.SPECGUARD_DATABASE_URL ?? env.DATABASE_URL } : {}),
    llm: {
      provider: env.SPECGUARD_LLM_PROVIDER ?? 'litellm',
      model: env.SPECGUARD_LLM_MODEL ?? 'fast',
      apiKeyEnv: env.SPECGUARD_LLM_API_KEY_ENV ?? 'LITELLM_API_KEY',
      ...(env.SPECGUARD_LLM_BASE_URL ? { baseUrl: env.SPECGUARD_LLM_BASE_URL } : {}),
      ...(env.SPECGUARD_LLM_MAX_USD ? { budget: { maxUsd: Number(env.SPECGUARD_LLM_MAX_USD) } } : {}),
    },
    auth: {
      adminEmails: list(env.SPECGUARD_ADMIN_EMAILS),
      maintainerEmails: list(env.SPECGUARD_MAINTAINER_EMAILS),
      ...(env.SPECGUARD_BOOTSTRAP_TOKEN ? { bootstrapToken: env.SPECGUARD_BOOTSTRAP_TOKEN } : {}),
      emailHeader: (env.SPECGUARD_EMAIL_HEADER ?? 'x-deploykit-email').toLowerCase(),
      ...(env.SPECGUARD_ALLOWED_DOMAIN ? { allowedDomain: env.SPECGUARD_ALLOWED_DOMAIN } : {}),
      ...(list(env.SPECGUARD_TRUSTED_PROXIES).length > 0 ? { trustedProxies: list(env.SPECGUARD_TRUSTED_PROXIES) } : {}),
    },
    rateLimit: rateLimitsFromEnv(env),
    github: {
      ...(env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {}),
      sources: parseGithubSources(env.SPECGUARD_GITHUB_REPOS),
      pollSeconds: Math.max(30, Number(env.SPECGUARD_GITHUB_POLL_SECONDS ?? 300)),
      artifact: env.SPECGUARD_GITHUB_ARTIFACT ?? 'specguard-evidence',
      apiUrl: (env.SPECGUARD_GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
    },
  };
}

/** Postgres when a database URL is set, otherwise files in the data directory. */
export async function openBackend(settings: Pick<CentralSettings, 'databaseUrl' | 'dataDir'>): Promise<Backend> {
  if (settings.databaseUrl) {
    const { connectPostgres } = await import('./pg-backend.js');
    return connectPostgres(settings.databaseUrl);
  }
  return fileBackend(settings.dataDir);
}

/** Problems that make a deployment unsafe or useless, said before it starts. */
export function settingsWarnings(settings: CentralSettings): string[] {
  const out: string[] = [];
  if (!settings.auth.bootstrapToken) out.push('SPECGUARD_BOOTSTRAP_TOKEN is not set: nobody can create the first admin token, so CI tokens cannot be issued');
  if (!settings.auth.allowedDomain) out.push('SPECGUARD_ALLOWED_DOMAIN is not set: any value in the sign-in header is accepted as a viewer');
  if (!settings.auth.trustedProxies?.length) out.push('SPECGUARD_TRUSTED_PROXIES is not set: the sign-in header is accepted from anywhere, so it signs in a viewer only and browser sessions cannot be maintainers (a container that can reach this server directly could forge it). Set it to the address of the sign-in proxy to enable SPECGUARD_MAINTAINER_EMAILS');
  if (settings.github.sources.length > 0 && !settings.github.token) out.push('SPECGUARD_GITHUB_REPOS is set but GITHUB_TOKEN is not: artifacts cannot be fetched');
  return out;
}
