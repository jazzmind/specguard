import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({
  llmGenerateText: vi.fn(async () => ''),
  llmGenerateObject: vi.fn(),
  resolveTargets: vi.fn((o: { model: string }) => [{ provider: 'p', model: o.model }]),
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {},
}));

import { llmGenerateObject } from '../../src/core/llm.js';
import { loadContractGraph } from '../../src/core/contracts.js';
import { loadWorkspaceWithConfigs } from '../../src/core/workspace.js';
import { runContracts } from '../../src/pipelines/contracts.js';
import { mappingImporter, plugin } from '../../src/plugins/contract-mappings/index.js';
import { runContractsMap } from '../../src/plugins/contract-mappings/map.js';
import { mergeMappings, type Suggestion } from '../../src/plugins/contract-mappings/merge.js';

const llm = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

const CONFIG = JSON.stringify({
  apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }],
  llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' },
  plugins: ['contract-mappings'],
});

const spec = (title: string, overview: string, extra = '') =>
  `# ${title}\n\n<!-- module: src/x.ts / type: core / status: draft -->\n\n## Overview\n\n${overview}\n\n${extra}## Scenarios\n\n### Scenario 1: x\n**Steps:**\n1. y\n\n**Expected Results:**\n- z\n`;

interface Fixture {
  ws: string;
  write: (rel: string, text: string) => void;
  read: (rel: string) => string;
  exists: (rel: string) => boolean;
}

/** web (consumer), api and payments (providers), siblings of the workspace folder. */
function fixture(files: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-cmap-'));
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  write('ws/.specguard/workspace.json', JSON.stringify({ version: '1', name: 'ws', repos: { web: { path: '../web', role: 'consumer' }, api: { path: '../api', role: 'provider' }, payments: { path: '../payments', role: 'provider' } } }));
  for (const repo of ['web', 'api', 'payments']) write(`${repo}/.specguard/config.json`, CONFIG);
  write('api/specs/capabilities/orders.md', spec('Order Service', 'Creates and lists orders.', '## Problem & Value\n\nCustomers place orders. More text.\n\n'));
  write('payments/specs/billing.md', spec('Payment Gateway', 'Takes card payments.'));
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return { ws: path.join(dir, 'ws'), write, read: (rel) => readFileSync(path.join(dir, rel), 'utf8'), exists: (rel) => existsSync(path.join(dir, rel)) };
}

const MAP = 'web/.specguard/contract-mappings.json';
const json = (f: Fixture, rel = MAP) => JSON.parse(f.read(rel)) as { mappings: Array<Record<string, unknown>> };
const out = (r: { messages: string[] }) => r.messages.join('\n');

beforeEach(() => llm.mockReset());

describe('contracts-map from spec text [contracts-map-spec-text]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-spec-text]
  it('scores references 0.95 / 0.9 / 0.8 / 0.7, keeps the evidence sentence and writes provider paths relative to the consumer repo', async () => {
    const f = fixture({
      'web/specs/ref.md': spec('Ref', 'The page loads data from api::specs/capabilities/orders.md for display.'),
      'web/specs/path.md': spec('Path', 'It depends on specs/capabilities/orders.md for display.'),
      'web/specs/key.md': spec('Key', 'It relies on `capabilities/orders` for display.'),
      'web/specs/title.md': spec('Title', 'First line.\n\nCheckout shows the Payment Gateway result, in any case.'),
      'web/specs/none.md': spec('None', 'Standalone page with no backend.'),
    });
    const res = await runContractsMap({ workspace: f.ws }, f.ws);
    expect(res.exitCode).toBe(0);
    const byspec = Object.fromEntries(json(f).mappings.map((m) => [m.spec as string, m]));
    const top = (s: string) => (byspec[s].suggestions as Suggestion[])[0];
    expect(top('specs/ref.md')).toMatchObject({ provider: '../api/specs/capabilities/orders.md', source: 'spec-text', confidence: 0.95 });
    expect(top('specs/path.md').confidence).toBe(0.9);
    expect(top('specs/key.md').confidence).toBe(0.8);
    expect(top('specs/title.md')).toMatchObject({ provider: '../payments/specs/billing.md', confidence: 0.7 });
    expect(top('specs/title.md').evidence).toContain('Payment Gateway');
    expect(byspec['specs/title.md']).toMatchObject({ generated: true, providers: ['../payments/specs/billing.md'] });
    expect(byspec['specs/none.md']).toBeUndefined();
    expect(out(res)).toMatch(/web: 4 added, 0 kept, 0 removed; 1 of 5 spec\(s\) had no match/);
    expect(out(res)).toContain('Hint:');

    // The written paths resolve to real nodes: the graph gets the edges.
    const { manifest, repos } = await loadWorkspaceWithConfigs(f.ws);
    await runContracts(manifest, repos, { force: true });
    const graph = await loadContractGraph(manifest.rootDir);
    expect(graph!.edges.map((e) => `${e.consumer} -> ${e.provider}`)).toContain('web::specs/title.md -> payments::specs/billing.md');
  });

  // [claims: capabilities/integration-surfaces#contracts-map-spec-text]
  it('ignores a one-word title and honours --min-confidence and --repo', async () => {
    const f = fixture({ 'web/specs/a.md': spec('A', 'Shows the Billing summary. Also uses the Payment Gateway.') });
    f.write('payments/specs/billing.md', spec('Billing', 'x'));
    await runContractsMap({ workspace: f.ws, minConfidence: 0.8 }, f.ws);
    expect(f.exists(MAP)).toBe(false); // 0.7 title match is below the bar; the one-word title never matches
    await runContractsMap({ workspace: f.ws, repo: 'api' }, f.ws);
    expect(f.exists(MAP)).toBe(false);
  });
});

