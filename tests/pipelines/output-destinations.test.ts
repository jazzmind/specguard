import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../src/core/llm.js', () => ({ llmGenerateText: vi.fn(async () => 'import { test, expect } from "@playwright/test"; test("login", async () => { expect(true).toBe(true); });'), llmGenerateObject: vi.fn(async () => ({ description: 'Login', category: 'core', order: 1, body: '# Login\nUse the login page.' })) }));
import { applyOutputLocations, saveOutputLocation } from '../../src/core/output-locations.js';
import { llmGenerateText } from '../../src/core/llm.js';
import { runForwardGenerate } from '../../src/pipelines/forward-generate.js';
import { runDocGenerate } from '../../src/pipelines/doc-generate.js';
import type { SpecGuardConfig } from '../../src/core/types.js';
let root: string;
let config: SpecGuardConfig;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'sg-output-pipeline-'));
  config = { rootDir: root, apps: [{ name: 'api', repo: 'code', language: 'java', framework: 'junit', specDir: 'specs', testOutput: 'tags', sources: {} }], llm: { provider: 'host', model: 'test', apiKeyEnv: 'TEST_KEY' } };
  mkdirSync(path.join(root, 'specs'), { recursive: true });
  writeFileSync(path.join(root, 'specs/login.md'), '# Login\n\n## Overview\nAuthenticate.\n\n## Scenarios\n### Scenario 1: Login\n**Steps:**\n1. Sign in\n\n**Expected Results:**\n- Signed in\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('writing pipelines use saved destinations', () => {
  // [claims: capabilities/integration-surfaces#output-destinations]
  it('writes executable Playwright TypeScript for backend claims to the existing overlay journey suite', async () => {
    saveOutputLocation(config, 'api', 'tests.e2e', 'overlay/e2e/journeys');
    const result = await runForwardGenerate(config, { all: true, app: 'api', type: 'e2e', framework: 'playwright' });
    expect(result.created).toBe(1);
    const file = path.join(root, 'overlay/e2e/journeys/login.spec.ts');
    expect(readFileSync(file, 'utf8')).toContain('[layer: e2e]');
    expect(existsSync(path.join(root, 'tags'))).toBe(false);
    expect(existsSync(path.join(root, 'code'))).toBe(false);
  });
  // [claims: capabilities/integration-surfaces#output-destinations]
  it('honors saved doc destinations and a one-run explicit --out override', async () => {
    saveOutputLocation(config, 'api', 'docs', 'overlay/guide');
    const result = await runDocGenerate(config, { all: true });
    expect(result.created).toBe(1); expect(existsSync(path.join(root, 'overlay/guide/login.md'))).toBe(true);
    await runDocGenerate(config, { all: true, out: 'one-run' });
    expect(existsSync(path.join(root, 'one-run/login.md'))).toBe(true);
  });
  // [claims: capabilities/integration-surfaces#output-destinations]
  it('uses canonical claim references for generation after relocating a nested spec root', async () => {
    config.apps[0].language = 'typescript'; config.apps[0].framework = 'vitest'; config.apps[0].specDir = 'specs/capabilities';
    mkdirSync(path.join(root, 'specs/capabilities'), { recursive: true });
    writeFileSync(path.join(root, 'specs/capabilities/login.md'), '# Login\n\n## Requirements\n- [ ] Signs in <!-- claim: sign-in -->\n');
    saveOutputLocation(config, 'api', 'specs', 'overlay/specs'); applyOutputLocations(config);
    saveOutputLocation(config, 'api', 'tests.unit', 'overlay/tests');
    const result = await runForwardGenerate(config, { all: true, app: 'api', type: 'unit' });
    expect(result.created).toBe(1);
    expect(vi.mocked(llmGenerateText)).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: expect.stringContaining('capabilities/login#sign-in') }));
  });

});
