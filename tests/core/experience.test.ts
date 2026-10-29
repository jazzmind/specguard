import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyExperience, experienceContext, experienceFile, mergeExperience, readExperience, revisionOf, saveExperience, validateExperience, type Experience } from '../../src/core/experience.js';
let root: string;
beforeEach(() => root = mkdtempSync(path.join(os.tmpdir(), 'sg-experience-')));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const journey = (title: string) => ({ id: 'purchase', title, summary: 'Original purpose', group: '', order: 4, status: 'reviewed' as const, steps: [{ id: 'pay', title: 'Pay', summary: 'One charge', order: 2, refs: ['api:capabilities/pay#once'] }] });
const put = (file: string, data: unknown) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data)); };
describe('business organization', () => {
  // [claims: capabilities/workspaces#workspace-business-journeys]
  it('keeps manual text, order and references when an automatic refresh proposes changes', () => {
    const current = emptyExperience('eSales'); current.overview = 'Reviewed overview'; current.journeys.push(journey('Buy insurance'));
    const generated = emptyExperience('Replacement'); generated.overview = 'Generated overview'; const j = journey('Model title'); j.steps.push({ id: 'confirm', title: 'Confirm', summary: 'Policy issued', order: 3, refs: ['ui:confirmation'] }); generated.journeys.push(j);
    const merged = mergeExperience(current, generated);
    expect(merged.overview).toBe('Reviewed overview'); expect(merged.journeys[0].title).toBe('Buy insurance'); expect(merged.journeys[0].order).toBe(4);
    expect(merged.journeys[0].steps[0]).toEqual(current.journeys[0].steps[0]);
    expect(merged.journeys[0].steps).toHaveLength(2); expect(merged.journeys[0].status).toBe('draft');
    expect(mergeExperience(merged, generated)).toEqual(merged);
  });
  // [claims: capabilities/workspaces#workspace-business-journeys]
  it('protects edits from stale writers, including the first save with a different workspace title', () => {
    const doc = emptyExperience('A business title'); saveExperience(root, doc, revisionOf(null));
    expect(readExperience(root)).toEqual(doc);
    expect(() => saveExperience(root, { ...doc, overview: 'stale edit' }, revisionOf(null))).toThrow(/changed/);
    expect(JSON.parse(readFileSync(experienceFile(root), 'utf8')).overview).toBe('');
  });
  // [claims: capabilities/spec-authoring#application-organization]
  it('rejects duplicate identities and dangling groups without changing stable spec references', () => {
    const doc = emptyExperience('App'); doc.groups.push({ id: 'quote', title: 'Quote', order: 0 }); doc.placements.push({ ref: 'ui:capabilities/quote', group: 'quote', order: 0 });
    expect(validateExperience(doc).placements[0].ref).toBe('ui:capabilities/quote');
    expect(() => validateExperience({ ...doc, groups: [...doc.groups, ...doc.groups] })).toThrow(/Duplicate/);
    expect(() => validateExperience({ ...doc, placements: [{ ref: 'ui:quote', group: 'unknown', order: 0 }] })).toThrow(/Unknown group/);
  });
  // [claims: capabilities/workspaces#workspace-business-journeys]
  it('catalogs participating repos with qualified claim refs and reports dangling journey links', async () => {
    put('.specguard/workspace.json', { version: '1.0', name: 'Insurance', repos: { web: { path: 'web', role: 'consumer' }, api: { path: 'api', role: 'provider' } } });
    for (const app of ['web', 'api']) {
      put(`${app}/.specguard/config.json`, { apps: [{ name: app, repo: '.', framework: 'vitest', specDir: 'specs', testOutput: 'tests', sources: {} }] });
      put(`${app}/specs/pay.md`, '# Pay\n\n## Requirements\n- [ ] Charge once <!-- claim: once -->\n');
    }
    const doc = emptyExperience('Insurance'); doc.journeys.push(journey('Purchase')); put('.specguard/experience.json', doc);
    const ctx = await experienceContext(root, root);
    expect(ctx.catalog.map(e => e.ref)).toEqual(['web:pay', 'api:pay']);
    expect(ctx.catalog[0].claims).toEqual(['web:pay#once']);
    expect(ctx.warnings).toContain('Missing reference: api:capabilities/pay#once');
  });
  // [claims: capabilities/spec-authoring#application-organization]
  it('defaults app grouping to workspace journey steps while preserving application overrides', async () => {
    put('.specguard/workspace.json', { version: '1.0', name: 'Insurance', repos: { web: { path: 'web', role: 'consumer' } } });
    put('web/.specguard/config.json', { apps: [{ name: 'ui', repo: '.', framework: 'vitest', specDir: 'specs', testOutput: 'tests', sources: {} }] });
    put('web/specs/pay.md', '# Checkout\n\n## Requirements\n- [ ] Pay <!-- claim: once -->\n');
    const shared = emptyExperience('Insurance'); const j = journey('Purchase'); j.steps[0].refs = ['web:pay#once']; shared.journeys.push(j); put('.specguard/experience.json', shared);
    const ctx = await experienceContext(path.join(root, 'web'));
    expect(ctx.document.placements[0].ref).toBe('ui:pay'); expect(ctx.document.groups[0].title).toBe('Purchase · Pay');
    const own: Experience = { ...ctx.document, groups: [{ id: 'custom', title: 'My group', order: 0 }], placements: [{ ref: 'ui:pay', group: 'custom', order: 8 }] };
    saveExperience(ctx.root, own, ctx.revision);
    expect((await experienceContext(path.join(root, 'web'))).document.placements[0]).toEqual(own.placements[0]);
  });
});