describe('contracts-map merge [contracts-map-merge]', () => {
  const keys = { list: 'mappings', spec: 'spec', providers: 'providers' };
  const s = (provider: string): Suggestion => ({ provider, source: 'spec-text', confidence: 0.9, reason: 'r', evidence: 'e' });
  const generated = (spec: string, providers: string[], extra: Record<string, unknown> = {}) => ({ spec, providers, generated: true, suggestions: providers.map(s), ...extra });

  // [claims: capabilities/integration-surfaces#contracts-map-merge]
  it('leaves manual entries alone, flips hand-edited generated entries, keeps pinned, removes the rest and lists them', () => {
    const existing = {
      other: 'kept',
      mappings: [
        { spec: 'm.md', providers: ['../x.md'] },
        generated('edited.md', ['../a.md', '../hand-added.md']).valueOf() && { ...generated('edited.md', ['../a.md']), providers: ['../a.md', '../hand-added.md'] },
        generated('pinned.md', ['../p.md'], { pinned: true }),
        generated('gone.md', ['../g.md']),
        generated('same.md', ['../s.md']),
      ],
    };
    const merged = mergeMappings(existing, [
      { spec: 'm.md', suggestions: [s('../should-not-replace.md')] },
      { spec: 'same.md', suggestions: [s('../s.md')] },
      { spec: 'new.md', suggestions: [s('../n.md')] },
    ], keys);
    expect(merged.added).toEqual(['new.md']);
    expect(merged.removed).toEqual(['gone.md']);
    expect(merged.flipped).toEqual(['edited.md']);
    expect(merged.kept.sort()).toEqual(['edited.md', 'm.md', 'pinned.md', 'same.md']);
    const list = merged.file.mappings as Array<Record<string, unknown>>;
    expect(list.find((e) => e.spec === 'm.md')).toEqual({ spec: 'm.md', providers: ['../x.md'] });
    expect(list.find((e) => e.spec === 'edited.md')!.generated).toBeUndefined();
    expect((list.find((e) => e.spec === 'edited.md')!.providers as string[])).toContain('../hand-added.md');
    expect(list.find((e) => e.spec === 'pinned.md')!.pinned).toBe(true);
    expect(list.some((e) => e.spec === 'gone.md')).toBe(false);
    expect(merged.file.other).toBe('kept');
  });

  // [claims: capabilities/integration-surfaces#contracts-map-merge]
  it('is idempotent on files, reports Removed: when a reference disappears, and respects the contractMappings key names', async () => {
    const f = fixture({ 'web/specs/t.md': spec('T', 'Shows the Payment Gateway.'), 'web/specs/manual.md': spec('M', 'Standalone.') });
    f.write(MAP, JSON.stringify({ mappings: [{ spec: 'specs/manual.md', providers: ['../api/specs/capabilities/orders.md'] }] }));
    await runContractsMap({ workspace: f.ws }, f.ws);
    const first = f.read(MAP);
    const second = await runContractsMap({ workspace: f.ws }, f.ws);
    expect(f.read(MAP)).toBe(first);
    expect(out(second)).toMatch(/web: 0 added, 2 kept, 0 removed/);
    expect(json(f).mappings[0]).toEqual({ spec: 'specs/manual.md', providers: ['../api/specs/capabilities/orders.md'] });

    f.write('web/specs/t.md', spec('T', 'Standalone now.'));
    const third = await runContractsMap({ workspace: f.ws }, f.ws);
    expect(out(third)).toMatch(/Removed:\n\s+specs\/t\.md/);
    expect(json(f).mappings.map((m) => m.spec)).toEqual(['specs/manual.md']);

    // Another tool's key names.
    f.write('web/.specguard/config.json', JSON.stringify({ ...JSON.parse(CONFIG), contractMappings: { file: 'deps.json', list: 'links', spec: 'consumer', providers: ['needs'] } }));
    f.write('web/specs/t.md', spec('T', 'Shows the Payment Gateway.'));
    await runContractsMap({ workspace: f.ws }, f.ws);
    const custom = JSON.parse(f.read('web/deps.json')) as { links: Array<Record<string, unknown>> };
    expect(custom.links[0]).toMatchObject({ consumer: 'specs/t.md', needs: ['../payments/specs/billing.md'], generated: true });
  });

  // [claims: capabilities/integration-surfaces#contracts-map-merge]
  it('leaves a file that is not a JSON object untouched', async () => {
    const f = fixture({ 'web/specs/t.md': spec('T', 'Shows the Payment Gateway.') });
    f.write(MAP, '[1,2');
    const res = await runContractsMap({ workspace: f.ws }, f.ws);
    expect(f.read(MAP)).toBe('[1,2');
    expect(out(res)).toContain('left untouched');
  });
});

