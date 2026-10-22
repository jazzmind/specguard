/**
 * Test layers: what kind of evidence a test is.
 *
 * `unit`, `integration`, `e2e` (browser/UX tests such as Playwright), `security` and
 * `functional` (the agentic browser check `verify` judges against the spec). A proof records
 * its layer, and a capability can say which layers a requirement needs, so "proven" can mean
 * "proven by a unit test and an e2e test" rather than "some test passed".
 *
 * Spec: specs/capabilities/conformance-testing.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expandGlobs } from './reader.js';

export const TEST_LAYERS = ['unit', 'integration', 'e2e', 'security', 'functional'] as const;
export type TestLayer = (typeof TEST_LAYERS)[number];
/** `unclassified` is evidence recorded before layers existed or without one; it never satisfies a requirement. */
export type EvidenceLayer = TestLayer | 'unclassified';

export const isTestLayer = (v: unknown): v is TestLayer => typeof v === 'string' && (TEST_LAYERS as readonly string[]).includes(v);

const LAYER_TAG = new RegExp(String.raw`(?:@layer:|\[layer:\s*)(${TEST_LAYERS.join('|')})\b`, 'i');
const FILE_HEAD_LINES = 30;

/** The layer a piece of text names with `@layer:e2e` or `[layer: e2e]`, if any. */
export function extractLayerTag(text: string): TestLayer | undefined {
  const m = LAYER_TAG.exec(text);
  return m ? (m[1].toLowerCase() as TestLayer) : undefined;
}

/** The layer a test file declares in a `// [layer: x]` comment within its first lines. */
export function fileLayerComment(source: string): TestLayer | undefined {
  return extractLayerTag(source.split('\n', FILE_HEAD_LINES).join('\n'));
}

export interface ClassifyInput {
  /** Repo-relative POSIX path of the test file. */
  file: string;
  title: string;
  fullTitle?: string;
  tags?: string[];
  /** The layer a `// [layer: x]` comment in the file declares. */
  fileComment?: TestLayer;
  /** Layer from the app's `test.layers` globs. */
  configured?: TestLayer;
  /** The layer of the suite that ran the test. */
  suite?: TestLayer;
  /** `results ingest --layer`. */
  forced?: TestLayer;
  /** The report format, for the runner rule. */
  format?: string;
}

/**
 * The layer of one test. The first rule that matches wins:
 * 1. an `@layer:` tag on the test, or a `[layer: x]` comment at the top of its file;
 * 2. the app's `test.layers` globs;
 * 3. the suite that ran it;
 * 4. `results ingest --layer`;
 * 5. a Playwright report means e2e;
 * 6. path conventions (`/e2e/`, `/integration/`, `/security/`, `*.e2e.*`, `*.int.*`);
 * 7. otherwise unit.
 */
export function classifyTest(t: ClassifyInput): TestLayer {
  const tagged = extractLayerTag([t.title, t.fullTitle ?? '', ...(t.tags ?? [])].join(' '));
  if (tagged) return tagged;
  if (t.fileComment) return t.fileComment;
  if (t.configured) return t.configured;
  if (t.suite) return t.suite;
  if (t.forced) return t.forced;
  if (t.format === 'playwright') return 'e2e';
  const f = `/${t.file.replace(/\\/g, '/')}`;
  if (/\/e2e\//i.test(f) || /\.(e2e|spec-e2e)\./i.test(f)) return 'e2e';
  if (/\/(integration|int)\//i.test(f) || /\.(int|integration)\./i.test(f)) return 'integration';
  if (/\/security\//i.test(f) || /\.security\./i.test(f)) return 'security';
  return 'unit';
}

/** Maps test files to the layer an app's `test.layers` globs give them. Built once per ingest. */
export async function layerGlobIndex(globs: Partial<Record<TestLayer, string[]>> | undefined, root: string): Promise<Map<string, TestLayer>> {
  const index = new Map<string, TestLayer>();
  for (const layer of TEST_LAYERS) {
    const patterns = globs?.[layer];
    if (!patterns || patterns.length === 0) continue;
    for (const abs of await expandGlobs(patterns, root)) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!index.has(rel)) index.set(rel, layer); // an earlier layer in TEST_LAYERS order wins a double match
    }
  }
  return index;
}

/** `// [layer: x]` of a test file on disk, cached by the caller. */
export function readFileLayer(root: string, file: string): TestLayer | undefined {
  try {
    return fileLayerComment(readFileSync(path.resolve(root, file), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Required layers a spec declares, from its frontmatter `layers:` value. Unknown names are returned in `unknown`. */
export interface LayerRequirements {
  default: TestLayer[];
  claims: Record<string, TestLayer[]>;
  unknown: string[];
}

/**
 * Read a capability's `layers:` frontmatter, which is either a list (the default for every claim) or
 * `{ default: [...], claims: { <claim-id>: [...] } }`.
 */
export function parseLayerRequirements(raw: unknown): LayerRequirements {
  const out: LayerRequirements = { default: [], claims: {}, unknown: [] };
  const take = (v: unknown): TestLayer[] => {
    const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
    const ok: TestLayer[] = [];
    for (const item of list) {
      if (isTestLayer(item)) ok.push(item);
      else out.unknown.push(String(item));
    }
    return [...new Set(ok)];
  };
  if (Array.isArray(raw) || typeof raw === 'string') {
    out.default = take(raw);
  } else if (raw && typeof raw === 'object') {
    const o = raw as { default?: unknown; claims?: Record<string, unknown> };
    out.default = take(o.default);
    for (const [id, v] of Object.entries(o.claims ?? {})) out.claims[id] = take(v);
  }
  return out;
}

/** The layers a claim needs: its own entry, else the capability default, else the config default. */
export function requiredLayersFor(claimId: string, spec: LayerRequirements | undefined, configDefault: TestLayer[] = []): TestLayer[] {
  return spec?.claims[claimId] ?? (spec && spec.default.length > 0 ? spec.default : configDefault);
}

/**
 * Mark generated test code with its layer, as a comment in the file's first lines, so the layer survives
 * after generation. Code that already names a layer is returned unchanged.
 */
export function withLayerComment(code: string, layer: TestLayer, language: string): string {
  if (fileLayerComment(code)) return code;
  const mark = language === 'python' ? `# [layer: ${layer}]` : `// [layer: ${layer}]`;
  // keep a shebang or a `use strict`-style first line on top
  const lines = code.split('\n');
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, mark);
  return lines.join('\n');
}
