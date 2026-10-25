/**
 * A small client for SpecGuard's HTTP API, the same one whether it is served by the local `specguard serve` or by a
 * team server. No VS Code imports, so it can be tested on its own.
 */

export interface ApiTarget {
  /** Server address including any path prefix, for example `https://specguard.example.com`. No trailing slash. */
  baseUrl: string;
  /** Project name on a team server. Absent for the local server, whose routes are unprefixed. */
  project?: string;
  token?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Health {
  ok: boolean;
  apiVersion: number;
  engineVersion: string;
  hashVersion: number;
  writable: boolean;
}

/** API version this extension speaks. A server answering another version is not used. */
export const SUPPORTED_API_VERSION = 1;

export class ApiClient {
  constructor(
    readonly target: ApiTarget,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private path(suffix: string): string {
    const base = `${this.target.baseUrl}/api/v1`;
    return this.target.project ? `${base}/projects/${encodeURIComponent(this.target.project)}${suffix}` : `${base}${suffix}`;
  }

  async request<T>(method: string, url: string, init: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(this.target.token ? { Authorization: `Bearer ${this.target.token}` } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) throw new ApiError(res.status, ((parsed ?? {}) as { error?: string }).error ?? `the server answered ${res.status}`);
    return parsed as T;
  }

  get<T>(suffix: string, timeoutMs?: number): Promise<T> {
    return this.request<T>('GET', this.path(suffix), { timeoutMs });
  }

  /** The server's health, ignoring the project. */
  health(timeoutMs = 800): Promise<Health> {
    return this.request<Health>('GET', `${this.target.baseUrl}/api/v1/health`, { timeoutMs });
  }

  /** Projects on the server (a team server lists several; the local one lists its own). */
  projects(): Promise<{ projects: Array<{ name: string; kind: string; commit?: string; branch?: string; updatedAt?: string }>; default: string | null }> {
    return this.request('GET', `${this.target.baseUrl}/api/v1/projects`);
  }
}