describe('contracts-map --dry-run [contracts-map-dry-run]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-dry-run]
  it('prints the proposal and writes nothing', async () => {
    const f = fixture({ 'web/specs/t.md': spec('T', 'Shows the Payment Gateway.') });
    const res = await runContractsMap({ workspace: f.ws, dryRun: true }, f.ws);
    expect(f.exists(MAP)).toBe(false);
    expect(out(res)).toContain('+ specs/t.md -> ../payments/specs/billing.md (spec-text 0.7)');
    expect(out(res)).toContain('[dry-run]');
  });
});

describe('the importer reads what contracts-map writes [contract-importer-ignores-extra-fields]', () => {
  // [claims: capabilities/integration-surfaces#contract-importer-ignores-extra-fields]
  it('gives the same edges with and without the generated, pinned and suggestions fields', () => {
    const f = fixture();
    const manifest = { rootDir: f.ws, repos: { web: { path: '../web' }, api: { path: '../api' } } };
    const repo = { key: 'web', absPath: path.resolve(f.ws, '../web') };
    const plain = { mappings: [{ spec: 'specs/a.md', providers: ['../api/specs/capabilities/orders.md'] }] };
    const rich = {
      version: 2,
      mappings: [{
        spec: 'specs/a.md',
        providers: ['../api/specs/capabilities/orders.md'],
        generated: true,
        pinned: true,
        confidence: 0.9,
        reason: 'r',
        evidence: 'e',
        source: 'code',
        suggestions: [{ provider: '../api/specs/capabilities/orders.md', source: 'code', confidence: 0.9, reason: 'r', evidence: 'e' }],
      }],
    };
    f.write(MAP, JSON.stringify(plain));
    const a = mappingImporter.read(repo, manifest);
    f.write(MAP, JSON.stringify(rich));
    expect(mappingImporter.read(repo, manifest)).toEqual(a);
    expect(a).toHaveLength(1);
  });
});

