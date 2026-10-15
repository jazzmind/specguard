/**
 * On-demand documentation. Docs are generated from the specs when a viewer
 * asks for them, by the fast model tier, and cached against a hash of the spec
 * content, the audience, the prompt version and the model. Identical concurrent
 * requests share one model call.
 *
 * The `agent` audience is a deterministic, compact rendering of the spec (no
 * model), so coding agents always get exact requirement ids.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LlmBudgetExceededError, llmGenerateText, resolveTargets } from '../core/llm.js';
import { resetRunSpend } from '../core/llm-runtime.js';
import { buildSpecGraph, type SpecNode } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import type { SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';

export const AUDIENCES = ['user', 'dev', 'agent'] as const;
export type Audience = (typeof AUDIENCES)[number];
export const PROMPT_VERSION = 'v1';

export class DocNotFoundError extends Error {}

export interface DocResult {
  id: string;
  audience: Audience;
  markdown: string;
  /** True when a model wrote it (now or when it was cached). */
  generated: boolean;
  /** True when served from the cache. */
  cached: boolean;
  hash: string;
  /** Set when a model was wanted but unavailable and the spec was rendered directly. */
  warning?: string;
}

export function isAudience(value: string): value is Audience {
  return (AUDIENCES as readonly string[]).includes(value);
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const section = (node: SpecNode, name: string): string => node.spec.sections[name]?.trim() ?? '';

function reqs(node: SpecNode, ids: boolean): string {
  return node.spec.claims
    .map((c) => (ids && c.id ? `- **${c.id}**: ${c.text}` : `- ${c.text}`))
    .join('\n');
}

/** The spec as prompt material: every section a doc could draw on. */
function material(node: SpecNode, dev: boolean): string {
  const parts = [
    `# ${node.spec.title || node.id}`,
    node.spec.meta.value ? `Value: ${node.spec.meta.value}` : '',
    `## Problem & Value\n${section(node, 'Problem & Value') || node.spec.overview}`,
    section(node, 'Users & Journeys') ? `## Users & Journeys\n${section(node, 'Users & Journeys')}` : '',
    `## Requirements\n${reqs(node, dev)}`,
    node.spec.scenarios.length > 0
      ? `## Scenarios\n${node.spec.scenarios.map((s) => `- ${s.name}: ${s.steps.join(' -> ')} (expect: ${s.expectedResults.join('; ')})`).join('\n')}`
      : '',
    section(node, 'Interfaces') ? `## Interfaces\n${section(node, 'Interfaces')}` : '',
    section(node, 'Security & Data Considerations') ? `## Security & Data Considerations\n${section(node, 'Security & Data Considerations')}` : '',
    section(node, 'Out of Scope') ? `## Out of Scope\n${section(node, 'Out of Scope')}` : '',
    dev
      ? `## Code map\nsources: ${(node.spec.meta.sources ?? []).join(', ') || '(none)'}\ntests: ${(node.spec.meta.tests ?? []).join(', ') || '(none)'}\nowned files: ${node.ownedFiles.length}`
      : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Compact brief for coding agents. Deterministic: exact ids, files and tests. */
export function renderAgentBrief(node: SpecNode): string {
  const m = node.spec.meta;
  return [
    `# ${node.spec.title || node.id} (${node.id})`,
    `kind: ${node.kind ?? 'v1'} | status: ${m.status ?? 'draft'}${m.parent ? ` | parent: ${m.parent}` : ''}`,
    '',
    `## Purpose\n${m.value ?? node.spec.overview}`,
    `## Invariants (do not break; cite ids in tests as @claim:${node.specKey}#<id>)\n${reqs(node, true) || '- none recorded'}`,
    section(node, 'Interfaces') ? `## Interfaces\n${section(node, 'Interfaces')}` : '',
    `## Owned files (${node.ownedFiles.length})\n${(m.sources ?? []).map((s) => `- ${s}`).join('\n') || '- none'}`,
    `## Tests\n${(m.tests ?? []).map((t) => `- ${t}`).join('\n') || '- none declared'}`,
    section(node, 'Out of Scope') ? `## Out of scope\n${section(node, 'Out of Scope')}` : '',
    (m.history ?? []).length > 0 ? `## History\n${(m.history ?? []).map((h) => `- ${h}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** What a viewer gets when no model is available: the spec, shaped for the audience. */
export function renderFallback(audience: Audience, node: SpecNode): string {
  if (audience === 'agent') return renderAgentBrief(node);
  const pv = section(node, 'Problem & Value') || node.spec.overview;
  const journeys = section(node, 'Users & Journeys');
  if (audience === 'user') {
    return [`# ${node.spec.title || node.id}`, pv, journeys ? `## What you can do\n${journeys}` : '', `## What to expect\n${reqs(node, false)}`].filter(Boolean).join('\n\n');
  }
  return [`# ${node.spec.title || node.id}`, pv, `## Requirements\n${reqs(node, true)}`, section(node, 'Interfaces') ? `## Interfaces\n${section(node, 'Interfaces')}` : '', `## Code map\n${(node.spec.meta.sources ?? []).map((s) => `- ${s}`).join('\n')}`]
    .filter(Boolean)
    .join('\n\n');
}

const USER_SYSTEM =
  'You write user documentation for one capability of a software system, for the people who use the product, not its developers. ' +
  'Plain language. Explain what it is for, what a person can do with it, and what to expect. Never mention code, files, requirement ids or internals. ' +
  'Describe only what the material says; do not invent features. Markdown with a title and short sections.';
const DEV_SYSTEM =
  'You write developer documentation for one capability of a software system. Sections: Purpose, Responsibilities, Interfaces, Requirements (keep the ids), ' +
  'Code map, Tests, Security and data, Extending it. Use only the material given; do not invent behaviour. Markdown.';
const SYSTEM_GUIDE_SYSTEM =
  'You write an overview guide to a whole software system from its master spec and the list of its capabilities. ' +
  'Say what problem it solves, who it is for, the value it creates, and walk through each capability in one short paragraph. Describe only what the material says. Markdown.';

export class DocService {
  private readonly inflight = new Map<string, Promise<DocResult>>();
  /** Model calls run one generation at a time: the spend budget is process-wide, so two at once would reset each other's count. */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: SpecGuardConfig) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.gate.then(run, run);
    this.gate = next.catch(() => undefined);
    return next;
  }

  private root(): string {
    return this.config.rootDir ?? process.cwd();
  }

  private cacheFile(audience: Audience, id: string): string {
    return path.join(this.root(), '.specguard', 'cache', 'docs', audience, `${id.replace(/[^a-z0-9-]/gi, '_')}.json`);
  }

  private fileText(node: SpecNode): string {
    try {
      return fs.readFileSync(path.join(specsRootDir(this.config), `${node.specKey}.md`), 'utf8');
    } catch {
      return JSON.stringify(node.spec.sections);
    }
  }

  async get(audience: Audience, id: string): Promise<DocResult> {
    const graph = await buildSpecGraph(this.config);
    const node = id === 'system' ? graph.system : graph.nodes.get(id);
    if (!node) throw new DocNotFoundError(id === 'system' ? 'this repo has no system spec' : `no spec with id "${id}"`);

    const capabilities = [...graph.nodes.values()].filter((n) => n.kind === 'capability').sort((a, b) => a.id.localeCompare(b.id));
    const content = id === 'system' ? [this.fileText(node), ...capabilities.map((c) => this.fileText(c))].join('\n\0\n') : this.fileText(node);
    const model = resolveTargets({ provider: this.config.llm.provider, model: this.config.llm.model, apiKeyEnv: this.config.llm.apiKeyEnv, pipeline: 'docs' })[0].model;
    const hash = sha(`${sha(content)}|${audience}|${PROMPT_VERSION}|${audience === 'agent' ? '-' : model}`);

    const cacheFile = this.cacheFile(audience, id);
    try {
      const hit = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { hash: string; markdown: string };
      if (hit.hash === hash) return { id, audience, markdown: hit.markdown, generated: audience !== 'agent', cached: true, hash };
    } catch {
      /* not cached */
    }

    const key = `${audience}:${id}:${hash}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const work = this.generate(audience, id, node, capabilities, hash, cacheFile).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async generate(audience: Audience, id: string, node: SpecNode, capabilities: SpecNode[], hash: string, cacheFile: string): Promise<DocResult> {
    if (audience === 'agent') {
      const markdown = renderAgentBrief(node);
      await writeFile(cacheFile, JSON.stringify({ hash, markdown }) + '\n');
      return { id, audience, markdown, generated: false, cached: false, hash };
    }
    const { llm } = this.config;
    if (llm.provider === 'none') {
      return { id, audience, markdown: renderFallback(audience, node), generated: false, cached: false, hash, warning: 'no model configured; rendered directly from the spec' };
    }
    const system = id === 'system' ? SYSTEM_GUIDE_SYSTEM : audience === 'user' ? USER_SYSTEM : DEV_SYSTEM;
    const prompt =
      id === 'system'
        ? `${material(node, false)}\n\n# Capabilities\n${capabilities.map((c) => `## ${c.spec.title || c.id}\n${c.spec.meta.value ?? ''}\n${(section(c, 'Problem & Value') || c.spec.overview).slice(0, 500)}`).join('\n\n')}`
        : material(node, audience === 'dev');
    try {
      const markdown = await this.exclusive(() => {
        // `llm.budget` applies to one generation, not to the lifetime of the server.
        resetRunSpend();
        return llmGenerateText({ provider: llm.provider, model: llm.model, apiKeyEnv: llm.apiKeyEnv, pipeline: 'docs', system, prompt });
      });
      await writeFile(cacheFile, JSON.stringify({ hash, markdown }) + '\n');
      return { id, audience, markdown, generated: true, cached: false, hash };
    } catch (err) {
      // A spent budget is an error to report, not something to paper over with a different document.
      if (err instanceof LlmBudgetExceededError) throw err;
      // Not cached, so the next request tries the model again.
      return { id, audience, markdown: renderFallback(audience, node), generated: false, cached: false, hash, warning: `model unavailable (${(err as Error).message}); rendered directly from the spec` };
    }
  }
}
