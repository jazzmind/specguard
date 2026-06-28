# SpecGuard Extension Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, animated visualization of SpecGuard's pipelines as a Webview panel inside the existing VS Code/Cursor extension — an animated system-flow graph plus Matrix, Docs, and Activity tabs — driven in real time by filesystem watchers + CLI runs + `traceability.json`.

**Architecture:** A two-process design inside `extension/`. The **extension host** (esbuild-bundled Node) spawns CLI pipelines, watches `specs/ tests/ docs/`, reads `.specguard/traceability.json`, and posts typed `DashboardEvent`s to a **Webview** (Vite+React in `extension/media/`) that animates off them. Pure transforms (matrix model, coverage parse, flow events, event reducer) are unit-tested with Vitest; vscode-wiring is build/manually verified.

**Tech Stack:** TypeScript, esbuild (host bundle), Vite + React (webview), Vitest, VS Code Webview API. SVG/CSS animations.

## Global Constraints

- **No changes to shared `src/**` or root config.** All work lives under `extension/`. (Another contributor owns CLI/pipeline "plumbing".)
- **CLI has no `--json` flag.** Real-time data comes from fs-watchers + CLI exit codes + reading `.specguard/traceability.json`; coverage reuses the lenient text parser.
- **Webview CSP locked.** Load only bundled local scripts from `extension/media/`; use a nonce; no remote/inline script.
- **Extension stays esbuild-bundled CJS**, `engines.vscode ^1.85.0`, `--external:vscode`.
- **Out of scope:** git commit behavior, making security/test-gen pipelines actually run, Nate-PRD evaluation. Coverage tree sidebar stays as-is.
- **Document as we go:** every task updates `docs/dashboard/WORKLOG.md` and (where relevant) `extension/README.md` in the same commit.
- All paths are relative to the repo root unless noted. Run extension commands from `extension/`.

---

### Task 1: Extension test harness + dashboard protocol + node metadata

**Files:**
- Modify: `extension/package.json` (add vitest devDep + test script)
- Create: `extension/vitest.config.ts`
- Create: `extension/src/dashboard/protocol.ts`
- Test: `extension/src/dashboard/protocol.test.ts`

**Interfaces:**
- Produces: types `DashboardEvent`, `DashboardCommand`, `MatrixModel`, `MatrixRow`, `AppCoverage`, `CoverageItem`; const `PIPELINE_NODES: PipelineNode[]` describing the flow graph (id, label, kind, from[]).

- [ ] **Step 1: Add Vitest to the extension package**

Modify `extension/package.json` — add to `devDependencies`: `"vitest": "^3"`, and to `scripts`: `"test": "vitest run"`.

- [ ] **Step 2: Create the vitest config**

Create `extension/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
```

- [ ] **Step 3: Install**

Run: `cd extension && npm install`
Expected: exit 0.

- [ ] **Step 4: Write the protocol + node metadata**

Create `extension/src/dashboard/protocol.ts`:

```ts
/** Shared message + model contracts between the extension host and the webview. */

export interface CoverageItem { app: string; key: string; hasSpec: boolean; hasTest: boolean; specPath?: string; }
export interface AppCoverage { name: string; specCount: number; sourceCount: number; testCount: number; percentage: number; items: CoverageItem[]; }

export interface MatrixRow { specKey: string; title: string; appName: string; sourceModule: string; hasTests: boolean; testCount: number; hasDocs: boolean; }
export interface MatrixModel { generatedAt: string | null; rows: MatrixRow[]; }

export type PipelineCounts = { created: number; updated: number; skipped: number; failed: number };

export type DashboardEvent =
  | { type: 'pipeline:start'; pipeline: string }
  | { type: 'pipeline:log'; pipeline: string; line: string }
  | { type: 'pipeline:done'; pipeline: string; exitCode: number; counts?: PipelineCounts }
  | { type: 'artifact'; kind: 'spec' | 'test' | 'doc'; path: string; change: 'create' | 'update' }
  | { type: 'matrix'; data: MatrixModel }
  | { type: 'coverage'; data: AppCoverage[] }
  | { type: 'error'; scope: string; message: string };

export type DashboardCommand =
  | { type: 'run'; pipeline: string; args?: string[] }
  | { type: 'refresh' }
  | { type: 'openFile'; path: string };

/** A node in the system-flow graph. `from` lists upstream node ids feeding it. */
export interface PipelineNode { id: string; label: string; kind: 'input' | 'pipeline' | 'artifact'; from: string[]; }

/** The flow graph, mirroring the README architecture diagram. */
export const PIPELINE_NODES: PipelineNode[] = [
  { id: 'docs-in', label: 'PRD / Jira / MD', kind: 'input', from: [] },
  { id: 'code', label: 'Source code', kind: 'input', from: [] },
  { id: 'import', label: 'import', kind: 'pipeline', from: ['docs-in'] },
  { id: 'reverse', label: 'reverse', kind: 'pipeline', from: ['code'] },
  { id: 'specs', label: 'Specs', kind: 'artifact', from: ['import', 'reverse'] },
  { id: 'generate', label: 'generate', kind: 'pipeline', from: ['specs'] },
  { id: 'tests', label: 'Tests', kind: 'artifact', from: ['generate'] },
  { id: 'heal', label: 'heal', kind: 'pipeline', from: ['tests'] },
  { id: 'security', label: 'security', kind: 'pipeline', from: ['specs'] },
  { id: 'validate', label: 'validate', kind: 'pipeline', from: ['specs'] },
  { id: 'docs', label: 'docs', kind: 'pipeline', from: ['specs'] },
  { id: 'user-docs', label: 'User Docs', kind: 'artifact', from: ['docs'] },
  { id: 'drift', label: 'drift', kind: 'pipeline', from: ['specs'] },
  { id: 'matrix', label: 'matrix', kind: 'pipeline', from: ['specs'] },
  { id: 'traceability', label: 'Traceability', kind: 'artifact', from: ['matrix'] },
];

/** Pipelines runnable from the Activity tab and whether they need a confirm. */
export const RUNNABLE_PIPELINES: { id: string; destructive: boolean }[] = [
  { id: 'status', destructive: false },
  { id: 'drift', destructive: false },
  { id: 'matrix', destructive: false },
  { id: 'reverse', destructive: true },
  { id: 'generate', destructive: true },
  { id: 'heal', destructive: true },
  { id: 'security', destructive: true },
  { id: 'docs', destructive: true },
  { id: 'validate', destructive: true },
  { id: 'import', destructive: true },
];
```

