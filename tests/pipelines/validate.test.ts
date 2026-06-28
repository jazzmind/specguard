import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock adapters and LLM so no real browser or API calls occur.
vi.mock('../../src/adapters/playwright.js', () => {
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    title: vi.fn(async () => 'My App'),
    url: vi.fn(() => 'http://localhost:3000/'),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
    accessibility: { snapshot: vi.fn(async () => ({ role: 'WebArea' })) },
    on: vi.fn(),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };
  const browser = { close: vi.fn(async () => {}) };
  return {
    launchBrowser: vi.fn(async () => ({
      _browser: browser,
      _page: page,
      _consoleErrors: [],
    })),
    closeBrowser: vi.fn(async () => {}),
    navigateTo: vi.fn(async () => ({
      url: 'http://localhost:3000/',
      title: 'My App',
      statusCode: 200,
      consoleErrors: [],
    })),
    takeScreenshot: vi.fn(async (_h: unknown, label: string, dir: string) =>
      path.join(dir, `${label}.png`),
    ),
    getAccessibilitySnapshot: vi.fn(async () => '{"role":"WebArea"}'),
    PlaywrightUnavailableError: class PlaywrightUnavailableError extends Error {
      constructor() { super('@playwright/test not available'); }
    },
  };
});

vi.mock('../../src/adapters/auth-state-machine.js', () => ({
  authenticate: vi.fn(async () => ({ success: true, profile: 'admin' })),
  clearSessionCache: vi.fn(),
}));

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateObject: vi.fn(async () => ({
    actions: [],
    verdicts: [{ criterion: 'AC 1', verdict: 'PASS', reason: 'Met in page state.' }],
  })),
  llmGenerateText: vi.fn(async () => ''),
}));

import { llmGenerateObject } from '../../src/core/llm.js';
import { runValidate } from '../../src/pipelines/validate.js';
import type { SpecGuardConfig } from '../../src/core/types.js';
import { ExitCode } from '../../src/core/exit-codes.js';

const mockedLlm = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

let rootDir: string;

const SPEC_WITH_URL = `# My Feature

<!--
module: src/feature.ts
type: feature
status: stable
url: http://localhost:3000/
-->

## Overview
Feature overview.

## Acceptance Criteria
- AC 1: Page loads correctly

## Scenarios

### Scenario 1: Basic
**Steps:**
1. Navigate to the page

**Expected Results:**
- Page title visible
`;

const SPEC_WITHOUT_URL = `# My Feature No URL

<!-- type: feature -->
<!-- status: stable -->

## Overview
No URL.

## Acceptance Criteria
- AC 1

## Scenarios

### Scenario 1: Basic
**Steps:**
1. Step

**Expected Results:**
- Result
`;

async function writeSpec(rel: string, content: string): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'myapp',
        repo: '.',
        specDir: 'specs',
        sources: { api: ['src/**/*.ts'] },
        framework: 'playwright',
        testOutput: 'tests',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockedLlm.mockReset();
  // Default: plan returns no actions; verify returns PASS
  mockedLlm
    .mockResolvedValueOnce({ actions: [] }) // PLAN
    .mockResolvedValueOnce({               // VERIFY
      verdicts: [{ criterion: 'AC 1: Page loads correctly', verdict: 'PASS', reason: 'Title visible.' }],
    });
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-validate-'));
});

describe('runValidate', () => {
  it('throws when neither --spec nor --all given', async () => {
    await expect(runValidate(makeConfig(), {})).rejects.toThrow();
  });

  it('scenario 1: all criteria pass → exitCode 0', async () => {
    await writeSpec('specs/feature.md', SPEC_WITH_URL);

    const res = await runValidate(makeConfig(), { spec: 'feature' });

    expect(res.exitCode).toBe(ExitCode.Success);
    expect(res.failed).toBe(0);
    expect(res.messages.some((m) => m.includes('PASS'))).toBe(true);
  });

  it('scenario 2: FAIL verdict → exitCode 2', async () => {
    mockedLlm.mockReset();
    mockedLlm
      .mockResolvedValueOnce({ actions: [] })
      .mockResolvedValueOnce({
        verdicts: [
          {
            criterion: 'AC 1: Page loads correctly',
            verdict: 'FAIL',
            reason: 'Page title was empty.',
            evidence: '/evidence/feature-post-action.png',
          },
        ],
      });

    await writeSpec('specs/feature.md', SPEC_WITH_URL);

    const res = await runValidate(makeConfig(), { spec: 'feature' });

    expect(res.exitCode).toBe(ExitCode.ValidationFailed);
    expect(res.failed).toBe(1);
    expect(res.messages.some((m) => m.includes('FAIL'))).toBe(true);
  });

  it('scenario 3: spec without url is skipped', async () => {
    await writeSpec('specs/no-url.md', SPEC_WITHOUT_URL);

    const res = await runValidate(makeConfig(), { spec: 'no-url' });

    expect(res.skipped).toBe(1);
    expect(res.exitCode).toBe(ExitCode.Success);
    expect(res.messages.some((m) => m.includes('[skip]') && m.includes('no url'))).toBe(true);
  });

  it('validation history written to .specguard/validation-history.json', async () => {
    await writeSpec('specs/feature.md', SPEC_WITH_URL);

    await runValidate(makeConfig(), { spec: 'feature' });

    const historyPath = path.join(rootDir, '.specguard', 'validation-history.json');
    const { readFile } = await import('node:fs/promises');
    const history = JSON.parse(await readFile(historyPath, 'utf-8'));
    expect(Array.isArray(history)).toBe(true);
    expect(history[0].specKey).toBe('feature');
    expect(history[0].url).toBe('http://localhost:3000/');
  });

  it('scenario 4: blocked action recorded in results', async () => {
    mockedLlm.mockReset();
    mockedLlm
      .mockResolvedValueOnce({
        actions: [{ description: 'Delete all records', selector: '#delete-btn' }],
      })
      .mockResolvedValueOnce({
        verdicts: [{ criterion: 'AC 1', verdict: 'PASS', reason: 'OK' }],
      });

    await writeSpec('specs/feature.md', SPEC_WITH_URL);

    const res = await runValidate(makeConfig(), { spec: 'feature' });

    expect(res.messages.some((m) => m.includes('[blocked]'))).toBe(true);
  });
});
