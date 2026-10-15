/**
 * The HTTP API, as a pure request handler so every route is testable without a
 * socket. All data comes from the trace model, the spec graph, the history
 * entries and the docs service; the server only adds transport.
 *
 * Read-only. Versioned under /api/v1.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { listHistory } from '../core/history.js';
import { LlmBudgetExceededError } from '../core/llm.js';
import { createSecretRedactor } from '../core/redact.js';
import { intentGaps } from '../core/intent-gap.js';
import { specsRootDir } from '../core/spec-key.js';
import type { TraceModel, TraceNode } from '../core/trace.js';
import type { SpecGuardConfig } from '../core/types.js';
import { loadTrace } from '../pipelines/check.js';
import { DocNotFoundError, DocService, isAudience, AUDIENCES } from './docs.js';
import { UI_HTML } from './ui.js';

export interface ApiRequest {
  method: string;
  /** Path without the query string. */
  path: string;
}

export interface ApiResponse {
  status: number;
  type: string;
  body: string;
}

const TRACE_TTL_MS = 3000;

const json = (status: number, value: unknown): ApiResponse => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(value) });
const notFound = (what: string): ApiResponse => json(404, { error: what });

export class Api {
  private readonly docs: DocService;
  private traceCache?: { at: number; model: TraceModel };
  /** `intentGaps` shells out to git per capability; it is computed once per trace, not once per request. */
  private gapsCache?: { model: TraceModel; gaps: ReturnType<typeof intentGaps> };

  constructor(private readonly config: SpecGuardConfig) {
    this.docs = new DocService(config);
  }

  private root(): string {
    return this.config.rootDir ?? process.cwd();
  }

  private async trace(): Promise<TraceModel> {
    const now = Date.now();
    if (this.traceCache && now - this.traceCache.at < TRACE_TTL_MS) return this.traceCache.model;
    const { model } = await loadTrace(this.config);
    this.traceCache = { at: now, model };
    return model;
  }