- [ ] **Step 5: Write the failing test**

Create `extension/src/dashboard/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PIPELINE_NODES, RUNNABLE_PIPELINES } from './protocol.js';

describe('flow graph metadata', () => {
  it('every non-input node lists at least one upstream source', () => {
    for (const n of PIPELINE_NODES) {
      if (n.kind !== 'input') expect(n.from.length).toBeGreaterThan(0);
    }
  });
  it('all `from` ids reference existing nodes', () => {
    const ids = new Set(PIPELINE_NODES.map((n) => n.id));
    for (const n of PIPELINE_NODES) for (const f of n.from) expect(ids.has(f)).toBe(true);
  });
  it('includes the core pipelines as runnable', () => {
    const ids = RUNNABLE_PIPELINES.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['reverse', 'generate', 'drift', 'matrix', 'status']));
  });
});
```

- [ ] **Step 6: Run the test**

Run: `cd extension && npx vitest run src/dashboard/protocol.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Update worklog + commit**

Append a dated entry to `docs/dashboard/WORKLOG.md` ("Task 1: extension test harness + flow protocol/metadata"). Then:

```bash
git add extension/package.json extension/package-lock.json extension/vitest.config.ts extension/src/dashboard/protocol.ts extension/src/dashboard/protocol.test.ts docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): extension test harness + flow protocol and node metadata"
```

---

### Task 2: Coverage text parser (extract + reuse)

**Files:**
- Create: `extension/src/dashboard/coverage-parse.ts`
- Test: `extension/src/dashboard/coverage-parse.test.ts`
- Modify: `extension/src/sidebar.ts` (DRY — import the extracted parser)

**Interfaces:**
- Consumes: `AppCoverage`, `CoverageItem` from `./protocol.js`.
- Produces: `parseCoverageText(raw: string): AppCoverage[]`.

- [ ] **Step 1: Write the failing test**

Create `extension/src/dashboard/coverage-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCoverageText } from './coverage-parse.js';

const sample = `# specguard-core (specs/core)
  [ok] core/parser
  [missing-spec] core/llm
specguard-core: 2 source files, 1 specs (50%), 1 tests
`;