describe('contracts-map --with-llm [contracts-map-llm-catalogue-only]', () => {
  const web = {
    'web/specs/matched.md': spec('Matched', 'Shows the Payment Gateway.'),
    'web/specs/open.md': spec('Open', 'Lists things.', '## Notes\n\nKey sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 here.\n\n'),
  };

  // [claims: capabilities/integration-surfaces#contracts-map-llm-catalogue-only]
  it('asks only about unmatched specs, sends their redacted body and the catalogue, and rejects ids outside it', async () => {
    const f = fixture({ ...web, 'web/specs/open.md': `---\nfm: SECRET-FRONTMATTER\n---\n${web['web/specs/open.md']}` });
    llm.mockResolvedValue({ picks: [{ providerId: 1, reason: 'lists orders', confidence: 0.8 }, { providerId: 99, reason: 'invented', confidence: 0.9 }, { providerId: 'elsewhere::x.md', reason: 'invented', confidence: 0.9 }] });
    const res = await runContractsMap({ workspace: f.ws, withLlm: true }, f.ws);
    expect(llm).toHaveBeenCalledTimes(1);
    const prompt = (llm.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('Lists things.');
    expect(prompt).not.toContain('Payment Gateway result'); // the matched spec's text stays home
    expect(prompt).not.toContain('SECRET-FRONTMATTER');
    expect(prompt).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
    expect(prompt).toContain('1. Order Service (api::specs/capabilities/orders.md): Customers place orders.');
    expect(prompt).not.toContain('Creates and lists orders.'); // catalogue lines carry summaries, not whole specs
    const open = json(f).mappings.find((m) => m.spec === 'specs/open.md')!;
    expect(open.providers).toEqual(['../api/specs/capabilities/orders.md']);
    expect((open.suggestions as Suggestion[])[0]).toMatchObject({ source: 'llm', confidence: 0.8, reason: 'lists orders' });
    expect(out(res)).toContain('[reject] web::specs/open.md: the model named "99", which is not in the catalogue');
    expect(out(res)).toContain('"elsewhere::x.md"');
  });

  // [claims: capabilities/integration-surfaces#contracts-map-llm-catalogue-only]
  it('asks about every spec with --all-specs and never without --with-llm', async () => {
    const f = fixture(web);
    llm.mockResolvedValue({ picks: [] });
    await runContractsMap({ workspace: f.ws }, f.ws);
    expect(llm).not.toHaveBeenCalled();
    await runContractsMap({ workspace: f.ws, withLlm: true, allSpecs: true }, f.ws);
    expect(llm).toHaveBeenCalledTimes(2);
  });
});

describe('contracts-map --with-llm egress [contracts-map-llm-egress-notice]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-llm-egress-notice]
  it('names provider and model, lists each spec and stops at --max-llm-specs, naming those not sent', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i += 1) files[`web/specs/s${i}.md`] = spec(`S${i}`, `Page ${i}.`);
    const f = fixture(files);
    llm.mockResolvedValue({ picks: [] });
    const res = await runContractsMap({ workspace: f.ws, withLlm: true, maxLlmSpecs: 2 }, f.ws);
    expect(llm).toHaveBeenCalledTimes(2);
    const text = out(res);
    expect(text).toContain('anthropic/m');
    expect(text).toContain('at most 2 item(s) (--max-llm-specs)');
    expect(text.match(/\[send\] web::/g)).toHaveLength(2);
    expect(text.match(/\[cap\] web::/g)).toHaveLength(2);
    expect(text.indexOf('model pass')).toBeLessThan(text.indexOf('[send]'));
  });

  // [claims: capabilities/integration-surfaces#contracts-map-llm-egress-notice]
  it('defaults the cap to 50 specs', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 52; i += 1) files[`web/specs/s${i}.md`] = spec(`S${i}`, `Page ${i}.`);
    const f = fixture(files);
    llm.mockResolvedValue({ picks: [] });
    const res = await runContractsMap({ workspace: f.ws, withLlm: true }, f.ws);
    expect(llm).toHaveBeenCalledTimes(50);
    expect(out(res).match(/\[cap\] web::/g)).toHaveLength(2);
  });
});

// Code-mode fixtures: web calls the API, api defines it, specs own the files.
const owned = (id: string, sources: string[], body = 'Does things.') =>
  `---\nid: ${id}\nkind: capability\nparent: system\nvalue: v\nsources:\n${sources.map((s) => `  - "${s}"`).join('\n')}\n---\n# ${id}\n\n## Problem & Value\n\n${body}\n`;

function codeFixture(): Fixture {
  return fixture({
    'web/specs/orders-ui.md': owned('orders-ui', ['src/orders.service.ts'], 'Orders screen.'),
    'web/specs/lonely-ui.md': owned('lonely-ui', ['src/lonely.ts'], 'No backend text here.'),
    'web/src/orders.service.ts': "export class S { list() { return this.http.get<Order[]>(this.cfg.api + '/orders'); } get(id) { return this.http.get(`/orders/${id}`); } }\n",
    'web/src/orphan.ts': "fetch('/orders');\n",
    'web/src/lonely.ts': "fetch('/nothing-defined-here');\n",
    'api/specs/capabilities/order-api.md': owned('order-api', ['src/OrderController.java'], 'Order endpoints.'),
    'api/src/OrderController.java': '@RestController\n@RequestMapping("/api/orders")\nclass OrderController {\n  @GetMapping\n  void list() {}\n  @GetMapping("/{id}")\n  void get() {}\n}\n',
  });
}

