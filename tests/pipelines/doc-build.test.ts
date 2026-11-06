import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(),
  llmGenerateObject: vi.fn(),
  resolveTargets: vi.fn((o: { model: string }) => [{ provider: 'p', model: o.model }]),
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {},
}));

import { ExitCode } from '../../src/core/exit-codes.js';
import { loadConfig } from '../../src/core/config.js';
import { llmGenerateText } from '../../src/core/llm.js';
import { docsCheckLines, runDocBuild } from '../../src/pipelines/doc-build.js';
import { makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const llm = llmGenerateText as unknown as ReturnType<typeof vi.fn>;
let repo: TmpRepo;

const QUICK = `---
id: try-it
kind: journey
title: "Try it"
audience: user
order: 1
useCase: Try the thing quickly.
related:
  - auth
---

# Try it

## Goal
Do it.

## Steps
### Run the check
\`\`\`bash
specguard check
\`\`\`

## Outcome
Done.

## Help Topics
- \`dashboard.try\` → Run the check: Runs the check for you.
- \`dashboard.auth\` → What to expect: Auth behavior.
`;

const DEVG = QUICK.replace('id: try-it', 'id: inside').replace('audience: user', 'audience: dev').replace('# Try it', '# Inside').replace(/useCase:.*\n/, '').replace(/## Help Topics[\s\S]*/, '');

async function build(opts: { noLlm?: boolean; check?: boolean; out?: string } = {}) {
  return runDocBuild(await loadConfig(repo.dir), opts);
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const f = path.join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else out[path.relative(dir, f)] = readFileSync(f, 'utf8');
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  llm.mockReset();
  repo = makeV2Repo();
  repo.write('specs/guides/try-it.md', QUICK);
  repo.write('specs/guides/inside.md', DEVG);
  // The capability carries a topic that points at a stable reference heading.
  const auth = readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8');
  repo.write('specs/capabilities/auth.md', `${auth}\n## Help Topics\n- \`dashboard.auth\` → What to expect: Auth behavior.\n`);
  repo.write('specs/guides/try-it.md', QUICK.replace(/- `dashboard.auth`.*\n/, ''));
});

describe('docs build [doc-set-build]', () => {
  // [claims: capabilities/documentation-api#doc-set-build]
  it('writes guides, reference pages for both audiences, index, manifest and help topics', async () => {
    const r = await build({ noLlm: true });
    expect(r.exitCode).toBe(ExitCode.Success);
    const d = path.join(repo.dir, 'docs');
    for (const f of ['guide/try-it.md', 'dev/inside.md', 'guide/reference/auth.md', 'dev/reference/auth.md', 'guide/reference/shop.md', 'dev/reference/shop.md', 'index.md', 'manifest.json', 'help-topics.json']) {
      expect(existsSync(path.join(d, f)), f).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(1);
    const page = manifest.pages.find((p: { id: string }) => p.id === 'try-it');
    expect(page).toMatchObject({ title: 'Try it', audience: 'user', group: 'Quickstarts', file: 'guide/try-it.md' });
    expect(page.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(page.sections.map((s: { anchor: string }) => s.anchor)).toEqual(['goal', 'steps', 'run-the-check', 'outcome', 'reference-pages']);
    expect(manifest.pages.find((p: { file: string }) => p.file === 'dev/inside.md').group).toBe('Developer');
    expect(manifest.pages.find((p: { file: string }) => p.file === 'guide/reference/auth.md').group).toBe('Reference');
    const index = readFileSync(path.join(d, 'index.md'), 'utf8');
    expect(index.indexOf('## Quickstarts')).toBeLessThan(index.indexOf('## Reference'));
    expect(index.indexOf('## Reference')).toBeLessThan(index.indexOf('## Developer'));
    expect(index).toContain('(guide/try-it.md)');
    expect(readFileSync(path.join(d, 'guide/try-it.md'), 'utf8')).toContain('[Auth](./reference/auth.md)');
    expect(llm).not.toHaveBeenCalled();
  });

  // [claims: capabilities/documentation-api#help-topics-from-specs]
  it('resolves help topics to the page and anchor of the section', async () => {
    await build({ noLlm: true });
    const topics = JSON.parse(readFileSync(path.join(repo.dir, 'docs/help-topics.json'), 'utf8'));
    expect(topics['dashboard.try']).toEqual({ title: 'Run the check', text: 'Runs the check for you.', page: 'guide/try-it.md', anchor: 'run-the-check' });
    expect(topics['dashboard.auth']).toMatchObject({ page: 'guide/reference/auth.md', anchor: 'what-to-expect' });
  });

  // [claims: capabilities/documentation-api#help-topics-from-specs]
  it('points a topic whose section is missing at the top of the page', async () => {
    repo.write('specs/guides/try-it.md', QUICK.replace('Run the check: Runs', 'Gone: Runs').replace(/- `dashboard.auth`.*\n/, ''));
    const r = await build({ noLlm: true });
    const topics = JSON.parse(readFileSync(path.join(repo.dir, 'docs/help-topics.json'), 'utf8'));
    expect(topics['dashboard.try'].anchor).toBe('try-it');
    expect(r.messages.join('\n')).toContain('dashboard.try');
  });

  // [claims: capabilities/documentation-api#doc-anchors-stable]
  it('anchors every heading of generated pages', async () => {
    await build({ noLlm: true });
    const page = readFileSync(path.join(repo.dir, 'docs/guide/reference/auth.md'), 'utf8');
    for (const m of page.matchAll(/^(#{1,4}) (.+)$/gm)) {
      expect(page).toMatch(new RegExp(`<a id="[a-z0-9-]+"></a>\\n${m[1]} ${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });
});

describe('determinism [doc-build-deterministic]', () => {
  // [claims: capabilities/documentation-api#doc-build-deterministic]
  it('two --no-llm builds produce byte-identical files', async () => {
    await build({ noLlm: true, out: 'out-a' });
    await build({ noLlm: true, out: 'out-b' });
    const a = snapshot(path.join(repo.dir, 'out-a'));
    const b = snapshot(path.join(repo.dir, 'out-b'));
    expect(Object.keys(a).length).toBeGreaterThan(8);
    expect(b).toEqual(a);
    const again = await build({ noLlm: true, out: 'out-a' });
    expect(again.created).toBe(0);
    expect(snapshot(path.join(repo.dir, 'out-a'))).toEqual(a);
  });

  // [claims: capabilities/documentation-api#doc-build-deterministic]
  it('asks the model only for pages whose spec changed, and keeps a polished page otherwise', async () => {
    llm.mockResolvedValue('# Polished\n\n## Why it exists\nWritten by a model.\n');
    const config = await loadConfig(repo.dir);
    config.llm = { ...config.llm, provider: 'anthropic', model: 'm', apiKeyEnv: 'K' } as typeof config.llm;
    const first = await runDocBuild(config, {});
    expect(first.exitCode).toBe(ExitCode.Success);
    const calls = llm.mock.calls.length;
    expect(calls).toBe(4); // two capabilities, two audiences
    const page = readFileSync(path.join(repo.dir, 'docs/guide/reference/auth.md'), 'utf8');
    expect(page).toContain('Written by a model.');
    expect(page).toContain('<a id="why-it-exists"></a>');
    expect(JSON.parse(readFileSync(path.join(repo.dir, 'docs/manifest.json'), 'utf8')).pages.find((p: { file: string }) => p.file === 'guide/reference/auth.md').generator).toBe('llm');

    await runDocBuild(config, {});
    expect(llm.mock.calls.length).toBe(calls);

    // a deterministic rebuild never downgrades a polished page whose spec is unchanged
    await runDocBuild(await loadConfig(repo.dir), { noLlm: true });
    expect(readFileSync(path.join(repo.dir, 'docs/guide/reference/auth.md'), 'utf8')).toBe(page);

    // editing one spec regenerates only its two pages
    const auth = path.join(repo.dir, 'specs/capabilities/auth.md');
    writeFileSync(auth, `${readFileSync(auth, 'utf8')}\nMore.\n`);
    await runDocBuild(config, {});
    expect(llm.mock.calls.length).toBe(calls + 2);
  });

  // [claims: capabilities/documentation-api#doc-build-deterministic]
  it('falls back to the spec when the model is unavailable', async () => {
    llm.mockRejectedValue(new Error('boom'));
    const config = await loadConfig(repo.dir);
    config.llm = { ...config.llm, provider: 'anthropic', model: 'm', apiKeyEnv: 'K' } as typeof config.llm;
    const r = await runDocBuild(config, {});
    expect(r.exitCode).toBe(ExitCode.Success);
    expect(r.messages.join('\n')).toContain('model unavailable');
    expect(readFileSync(path.join(repo.dir, 'docs/guide/reference/auth.md'), 'utf8')).toContain('## What to expect');
  });
});

describe('freshness [docs-freshness-check]', () => {
  // [claims: capabilities/documentation-api#docs-freshness-check]
  it('passes on a fresh build, names stale pages after a spec edit, and calls no model or writes', async () => {
    await build({ noLlm: true });
    const fresh = await build({ check: true });
    expect(fresh.exitCode).toBe(ExitCode.Success);

    const auth = path.join(repo.dir, 'specs/capabilities/auth.md');
    writeFileSync(auth, `${readFileSync(auth, 'utf8')}\nMore.\n`);
    writeFileSync(path.join(repo.dir, 'specs/guides/try-it.md'), `${QUICK.replace(/- `dashboard.auth`.*\n/, '')}\nExtra paragraph.\n`);
    const before = snapshot(path.join(repo.dir, 'docs'));
    const stale = await build({ check: true });
    expect(stale.exitCode).toBe(ExitCode.DriftDetected);
    const text = stale.messages.join('\n');
    expect(text).toContain('guide/reference/auth.md (its spec changed)');
    expect(text).toContain('dev/reference/auth.md');
    expect(text).toContain('guide/try-it.md');
    expect(text).not.toContain('guide/reference/shop.md');
    expect(snapshot(path.join(repo.dir, 'docs'))).toEqual(before);
    expect(llm).not.toHaveBeenCalled();
  });

  // [claims: capabilities/documentation-api#docs-freshness-check]
  it('reports a missing page and a missing manifest', async () => {
    const r = await build({ check: true });
    expect(r.exitCode).toBe(ExitCode.DriftDetected);
    expect(r.messages.join('\n')).toContain('manifest.json (missing)');
  });

  // [claims: capabilities/documentation-api#docs-freshness-check]
  it('makes check warn docs-stale only once a manifest exists and a page is older than its spec', async () => {
    const config = await loadConfig(repo.dir);
    expect((await docsCheckLines(config)).join('\n')).not.toContain('docs-stale');
    await build({ noLlm: true });
    expect((await docsCheckLines(config)).join('\n')).not.toContain('docs-stale');
    const auth = path.join(repo.dir, 'specs/capabilities/auth.md');
    writeFileSync(auth, `${readFileSync(auth, 'utf8')}\nMore.\n`);
    expect((await docsCheckLines(config)).join('\n')).toContain('[warn] docs-stale');
  });
});

describe('guide checks in check [guide-validation]', () => {
  // [claims: capabilities/documentation-api#guide-validation]
  it('reports unknown commands, related ids and help anchors as warnings', async () => {
    repo.write('specs/guides/try-it.md', QUICK.replace('specguard check', 'specguard frobnicate').replace('- auth', '- ghost').replace('Run the check: Runs', 'Nowhere: Runs'));
    const lines = await docsCheckLines(await loadConfig(repo.dir), { name: 'specguard', takesArgs: false, subs: [{ name: 'check', takesArgs: false, subs: [] }] });
    const text = lines.join('\n');
    expect(text).toContain('guide-unknown-command');
    expect(text).toContain('guide-unknown-related');
    expect(text).toContain('help-unknown-anchor');
    expect(lines.every((l) => l.startsWith('  [warn]'))).toBe(true);
  });
});

describe('docs command wiring [doc-set-build]', () => {
  // [claims: capabilities/documentation-api#doc-set-build]
  it('keeps the legacy docs options and adds `docs build` with --no-llm, --check and --out', async () => {
    const { buildProgram } = await import('../../src/cli/index.js');
    const docs = buildProgram().commands.find((c) => c.name() === 'docs')!;
    expect(docs.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--spec', '--all', '--out', '--app']));
    const build = docs.commands.find((c) => c.name() === 'build')!;
    expect(build.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--no-llm', '--check', '--out']));
  });
});

describe("SpecGuard's own guides [guide-validation]", () => {
  // [claims: capabilities/documentation-api#guide-validation]
  it('name only real commands and capabilities, define each help key once, and point at real sections', async () => {
    const { buildProgram } = await import('../../src/cli/index.js');
    const { commandTree } = await import('../../src/core/guides.js');
    const root = path.resolve(import.meta.dirname, '..', '..');
    const lines = await docsCheckLines(await loadConfig(root), commandTree(buildProgram()));
    expect(lines.filter((l) => !l.includes('docs-stale'))).toEqual([]);
  });

  // [claims: capabilities/documentation-api#help-topics-from-specs]
  it('define every help key the dashboards use', () => {
    const topics = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', '..', 'docs/help-topics.json'), 'utf8')) as Record<string, { page: string; anchor: string; text: string }>;
    const keys = ['workspace.status', 'workspace.drift', 'workspace.contracts', 'workspace.settings', 'workspace.teamServer', 'workspace.repos', 'dashboard.overview', 'dashboard.coverage', 'dashboard.flow', 'dashboard.plans', 'dashboard.findings', 'dashboard.activity', 'dashboard.docs', 'dashboard.specs', 'dashboard.tests', 'dashboard.traceability', 'dashboard.settings', 'sidebar.coverage', 'sidebar.pipelines', 'sidebar.plugins'];
    for (const k of keys) expect(topics[k], k).toBeTruthy();
    for (const t of Object.values(topics)) {
      expect(t.text.length).toBeGreaterThan(10);
      expect(t.anchor).not.toBe('');
    }
  });
});

describe('committed documentation set [doc-set-build]', () => {
  // [claims: capabilities/documentation-api#doc-set-build]
  it('has no broken relative link or anchor', () => {
    const docs = path.resolve(import.meta.dirname, '..', '..', 'docs');
    const files: string[] = [path.join(docs, 'index.md')];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const f = path.join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else if (f.endsWith('.md')) files.push(f);
      }
    };
    walk(path.join(docs, 'guide'));
    walk(path.join(docs, 'dev'));
    const anchors = new Map(files.map((f) => [f, new Set([...readFileSync(f, 'utf8').matchAll(/<a id="([^"]+)">/g)].map((m) => m[1]))]));
    const broken: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (m[1].startsWith('http')) continue;
        const [p, a] = m[1].split('#');
        const target = p ? path.normalize(path.join(path.dirname(f), p)) : f;
        if (!existsSync(target)) broken.push(`${path.relative(docs, f)} -> ${m[1]}`);
        else if (a && !anchors.get(target)?.has(a)) broken.push(`${path.relative(docs, f)} -> ${m[1]} (anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