describe('parseCoverageText', () => {
  it('parses app name, items and summary percentage', () => {
    const apps = parseCoverageText(sample);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('specguard-core');
    expect(apps[0].percentage).toBe(50);
    expect(apps[0].items.find((i) => i.key === 'core/parser')?.hasSpec).toBe(true);
    expect(apps[0].items.find((i) => i.key === 'core/llm')?.hasSpec).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run src/dashboard/coverage-parse.test.ts`
Expected: FAIL — cannot resolve `./coverage-parse.js`.

- [ ] **Step 3: Implement the parser (moved from sidebar.ts)**

Create `extension/src/dashboard/coverage-parse.ts`:

```ts
import type { AppCoverage, CoverageItem } from './protocol.js';

/** Lenient parser for the text output of `specguard status` (no --json yet). */
export function parseCoverageText(raw: string): AppCoverage[] {
  const apps: AppCoverage[] = [];
  const appSections = raw.split(/^# /m).filter(Boolean);

  for (const section of appSections) {
    const lines = section.split('\n');
    const header = lines[0] ?? '';
    const nameMatch = header.match(/^(\S+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const items: CoverageItem[] = [];
    for (const line of lines.slice(1)) {
      const noTestMatch = line.match(/^\s+\[ok\]\s+(\S+)\s+\(no test\)/);
      const okMatch = line.match(/^\s+\[ok\]\s+(\S+)/);
      const missingMatch = line.match(/^\s+\[missing-spec\]\s+(\S+)/);
      if (noTestMatch) items.push({ app: name, key: noTestMatch[1], hasSpec: true, hasTest: false });
      else if (okMatch) items.push({ app: name, key: okMatch[1], hasSpec: true, hasTest: true });
      else if (missingMatch) items.push({ app: name, key: missingMatch[1], hasSpec: false, hasTest: false });
    }

    const summary = section.match(/(\d+) source files, (\d+) specs \((\d+)%\), (\d+) tests/);
    const sourceCount = summary ? parseInt(summary[1], 10) : items.length;
    const specCount = summary ? parseInt(summary[2], 10) : items.filter((i) => i.hasSpec).length;
    const percentage = summary ? parseInt(summary[3], 10) : 0;
    apps.push({ name, specCount, sourceCount, testCount: 0, percentage, items });
  }
  return apps;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npx vitest run src/dashboard/coverage-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: DRY — point sidebar.ts at the shared parser**

In `extension/src/sidebar.ts`: delete the local `parseStatusJson` function (lines defining it) and its call; add `import { parseCoverageText } from './dashboard/coverage-parse.js';` and replace `this._apps = parseStatusJson(raw);` with `this._apps = parseCoverageText(raw);`. Remove the now-unused `AppCoverage`/`CoverageItem` local interface declarations and instead `import type { AppCoverage, CoverageItem } from './dashboard/protocol.js';` (keep the rest of sidebar.ts unchanged).

- [ ] **Step 6: Verify the extension still builds**

Run: `cd extension && npm run lint && npm run build`
Expected: `tsc --noEmit` clean and esbuild emits `dist/extension.js`.

- [ ] **Step 7: Update worklog + commit**

```bash
git add extension/src/dashboard/coverage-parse.ts extension/src/dashboard/coverage-parse.test.ts extension/src/sidebar.ts docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): extract+test coverage parser, reuse in sidebar"
```

---

### Task 3: Matrix model transform

**Files:**
- Create: `extension/src/dashboard/matrix-model.ts`
- Test: `extension/src/dashboard/matrix-model.test.ts`

**Interfaces:**
- Consumes: `MatrixModel`, `MatrixRow` from `./protocol.js`.
- Produces: `toMatrixModel(raw: unknown): MatrixModel`; type `TraceabilityFile`.

- [ ] **Step 1: Write the failing test**

Create `extension/src/dashboard/matrix-model.test.ts` (shape copied from real `.specguard/traceability.json`):

```ts
import { describe, it, expect } from 'vitest';
import { toMatrixModel } from './matrix-model.js';

const raw = {
  generatedAt: '2026-06-28T18:24:50.615Z',
  entries: [
    { specKey: 'cli', title: 'CLI Entrypoint', appName: 'specguard-core', tests: [], docs: [], sourceModule: 'src/cli/index.ts' },
    { specKey: 'config', title: 'Config Loader', appName: 'specguard-core', tests: ['/x/tests/core/config.test.ts'], docs: [], sourceModule: 'src/core/config.ts' },
  ],
};

describe('toMatrixModel', () => {
  it('maps entries to rows with test/doc coverage flags', () => {
    const m = toMatrixModel(raw);
    expect(m.generatedAt).toBe('2026-06-28T18:24:50.615Z');
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]).toMatchObject({ specKey: 'cli', hasTests: false, testCount: 0, hasDocs: false });
    expect(m.rows[1]).toMatchObject({ specKey: 'config', hasTests: true, testCount: 1 });
  });
  it('returns an empty model for malformed input', () => {
    expect(toMatrixModel(null)).toEqual({ generatedAt: null, rows: [] });
    expect(toMatrixModel({})).toEqual({ generatedAt: null, rows: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run src/dashboard/matrix-model.test.ts`
Expected: FAIL — cannot resolve `./matrix-model.js`.

- [ ] **Step 3: Implement the transform**

Create `extension/src/dashboard/matrix-model.ts`:

```ts
import type { MatrixModel, MatrixRow } from './protocol.js';

interface TraceabilityEntry { specKey: string; title?: string; appName?: string; tests?: string[]; docs?: string[]; sourceModule?: string; }
export interface TraceabilityFile { generatedAt?: string; entries?: TraceabilityEntry[]; }

/** Convert `.specguard/traceability.json` into a flat, render-ready matrix. */
export function toMatrixModel(raw: unknown): MatrixModel {
  const file = (raw ?? {}) as TraceabilityFile;
  if (!Array.isArray(file.entries)) return { generatedAt: null, rows: [] };
  const rows: MatrixRow[] = file.entries.map((e) => {
    const tests = Array.isArray(e.tests) ? e.tests : [];
    const docs = Array.isArray(e.docs) ? e.docs : [];
    return {
      specKey: e.specKey,
      title: e.title ?? e.specKey,
      appName: e.appName ?? '',
      sourceModule: e.sourceModule ?? '',
      hasTests: tests.length > 0,
      testCount: tests.length,
      hasDocs: docs.length > 0,
    };
  });
  return { generatedAt: file.generatedAt ?? null, rows };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npx vitest run src/dashboard/matrix-model.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Update worklog + commit**

```bash
git add extension/src/dashboard/matrix-model.ts extension/src/dashboard/matrix-model.test.ts docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): traceability.json → matrix model transform"
```

---

### Task 4: Flow event mappers + CLI arg builder (pure)

**Files:**
- Create: `extension/src/dashboard/flow-events.ts`
- Test: `extension/src/dashboard/flow-events.test.ts`

**Interfaces:**
- Consumes: `DashboardEvent` from `./protocol.js`.
- Produces: `artifactEventFor(path: string, change: 'create' | 'update'): DashboardEvent | null`; `cliArgsFor(pipeline: string, extra?: string[]): string[]`.

- [ ] **Step 1: Write the failing test**

Create `extension/src/dashboard/flow-events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { artifactEventFor, cliArgsFor } from './flow-events.js';

describe('artifactEventFor', () => {
  it('classifies a spec path', () => {
    expect(artifactEventFor('specs/core/parser.md', 'create')).toMatchObject({ type: 'artifact', kind: 'spec', change: 'create' });
  });
  it('classifies test and doc paths', () => {
    expect(artifactEventFor('tests/core/parser.test.ts', 'update')?.kind).toBe('test');
    expect(artifactEventFor('docs/user/login.md', 'create')?.kind).toBe('doc');
  });
  it('ignores unrelated paths', () => {
    expect(artifactEventFor('src/core/parser.ts', 'create')).toBeNull();
  });
});

describe('cliArgsFor', () => {
  it('returns the pipeline name plus extras', () => {
    expect(cliArgsFor('drift')).toEqual(['drift']);
    expect(cliArgsFor('reverse', ['--app', 'specguard-core'])).toEqual(['reverse', '--app', 'specguard-core']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run src/dashboard/flow-events.test.ts`
Expected: FAIL — cannot resolve `./flow-events.js`.

- [ ] **Step 3: Implement the mappers**

Create `extension/src/dashboard/flow-events.ts`:

```ts
import type { DashboardEvent } from './protocol.js';

/** Map a changed file path to an artifact event, or null if not a tracked artifact. */
export function artifactEventFor(path: string, change: 'create' | 'update'): DashboardEvent | null {
  const p = path.replace(/\\/g, '/');
  let kind: 'spec' | 'test' | 'doc' | null = null;
  if (/(^|\/)specs\/.+\.md$/.test(p)) kind = 'spec';
  else if (/(^|\/)tests\/.+\.(test|spec)\.(ts|js)$/.test(p)) kind = 'test';
  else if (/(^|\/)docs\/.+\.md$/.test(p)) kind = 'doc';
  return kind ? { type: 'artifact', kind, path: p, change } : null;
}

/** Build CLI args for a pipeline run. */
export function cliArgsFor(pipeline: string, extra: string[] = []): string[] {
  return [pipeline, ...extra];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npx vitest run src/dashboard/flow-events.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Update worklog + commit**

```bash
git add extension/src/dashboard/flow-events.ts extension/src/dashboard/flow-events.test.ts docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): pure flow-event + cli-arg mappers"
```

---

### Task 5: CLI runner + dashboard host (vscode wiring)

**Files:**
- Create: `extension/src/dashboard/cli.ts`
- Create: `extension/src/dashboard/host.ts`

**Interfaces:**
- Consumes: `parseCoverageText`, `toMatrixModel`, `artifactEventFor`, `cliArgsFor`, `PIPELINE_NODES`, types from `./protocol.js`.
- Produces:
  - `resolveCliPath(workspaceRoot: string): Promise<string>`; `spawnCli(cliPath, args, cwd, onLine): Promise<number>` (resolves exit code, streams stdout lines).
  - `class DashboardHost { constructor(post: (e: DashboardEvent) => void, workspaceRoot: string); start(): void; dispose(): void; handle(cmd: DashboardCommand): Promise<void>; }`

- [ ] **Step 1: Implement the CLI runner**

Create `extension/src/dashboard/cli.ts`:

```ts
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export async function resolveCliPath(workspaceRoot: string): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('specguard');
  const custom = cfg.get<string>('cliPath', '');
  if (custom) return custom;
  const localBin = path.join(workspaceRoot, 'node_modules', '.bin', 'specguard');
  if (fs.existsSync(localBin)) return localBin;
  const localSrc = path.join(workspaceRoot, 'src', 'cli', 'index.ts');
  return fs.existsSync(localSrc) ? localSrc : localBin;
}

/** Spawn the CLI, stream stdout line-by-line via onLine, resolve the exit code. */
export function spawnCli(cliPath: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, cmdArgs] = cliPath.endsWith('.js')
      ? ['node', [cliPath, ...args]]
      : cliPath.endsWith('.ts')
        ? ['npx', ['tsx', cliPath, ...args]]
        : [cliPath, args];
    const proc = cp.spawn(cmd, cmdArgs as string[], { cwd, env: process.env, shell: process.platform === 'win32' });
    let buf = '';
    const flush = (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    };
    proc.stdout.on('data', (d: Buffer) => flush(d.toString()));
    proc.stderr.on('data', (d: Buffer) => flush(d.toString()));
    proc.on('close', (code) => { if (buf) onLine(buf); resolve(code ?? 0); });
    proc.on('error', reject);
  });
}
```

- [ ] **Step 2: Implement the dashboard host**

Create `extension/src/dashboard/host.ts`:

```ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DashboardEvent, DashboardCommand } from './protocol.js';
import { resolveCliPath, spawnCli } from './cli.js';
import { parseCoverageText } from './coverage-parse.js';
import { toMatrixModel } from './matrix-model.js';
import { artifactEventFor, cliArgsFor } from './flow-events.js';

export class DashboardHost {
  private watcher?: vscode.FileSystemWatcher;
  constructor(private post: (e: DashboardEvent) => void, private workspaceRoot: string) {}

  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{specs,tests,docs}/**/*.{md,ts,js}');
    const emit = (uri: vscode.Uri, change: 'create' | 'update') => {
      const rel = path.relative(this.workspaceRoot, uri.fsPath);
      const ev = artifactEventFor(rel, change);
      if (ev) this.post(ev);
    };
    this.watcher.onDidCreate((u) => emit(u, 'create'));
    this.watcher.onDidChange((u) => emit(u, 'update'));
    void this.refresh();
  }

  async handle(cmd: DashboardCommand): Promise<void> {
    if (cmd.type === 'refresh') return this.refresh();
    if (cmd.type === 'openFile') {
      await vscode.window.showTextDocument(vscode.Uri.file(path.resolve(this.workspaceRoot, cmd.path)));
      return;
    }
    if (cmd.type === 'run') return this.run(cmd.pipeline, cmd.args ?? []);
  }

  private async run(pipeline: string, extra: string[]): Promise<void> {
    this.post({ type: 'pipeline:start', pipeline });
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      const code = await spawnCli(cli, cliArgsFor(pipeline, extra), this.workspaceRoot,
        (line) => this.post({ type: 'pipeline:log', pipeline, line }));
      this.post({ type: 'pipeline:done', pipeline, exitCode: code });
      await this.refresh();
    } catch (err) {
      this.post({ type: 'error', scope: pipeline, message: (err as Error).message ?? String(err) });
    }
  }

  private async refresh(): Promise<void> {
    // Coverage (best-effort, lenient text parse)
    try {
      const cli = await resolveCliPath(this.workspaceRoot);
      let out = '';
      await spawnCli(cli, ['status'], this.workspaceRoot, (l) => { out += l + '\n'; });
      this.post({ type: 'coverage', data: parseCoverageText(out) });
    } catch (err) {
      this.post({ type: 'error', scope: 'status', message: (err as Error).message ?? String(err) });
    }
    // Matrix from traceability.json (if present)
    try {
      const file = path.join(this.workspaceRoot, '.specguard', 'traceability.json');
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        this.post({ type: 'matrix', data: toMatrixModel(raw) });
      }
    } catch (err) {
      this.post({ type: 'error', scope: 'matrix', message: (err as Error).message ?? String(err) });
    }
  }

  dispose(): void { this.watcher?.dispose(); }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd extension && npm run lint`
Expected: `tsc --noEmit` clean.

- [ ] **Step 4: Update worklog + commit**

```bash
git add extension/src/dashboard/cli.ts extension/src/dashboard/host.ts docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): CLI runner + host (watchers, run, coverage, matrix)"
```

---

### Task 6: Webview panel + command/menu registration

**Files:**
- Create: `extension/src/dashboard/panel.ts`
- Modify: `extension/src/extension.ts` (instantiate panel command)
- Modify: `extension/src/commands.ts` (register `specguard.openDashboard`)
- Modify: `extension/package.json` (contributes: command + view/title button)

**Interfaces:**
- Consumes: `DashboardHost`, `DashboardEvent`, `DashboardCommand`.
- Produces: `openDashboardPanel(context: vscode.ExtensionContext): void` — creates/reveals a singleton `WebviewPanel`, wires host↔webview messaging, loads `media/` bundle with a CSP nonce.

- [ ] **Step 1: Implement the panel**

Create `extension/src/dashboard/panel.ts`:

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DashboardHost } from './host.js';
import type { DashboardEvent, DashboardCommand } from './protocol.js';

let panel: vscode.WebviewPanel | undefined;

export function openDashboardPanel(context: vscode.ExtensionContext): void {
  if (panel) { panel.reveal(); return; }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { vscode.window.showErrorMessage('SpecGuard: open a workspace folder first.'); return; }

  const mediaUri = vscode.Uri.file(path.join(context.extensionPath, 'media'));
  panel = vscode.window.createWebviewPanel('specguard.dashboard', 'SpecGuard Dashboard', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaUri],
  });

  const host = new DashboardHost((e: DashboardEvent) => panel?.webview.postMessage(e), workspaceRoot);
  panel.webview.html = renderHtml(panel.webview, context.extensionPath);
  panel.webview.onDidReceiveMessage((msg: DashboardCommand) => void host.handle(msg));
  host.start();

  panel.onDidDispose(() => { host.dispose(); panel = undefined; }, null, context.subscriptions);
}

function renderHtml(webview: vscode.Webview, extPath: string): string {
  const nonce = String(Date.now()) + Math.round(Math.abs(Math.sin(Date.now())) * 1e6);
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extPath, 'media', 'main.js')));
  const cssPath = path.join(extPath, 'media', 'main.css');
  const cssTag = fs.existsSync(cssPath)
    ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(cssPath))}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
${cssTag}</head><body><div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}
```

- [ ] **Step 2: Register the command**

In `extension/src/commands.ts`, add inside `registerCommands` (after the existing commands), and add the import at top:

```ts
import { openDashboardPanel } from './dashboard/panel.js';
// ...inside registerCommands(context, ...):
  context.subscriptions.push(
    vscode.commands.registerCommand('specguard.openDashboard', () => openDashboardPanel(context)),
  );
```

- [ ] **Step 3: Contribute the command + buttons in the manifest**

In `extension/package.json` `contributes.commands`, add:

```json
{ "command": "specguard.openDashboard", "title": "SpecGuard: Open Dashboard", "icon": "$(graph)" }
```

In `contributes.menus`, add a `view/title` entry so it opens from the coverage view header:

```json
{ "command": "specguard.openDashboard", "when": "view == specguard.coverageView", "group": "navigation" }
```

Add `"onCommand:specguard.openDashboard"` to `activationEvents`.

- [ ] **Step 4: Verify it compiles**

Run: `cd extension && npm run lint && npm run build`
Expected: clean tsc + esbuild emits `dist/extension.js`.

- [ ] **Step 5: Update worklog + commit**

```bash
git add extension/src/dashboard/panel.ts extension/src/extension.ts extension/src/commands.ts extension/package.json docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): webview panel + openDashboard command/menu"
```

---

### Task 7: Webview scaffold + event reducer (tested) + Vite build to media

**Files:**
- Create: `extension/webview/package.json`, `extension/webview/vite.config.ts`, `extension/webview/tsconfig.json`, `extension/webview/index.html`
- Create: `extension/webview/src/main.tsx`, `extension/webview/src/App.tsx`, `extension/webview/src/vscode.ts`
- Create: `extension/webview/src/reducer.ts`
- Test: `extension/webview/src/reducer.test.ts`

**Interfaces:**
- Consumes: protocol types (re-imported via a local copy path — see Step 2).
- Produces: `initialViewModel`, `reduce(vm: ViewModel, e: DashboardEvent): ViewModel`; `ViewModel = { nodeStates: Record<string,'idle'|'running'|'done'|'failed'>; logs: Record<string,string[]>; coverage: AppCoverage[]; matrix: MatrixModel | null; artifacts: {kind:string;path:string}[]; errors: string[] }`.

- [ ] **Step 1: Create the webview package + Vite config (build to ../media)**

Create `extension/webview/package.json`:

```json
{
  "name": "specguard-dashboard-webview",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build", "dev": "vite", "test": "vitest run" },
  "dependencies": { "react": "^18", "react-dom": "^18" },
  "devDependencies": { "vite": "^6", "@vitejs/plugin-react": "^4", "typescript": "^5.7", "@types/react": "^18", "@types/react-dom": "^18", "vitest": "^3" }
}
```

Create `extension/webview/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: '../media',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'main.js', assetFileNames: 'main.[ext]' } },
  },
});
```

Create `extension/webview/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx",
    "strict": true, "skipLibCheck": true, "noEmit": true, "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 2: Share the protocol types**

