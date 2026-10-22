/**
 * The HTTP API, as a pure request handler so every route is testable without a
 * socket. All data comes from a project's trace model, spec files, history
 * entries, plans and the docs service; the server only adds transport.
 *
 * Routes live under `/api/v1/projects/:project/...`. On a server with one
 * project (the local `serve`), the same routes also work without the prefix.
 * A registry that is not writable (the local serve) serves reads only.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { HASH_VERSION } from '../core/claim-hash.js';
import { loadContractGraph } from '../core/contracts.js';
import { listHistory } from '../core/history.js';
import { LlmBudgetExceededError } from '../core/llm.js';
import type { UsageEvent } from '../core/llm-runtime.js';
import { createSecretRedactor } from '../core/redact.js';
import { cliVersion } from '../core/version.js';
import { intentGaps } from '../core/intent-gap.js';
import { UNRESOLVED } from '../core/remediation-schema.js';
import { specsRootDir } from '../core/spec-key.js';
import type { TraceModel, TraceNode } from '../core/trace.js';
import type { SpecGuardConfig } from '../core/types.js';
import { DocNotFoundError, DocService, isAudience, AUDIENCES } from './docs.js';
import { parseSnapshot } from '../core/snapshot.js';
import { listPlugins } from '../pipelines/plugin-manage.js';
import { rollupRepo, rollupWorkspace, type WorkspaceRollup } from '../core/workspace-rollup.js';
import { PROJECT_NAME, WORKSPACE_NAME, type WorkspaceDef } from './central/backend.js';
import { z } from 'zod';
import { PlanStatusError, itemVersion, setItemStatus } from '../pipelines/security-plan.js';
import { localRegistry, type ProjectRegistry, type ProjectSource } from './project.js';
import { renderUi } from './ui.js';

const WorkspaceBodySchema = z.object({
  description: z.string().max(500).optional(),
  projects: z
    .array(
      z.object({
        project: z.string().regex(PROJECT_NAME, 'not a valid project name'),
        key: z.string().max(64).optional(),
        role: z.string().max(32).optional(),
        ignore: z.boolean().optional(),
      }),
    )
    .max(200),
});

/** Who is calling. Set by the server's authentication; absent means anonymous. */
export interface Identity {
  user: string;
  role: 'viewer' | 'maintainer' | 'admin';
  /** A credential limited to one project (a project's CI token). Absent means every project. */
  project?: string;
}

const ROLE_RANK: Record<Identity['role'], number> = { viewer: 1, maintainer: 2, admin: 3 };

export interface ApiRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** Request body, for writes. */
  body?: string;
  /** Lower-cased header names. */
  headers?: Record<string, string | undefined>;
  identity?: Identity;
}

export interface ApiResponse {
  status: number;
  type: string;
  body: string;
}

/**
 * Headers for the HTML page. The page's own script is inline, so `script-src` allows it; everything else is closed:
 * it cannot be framed (clickjacking), cannot change its base URL or post forms elsewhere, and sends no referrer.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/** Version of the HTTP API's shape. Clients check it before trusting a server. */
export const API_VERSION = 1;

const json = (status: number, value: unknown): ApiResponse => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(value) });
const notFound = (what: string): ApiResponse => json(404, { error: what });

const isRegistry = (x: SpecGuardConfig | ProjectRegistry): x is ProjectRegistry => typeof (x as ProjectRegistry).get === 'function';

export class Api {
  private readonly registry: ProjectRegistry;
  private readonly docs = new Map<string, DocService>();
  /** `intentGaps` shells out to git per capability; it is computed once per trace, not once per request. */
  private readonly gapsCache = new WeakMap<TraceModel, ReturnType<typeof intentGaps>>();

  /** A config serves that one repo, live; a registry serves whatever projects it holds. */
  constructor(
    source: SpecGuardConfig | ProjectRegistry,
    private readonly opts: {
      /** Called for every model call made to answer a request, so spend can be recorded per user and project. */
      onUsage?: (usage: UsageEvent, project: string) => void;
      /** Names the pages' path prefix is mounted under, for the UI. */
      basePath?: string;
      /** Answers `GET /api/v1/workspace` with the combined picture of the workspace being served. */
      workspace?: () => Promise<unknown>;
      /** Told of every change made through the API and every refused attempt to make one, for an audit trail. */
      onAudit?: (entry: { actor: string; action: string; project?: string; detail: string }) => void;
    } = {},
  ) {
    this.registry = isRegistry(source) ? source : localRegistry(source);
    this.ui = renderUi(opts.basePath ?? '');
  }

