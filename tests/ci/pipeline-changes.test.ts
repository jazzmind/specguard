import { describe, expect, it } from 'vitest';

import { pipelineChanges } from '../../src/ci/pipeline-changes.js';

const f = (filename: string, status = 'modified', previous_filename?: string) => ({ filename, status, ...(previous_filename ? { previous_filename } : {}) });

describe('pipelineChanges [pipeline-changes]', () => {
  // [claims: capabilities/integration-surfaces#pipeline-change-detection]
  it('lists workflow, config, code owners and action files as warnings', () => {
    const out = pipelineChanges([
      f('src/cart.ts'),
      f('.github/workflows/specguard.yml'),
      f('.specguard/config.json'),
      f('.github/CODEOWNERS'),
      f('action.yml'),
      f('action/run-gates.mjs'),
      f('README.md'),
    ]);
    expect(out).toEqual([
      { file: '.github/CODEOWNERS', kind: 'codeowners', severity: 'warn' },
      { file: '.github/workflows/specguard.yml', kind: 'workflow', severity: 'warn' },
      { file: '.specguard/config.json', kind: 'specguard-config', severity: 'warn' },
      { file: 'action.yml', kind: 'action', severity: 'warn' },
      { file: 'action/run-gates.mjs', kind: 'action', severity: 'warn' },
    ]);
  });

  // [claims: capabilities/integration-surfaces#pipeline-change-detection]
  it('ignores ordinary files, including look-alikes', () => {
    expect(pipelineChanges([f('docs/workflows/notes.md'), f('.github/workflows/readme.md'), f('src/action.ts'), f('specs/capabilities/cart.md'), f('.specguard/ledger.json')])).toEqual([]);
    expect(pipelineChanges([])).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#pipeline-change-detection]
  it('deleting a pipeline file, or renaming it away, is an error; renaming one in is a warning', () => {
    const out = pipelineChanges([f('.github/workflows/old.yml', 'removed'), f('.github/workflows/new.yml', 'renamed', '.github/workflows/gate.yml'), f('.github/workflows/in.yml', 'renamed', 'ci/in.yml')]);
    expect(out).toEqual([
      { file: '.github/workflows/gate.yml', kind: 'workflow', severity: 'error' },
      { file: '.github/workflows/in.yml', kind: 'workflow', severity: 'warn' },
      { file: '.github/workflows/new.yml', kind: 'workflow', severity: 'warn' },
      { file: '.github/workflows/old.yml', kind: 'workflow', severity: 'error' },
    ]);
  });

  // [claims: capabilities/integration-surfaces#pipeline-change-detection]
  it('one entry per file, the error wins, order is by file name, and other CI systems count', () => {
    const out = pipelineChanges([f('./.github/workflows/a.yaml'), f('.github/workflows/a.yaml', 'removed'), f('Jenkinsfile'), f('.gitlab-ci.yml')]);
    expect(out.map((c) => [c.file, c.severity])).toEqual([
      ['.github/workflows/a.yaml', 'error'],
      ['.gitlab-ci.yml', 'warn'],
      ['Jenkinsfile', 'warn'],
    ]);
  });
});
