import { configureLlm } from '../../core/llm-runtime.js';
import path from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { experienceContext, experienceFile, experienceSchema, mergeExperience, revisionOf, saveExperience, validateExperience, writeJson } from '../../core/experience.js';
import { llmGenerateObject } from '../../core/llm.js';
import { untrusted } from '../../core/untrusted.js';
import { resolveSearchDir, type GlobalOpts } from './helpers.js';

export async function experienceCommand(opts: GlobalOpts & { workspace?: string; inheritWorkspace?: string; action?: string; data?: string; revision?: string }): Promise<void> {
  const ctx = await experienceContext(resolveSearchDir(opts.config), opts.workspace, opts.inheritWorkspace);
  const proposalFile = path.join(ctx.root, '.specguard/experience.draft.json');
  const action = opts.action ?? 'show';
  if (action === 'save') {
    if (!opts.data || !opts.revision) throw new Error('Saving requires --data and --revision');
    saveExperience(ctx.root, JSON.parse(opts.data), opts.revision);
  } else if (action === 'draft') {
    const config = ctx.configs[0];
    if (!config || !ctx.catalog.length) throw new Error('Add application specs or feature catalogs before drafting journeys');
    configureLlm({ rootDir: ctx.root, llm: config.llm });
    const generated = await llmGenerateObject({
      provider: config.llm.provider, model: config.llm.model, apiKeyEnv: config.llm.apiKeyEnv,
      schema: experienceSchema, maxTokens: 14000,
      system: 'Draft a coherent business-oriented application overview, logical feature groups and ordered business journeys across the supplied applications. Use only exact supplied refs, including app prefixes. Never invent behavior or claim approval/proof. Every journey status is draft. Group/order placements for every feature and capability. Reuse existing group/journey/step IDs where applicable; retain user organization. Empty group is allowed. Output version 1.',
      prompt: [untrusted('existing organization', JSON.stringify(ctx.document)), untrusted('available specs and features', JSON.stringify(ctx.catalog.map(({ file: _file, ...e }) => e)))].join('\n'),
    });
    const valid = validateExperience(generated);
    const known = new Set(ctx.catalog.flatMap(e => [e.ref, ...e.claims]));
    for (const ref of [...valid.placements.map(p => p.ref), ...valid.journeys.flatMap(j => j.steps.flatMap(s => s.refs))]) if (!known.has(ref)) throw new Error(`Draft invented a reference: ${ref}`);
    const next = mergeExperience(ctx.document, valid);
    writeJson(proposalFile, { baseRevision: ctx.revision, catalogRevision: revisionOf(ctx.catalog), document: next });
  } else if (action === 'apply') {
    if (!existsSync(proposalFile)) throw new Error('Draft an organization first');
    const proposal = JSON.parse(readFileSync(proposalFile, 'utf8'));
    if (proposal.catalogRevision !== revisionOf(ctx.catalog)) throw new Error('Specs/catalog changed since drafting. Draft again before applying.');
    saveExperience(ctx.root, proposal.document, proposal.baseRevision);
    unlinkSync(proposalFile);
  } else if (action !== 'show') throw new Error(`Unknown experience action: ${action}`);
  const updated = await experienceContext(resolveSearchDir(opts.config), opts.workspace, opts.inheritWorkspace);
  const { configs: _configs, ...view } = updated;
  const proposal = existsSync(proposalFile) ? JSON.parse(readFileSync(proposalFile, 'utf8')) : undefined;
  const result = { ...view, file: experienceFile(ctx.root), proposalFile, proposal };
  console.log(opts.json ? JSON.stringify(result) : `${view.document.title}\n${view.document.overview}\n${view.document.journeys.length} journeys; ${view.catalog.length} features/specs\n${view.warnings.join('\n')}\nOrganization: ${result.file}${proposal ? `\nDraft: ${proposalFile}` : ''}`);
}