The webview must use the same contracts as the host without reaching across packages at build time. Create `extension/webview/src/protocol.ts` that re-exports from the host copy via a relative path (type-only, erased by Vite):

```ts
export type {
  DashboardEvent, DashboardCommand, AppCoverage, CoverageItem,
  MatrixModel, MatrixRow, PipelineNode,
} from '../../src/dashboard/protocol.js';
export { PIPELINE_NODES, RUNNABLE_PIPELINES } from '../../src/dashboard/protocol.js';
```

This is a type-only re-export plus two `const` arrays; Vite bundles the imported file directly at build time (no dev-server `fs.allow` needed since the build resolves the relative import). Verified by the Step 8 build.

- [ ] **Step 3: Write the failing reducer test**

Create `extension/webview/src/reducer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { initialViewModel, reduce } from './reducer.js';

describe('reduce', () => {
  it('marks a node running then done', () => {
    let vm = initialViewModel();
    vm = reduce(vm, { type: 'pipeline:start', pipeline: 'drift' });
    expect(vm.nodeStates['drift']).toBe('running');
    vm = reduce(vm, { type: 'pipeline:done', pipeline: 'drift', exitCode: 0 });
    expect(vm.nodeStates['drift']).toBe('done');
  });
  it('marks failed on non-zero (non-4) exit', () => {
    let vm = reduce(initialViewModel(), { type: 'pipeline:done', pipeline: 'heal', exitCode: 1 });
    expect(vm.nodeStates['heal']).toBe('failed');
  });
  it('treats exit code 4 (coverage gap) as done, not failed', () => {
    const vm = reduce(initialViewModel(), { type: 'pipeline:done', pipeline: 'status', exitCode: 4 });
    expect(vm.nodeStates['status']).toBe('done');
  });
  it('appends logs and records artifacts/coverage/matrix', () => {
    let vm = initialViewModel();
    vm = reduce(vm, { type: 'pipeline:log', pipeline: 'drift', line: 'hello' });
    expect(vm.logs['drift']).toEqual(['hello']);
    vm = reduce(vm, { type: 'artifact', kind: 'spec', path: 'specs/core/x.md', change: 'create' });
    expect(vm.artifacts.at(-1)).toMatchObject({ kind: 'spec', path: 'specs/core/x.md' });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd extension/webview && npm install && npx vitest run src/reducer.test.ts`
