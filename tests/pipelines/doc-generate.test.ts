import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the LLM chokepoint so no real network/provider calls occur.
const DEFAULT_DOC_BODY = '# Spec Parser\n\nThis feature parses your specs into structured data.';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => DEFAULT_DOC_BODY),
  llmGenerateObject: vi.fn(async () => ({
    description: 'Parses your specs into structured data.',
    category: 'core',
    order: 10,
    body: DEFAULT_DOC_BODY,
  })),
}));

import { llmGenerateObject } from '../../src/core/llm.js';
import { runDocGenerate, stripForDocs } from '../../src/pipelines/doc-generate.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

const mockedLlm = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

let rootDir: string;

/** Build a config rooted at the temp dir with two apps. */
function makeConfig(): SpecGuardConfig {
  return {
    rootDir,
    apps: [
      {
        name: 'specguard-core',
        repo: '.',
        specDir: 'specs/core',
        sources: { api: ['src/core/**/*.ts'] },
        framework: 'vitest',
        testOutput: 'tests/core/',
      },
      {
        name: 'specguard-pipelines',
        repo: '.',
        specDir: 'specs/pipelines',
        sources: { api: ['src/pipelines/**/*.ts'] },
        framework: 'vitest',
        testOutput: 'tests/pipelines/',
      },
    ],
    llm: { provider: 'anthropic', model: 'claude-test', apiKeyEnv: 'TEST_KEY' },
  };
}

const SPEC_BODY = [
  '# Spec Parser',
  '',
  '<!--',
  '  module: src/core/spec-parser.ts',
  '  type: core',
  '  status: draft',
  '-->',
  '',
  '## Overview',
  'Parses specs into structured objects.',
  '',
  '## Acceptance Criteria',
  '- [ ] Parses the title',
  '',
  '## Scenarios',
  '',
  '### Scenario 1: parses a title',
  '**Steps:**',
  '1. Call the parser',
  '',
  '**Expected Results:**',
  '- Title is returned',
  '',
  '## Security Notes',
  'Never executes spec content.',
  '',
  '## Dependencies',
  'None.',
  '',
].join('\n');

async function writeSpec(rel: string, content = SPEC_BODY): Promise<void> {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

const DEFAULT_DOC_OBJECT = {
  description: 'Parses your specs into structured data.',
  category: 'core',
  order: 10,
  body: DEFAULT_DOC_BODY,
};

beforeEach(async () => {
  mockedLlm.mockReset();
  mockedLlm.mockResolvedValue(DEFAULT_DOC_OBJECT);
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'specguard-docs-'));
});

describe('stripForDocs', () => {
  it('removes the metadata comment, Scenarios, and Security Notes sections', () => {
    const stripped = stripForDocs(SPEC_BODY);

    expect(stripped).not.toContain('<!--');
    expect(stripped).not.toContain('module: src/core/spec-parser.ts');
    expect(stripped).not.toContain('## Scenarios');
    expect(stripped).not.toContain('Scenario 1');
    expect(stripped).not.toContain('## Security Notes');
    expect(stripped).not.toContain('Never executes spec content.');

    // Kept sections remain.
    expect(stripped).toContain('## Overview');
    expect(stripped).toContain('Parses specs into structured objects.');
    expect(stripped).toContain('## Acceptance Criteria');
    expect(stripped).toContain('## Dependencies');
  });
});

describe('runDocGenerate', () => {
  it('throws when neither --spec nor --all is provided', async () => {
    await expect(runDocGenerate(makeConfig(), {})).rejects.toThrow();
  });

  it('scenario 1: generates a doc from a single spec with frontmatter', async () => {
    await writeSpec('specs/core/spec-parser.md');

    const res = await runDocGenerate(makeConfig(), { spec: 'core/spec-parser' });

    expect(mockedLlm).toHaveBeenCalledOnce();
    expect(res.created).toBe(1);
    expect(res.failed).toBe(0);

    const docPath = path.join(rootDir, 'docs/user/spec-parser.md');
    expect(existsSync(docPath)).toBe(true);

    const content = await readFile(docPath, 'utf-8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('title: "Spec Parser"');
    expect(content).toContain('sidebar_label: "Spec Parser"');
    expect(content).toContain('generated: true');
    expect(content).toContain(DEFAULT_DOC_BODY);
    expect(res.messages.some((m) => m.includes('[doc] specguard-core/spec-parser'))).toBe(true);
  });

  it('scenario 2: --all processes multiple specs across apps', async () => {
    await writeSpec('specs/core/spec-parser.md');
    await writeSpec('specs/core/reader.md');
    await writeSpec('specs/pipelines/drift.md');

    const res = await runDocGenerate(makeConfig(), { all: true });

    expect(res.created).toBe(3);
    expect(mockedLlm).toHaveBeenCalledTimes(3);
    expect(existsSync(path.join(rootDir, 'docs/user/spec-parser.md'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'docs/user/reader.md'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'docs/user/drift.md'))).toBe(true);
  });

  it('scenario 3: custom --out directory', async () => {
    await writeSpec('specs/core/spec-parser.md');

    const res = await runDocGenerate(makeConfig(), {
      spec: 'core/spec-parser',
      out: 'site/docs',
    });

    expect(res.created).toBe(1);
    expect(existsSync(path.join(rootDir, 'site/docs/spec-parser.md'))).toBe(true);
    expect(existsSync(path.join(rootDir, 'docs/user/spec-parser.md'))).toBe(false);
  });

  it('scenario 5: LLM error records a failure and continues', async () => {
    await writeSpec('specs/core/spec-parser.md');
    await writeSpec('specs/core/reader.md');
    mockedLlm.mockRejectedValueOnce(new Error('llm boom'));

    const res = await runDocGenerate(makeConfig(), { all: true, app: 'specguard-core' });

    expect(res.failed).toBe(1);
    expect(res.created).toBe(1);
    const failedItem = res.items.find((i) => i.status === 'failed');
    expect(failedItem?.message).toContain('llm boom');
    expect(res.exitCode).toBe(0);
  });

  it('exit code is non-zero when every attempted spec fails', async () => {
    await writeSpec('specs/core/spec-parser.md');
    mockedLlm.mockRejectedValue(new Error('always boom'));

    const res = await runDocGenerate(makeConfig(), { spec: 'core/spec-parser' });

    expect(res.created).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.exitCode).not.toBe(0);
  });
});
