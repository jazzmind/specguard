/**
 * Spec graph: every spec in a repo as a tree (system -> capability ->
 * component), with the code files each spec owns and a validator for the v2
 * rules. This is the single place that answers "which spec owns this file".
 *
 * v1 specs (no `kind`) are kept as nodes with no kind so mixed repos keep
 * working; the v2 rules apply only to specs that declare a kind.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { duplicateClaimIds } from './claims.js';
import { loadAllSpecs } from './spec-parser.js';
import {
  appForSpecFile,
  canonicalSpecKey,
  declaredSources,
  resolveDeclaredSources,
  sourceKeys,
  specsRootDir,
} from './spec-key.js';
import type { ParsedSpec, SpecGuardConfig, SpecKind } from './types.js';

const DEFAULT_MAX_CAPABILITIES = 20;

export type GraphIssueCode =
  | 'no-system'
  | 'multiple-system'
  | 'missing-id'
  | 'duplicate-id'
  | 'id-filename'
  | 'unknown-parent'
  | 'parent-cycle'
  | 'parent-kind'
  | 'duplicate-claim'
  | 'missing-problem-value'
  | 'no-sources'
  | 'too-many-capabilities';

export interface GraphIssue {
  level: 'error' | 'warn';
  code: GraphIssueCode;
  /** Spec id the issue is about, when it has one. */
  spec?: string;
  message: string;
}

export interface SpecNode {
  /** `meta.id` for v2 specs, else the canonical spec key. */
  id: string;
  specKey: string;
  /** Undefined for a v1 spec. */
  kind?: SpecKind;
  /** The workspace unit (a repo or a monorepo package) the spec belongs to. `.` is the repo itself. */
  unit: string;
  spec: ParsedSpec;
  parent?: string;
  children: string[];
  /** Root-relative POSIX paths of the files the spec's `sources` match. */
  ownedFiles: string[];
}

export interface SpecGraph {
  nodes: Map<string, SpecNode>;
  /** The kind: system node, when exactly one exists. */
  system?: SpecNode;
  issues: GraphIssue[];
  /** Ids of the specs that own `file` (root-relative POSIX, or absolute inside the root). Several is normal; none means unowned. */
  specsForFile(file: string): string[];
  /** Of `files`, those no spec owns. */
  unowned(files: string[]): string[];
}

export interface BuildGraphOptions {
  /** Workspace unit the specs belong to. Default `.`. */
  unit?: string;
  /** Receives `[warn]` lines from source resolution. */
  warn?: (msg: string) => void;
}

/** Specs of the repo: the top-level specs root when it exists, else each app's `specDir`. */
export function loadRepoSpecs(config: SpecGuardConfig): Array<{ spec: ParsedSpec; abs: string; dir: string }> {
  const root = config.rootDir ?? process.cwd();
  const top = specsRootDir(config);
  const dirs = fs.existsSync(top) ? [top] : config.apps.map((app) => path.resolve(root, app.specDir));
  const seen = new Set<string>();
  const out: Array<{ spec: ParsedSpec; abs: string; dir: string }> = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const spec of loadAllSpecs(dir)) {
      const abs = path.join(dir, `${spec.specKey}.md`);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ spec: { ...spec, localKey: spec.specKey, specKey: canonicalSpecKey(config, abs, dir) }, abs, dir });
    }
  }
  return out;
}