describe('contracts-map --with-code [contracts-map-code-ownership]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-code-ownership]
  it('maps a call site to the spec owning its file and a definition to the spec owning its file, with file:line evidence', async () => {
    const f = codeFixture();
    const res = await runContractsMap({ workspace: f.ws, withCode: true }, f.ws);
    const byspec = Object.fromEntries(json(f).mappings.map((m) => [m.spec as string, m]));
    const sug = (byspec['specs/orders-ui.md'].suggestions as Suggestion[]).find((s) => s.source === 'code')!;
    expect(sug.provider).toBe('../api/specs/capabilities/order-api.md');
    expect(sug.confidence).toBe(0.9);
    expect(sug.evidence).toBe('src/orders.service.ts:1 GET /orders/{}');
    // A file no spec owns proposes nothing, and a call with no definition either.
    expect(Object.keys(byspec)).toEqual(['specs/orders-ui.md']);
    expect(out(res)).toContain('1 of 2 spec(s) had no match');
  });

  // [claims: capabilities/integration-surfaces#contracts-map-code-ownership]
  it('falls back to a v1 spec module path when no graph owns the file', async () => {
    const f = fixture({
      'web/specs/v1.md': spec('Legacy Page', 'Plain.').replace('module: src/x.ts', 'module: src/legacy/'),
      'web/src/legacy/page.ts': "fetch('/api/orders');\n",
      'api/specs/capabilities/order-api.md': owned('order-api', ['src/OrderController.java']),
      'api/src/OrderController.java': '@RequestMapping("/orders")\nclass C {\n  @GetMapping\n  void list() {}\n}\n',
    });
    await runContractsMap({ workspace: f.ws, withCode: true }, f.ws);
    expect(json(f).mappings[0]).toMatchObject({ spec: 'specs/v1.md', providers: ['../api/specs/capabilities/order-api.md'] });
  });
});

