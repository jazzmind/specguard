/**
 * `specguard server`: the team server. The same API the local `serve` offers, over published snapshots, with
 * sign-in, tokens and writes.
 *
 * It is mounted under a path prefix (`/specguard`) because the sandbox proxy forwards the full path. Every route
 * except `/health` needs a credential: a token, or the sandbox's signed-in user header for browsers.
 *
 * Spec: specs/capabilities/team-server.md
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { LlmConfig } from '../../core/types.js';
import { MAX_SNAPSHOT_BYTES } from '../../core/snapshot.js';
import { Api, type ApiRequest } from '../api.js';
import { authenticate, tokenRoute, type AuthConfig } from './auth.js';
import { handleMcp } from './mcp.js';
import type { Backend } from './backend.js';
import { centralRegistry, type CentralRegistry } from './registry.js';

export interface CentralServerOptions {
  backend: Backend;
  llm: LlmConfig;
  port?: number;
  host?: string;
  /** Path the server is mounted under, for example `/specguard`. Default: the root. */
  basePath?: string;
  auth?: Omit<AuthConfig, 'backend'>;
  /** Where snapshots are written out to be read. */
  workDir?: string;
  /** Largest request body accepted, in bytes. Default: a snapshot's limit plus 1 MB. */
  maxBodyBytes?: number;
  /** Called with the registry once it exists, for things that publish into it (the artifact puller). */
  onRegistry?: (registry: CentralRegistry) => void;
}

export interface RunningCentralServer {
  url: string;
  port: number;
  registry: CentralRegistry;
  close(): Promise<void>;
}

const BODY_LIMIT = MAX_SNAPSHOT_BYTES + 1024 * 1024;
const MCP_BODY_LIMIT = 1024 * 1024;

/** The paths anyone may read without a credential. */
const PUBLIC = new Set(['/api/v1/health', '/api/v1/version']);

/** How much of an oversized upload is read and thrown away after the refusal, so the client sees the 413 rather than a reset. */
const DRAIN_LIMIT = 200 * 1024 * 1024;

function readBody(req: http.IncomingMessage, limit: number): Promise<{ ok: true; body: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (refused) {
        if (size > DRAIN_LIMIT) req.destroy();
        return;
      }
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(refused ? { ok: false } : { ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false }));
  });
}

export function createCentralListener(opts: CentralServerOptions): { listener: http.RequestListener; registry: CentralRegistry } {
  const basePath = (opts.basePath ?? '').replace(/\/+$/, '');
  const authConfig: AuthConfig = { ...opts.auth, backend: opts.backend };
  const registry = centralRegistry({ backend: opts.backend, llm: opts.llm, workDir: opts.workDir });
  const api = new Api(registry, {
    basePath,
    onUsage: (usage, project) => void opts.backend.usage({ at: new Date().toISOString(), ...(usage.user ? { user: usage.user } : {}), project, pipeline: usage.pipeline, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedUsd: usage.estimatedUsd }).catch(() => undefined),
  });

  const listener: http.RequestListener = async (req, res) => {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const sendJson = (status: number, value: unknown, extra?: Record<string, string>): void => send(status, 'application/json; charset=utf-8', JSON.stringify(value), extra);

    try {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://local').pathname;
      } catch {
        return sendJson(400, { error: 'invalid request target' });
      }
      // The sandbox's health check calls the container directly, without the path prefix.
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        const health = await api.handle({ method: 'GET', path: '/api/v1/health' });
        return send(health.status, health.type, health.body);
      }
      if (basePath) {
        if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return sendJson(404, { error: 'not found' });
        pathname = pathname.slice(basePath.length) || '/';
      }
      const method = req.method ?? 'GET';
      const reading = method === 'GET' || method === 'HEAD';
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;

      const isApi = pathname.startsWith('/api/v1');
      const normalized = pathname.replace(/\/+$/, '') || '/';
      const auth = isApi && !PUBLIC.has(normalized) ? await authenticate(headers, authConfig) : { identity: undefined };
      if (isApi && !PUBLIC.has(normalized)) {
        if ('rejected' in auth && auth.rejected) return sendJson(401, { error: 'that token is not valid' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
        if (!auth.identity) return sendJson(401, { error: 'sign in, or send a token' }, { 'WWW-Authenticate': 'Bearer' });
      }
      // A browser session can be driven by another site; a token cannot. Changing anything from a session needs a header
      // that only same-origin script can set.
      if (!reading && 'via' in auth && auth.via === 'header' && !headers['x-requested-with']) {
        return sendJson(403, { error: 'send the X-Requested-With header with changes made from a browser session' });
      }

      if (normalized === '/mcp') {
        // MCP clients send a token; a signed-in browser has no business here.
        const mcpAuth = await authenticate(headers, authConfig);
        if (mcpAuth.rejected || !mcpAuth.identity || mcpAuth.via === 'header') return sendJson(401, { error: 'send a token' }, { 'WWW-Authenticate': 'Bearer' });
        // The transport reads the body itself, so its size is bounded by the declared length instead.
        if (method === 'POST') {
          const length = Number(headers['content-length']);
          if (!Number.isFinite(length)) return sendJson(411, { error: 'send a Content-Length' });
          if (length > MCP_BODY_LIMIT) return sendJson(413, { error: 'the request body is too large' }, { Connection: 'close' });
        }
        return await handleMcp(req, res, undefined, api, mcpAuth.identity);
      }

      let body: string | undefined;
      if (!reading) {
        const read = await readBody(req, opts.maxBodyBytes ?? BODY_LIMIT);
        if (!read.ok) return sendJson(413, { error: 'the request body is too large' }, { Connection: 'close' });
        body = read.body;
      }

      if (isApi) {
        const parts = normalized.slice('/api/v1'.length).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
        const tokens = await tokenRoute(method, parts, body, auth as Parameters<typeof tokenRoute>[3], opts.backend);
        if (tokens) return send(tokens.status, tokens.type, tokens.body, { 'Cache-Control': 'no-store' });
      }

      const request: ApiRequest = { method, path: normalized, body, headers, identity: auth.identity };
      const response = await api.handle(request);
      const extra: Record<string, string> = response.type.startsWith('text/html')
        ? { 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" }
        : {};
      return send(response.status, response.type, response.body, extra);
    } catch (err) {
      if (err instanceof URIError) return sendJson(400, { error: 'invalid percent-encoding in the path' });
      return sendJson(500, { error: (err as Error).message });
    }
  };
  return { listener, registry };
}

export function startCentralServer(opts: CentralServerOptions): Promise<RunningCentralServer> {
  const host = opts.host ?? '0.0.0.0';
  const { listener, registry } = createCentralListener(opts);
  const server = http.createServer(listener);
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  opts.onRegistry?.(registry);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4317, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}${(opts.basePath ?? '').replace(/\/+$/, '')}`,
        port,
        registry,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