Expected: FAIL — cannot resolve `./reducer.js`.

- [ ] **Step 5: Implement the reducer**

Create `extension/webview/src/reducer.ts`:

```ts
import type { DashboardEvent, AppCoverage, MatrixModel } from './protocol.js';

export type NodeState = 'idle' | 'running' | 'done' | 'failed';
export interface ViewModel {
  nodeStates: Record<string, NodeState>;
  logs: Record<string, string[]>;
  coverage: AppCoverage[];
  matrix: MatrixModel | null;
  artifacts: { kind: string; path: string }[];
  errors: string[];
}

export function initialViewModel(): ViewModel {
  return { nodeStates: {}, logs: {}, coverage: [], matrix: null, artifacts: [], errors: [] };
}

export function reduce(vm: ViewModel, e: DashboardEvent): ViewModel {
  switch (e.type) {
    case 'pipeline:start':
      return { ...vm, nodeStates: { ...vm.nodeStates, [e.pipeline]: 'running' } };
    case 'pipeline:done': {
      const ok = e.exitCode === 0 || e.exitCode === 4;
      return { ...vm, nodeStates: { ...vm.nodeStates, [e.pipeline]: ok ? 'done' : 'failed' } };
    }
    case 'pipeline:log':
      return { ...vm, logs: { ...vm.logs, [e.pipeline]: [...(vm.logs[e.pipeline] ?? []), e.line] } };
    case 'artifact':
      return { ...vm, artifacts: [...vm.artifacts, { kind: e.kind, path: e.path }].slice(-200) };
    case 'coverage':
      return { ...vm, coverage: e.data };
    case 'matrix':
      return { ...vm, matrix: e.data };
    case 'error':
      return { ...vm, errors: [...vm.errors, `${e.scope}: ${e.message}`].slice(-50) };
    default:
      return vm;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd extension/webview && npx vitest run src/reducer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Create the vscode message client + React shell**

Create `extension/webview/src/vscode.ts`:

```ts
import type { DashboardCommand } from './protocol.js';
interface VsApi { postMessage(msg: DashboardCommand): void; }
declare function acquireVsCodeApi(): VsApi;
export const vscodeApi: VsApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
```

Create `extension/webview/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
```

Create `extension/webview/index.html`:

```html
<!doctype html><html><head><meta charset="utf-8" /><title>SpecGuard Dashboard</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