  private readonly ui: string;

  private docsFor(project: ProjectSource): DocService {
    let service = this.docs.get(project.name);
    if (!service) {
      service = new DocService(project.config, project.cache, { tags: [`project:${project.name}`] });
      this.docs.set(project.name, service);
    }
    return service;
  }

  /** Everything served passes through the secret redactor, so a credential in a spec, config or history entry never leaves. */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    const res = await this.route(req);
    return res.type.startsWith('text/html') ? res : { ...res, body: this.redact.text(res.body) };
  }

  private readonly redact = createSecretRedactor();

  private health(extra: Record<string, unknown> = {}): ApiResponse {
    return json(200, { ok: true, version: 1, apiVersion: API_VERSION, engineVersion: cliVersion(), hashVersion: HASH_VERSION, writable: this.registry.writable, ...extra });
  }

  private async route(req: ApiRequest): Promise<ApiResponse> {
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (!reading && !this.registry.writable) return json(405, { error: 'this API is read-only' });
    const p = req.path.replace(/\/+$/, '') || '/';
    if (p === '/') return { status: 200, type: 'text/html; charset=utf-8', body: this.ui };
    if (!p.startsWith('/api/v1')) return notFound('not found');
    const route = p.slice('/api/v1'.length) || '/';
    let parts: string[];
    try {
      parts = route.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    } catch {
      return json(400, { error: 'invalid percent-encoding in the path' });
    }

    try {
      if (parts.length === 0 || parts[0] === 'health' || parts[0] === 'version') return this.health();
      if (parts[0] === 'workspaces') return await this.workspacesRoute(req, parts.slice(1));
      if (parts[0] === 'workspace' && parts.length === 1) {
        if (!this.opts.workspace) return notFound('this server is not serving a workspace; start it with `specguard serve --workspace`');
        return reading ? json(200, await this.opts.workspace()) : json(405, { error: 'the workspace view is read-only' });
      }
      if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'snapshots' && req.method === 'POST') return await this.publish(req, parts[1]);
      if (parts[0] === 'projects') {
        if (parts.length === 1) return reading ? json(200, { projects: await this.registry.list(), default: this.registry.defaultProject ?? null }) : json(405, { error: 'projects are created by publishing to them' });
        return await this.projectRoute(req, parts[1], parts.slice(2));
      }
      const name = this.registry.defaultProject;
      if (!name) return notFound('this server hosts several projects; use /api/v1/projects/<name>/...');
      return await this.projectRoute(req, name, parts);
    } catch (err) {
      if (err instanceof DocNotFoundError) return notFound(err.message);
      if (err instanceof LlmBudgetExceededError) return json(429, { error: err.message });
      return json(500, { error: (err as Error).message });
    }
  }

  /**
   * Workspaces: named sets of projects with a combined rollup. A credential limited to one project reaches only a
   * workspace made of that project alone, and may not define one.
   */
  private async workspacesRoute(req: ApiRequest, parts: string[]): Promise<ApiResponse> {
    const store = this.registry.workspaces;
    if (!store) return notFound('this server does not keep workspaces');
    const scoped = req.identity?.project;
    const visible = (def: WorkspaceDef): boolean => !scoped || (def.projects.length > 0 && def.projects.every((p) => p.project === scoped));
    const reading = req.method === 'GET' || req.method === 'HEAD';

    if (parts.length === 0) {
      if (!reading) return json(405, { error: 'a workspace is created by putting it at /api/v1/workspaces/<name>' });
      return json(200, { workspaces: (await store.list()).filter(visible) });
    }
    const name = parts[0];
    if (!WORKSPACE_NAME.test(name)) return json(400, { error: 'workspace names are letters, digits, . _ and -, up to 64 characters' });

    if (req.method === 'PUT' && parts.length === 1) {
      const refused = this.mayWrite(req);
      if (refused) return refused;
      if (scoped) return json(403, { error: `a credential limited to project "${scoped}" cannot define a workspace` });
      let parsed: z.infer<typeof WorkspaceBodySchema>;
      try {
        parsed = WorkspaceBodySchema.parse(JSON.parse(req.body ?? ''));
      } catch (err) {
        return json(400, { error: err instanceof z.ZodError ? err.errors.map((e) => `${e.path.join('.') || '(body)'}: ${e.message}`).join('; ') : 'the body is not valid JSON' });
      }
      const def: WorkspaceDef = { name, ...(parsed.description ? { description: parsed.description } : {}), projects: parsed.projects, updatedAt: new Date().toISOString(), updatedBy: req.identity?.user ?? 'unknown' };
      await store.put(def);
      this.opts.onAudit?.({ actor: def.updatedBy, action: 'workspace.put', detail: `${name}: ${def.projects.length} project(s)` });
      return json(200, def);
    }
    if (!reading) return json(405, { error: 'workspaces are read with GET and defined with PUT' });
    const def = await store.get(name);
    if (!def || !visible(def)) return notFound(`no workspace "${name}"`);
    if (parts.length === 1) return json(200, def);
    if (parts.length === 2 && parts[1] === 'rollup') return json(200, await this.workspaceRollup(def));
    return notFound(`no route /workspaces/${parts.join('/')}`);
  }

  /** Each project's newest snapshot, rolled up the way the local `check --workspace` rolls up working trees. */
  private async workspaceRollup(def: WorkspaceDef): Promise<WorkspaceRollup> {
    const rows = [];
    for (const p of def.projects) {
      const source = await this.registry.get(p.project);
      const base = { key: p.key ?? p.project, path: p.project, role: p.role ?? 'consumer', ignored: p.ignore === true, configured: true };
      if (!source) {
        rows.push(rollupRepo({ ...base, trace: null }));
        continue;
      }
      rows.push(rollupRepo({ ...base, trace: await source.trace(), plan: await source.plans.read('latest') }));
    }
    rows.sort((a, b) => Number(a.ignored) - Number(b.ignored) || a.key.localeCompare(b.key));
    return rollupWorkspace(def.name, rows);
  }

  /** A project-scoped credential reaches only its own project. */
  private scopeRefusal(req: ApiRequest, name: string): ApiResponse | null {
    return req.identity?.project && req.identity.project !== name ? json(403, { error: `this credential is limited to project "${req.identity.project}"` }) : null;
  }

  private async publish(req: ApiRequest, name: string): Promise<ApiResponse> {
    const refused = this.mayWrite(req) ?? this.scopeRefusal(req, name);
    if (refused) return refused;
    if (!this.registry.publish) return json(405, { error: 'this server does not accept snapshots' });
    const parsed = parseSnapshot(req.body ?? '');
    if (!parsed.ok) return json(400, { error: parsed.error });
    if (parsed.snapshot.project !== name) return json(400, { error: `the snapshot is for project "${parsed.snapshot.project}", not "${name}"` });
    const published = await this.registry.publish(parsed.snapshot);
    this.opts.onAudit?.({ actor: req.identity?.user ?? 'unknown', action: 'snapshot.publish', project: name, detail: `${published.snapshotId}${published.commit ? ` at ${published.commit.slice(0, 8)}` : ''}` });
    return json(201, published);
  }

  private async projectRoute(req: ApiRequest, name: string, parts: string[]): Promise<ApiResponse> {
    const scoped = this.scopeRefusal(req, name);
    if (scoped) return scoped;
    const project = await this.registry.get(name);
    if (!project) return notFound(`no project "${name}"`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return await this.writeRoute(req, project, parts);

    if (parts.length === 0) return json(200, { name: project.name, ...(await this.registry.list()).find((i) => i.name === project.name) });
    if (parts[0] === 'health' || parts[0] === 'version') return this.health({ project: project.name });
    if (parts[0] === 'system' && parts.length === 1) return await this.system(project);
    if (parts[0] === 'capabilities') {
      if (parts.length === 1) return await this.capabilities(project);
      if (parts.length === 2) return await this.capability(project, parts[1]);
      if (parts.length === 3 && parts[2] === 'history') return await this.capabilityHistory(project, parts[1]);
    }
    if (parts[0] === 'specs' && parts.length === 1) return await this.specs(project);
    if (parts[0] === 'specs' && parts.length === 2) return await this.specFile(project, parts[1]);
    if (parts[0] === 'coverage' && parts.length === 1) return await this.coverage(project);
    if (parts[0] === 'contracts' && parts.length === 1) return await this.contracts(project);
    if (parts[0] === 'findings' && parts.length === 1) return await this.findings(project);
    if (parts[0] === 'history' && parts.length === 2) return this.historyEntry(project, parts[1]);
    if (parts[0] === 'trace' && parts.length === 1) return json(200, await project.trace());
    if (parts[0] === 'units' && parts.length === 1) return json(200, { units: (await project.trace()).units ?? [] });
    if (parts[0] === 'audit' && parts.length === 1) return await this.audit(project);
    if (parts[0] === 'docs' && parts.length === 1) return await this.docList(project);
    if (parts[0] === 'docs' && parts.length === 3) return await this.doc(project, parts[1], parts[2], req);
    if (parts[0] === 'security' && parts[1] === 'plans') return await this.plans(project, parts[2]);
    if (parts[0] === 'plugins' && parts.length === 1) return await this.plugins(project);
    return notFound(`no route /${parts.join('/')}`);
  }

  /**
   * The plugins of a working-tree project. A snapshot project has no checkout to read a config from, so it
   * reports none rather than guessing; the answer is informational and nothing changes through the API.
   */
  private async plugins(project: ProjectSource): Promise<ApiResponse> {
    const root = project.config.rootDir;
    if (!root || !fs.existsSync(path.join(root, '.specguard', 'config.json'))) return json(200, { plugins: [], note: 'this project has no working tree to read plugins from' });
    try {
      return json(200, await listPlugins(root));
    } catch (err) {
      return json(500, { error: (err as Error).message });
    }
  }

  /** Writes need a signed-in maintainer. Returns the refusal, or null when the caller may write. */
  private mayWrite(req: ApiRequest): ApiResponse | null {
    if (!req.identity) {
      this.opts.onAudit?.({ actor: 'anonymous', action: 'write.refused', detail: `${req.method} ${req.path}: no credential` });
      return json(401, { error: 'sign in, or send a token, to change anything' });
    }
    if (ROLE_RANK[req.identity.role] < ROLE_RANK.maintainer) {
      this.opts.onAudit?.({ actor: req.identity.user, action: 'write.refused', detail: `${req.method} ${req.path}: needs the maintainer role, has ${req.identity.role}` });
      return json(403, { error: 'changing anything needs the maintainer role' });
    }
    return null;
  }

  private async writeRoute(req: ApiRequest, project: ProjectSource, parts: string[]): Promise<ApiResponse> {
    // PATCH /security/plans/:plan/items/:item
    if (req.method === 'PATCH' && parts[0] === 'security' && parts[1] === 'plans' && parts[3] === 'items' && parts.length === 5) {
      const refused = this.mayWrite(req);
      if (refused) return refused;
      return await this.patchPlanItem(req, project, parts[2], parts[4]);
    }
    return json(405, { error: `no writable route ${req.method} /${parts.join('/')}` });
  }

  private async patchPlanItem(req: ApiRequest, project: ProjectSource, planId: string, itemId: string): Promise<ApiResponse> {
    let body: { status?: unknown; note?: unknown; externalRef?: unknown };
    try {
      body = JSON.parse(req.body ?? '') as typeof body;
    } catch {
      return json(400, { error: 'the body must be JSON: { "status": "...", "note"?: "...", "externalRef"?: "..." }' });
    }
    if (typeof body.status !== 'string') return json(400, { error: '`status` is required' });
    for (const key of ['note', 'externalRef'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') return json(400, { error: `\`${key}\` must be a string` });
    }
    // If-Match carries the item version the caller last read. Without it the update applies to whatever is there.
    const match = req.headers?.['if-match'];
    let expectedVersion: number | undefined;
    if (match !== undefined) {
      expectedVersion = Number(match.replace(/^W\//, '').replace(/"/g, ''));
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return json(400, { error: 'If-Match must be the item version, a whole number' });
    }
    try {
      const change = await setItemStatus(project.plans, planId, itemId, body.status, {
        by: req.identity?.user,
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        ...(typeof body.externalRef === 'string' ? { externalRef: body.externalRef } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      });
      this.opts.onAudit?.({ actor: req.identity?.user ?? 'unknown', action: 'plan.item.status', project: project.name, detail: `${change.plan.id}/${change.item.id}: ${change.was} -> ${change.item.status}` });
      return json(200, { plan: change.plan.id, item: change.item, was: change.was, version: itemVersion(change.item) });
    } catch (err) {
      if (!(err instanceof PlanStatusError)) throw err;
      const status = { 'no-plan': 404, 'no-item': 404, 'bad-status': 400, 'bad-transition': 422, conflict: 409 }[err.code];
      return json(status, { error: err.message, code: err.code });
    }
  }

  private summary(n: TraceNode) {
    return { id: n.id, title: n.title, kind: n.kind, status: n.status, value: n.value, parent: n.parent ?? null, counts: n.counts, files: n.ownedFiles.length, tests: n.tests.length };
  }

  private async system(project: ProjectSource) {
    const m = await project.trace();
    return json(200, { system: m.system ?? null, totals: m.totals, capabilities: m.nodes.filter((n) => n.kind === 'capability').map((n) => this.summary(n)), generated: m.generated });
  }

  private async capabilities(project: ProjectSource) {
    const m = await project.trace();
    return json(200, { capabilities: m.nodes.filter((n) => n.kind !== 'system').map((n) => this.summary(n)) });
  }

  private async capability(project: ProjectSource, id: string) {
    const m = await project.trace();
    const n = m.nodes.find((x) => x.id === id);
    if (!n) return notFound(`no spec with id "${id}"`);
    return json(200, { ...this.summary(n), specKey: n.specKey, ownedFiles: n.ownedFiles, testFiles: n.tests, docs: n.docs, history: n.history, claims: n.claims });
  }

  private async capabilityHistory(project: ProjectSource, id: string) {
    const m = await project.trace();
    const n = m.nodes.find((x) => x.id === id);
    if (!n) return notFound(`no spec with id "${id}"`);
    const entries = listHistory(project.config).filter((e) => e.affects.includes(id) || n.history.includes(e.id));
    return json(200, { id, entries: entries.map(({ file: _file, body: _body, ...meta }) => meta) });
  }

  private historyEntry(project: ProjectSource, id: string): ApiResponse {
    const e = listHistory(project.config).find((x) => x.id === id);
    if (!e) return notFound(`no history entry "${id}"`);
    const { file: _file, ...rest } = e;
    return json(200, rest);
  }

  /** The spec files, with the path an editor opens. */
  private async specs(project: ProjectSource) {
    const m = await project.trace();
    const root = project.config.rootDir ?? process.cwd();
    const specsDir = path.relative(root, specsRootDir(project.config)).split(path.sep).join('/');
    return json(200, {
      specs: m.nodes.map((n) => ({ id: n.id, title: n.title, kind: n.kind, specKey: n.specKey, file: path.posix.join(specsDir, `${n.specKey}.md`), claims: n.counts.claims })),
    });
  }

  /** One spec's markdown, as written. */
  private async specFile(project: ProjectSource, id: string) {
    const m = await project.trace();
    const node = m.nodes.find((n) => n.id === id);
    if (!node) return notFound(`no spec with id "${id}"`);
    const root = project.config.rootDir ?? process.cwd();
    const file = path.join(specsRootDir(project.config), `${node.specKey}.md`);
    let markdown: string;
    try {
      markdown = fs.readFileSync(file, 'utf8');
    } catch {
      return notFound(`the file for spec "${id}" is not available on this server`);
    }
    return json(200, { id, title: node.title, kind: node.kind, file: path.relative(root, file).split(path.sep).join('/'), markdown });
  }

  /** Coverage per capability and per unit: what a coverage tree or status bar shows. */
  private async coverage(project: ProjectSource) {
    const m = await project.trace();
    const caps = m.nodes.filter((n) => n.kind === 'capability' || n.kind === 'component');
    const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 100));
    return json(200, {
      generated: m.generated,
      totals: m.totals,
      // Owned means not in `unowned`: `ownedFiles` counts a file once per capability that owns it, and includes non-source files.
      sourceCoverage: pct(Math.max(0, m.totals.sourceFiles - m.unowned.length), m.totals.sourceFiles),
      provenCoverage: pct(m.totals.proven, m.totals.claims),
      // Per test layer, over the claims that require it; absent when no claim requires a layer.
      ...(m.totals.layerCounts ? { layerCoverage: m.totals.layerCounts } : {}),
      unowned: m.unowned,
      capabilities: caps.map((n) => ({
        id: n.id,
        title: n.title,
        status: n.status,
        files: n.ownedFiles.length,
        tests: n.tests.length,
        counts: n.counts,
        ...(n.layerCounts ? { layers: n.layerCounts } : {}),
        provenPercent: pct(n.counts.proven, n.counts.claims),
        testedPercent: pct(n.counts.withTests, n.counts.claims),
      })),
      units: (m.units ?? []).map((u) => ({ unit: u.unit, kind: u.kind, path: u.path, sourceFiles: u.sourceFiles, unowned: u.unowned.length, capabilities: u.capabilities, counts: u.counts })),
    });
  }

  private async contracts(project: ProjectSource) {
    const graph = await loadContractGraph(project.config.rootDir ?? process.cwd());
    return graph ? json(200, graph) : json(200, { version: '1', generatedAt: null, nodes: [], edges: [] });
  }

  /** Unresolved security plan items, from the newest plan, flattened for a findings list. */
  private async findings(project: ProjectSource) {
    const plan = await project.plans.read('latest');
    if (!plan) return json(200, { plan: null, findings: [] });
    return json(200, {
      plan: plan.id,
      createdAt: plan.createdAt,
      findings: plan.items
        .filter((i) => UNRESOLVED.includes(i.status))
        .map((i) => ({ id: i.id, severity: i.severity, type: i.type, title: i.title, status: i.status, version: itemVersion(i), capability: i.capability ?? null, unit: i.unit ?? null, files: i.files, externalRef: i.externalRef ?? null })),
    });
  }

  private gapsFor(project: ProjectSource, m: TraceModel, rel: string): ReturnType<typeof intentGaps> {
    let gaps = this.gapsCache.get(m);
    if (!gaps) {
      gaps = intentGaps(project.config.rootDir ?? process.cwd(), m.nodes, listHistory(project.config), rel);
      this.gapsCache.set(m, gaps);
    }
    return gaps;
  }

  private async audit(project: ProjectSource) {
    const m = await project.trace();
    const specs = m.nodes.filter((n) => n.kind === 'capability' || n.kind === 'component');
    const claims = specs.flatMap((n) => n.claims.map((c) => ({ capability: n.id, ...c })));
    const root = project.config.rootDir ?? process.cwd();
    const rel = path.relative(root, specsRootDir(project.config)).split(path.sep).join('/');
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
      intentGaps: this.gapsFor(project, m, rel),
    });
  }

  /** What documents can be requested: the system guide and one per capability, in each audience. */
  private async docList(project: ProjectSource) {
    const m = await project.trace();
    return json(200, {
      audiences: AUDIENCES,
      documents: [
        ...(m.system ? [{ id: 'system', title: m.system.title, audiences: AUDIENCES }] : []),
        ...m.nodes.filter((n) => n.kind === 'capability').map((n) => ({ id: n.id, title: n.title, audiences: AUDIENCES })),
      ],
    });
  }

  private async doc(project: ProjectSource, audience: string, id: string, req: ApiRequest) {
    if (!isAudience(audience)) return json(400, { error: `audience must be one of ${AUDIENCES.join(', ')}` });
    const r = await this.docsFor(project).get(audience, id, {
      ...(req.identity ? { user: req.identity.user } : {}),
      onUsage: (usage) => this.opts.onUsage?.(usage, project.name),
    });
    return json(200, r);
  }

  private async plans(project: ProjectSource, id?: string): Promise<ApiResponse> {
    if (id !== undefined) {
      const plan = await project.plans.read(id);
      return plan ? json(200, plan) : notFound(`no plan "${id}"`);
    }
    const plans = [];
    for (const planId of await project.plans.list()) {
      const plan = await project.plans.read(planId);
      if (plan) plans.push({ id: plan.id, createdAt: plan.createdAt, items: plan.items.length });
    }
    return json(200, { plans });
  }
}
