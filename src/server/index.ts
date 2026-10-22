/**
 * `specguard serve`: the read-only docs and audit API, plus its web UI, on
 * node:http. No framework dependency.
 *
 * Binds to loopback by default. On a loopback bind it also rejects requests
 * whose Host header is not a local name, which blocks DNS-rebinding reads of a
 * local server from a hostile web page. Cross-origin access is off unless
 * `cors` names an origin.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SpecGuardConfig } from '../core/types.js';
import { Api, HTML_SECURITY_HEADERS } from './api.js';
import type { ProjectRegistry } from './project.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Origin allowed to read the API from a browser, or `*`. Default: none. */
  cors?: string;
  /** Serves `GET /api/v1/workspace` with this view of the workspace. */
  workspace?: () => Promise<unknown>;
}

export const DEFAULT_PORT = 4317;

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;
const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\./.test(host);

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function createRequestListener(source: SpecGuardConfig | ProjectRegistry, opts: ServeOptions = {}): http.RequestListener {
  const api = new Api(source, { workspace: opts.workspace });
  const host = opts.host ?? '127.0.0.1';
  const guardHost = isLoopback(host);
  return (req, res) => {
    const respond = (status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...(opts.cors ? { 'Access-Control-Allow-Origin': opts.cors } : {}),
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (guardHost && !LOCAL_HOST.test(req.headers.host ?? '')) {
      respond(403, 'application/json; charset=utf-8', JSON.stringify({ error: 'unexpected Host header' }));
      return;
    }
    // A request target that is not a valid path (`//a:b:c`, `//[`) must be a 400, never an uncaught throw.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://local').pathname;
    } catch {
      respond(400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid request target' }));
      return;
    }
    api
      .handle({ method: req.method ?? 'GET', path: pathname })
      .then((r) => respond(r.status, r.type, r.body, r.type.startsWith('text/html') ? HTML_SECURITY_HEADERS : {}))
      .catch((err: Error) => respond(500, 'application/json; charset=utf-8', JSON.stringify({ error: err.message })));
  };
}

export function startServer(source: SpecGuardConfig | ProjectRegistry, opts: ServeOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(createRequestListener(source, opts));
  // Malformed HTTP framing is answered by the socket, not thrown at the process.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
