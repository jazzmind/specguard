/**
 * The client side of the team server: find a server, check that it answers and speaks a compatible version, and
 * talk to it. Everything here is optional; callers fall back to local files when `connect` returns null.
 *
 * Spec: specs/capabilities/team-server.md
 */
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { HASH_VERSION } from '../core/claim-hash.js';
import { SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import type { SpecGuardConfig } from '../core/types.js';
import { API_VERSION } from '../server/api.js';
import { normalizeServerUrl, readSavedToken } from './credentials.js';

export interface ServerTarget {
  /** Base URL, for example `https://specguard.example.com`. */
  url: string;
  project: string;
  token?: string;
  mode: 'auto' | 'required';
  timeoutMs: number;
}

export interface ServerHealth {
  ok: boolean;
  apiVersion: number;
  engineVersion: string;
  hashVersion: number;
  writable: boolean;
}

export class ServerUnavailableError extends SpecGuardError {
  constructor(message: string) {
    super(message, ExitCode.InternalError);
    this.name = 'ServerUnavailableError';
  }
}

export class ServerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ServerRequestError';
  }
}

const DEFAULT_TIMEOUT_MS = 800;

/**
 * The server this project should use, or null when none is configured or `mode` is `off`.
 * `SPECGUARD_SERVER`, `SPECGUARD_PROJECT` and `SPECGUARD_TOKEN` (or `server.tokenEnv`) override config.
 */
export function serverTarget(config: SpecGuardConfig | null, env: NodeJS.ProcessEnv = process.env): ServerTarget | null {
  const cfg = config?.server;
  const url = env.SPECGUARD_SERVER || cfg?.url;
  if (!url || cfg?.mode === 'off') return null;
  const root = config?.rootDir ?? process.cwd();
  const token = env[cfg?.tokenEnv ?? 'SPECGUARD_TOKEN'] || readSavedToken(url, env);
  return {
    url: normalizeServerUrl(url),
    project: env.SPECGUARD_PROJECT || cfg?.project || path.basename(root),
    ...(token ? { token } : {}),
    mode: cfg?.mode === 'required' ? 'required' : 'auto',
    timeoutMs: cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export class SpecGuardClient {
  constructor(
    readonly target: ServerTarget,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** `/api/v1/projects/<project>` plus `suffix`. */
  projectPath(suffix = ''): string {
    return `${this.target.url}/api/v1/projects/${encodeURIComponent(this.target.project)}${suffix}`;
  }

  async request<T>(method: string, url: string, init: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number; gzip?: boolean } = {}): Promise<T> {
    const json = init.body === undefined ? undefined : JSON.stringify(init.body);
    // A proxy in front of a server often caps uploads at 1 MB; JSON compresses well, so large bodies are sent gzipped.
    const compress = json !== undefined && (init.gzip ?? json.length > 256 * 1024);
    const payload = json === undefined ? undefined : compress ? gzipSync(json) : json;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(this.target.token ? { Authorization: `Bearer ${this.target.token}` } : {}),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(compress ? { 'Content-Encoding': 'gzip' } : {}),
      ...init.headers,
    };
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: payload as RequestInit['body'],
      signal: AbortSignal.timeout(init.timeoutMs ?? Math.max(this.target.timeoutMs, 10_000)),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const body = (parsed ?? {}) as { error?: string; code?: string };
      throw new ServerRequestError(res.status, body.error ?? `the server answered ${res.status}`, body.code);
    }
    return parsed as T;
  }

  get<T>(suffix: string): Promise<T> {
    return this.request<T>('GET', this.projectPath(suffix));
  }

  /** Move a plan item. `version` is the item version last read; a stale one is refused with 409. */
  setItemStatus(plan: string, item: string, body: { status: string; note?: string; externalRef?: string }, version?: number): Promise<{ plan: string; item: { id: string; status: string }; was: string; version: number }> {
    return this.request('PATCH', this.projectPath(`/security/plans/${encodeURIComponent(plan)}/items/${encodeURIComponent(item)}`), {
      body,
      headers: version === undefined ? undefined : { 'If-Match': String(version) },
    });
  }
}

export interface Connection {
  client: SpecGuardClient;
  health: ServerHealth;
  /** The server's claim hashes follow other rules than this build's; its proofs must not be compared with local ones. */
  hashMismatch: boolean;
}

const probes = new Map<string, { at: number; result: Promise<Connection | string> }>();
const PROBE_TTL_MS = 30_000;

/** Forget cached probes (tests). */
export function resetProbeCache(): void {
  probes.clear();
}

async function probe(target: ServerTarget, fetchImpl: typeof fetch): Promise<Connection | string> {
  try {
    const res = await fetchImpl(`${target.url}/api/v1/health`, { signal: AbortSignal.timeout(target.timeoutMs), headers: { Accept: 'application/json' } });
    if (!res.ok) return `the server answered ${res.status} to its health check`;
    const health = (await res.json()) as Partial<ServerHealth>;
    if (!health.ok || typeof health.apiVersion !== 'number') return 'that address does not look like a SpecGuard server';
    if (health.apiVersion !== API_VERSION) return `the server speaks API version ${health.apiVersion}; this SpecGuard speaks ${API_VERSION}. Upgrade the older one.`;
    return {
      client: new SpecGuardClient(target, fetchImpl),
      health: health as ServerHealth,
      hashMismatch: health.hashVersion !== undefined && health.hashVersion !== HASH_VERSION,
    };
  } catch (err) {
    const name = (err as Error).name;
    return name === 'TimeoutError' || name === 'AbortError' ? `no answer from ${target.url} within ${target.timeoutMs} ms` : `cannot reach ${target.url} (${(err as Error).message})`;
  }
}

/**
 * Connect to the project's server. Returns null when there is none configured, or (in `auto` mode) when it does not
 * answer or is incompatible, so the caller uses local files. In `required` mode an unusable server throws.
 */
export async function connect(config: SpecGuardConfig | null, opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; onFallback?: (reason: string) => void } = {}): Promise<Connection | null> {
  const target = serverTarget(config, opts.env);
  if (!target) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const key = `${target.url}|${target.token ?? ''}|${target.project}`;
  let cached = probes.get(key);
  if (!cached || Date.now() - cached.at > PROBE_TTL_MS || opts.fetchImpl) {
    cached = { at: Date.now(), result: probe(target, fetchImpl) };
    if (!opts.fetchImpl) probes.set(key, cached);
  }
  const result = await cached.result;
  if (typeof result === 'string') {
    if (target.mode === 'required') throw new ServerUnavailableError(`the team server is required (server.mode is "required") but unusable: ${result}`);
    opts.onFallback?.(result);
    return null;
  }
  return result;
}