describe('contracts-map --assess [contracts-map-assess]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-assess]
  it('reports the share of unmatched specs, call sites by kind and provider definitions, writes nothing and uses no model', async () => {
    const f = codeFixture();
    const res = await runContractsMap({ workspace: f.ws, assess: true }, f.ws);
    expect(f.exists(MAP)).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    const text = out(res);
    expect(text).toContain('web: 2 consumer spec(s), 2 (100%) with no spec-text match');
    expect(text).toMatch(/call sites found: 4; named in spec text: 0; in files no spec owns: 1; in owned files but not named in spec text: 3/);
    expect(text).toContain('Provider endpoint definitions: api 2, payments 0');
    // 100% unmatched but only 3 call sites a spec could gain from: below the bar of 5.
    expect(text).toContain('Recommendation: spec text is sufficient');
  });

  // [claims: capabilities/integration-surfaces#contracts-map-assess]
  it('recommends "code likely helps" with enough unmatched specs and uncovered call sites, and "code won\'t help" with no definitions', async () => {
    const calls = Array.from({ length: 6 }, (_, i) => `fetch('/orders/${i}x');`).join('\n');
    const f = fixture({
      'web/specs/ui.md': owned('ui', ['src/ui.ts'], 'Screen.'),
      'web/src/ui.ts': `${calls}\n`,
      'api/specs/capabilities/order-api.md': owned('order-api', ['src/OrderController.java']),
      'api/src/OrderController.java': '@RequestMapping("/orders")\nclass C {\n  @GetMapping("/{id}")\n  void get() {}\n}\n',
    });
    expect(out(await runContractsMap({ workspace: f.ws, assess: true }, f.ws))).toContain('Recommendation: code likely helps');
    const g = fixture({ 'web/specs/ui.md': owned('ui', ['src/ui.ts'], 'Screen.'), 'web/src/ui.ts': `${calls}\n` });
    expect(out(await runContractsMap({ workspace: g.ws, assess: true }, g.ws))).toContain("Recommendation: code won't help: no provider endpoint definitions found");
    // Plain runs print a one-line hint instead.
    expect(out(await runContractsMap({ workspace: g.ws, dryRun: true }, g.ws))).toContain('Hint: 1 of 1 spec(s) (100%) have no spec-text match');
  });

  // [claims: capabilities/integration-surfaces#contracts-map-assess]
  it('refuses to combine --assess with a model flag', async () => {
    const f = fixture();
    const res = await runContractsMap({ workspace: f.ws, assess: true, withLlm: true }, f.ws);
    expect(res.exitCode).not.toBe(0);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe('code is sent only when asked twice [contracts-map-code-egress-opt-in]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-code-egress-opt-in]
  it('--send-code without --with-llm is refused, and --with-code alone sends nothing', async () => {
    const f = codeFixture();
    llm.mockResolvedValue({ picks: [] });
    const refused = await runContractsMap({ workspace: f.ws, withCode: true, sendCode: true }, f.ws);
    expect(refused.exitCode).not.toBe(0);
    expect(out(refused)).toContain('--send-code requires --with-llm');
    await runContractsMap({ workspace: f.ws, withCode: true }, f.ws);
    expect(llm).not.toHaveBeenCalled();
  });

  // [claims: capabilities/integration-surfaces#contracts-map-code-egress-opt-in]
  it('sends +-15 line excerpts of unmatched call sites with the endpoint list, skips files that look secret, and says so first', async () => {
    const filler = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`);
    const body = [...filler.slice(0, 20), "fetch('/unmatched/thing');", ...filler.slice(20)].join('\n');
    const f = fixture({
      'web/specs/ui.md': owned('ui', ['src/ui.ts', 'src/leaky.ts']),
      'web/src/ui.ts': `${body}\n`,
      'web/src/leaky.ts': "const k = process.env.KEY;\nfetch('/also/unmatched');\n",
      'api/specs/capabilities/order-api.md': owned('order-api', ['src/OrderController.java']),
      'api/src/OrderController.java': '@RequestMapping("/orders")\nclass C {\n  @GetMapping\n  void list() {}\n}\n',
    });
    llm.mockResolvedValue({ picks: [{ providerId: 1, reason: 'order endpoints', confidence: 0.8 }] });
    const res = await runContractsMap({ workspace: f.ws, withCode: true, withLlm: true, sendCode: true }, f.ws);
    const text = out(res);
    expect(text).toContain('code pass');
    expect(text).toContain('[send] web::src/ui.ts');
    expect(text).toContain('[skip] web::src/leaky.ts: looks like it holds a secret');
    expect(text.indexOf('code pass')).toBeLessThan(text.indexOf('[skip]'));
    const prompts = llm.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);
    const codePrompt = prompts.find((p) => p.includes('unmatched/thing'))!;
    expect(codePrompt).toContain('6: // line 6');
    expect(codePrompt).not.toContain('5: // line 5');
    expect(codePrompt).toContain('36: ');
    expect(codePrompt).not.toContain('37: ');
    expect(codePrompt).toContain('GET /orders (api::specs/capabilities/order-api.md)');
    expect(prompts.some((p) => p.includes('process.env'))).toBe(false);
    expect(json(f).mappings[0]).toMatchObject({ spec: 'specs/ui.md', providers: ['../api/specs/capabilities/order-api.md'] });
  });
});

describe('the command is part of the plugin [contracts-map-spec-text]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-spec-text]
  it('is a contract-mappings plugin command with the documented options', () => {
    const cmd = plugin.commands![0];
    expect(cmd.name).toBe('contracts-map');
    expect(cmd.options!.map((o) => o.flags.split(' ')[0])).toEqual(['--workspace', '--repo', '--dry-run', '--min-confidence', '--with-llm', '--max-llm-specs', '--all-specs', '--with-code', '--send-code', '--assess']);
  });
});

describe('contracts-map precision [contracts-map-precision]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-precision]
  it('never proposes a sibling consumer, its own title, a table row or the system spec, and flags a title found in two providers', async () => {
    const f = fixture({
      // A second consumer whose spec shares a title with the web spec: siblings, not a dependency.
      'web/specs/checkout.md': spec('Order Service', 'Checkout page.\n\n| [Payment Gateway](x.md) | card form |\n\nIt submits through the Shared Ledger before confirming.'),
      'web/specs/system.md': '---\nkind: system\n---\n# Web\n\nThe web app uses the Payment Gateway and the Order Service.\n',
      'mobile/specs/checkout.md': spec('Checkout', 'Mobile checkout.'),
      'api/specs/ledger.md': spec('Shared Ledger', 'Ledger in api.'),
      'payments/specs/ledger.md': spec('Shared Ledger', 'Ledger in payments.'),
    });
    f.write('ws/.specguard/workspace.json', JSON.stringify({ version: '1', name: 'ws', repos: { web: { path: '../web', role: 'consumer' }, mobile: { path: '../mobile', role: 'consumer' }, api: { path: '../api', role: 'provider' }, payments: { path: '../payments', role: 'provider' } } }));
    f.write('mobile/.specguard/config.json', CONFIG);
    const res = await runContractsMap({ workspace: f.ws, dryRun: true, minConfidence: 0 }, f.ws);
    const text = out(res);
    expect(text).not.toContain('../mobile/');
    expect(text).not.toMatch(/specs\/system\.md ->/);
    // Its own heading "Order Service" and the table row naming "Payment Gateway" are not references.
    expect(text).not.toContain('orders.md');
    expect(text).not.toContain('billing.md');
    expect(text).toMatch(/checkout\.md -> \.\.\/api\/specs\/ledger\.md \(spec-text 0\.5\)/);
    const def = await runContractsMap({ workspace: f.ws, dryRun: true }, f.ws);
    expect(out(def)).not.toContain('ledger.md');
  });

  // [claims: capabilities/integration-surfaces#contracts-map-precision]
  it('scans an overlay app\'s code where its config `repo` points, not the spec folder', async () => {
    const f = codeFixture();
    // Move the web code out of the spec folder and point the config at it.
    f.write('code/web/src/orders.service.ts', f.read('web/src/orders.service.ts'));
    f.write('web/src/orders.service.ts', '// moved\n');
    f.write('web/.specguard/config.json', JSON.stringify({ ...JSON.parse(CONFIG), apps: [{ name: 'app', repo: '../code/web', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 't/' }] }));
    f.write('web/specs/orders-ui.md', owned('orders-ui', ['../code/web/src/orders.service.ts'], 'Orders screen.'));
    const res = await runContractsMap({ workspace: f.ws, withCode: true, dryRun: true }, f.ws);
    expect(out(res)).toMatch(/orders-ui\.md -> \.\.\/api\/specs\/capabilities\/order-api\.md \(code 0\.9\) \.\.\/code\/web\/src\/orders\.service\.ts:1/);
  });

  // [claims: capabilities/integration-surfaces#contracts-map-precision]
  it('caps and flags an endpoint two providers define, and contractMappings.baseRepos settles it', async () => {
    const f = codeFixture();
    f.write('payments/specs/capabilities/order-copy.md', owned('order-copy', ['src/OrderCopy.java'], 'Copy.'));
    f.write('payments/src/OrderCopy.java', f.read('api/src/OrderController.java'));
    const amb = await runContractsMap({ workspace: f.ws, withCode: true, dryRun: true }, f.ws);
    expect(out(amb)).toMatch(/order-api\.md \(code 0\.6\)/);
    expect(out(amb)).toMatch(/order-copy\.md \(code 0\.6\)/);
    f.write('web/.specguard/config.json', JSON.stringify({ ...JSON.parse(CONFIG), contractMappings: { baseRepos: { 'this.cfg.api': 'api' } } }));
    await runContractsMap({ workspace: f.ws, withCode: true }, f.ws);
    const sugs = json(f).mappings.flatMap((m) => m.suggestions as Suggestion[]);
    // The call with a known base reaches only api; the one without a base stays ambiguous at 0.6.
    expect(sugs.some((s) => s.provider.includes('order-copy') && s.evidence === 'src/orders.service.ts:1 GET /orders')).toBe(false);
    expect(sugs.find((s) => s.provider.includes('order-api') && s.evidence === 'src/orders.service.ts:1 GET /orders')?.confidence).toBe(0.9);

    // providerRepos limits the candidates outright, so nothing is ambiguous.
    f.write('web/.specguard/config.json', JSON.stringify({ ...JSON.parse(CONFIG), contractMappings: { providerRepos: ['payments'] } }));
    const only = await runContractsMap({ workspace: f.ws, withCode: true, dryRun: true }, f.ws);
    expect(out(only)).not.toContain('order-api');
    expect(out(only)).toMatch(/order-copy\.md \(code 0\.9\)/);
  });
});
