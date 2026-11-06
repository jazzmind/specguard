import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import {
  anchorize,
  commandLines,
  commandTree,
  headingsOf,
  isGuide,
  parseGuides,
  parseHelpTopics,
  stripSection,
  unknownCommand,
  validateGuides,
  withCommands,
  type CommandNode,
  type GuideDoc,
} from '../../src/core/guides.js';
import { buildSpecGraph } from '../../src/core/spec-graph.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const tree: CommandNode = {
  name: 'specguard',
  takesArgs: false,
  subs: [
    { name: 'check', takesArgs: false, subs: [] },
    { name: 'docs', takesArgs: false, subs: [{ name: 'build', takesArgs: false, subs: [] }] },
    { name: 'plugin', takesArgs: false, subs: [{ name: 'list', takesArgs: false, subs: [] }] },
    { name: 'import', takesArgs: true, subs: [] },
  ],
};

const guide = (id: string, body: string, related: string[] = []): GuideDoc => ({ id, specKey: `guides/${id}`, title: id, audience: 'user', order: 1, related, group: 'quickstart', body, source: body, file: `specs/guides/${id}.md` });

const GUIDE_SPEC = (id: string, extra = '') =>
  `---\nid: ${id}\nkind: journey\ntitle: "Guide ${id}"\naudience: user\norder: 2\nuseCase: do the thing\nrelated:\n  - auth\n---\n\n# Guide ${id}\n\n## Goal\nDo it.\n\n## Steps\n\`\`\`bash\nspecguard check\n\`\`\`\n${extra}`;