export async function buildSpecGraph(config: SpecGuardConfig, opts: BuildGraphOptions = {}): Promise<SpecGraph> {
  const root = config.rootDir ?? process.cwd();
  const unit = opts.unit ?? '.';
  const issues: GraphIssue[] = [];
  const nodes = new Map<string, SpecNode>();
  const fileOwners = new Map<string, string[]>();

  for (const { spec, abs } of loadRepoSpecs(config)) {
    const kind = spec.meta.kind;
    const id = spec.meta.id ?? spec.specKey;
    if (kind && !spec.meta.id) {
      issues.push({ level: 'error', code: 'missing-id', spec: spec.specKey, message: `${spec.specKey}: v2 spec has no frontmatter id` });
    }
    if (kind && spec.meta.id && spec.meta.id !== path.basename(abs, '.md')) {
      issues.push({
        level: 'error',
        code: 'id-filename',
        spec: id,
        message: `${id}: id must equal the file name (${path.basename(abs)})`,
      });
    }
    if (nodes.has(id)) {
      issues.push({ level: 'error', code: 'duplicate-id', spec: id, message: `${id}: id is used by two specs (${nodes.get(id)!.specKey}, ${spec.specKey})` });
      continue;
    }

    let ownedFiles: string[] = [];
    const patterns = declaredSources(spec);
    // A v1 spec's `module:` is free text, not a glob list; only v2 specs own files through it.
    if (kind && patterns.length > 0) {
      const app = appForSpecFile(config, abs) ?? config.apps[0];
      ownedFiles = sourceKeys(config, await resolveDeclaredSources(config, app, patterns, opts.warn));
    }
    for (const file of ownedFiles) {
      const owners = fileOwners.get(file) ?? [];
      owners.push(id);
      fileOwners.set(file, owners);
    }
    nodes.set(id, { id, specKey: spec.specKey, kind, unit, spec, parent: spec.meta.parent, children: [], ownedFiles });
  }

  validate(config, nodes, issues);

  const systems = [...nodes.values()].filter((n) => n.kind === 'system');
  const system = systems.length === 1 ? systems[0] : undefined;

  // Link children. A capability with no parent hangs off the system spec.
  for (const node of nodes.values()) {
    if (!node.kind || node.kind === 'system') continue;
    const parentId = node.parent ?? (node.kind === 'capability' ? system?.id : undefined);
    if (parentId && nodes.has(parentId)) nodes.get(parentId)!.children.push(node.id);
  }
  for (const node of nodes.values()) node.children.sort();

  const toKey = (file: string): string => {
    if (!path.isAbsolute(file)) return file.split(path.sep).join('/');
    return path.relative(root, file).split(path.sep).join('/');
  };
  const specsForFile = (file: string): string[] => [...(fileOwners.get(toKey(file)) ?? [])].sort();
  return {
    nodes,
    system,
    issues,
    specsForFile,
    unowned: (files) => files.filter((f) => specsForFile(f).length === 0),
  };
}

function validate(config: SpecGuardConfig, nodes: Map<string, SpecNode>, issues: GraphIssue[]): void {
  const v2 = [...nodes.values()].filter((n) => n.kind);
  if (v2.length === 0) return;

  const systems = v2.filter((n) => n.kind === 'system');
  if (systems.length === 0) issues.push({ level: 'error', code: 'no-system', message: 'no spec has kind: system; a repo with v2 specs needs exactly one master spec' });
  if (systems.length > 1) {
    issues.push({ level: 'error', code: 'multiple-system', message: `more than one kind: system spec: ${systems.map((n) => n.id).join(', ')}` });
  }

  for (const node of v2) {
    const { spec } = node;
    if (node.kind !== 'system' && node.kind !== 'journey' && !('Problem & Value' in spec.sections)) {
      issues.push({ level: 'error', code: 'missing-problem-value', spec: node.id, message: `${node.id}: a ${node.kind} spec needs a "## Problem & Value" section` });
    }
    if ((node.kind === 'capability' || node.kind === 'component') && node.ownedFiles.length === 0) {
      issues.push({ level: 'warn', code: 'no-sources', spec: node.id, message: `${node.id}: sources match no files, so the spec owns no code` });
    }
    for (const dup of duplicateClaimIds(spec.claims)) {
      issues.push({ level: 'error', code: 'duplicate-claim', spec: node.id, message: `${node.id}: claim id "${dup}" appears more than once` });
    }
    if (node.kind === 'component' && !node.parent) {
      issues.push({ level: 'error', code: 'unknown-parent', spec: node.id, message: `${node.id}: a component spec needs a parent` });
    }
    if (node.parent) {
      const parent = nodes.get(node.parent);
      if (!parent) {
        issues.push({ level: 'error', code: 'unknown-parent', spec: node.id, message: `${node.id}: parent "${node.parent}" is not a spec id` });
      } else if (node.kind === 'capability' && parent.kind !== 'system') {
        issues.push({ level: 'error', code: 'parent-kind', spec: node.id, message: `${node.id}: a capability's parent must be the system spec` });
      } else if (node.kind === 'component' && parent.kind !== 'capability') {
        issues.push({ level: 'error', code: 'parent-kind', spec: node.id, message: `${node.id}: a component's parent must be a capability` });
      }
    }
    // Walk up to catch a cycle.
    const seen = new Set<string>([node.id]);
    let cursor = node.parent ? nodes.get(node.parent) : undefined;
    while (cursor) {
      if (seen.has(cursor.id)) {
        issues.push({ level: 'error', code: 'parent-cycle', spec: node.id, message: `${node.id}: parent chain loops back to ${cursor.id}` });
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parent ? nodes.get(cursor.parent) : undefined;
    }
  }

  const max = config.granularity?.maxCapabilities ?? DEFAULT_MAX_CAPABILITIES;
  const capabilities = v2.filter((n) => n.kind === 'capability').length;
  if (capabilities > max) {
    issues.push({
      level: 'warn',
      code: 'too-many-capabilities',
      message: `${capabilities} capability specs exceeds granularity.maxCapabilities (${max}); merge related capabilities or use components`,
    });
  }
}