  /** Everything served passes through the secret redactor, so a credential in a spec, config or history entry never leaves. */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    const res = await this.route(req);
    return res.type.startsWith('text/html') ? res : { ...res, body: this.redact.text(res.body) };
  }

  private readonly redact = createSecretRedactor();

  private async route(req: ApiRequest): Promise<ApiResponse> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'this API is read-only' });
    const p = req.path.replace(/\/+$/, '') || '/';
    if (p === '/') return { status: 200, type: 'text/html; charset=utf-8', body: UI_HTML };
    if (!p.startsWith('/api/v1')) return notFound('not found');
    const route = p.slice('/api/v1'.length) || '/';
    let parts: string[];
    try {
      parts = route.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    } catch {
      return json(400, { error: 'invalid percent-encoding in the path' });
    }

    try {
      if (parts.length === 0 || parts[0] === 'health') return json(200, { ok: true, version: 1 });
      if (parts[0] === 'system' && parts.length === 1) return await this.system();
      if (parts[0] === 'capabilities') {
        if (parts.length === 1) return await this.capabilities();
        if (parts.length === 2) return await this.capability(parts[1]);
        if (parts.length === 3 && parts[2] === 'history') return await this.capabilityHistory(parts[1]);
      }
      if (parts[0] === 'history' && parts.length === 2) return this.historyEntry(parts[1]);
      if (parts[0] === 'trace' && parts.length === 1) return json(200, await this.trace());
      if (parts[0] === 'units' && parts.length === 1) return json(200, { units: (await this.trace()).units ?? [] });
      if (parts[0] === 'audit' && parts.length === 1) return await this.audit();
      if (parts[0] === 'docs' && parts.length === 3) return await this.doc(parts[1], parts[2]);
      if (parts[0] === 'security' && parts[1] === 'plans') return this.plans(parts[2]);
      return notFound(`no route ${route}`);
    } catch (err) {
      if (err instanceof DocNotFoundError) return notFound(err.message);
      if (err instanceof LlmBudgetExceededError) return json(429, { error: err.message });
      return json(500, { error: (err as Error).message });
    }
  }

  private summary(n: TraceNode) {
    return { id: n.id, title: n.title, kind: n.kind, status: n.status, value: n.value, parent: n.parent ?? null, counts: n.counts, files: n.ownedFiles.length, tests: n.tests.length };
  }

  private async system() {
    const m = await this.trace();
    return json(200, { system: m.system ?? null, totals: m.totals, capabilities: m.nodes.filter((n) => n.kind === 'capability').map((n) => this.summary(n)), generated: m.generated });
  }

  private async capabilities() {
    const m = await this.trace();
    return json(200, { capabilities: m.nodes.filter((n) => n.kind !== 'system').map((n) => this.summary(n)) });
  }

  private async capability(id: string) {
    const m = await this.trace();
    const n = m.nodes.find((x) => x.id === id);
    if (!n) return notFound(`no spec with id "${id}"`);
    return json(200, { ...this.summary(n), specKey: n.specKey, ownedFiles: n.ownedFiles, testFiles: n.tests, docs: n.docs, history: n.history, claims: n.claims });
  }

  private async capabilityHistory(id: string) {
    const m = await this.trace();
    const n = m.nodes.find((x) => x.id === id);
    if (!n) return notFound(`no spec with id "${id}"`);
    const entries = listHistory(this.config).filter((e) => e.affects.includes(id) || n.history.includes(e.id));
    return json(200, { id, entries: entries.map(({ file: _file, body: _body, ...meta }) => meta) });
  }

  private historyEntry(id: string): ApiResponse {
    const e = listHistory(this.config).find((x) => x.id === id);
    if (!e) return notFound(`no history entry "${id}"`);
    const { file: _file, ...rest } = e;
    return json(200, rest);
  }

  private gapsFor(m: TraceModel, rel: string): ReturnType<typeof intentGaps> {
    if (this.gapsCache?.model !== m) this.gapsCache = { model: m, gaps: intentGaps(this.root(), m.nodes, listHistory(this.config), rel) };
    return this.gapsCache.gaps;
  }

  private async audit() {
    const m = await this.trace();
    const specs = m.nodes.filter((n) => n.kind === 'capability' || n.kind === 'component');
    const claims = specs.flatMap((n) => n.claims.map((c) => ({ capability: n.id, ...c })));
    const rel = path.relative(this.root(), specsRootDir(this.config)).split(path.sep).join('/');
    return json(200, {
      generated: m.generated,
      totals: m.totals,
      unowned: m.unowned,
      issues: m.issues,
      noTests: specs.filter((n) => n.tests.length === 0).map((n) => n.id),
      noSources: specs.filter((n) => n.ownedFiles.length === 0).map((n) => n.id),
      untestedClaims: claims.filter((c) => c.tests.length === 0).map((c) => c.ref),
      stale: claims.filter((c) => c.proof === 'stale').map((c) => c.ref),
      failed: claims.filter((c) => c.proof === 'failed').map((c) => c.ref),
      unproven: claims.filter((c) => c.proof === 'unproven').map((c) => c.ref),
      intentGaps: this.gapsFor(m, rel),
    });
  }

  private async doc(audience: string, id: string) {
    if (!isAudience(audience)) return json(400, { error: `audience must be one of ${AUDIENCES.join(', ')}` });
    const r = await this.docs.get(audience, id);
    return json(200, r);
  }

  private plans(id?: string): ApiResponse {
    const dir = path.join(this.root(), '.specguard', 'security', 'plans');
    const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (id !== undefined) {
      const name = `${id.replace(/[^A-Za-z0-9_.-]/g, '')}.json`;
      if (!fs.existsSync(path.join(dir, name))) return notFound(`no plan "${id}"`);
      return json(200, read(name));
    }
    if (!fs.existsSync(dir)) return json(200, { plans: [] });
    const plans = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        const p = read(f) as { id?: string; createdAt?: string; items?: unknown[] };
        return { id: p.id ?? f.replace(/\.json$/, ''), createdAt: p.createdAt ?? null, items: Array.isArray(p.items) ? p.items.length : 0 };
      });
    return json(200, { plans });
  }
}