describe('guide specs [guide-specs]', () => {
  // [claims: capabilities/documentation-api#guide-specs]
  it('loads journey guides under specs/guides without graph issues and keeps them out of the capabilities', async () => {
    const repo = makeV2Repo();
    repo.write('specs/guides/try-it.md', GUIDE_SPEC('try-it'));
    const config = await loadConfig(repo.dir);
    const graph = await buildSpecGraph(config);
    expect(graph.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(graph.issues.map((i) => i.code)).not.toContain('missing-problem-value');
    const node = graph.nodes.get('try-it')!;
    expect(node.kind).toBe('journey');
    expect(isGuide(node)).toBe(true);
    expect(graph.system?.children).not.toContain('try-it');
    const [g] = parseGuides(graph.nodes.values(), repo.dir);
    expect(g).toMatchObject({ id: 'try-it', audience: 'user', order: 2, useCase: 'do the thing', related: ['auth'], group: 'quickstart', title: 'Guide try-it' });
    expect(g.body).toContain('## Goal');
    expect(g.body).not.toMatch(/^# Guide/m);
    expect(g.body).not.toContain('Help Topics');
  });
});

describe('help topics [help-topics-from-specs]', () => {
  // [claims: capabilities/documentation-api#help-topics-from-specs]
  it('parses key, section heading and text, and ignores everything else', () => {
    const md = '# T\n\n## Goal\nx\n\n## Help Topics\n- `workspace.status` → Workspace status: Repos and specs at a glance.\n- `a-b.c_d` -> Heading: with: colons in text\nnot a topic\n\n## Next\n- `x.y` → H: not in the section\n';
    expect(parseHelpTopics(md, 'g', 'guide')).toEqual([
      { key: 'workspace.status', heading: 'Workspace status', text: 'Repos and specs at a glance.', spec: 'g', specKind: 'guide' },
      { key: 'a-b.c_d', heading: 'Heading', text: 'with: colons in text', spec: 'g', specKind: 'guide' },
    ]);
  });

  // [claims: capabilities/documentation-api#help-topics-from-specs]
  it('does not read a Help Topics heading inside a code fence', () => {
    const md = '## Goal\n```\n## Help Topics\n- `k.k` → H: t\n```\n';
    expect(parseHelpTopics(md, 'g', 'guide')).toEqual([]);
    expect(stripSection('## A\nx\n## Help Topics\n- y\n## B\nz', 'Help Topics')).toBe('## A\nx\n## B\nz');
  });
});

describe('guide validation [guide-validation]', () => {
  // [claims: capabilities/documentation-api#guide-validation]
  it('finds commands the CLI lacks, including a subcommand, and accepts real and plugin ones', () => {
    const body = '## Steps\n```bash\nspecguard check --gaps\nspecguard docs build --check\nnpx -y -p specguard-ai specguard import file.md\nspecguard nope\nspecguard docs frobnicate\nspecguard contracts-map --assess\n$ specguard plugin list\n```\n\n```json\n{ "x": "specguard bogus" }\n```\n';
    const g = guide('g', body);
    const issues = validateGuides({ guides: [g], capabilityIds: new Set(), topics: [], commands: tree });
    expect(issues.filter((i) => i.code === 'guide-unknown-command').map((i) => i.message)).toEqual([
      'g: `specguard nope` is not a command',
      'g: `specguard docs frobnicate` is not a command',
      'g: `specguard contracts-map` is not a command',
    ]);
    const withPlugin = validateGuides({ guides: [g], capabilityIds: new Set(), topics: [], commands: withCommands(tree, ['contracts-map']) });
    expect(withPlugin.map((i) => i.message).join('\n')).not.toContain('contracts-map');
    expect(commandLines('```bash\nspecguard a b\n```\nspecguard prose\n')).toEqual([['a', 'b']]);
    expect(unknownCommand(['check'], tree)).toBeUndefined();
    expect(unknownCommand(['--version'], tree)).toBeUndefined();
  });

  // [claims: capabilities/documentation-api#guide-validation]
  it('reads the command tree from a commander-like program', () => {
    const fake = { name: () => 'specguard', commands: [{ name: () => 'docs', commands: [{ name: () => 'build', commands: [], registeredArguments: [] }], registeredArguments: [] }], registeredArguments: [] };
    const t = commandTree(fake);
    expect(t.subs[0].subs[0].name).toBe('build');
  });

  // [claims: capabilities/documentation-api#guide-validation]
  it('flags unknown related ids, duplicate keys and unknown anchors', () => {
    const g = guide('g', '## Goal\nx\n\n### Real section\ny\n', ['auth', 'missing']);
    const topics = [
      { key: 'k.a', heading: 'Real section', text: 't', spec: 'g', specKind: 'guide' as const },
      { key: 'k.b', heading: 'Gone', text: 't', spec: 'g', specKind: 'guide' as const },
      { key: 'k.a', heading: 'Real section', text: 't', spec: 'other', specKind: 'guide' as const },
      { key: 'k.c', heading: 'What to expect', text: 't', spec: 'auth', specKind: 'capability' as const },
      { key: 'k.d', heading: 'Problem & Value', text: 't', spec: 'auth', specKind: 'capability' as const },
    ];
    const issues = validateGuides({ guides: [g], capabilityIds: new Set(['auth']), topics });
    expect(issues.map((i) => i.code).sort()).toEqual(['guide-unknown-related', 'help-duplicate-key', 'help-unknown-anchor', 'help-unknown-anchor']);
    expect(issues.find((i) => i.code === 'guide-unknown-related')?.message).toContain('missing');
  });
});

describe('anchors [doc-anchors-stable]', () => {
  const page = '# Title\n\nintro\n\n## Steps\n```bash\n# Not a heading\n## Nor this\n```\n\n### Steps\n\n## Steps\n';

  // [claims: capabilities/documentation-api#doc-anchors-stable]
  it('puts a unique anchor before every heading outside code fences', () => {
    const { markdown, sections } = anchorize(page);
    expect(markdown).toContain('<a id="title"></a>\n# Title');
    expect(markdown).toContain('<a id="steps"></a>\n## Steps');
    expect(markdown).toContain('<a id="steps-2"></a>\n### Steps');
    expect(markdown).toContain('<a id="steps-3"></a>\n## Steps');
    expect(markdown).not.toContain('id="not-a-heading"');
    expect(sections.map((s) => s.anchor)).toEqual(['steps', 'steps-2', 'steps-3']);
    expect(headingsOf(page).map((h) => h.title)).toEqual(['Title', 'Steps', 'Steps', 'Steps']);
  });

  // [claims: capabilities/documentation-api#doc-anchors-stable]
  it('is idempotent and keeps an anchor while its heading text is unchanged', () => {
    const once = anchorize(page).markdown;
    expect(anchorize(once).markdown).toBe(once);
    const edited = anchorize(page.replace('intro', 'a different intro paragraph')).markdown;
    const ids = (m: string) => [...m.matchAll(/<a id="([^"]+)">/g)].map((x) => x[1]);
    expect(ids(edited)).toEqual(ids(once));
  });
});