Create `extension/webview/src/App.tsx` (tab shell + live event wiring; views land in Tasks 8–9):

```tsx
import { useEffect, useReducer, useState } from 'react';
import type { DashboardEvent } from './protocol.js';
import { initialViewModel, reduce, type ViewModel } from './reducer.js';
import { vscodeApi } from './vscode.js';

type Tab = 'flow' | 'matrix' | 'docs' | 'activity';

export function App() {
  const [vm, dispatch] = useReducer((s: ViewModel, e: DashboardEvent) => reduce(s, e), undefined, initialViewModel);
  const [tab, setTab] = useState<Tab>('flow');

  useEffect(() => {
    const onMsg = (ev: MessageEvent<DashboardEvent>) => dispatch(ev.data);
    window.addEventListener('message', onMsg);
    vscodeApi.postMessage({ type: 'refresh' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const tabs: Tab[] = ['flow', 'matrix', 'docs', 'activity'];
  return (
    <div className="sg-app">
      <header className="sg-tabs">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </header>
      <main>
        {tab === 'flow' && <pre>Flow view (Task 8) — nodes: {Object.keys(vm.nodeStates).length}</pre>}
        {tab === 'matrix' && <pre>Matrix view (Task 9) — rows: {vm.matrix?.rows.length ?? 0}</pre>}
        {tab === 'docs' && <pre>Docs view (Task 9)</pre>}
        {tab === 'activity' && <pre>Activity view (Task 9) — artifacts: {vm.artifacts.length}</pre>}
      </main>
      {vm.errors.length > 0 && <footer className="sg-errors">{vm.errors.at(-1)}</footer>}
    </div>
  );
}
```

