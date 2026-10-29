import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn() }));
import { llmGenerateObject } from '../../src/core/llm.js';
import { experienceCommand } from '../../src/cli/commands/experience.js';
import { emptyExperience, experienceFile, readExperience } from '../../src/core/experience.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'sg-experience-cli-')); mkdirSync(path.join(root, '.specguard')); mkdirSync(path.join(root, 'specs'));
  writeFileSync(path.join(root, '.specguard/config.json'), JSON.stringify({ apps: [{ name: 'api', repo: '.', specDir: 'specs', testOutput: 'tests', framework: 'vitest', sources: {} }] }));
  writeFileSync(path.join(root, 'specs/pay.md'), '# Pay\n\n## Requirements\n- [ ] Charge once <!-- claim: once -->\n');
  const draft = emptyExperience('Insurance'); draft.journeys = [{ id: 'buy', title: 'Buy policy', summary: 'Purchase', group: '', order: 0, status: 'draft', steps: [{ id: 'pay', title: 'Pay', summary: 'Charge once', order: 0, refs: ['api:pay#once'] }] }];
  vi.mocked(llmGenerateObject).mockResolvedValue(draft); vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
// [claims: capabilities/workspaces#journey-draft-review]
describe('draft review and apply', () => {
  // [claims: capabilities/workspaces#journey-draft-review]
  it('keeps generated organization separate until apply and removes the applied proposal', async () => {
    await experienceCommand({ config: root, action: 'draft', json: true });
    expect(existsSync(experienceFile(root))).toBe(false);
    expect(existsSync(path.join(root, '.specguard/experience.draft.json'))).toBe(true);
    await experienceCommand({ config: root, action: 'apply', json: true });
    expect(readExperience(root).journeys[0].steps[0].refs).toEqual(['api:pay#once']);
    expect(existsSync(path.join(root, '.specguard/experience.draft.json'))).toBe(false);
  });
  // [claims: capabilities/workspaces#journey-draft-review]
  it('refuses a stale draft when the underlying requirements change', async () => {
    await experienceCommand({ config: root, action: 'draft', json: true });
    writeFileSync(path.join(root, 'specs/pay.md'), '# Pay changed\n\n## Requirements\n- [ ] Charge twice <!-- claim: twice -->\n');
    await expect(experienceCommand({ config: root, action: 'apply', json: true })).rejects.toThrow(/changed since drafting/);
    expect(existsSync(experienceFile(root))).toBe(false);
  });
  // [claims: capabilities/workspaces#journey-draft-review]
  it('rejects hallucinated references without saving an active document', async () => {
    const invalid = emptyExperience('Insurance'); invalid.placements.push({ ref: 'api:imaginary', group: '', order: 0 });
    vi.mocked(llmGenerateObject).mockResolvedValue(invalid);
    await expect(experienceCommand({ config: root, action: 'draft', json: true })).rejects.toThrow(/invented a reference/);
    expect(existsSync(experienceFile(root))).toBe(false);
  });
});