- [ ] **Step 8: Build the webview into media/**

Run: `cd extension/webview && npm run build`
Expected: emits `extension/media/main.js` (and `main.css` if styles exist).

- [ ] **Step 9: Update worklog + commit**

```bash
git add extension/webview docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): webview scaffold, tested event reducer, vite→media build"
```

---

### Task 8: Flow view (animated system graph)

**Files:**
- Create: `extension/webview/src/views/FlowView.tsx`
- Create: `extension/webview/src/views/flow.css`
- Modify: `extension/webview/src/App.tsx` (mount FlowView)

**Interfaces:**
- Consumes: `PIPELINE_NODES` from `./protocol.js`; `ViewModel` from `./reducer.js`; `vscodeApi`.
- Produces: `<FlowView vm={ViewModel} />`.

- [ ] **Step 1: Implement the flow view**

Create `extension/webview/src/views/FlowView.tsx`:

```tsx
import { PIPELINE_NODES } from '../protocol.js';
import type { ViewModel, NodeState } from '../reducer.js';
import { vscodeApi } from '../vscode.js';
import './flow.css';

const COLUMN: Record<string, number> = {
  'docs-in': 0, code: 0, import: 1, reverse: 1, specs: 2,
  generate: 3, security: 3, validate: 3, docs: 3, drift: 3, matrix: 3,
  tests: 4, 'user-docs': 4, traceability: 4, heal: 5,
};

export function FlowView({ vm }: { vm: ViewModel }) {
  const stateOf = (id: string): NodeState => vm.nodeStates[id] ?? 'idle';
  const cols = [...new Set(Object.values(COLUMN))].sort((a, b) => a - b);
  return (
    <div className="sg-flow">
      {cols.map((c) => (
        <div className="sg-col" key={c}>
          {PIPELINE_NODES.filter((n) => COLUMN[n.id] === c).map((n) => (
            <div
              key={n.id}
              className={`sg-node sg-${n.kind} sg-${stateOf(n.id)}`}
              onClick={() => n.kind === 'pipeline' && vscodeApi.postMessage({ type: 'run', pipeline: n.id })}
              title={n.kind === 'pipeline' ? `Run ${n.label}` : n.label}
            >
              <span className="sg-node-label">{n.label}</span>
              {n.kind === 'pipeline' && vm.logs[n.id]?.length ? (
                <span className="sg-node-badge">{vm.logs[n.id].length}</span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

Create `extension/webview/src/views/flow.css`:

```css
.sg-flow { display: flex; gap: 28px; padding: 16px; align-items: flex-start; }
.sg-col { display: flex; flex-direction: column; gap: 16px; }
.sg-node { position: relative; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--vscode-panel-border, #444);
  cursor: default; min-width: 96px; text-align: center; background: var(--vscode-editorWidget-background, #252526); transition: all .25s ease; }
.sg-pipeline { cursor: pointer; }
.sg-input { opacity: .85; }
.sg-artifact { border-style: dashed; }
.sg-running { animation: sg-pulse 1s infinite; border-color: #e2c08d; box-shadow: 0 0 10px #e2c08d88; }
.sg-done { border-color: #4ec9b0; box-shadow: 0 0 8px #4ec9b055; }
.sg-failed { border-color: #f48771; box-shadow: 0 0 8px #f4877155; }
.sg-node-badge { position: absolute; top: -8px; right: -8px; background: #4ec9b0; color: #000; border-radius: 10px; padding: 0 6px; font-size: 11px; }
@keyframes sg-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
```

- [ ] **Step 2: Mount FlowView in App**

In `extension/webview/src/App.tsx`, add `import { FlowView } from './views/FlowView.js';` and replace the flow placeholder line with:

```tsx
        {tab === 'flow' && <FlowView vm={vm} />}
```

- [ ] **Step 3: Build to verify**

Run: `cd extension/webview && npm run build`
Expected: emits `extension/media/main.js` + `main.css`.

- [ ] **Step 4: Update worklog + commit**

```bash
git add extension/webview/src/views/FlowView.tsx extension/webview/src/views/flow.css extension/webview/src/App.tsx docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): animated system-flow view"
```

---

### Task 9: Matrix, Docs, and Activity tabs

**Files:**
- Create: `extension/webview/src/views/MatrixView.tsx`
- Create: `extension/webview/src/views/ActivityView.tsx`
- Create: `extension/webview/src/views/DocsView.tsx`
- Modify: `extension/webview/src/App.tsx` (mount all three)

**Interfaces:**
- Consumes: `ViewModel`, `RUNNABLE_PIPELINES`, `vscodeApi`.
- Produces: `<MatrixView vm />`, `<ActivityView vm />`, `<DocsView vm />`.

- [ ] **Step 1: Implement MatrixView**

Create `extension/webview/src/views/MatrixView.tsx`:

```tsx
import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

export function MatrixView({ vm }: { vm: ViewModel }) {
  const m = vm.matrix;
  if (!m || m.rows.length === 0) {
    return <div style={{ padding: 16 }}><p>No traceability data.</p>
      <button onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'matrix' })}>Run matrix</button></div>;
  }
  return (
    <div style={{ padding: 16 }}>
      <p style={{ color: '#888' }}>generated {m.generatedAt ?? '—'}</p>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr><th align="left">Spec</th><th align="left">Source</th><th>Tests</th><th>Docs</th></tr></thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={`${r.appName}/${r.specKey}`} style={{ borderTop: '1px solid #333' }}>
              <td><button onClick={() => vscodeApi.postMessage({ type: 'openFile', path: r.sourceModule })}>{r.title}</button></td>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.sourceModule}</td>
              <td align="center" style={{ color: r.hasTests ? '#4ec9b0' : '#f48771' }}>{r.hasTests ? `✓ ${r.testCount}` : '—'}</td>
              <td align="center" style={{ color: r.hasDocs ? '#4ec9b0' : '#888' }}>{r.hasDocs ? '✓' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Implement ActivityView (runner + counters + log)**

Create `extension/webview/src/views/ActivityView.tsx`:

```tsx
import { useState } from 'react';
import type { ViewModel } from '../reducer.js';
import { RUNNABLE_PIPELINES } from '../protocol.js';
import { vscodeApi } from '../vscode.js';

export function ActivityView({ vm }: { vm: ViewModel }) {
  const [pipeline, setPipeline] = useState('status');
  const counts = {
    specs: vm.artifacts.filter((a) => a.kind === 'spec').length,
    tests: vm.artifacts.filter((a) => a.kind === 'test').length,
    docs: vm.artifacts.filter((a) => a.kind === 'doc').length,
  };
  const entry = RUNNABLE_PIPELINES.find((p) => p.id === pipeline);
  const run = () => {
    if (entry?.destructive && !confirm(`Run "${pipeline}"? It may call the LLM and write files.`)) return;
    vscodeApi.postMessage({ type: 'run', pipeline });
  };
  const log = vm.logs[pipeline] ?? [];
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <span>● {counts.specs} specs</span><span>● {counts.tests} tests</span><span>● {counts.docs} docs</span>
      </div>
      <select value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
        {RUNNABLE_PIPELINES.map((p) => <option key={p.id} value={p.id}>{p.id}{p.destructive ? ' ⚠' : ''}</option>)}
      </select>
      <button onClick={run} style={{ marginLeft: 8 }}>Run</button>
      {log.length > 0 && <pre style={{ background: '#111', color: '#0f0', padding: 8, marginTop: 12, maxHeight: 280, overflow: 'auto' }}>{log.join('\n')}</pre>}
    </div>
  );
}
```

- [ ] **Step 3: Implement DocsView (lists generated docs, opens them)**

Create `extension/webview/src/views/DocsView.tsx`:

```tsx
import type { ViewModel } from '../reducer.js';
import { vscodeApi } from '../vscode.js';

export function DocsView({ vm }: { vm: ViewModel }) {
  const docs = vm.artifacts.filter((a) => a.kind === 'doc');
  if (docs.length === 0) {
    return <div style={{ padding: 16 }}><p>No generated docs yet.</p>
      <button onClick={() => vscodeApi.postMessage({ type: 'run', pipeline: 'docs' })}>Run docs</button></div>;
  }
  return (
    <div style={{ padding: 16 }}>
      <h3>Generated user docs ({docs.length})</h3>
      <ul>{docs.map((d) => <li key={d.path}><button onClick={() => vscodeApi.postMessage({ type: 'openFile', path: d.path })}>{d.path}</button></li>)}</ul>
    </div>
  );
}
```

- [ ] **Step 4: Mount all three in App**

In `extension/webview/src/App.tsx`, add imports and replace the matrix/docs/activity placeholder lines:

```tsx
import { MatrixView } from './views/MatrixView.js';
import { DocsView } from './views/DocsView.js';
import { ActivityView } from './views/ActivityView.js';
// replace placeholders:
        {tab === 'matrix' && <MatrixView vm={vm} />}
        {tab === 'docs' && <DocsView vm={vm} />}
        {tab === 'activity' && <ActivityView vm={vm} />}
```

- [ ] **Step 5: Build to verify**

Run: `cd extension/webview && npm run build && npx tsc --noEmit -p tsconfig.json`
Expected: build + typecheck succeed.

- [ ] **Step 6: Update worklog + commit**

```bash
git add extension/webview/src/views/MatrixView.tsx extension/webview/src/views/ActivityView.tsx extension/webview/src/views/DocsView.tsx extension/webview/src/App.tsx docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): matrix, docs, and activity tabs"
```

---

### Task 10: Build wiring, packaging ignore, docs, full verification

**Files:**
- Modify: `extension/package.json` (build script builds webview too; add deps note)
- Modify: `extension/.vscodeignore` (ship `media/`, exclude `webview/` source)
- Modify: `extension/README.md` (or create a dashboard section)
- Modify: `docs/dashboard/WORKLOG.md`

**Interfaces:**
- Produces: `cd extension && npm run build` builds both the webview (→ media) and the host (→ dist); the packaged extension contains `dist/` + `media/`.

- [ ] **Step 1: Chain the webview build into the extension build**

In `extension/package.json` `scripts`, change `build` to build the webview first:

```json
    "build:webview": "npm --prefix webview install && npm --prefix webview run build",
    "build:host": "esbuild src/extension.ts --bundle --platform=node --external:vscode --outfile=dist/extension.js --sourcemap",
    "build": "npm run build:webview && npm run build:host"
```

- [ ] **Step 2: Update packaging ignore**

In `extension/.vscodeignore`, add lines to exclude webview source but keep the built media:

```
webview/**
!media/**
```

- [ ] **Step 3: Document the dashboard in the extension README**

Append to `extension/README.md` (create if missing) a section:

```markdown
## Dashboard

Run **SpecGuard: Open Dashboard** (or the graph icon in the SpecGuard Coverage view header)
to open a live, animated view of the pipelines. Click a pipeline node to run it; watch
specs/tests/docs appear in real time. Tabs: Flow · Matrix · Docs · Activity.

Dev: `cd extension && npm run build` (builds the webview into `media/` and the host into `dist/`).
```

- [ ] **Step 4: Run the full extension test suite**

Run: `cd extension && npx vitest run && cd webview && npx vitest run`
Expected: all dashboard unit tests pass (protocol, coverage-parse, matrix-model, flow-events, reducer).

- [ ] **Step 5: Full build + CLI regression check**

Run: `cd extension && npm run build` then from repo root `npm test`
Expected: extension builds (media + dist); the root CLI suite still passes (we never touched `src/`). Note: the 2 pre-existing upstream failures (`playwright` label sanitisation, `matrix` basename) are unrelated to this work.

- [ ] **Step 6: Manual smoke test (F5 / Extension Development Host)**

Open `extension/` in VS Code, press F5 to launch the Extension Development Host on this repo, run **SpecGuard: Open Dashboard**. Verify: the flow graph renders; clicking `status` populates coverage; the Matrix tab shows rows from `.specguard/traceability.json`; clicking `drift` animates the node and streams a log. Record the result in the worklog.

- [ ] **Step 7: Final worklog entry + commit**

```bash
git add extension/package.json extension/.vscodeignore extension/README.md docs/dashboard/WORKLOG.md
git commit -m "feat(dashboard): chain webview build, packaging, README + verification"
```

- [ ] **Step 8: Push branch + open draft PR**

```bash
git push -u origin feat/dashboard
gh pr create --draft --base build/specguard-impl --title "feat: live SpecGuard dashboard (extension webview)" --body "Implements docs/superpowers/specs/2026-06-28-specguard-extension-dashboard-design.md. Animated pipeline visualization inside the existing extension; no changes to src/. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review Notes

- **Spec coverage:** Webview-in-extension (Tasks 6–7) · live flow centerpiece (Task 8) · real-time via fs-watch + CLI spawn + traceability.json (Task 5) · Matrix/Docs/Activity tabs (Task 9) · surfacing generated docs (Task 9 DocsView) · pure-transform tests (Tasks 1–4, 7) · esbuild host + Vite webview build (Tasks 7, 10) · CSP-locked webview (Task 6) · no `src/**` changes (all under `extension/`) · docs-as-we-go (every task commits a WORKLOG update). Non-goals (git/plumbing, Nate-PRD, result column) intentionally excluded.
- **Type consistency:** `DashboardEvent`/`DashboardCommand`/`MatrixModel`/`AppCoverage` defined once in `protocol.ts` (Task 1), re-exported to the webview (Task 7 Step 2), and consumed identically by host (Task 5), reducer (Task 7), and views (Tasks 8–9). `ViewModel`/`NodeState` defined in `reducer.ts` and consumed by all views. `PIPELINE_NODES`/`RUNNABLE_PIPELINES` single-sourced in `protocol.ts`. Exit-code-4-as-success handled consistently in the reducer (Task 7) matching the extension's existing `runCli` convention.
- **Verified against source:** `traceability.json` shape (Task 3 test mirrors it); `sidebar.ts` text format (Task 2 parser moved verbatim); esbuild/CJS + `--external:vscode` build (Task 10); CLI has no `--json` (host uses text + fs + json file).
- **Known risk:** Task 7 Step 2 imports `../../src/dashboard/protocol.js` (type + two const arrays) across the webview/host boundary; Vite bundles it fine since it has no `vscode` import. If bundling complains, copy `protocol.ts` into `webview/src/` and keep them in sync — noted inline.
