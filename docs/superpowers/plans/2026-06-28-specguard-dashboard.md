# SpecGuard Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, single-user developer control panel for SpecGuard that surfaces spec coverage, drift, and parsed specs, and triggers any implemented pipeline with streamed output — wrapping the existing CLI pipeline functions with zero edits to them.

**Architecture:** A nested, self-contained `dashboard/` package: a Hono (ESM/TS) server that imports the existing `src/pipelines/*` and `src/core/*` functions directly and exposes them as JSON + SSE endpoints, plus a Vite + React + TypeScript frontend that shares `src/core/types.ts`. Run in dev via `tsx` (server) + Vite (web); the only change outside `dashboard/` is one script line in the root `package.json`.

**Tech Stack:** Hono, `@hono/node-server`, tsx, Vite, React 18, TypeScript (NodeNext), Vitest.

## Global Constraints

- **No edits to `src/pipelines/**` or `src/core/**`.** The dashboard wraps them as-is. The only file touched outside `dashboard/` is root `package.json` (one script line).
- **ESM + NodeNext throughout.** Imports of CLI source use `.js` extension specifiers (e.g. `../../src/pipelines/drift.js`), matching the existing code.
- **Server binds `127.0.0.1` only.** Never `0.0.0.0`. It runs LLM pipelines and writes files.
- **No real LLM calls in tests.** Mock pipeline functions in server tests, exactly like the existing `tests/pipelines/*`.
- **Only implemented pipelines are runnable:** `reverse` (`runReverseGenerate`), `generate` (`runForwardGenerate`), `heal` (`runHeal`), `security` (`runSecurity`), `docs` (`runDocGenerate`), `drift` (`runDrift`), `status` (`runStatus`). `validate`/`matrix`/`import` are stubs — shown disabled.
- **Costly/destructive pipelines** (`reverse`, `generate`, `heal`, `security`) require a confirm step in the UI before running.
- **Conventional Commits**, small and frequent, on branch `feat/dashboard`.
- All paths below are relative to the repo root `specguard-dashboard/` (the worktree).

---

### Task 1: Dashboard package scaffold + health endpoint

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/server/index.ts`
- Create: `dashboard/server/app.ts`
- Create: `dashboard/vitest.config.ts`
- Create: `dashboard/server/app.test.ts`
- Modify: `package.json` (root — add one script)

**Interfaces:**
- Produces: `createApp(): Hono` (in `dashboard/server/app.ts`) — the Hono app with routes mounted, exported separately from the server bootstrap so tests can call it without binding a port.
- Produces: `dashboard/server/index.ts` — boots `@hono/node-server` on `127.0.0.1:4317`.

- [ ] **Step 1: Create the dashboard package manifest**

Create `dashboard/package.json`:

```json
{
  "name": "specguard-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:server": "tsx watch server/index.ts",
    "dev:web": "vite",
    "dev": "tsx server/index.ts",
    "build:web": "vite build",
    "start": "tsx server/index.ts",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4",
    "@hono/node-server": "^1"
  },
  "devDependencies": {
    "tsx": "^4",
    "typescript": "^5.7",
    "vitest": "^3",
    "vite": "^6",
    "@vitejs/plugin-react": "^4",
    "react": "^18",
    "react-dom": "^18",
    "@types/react": "^18",
    "@types/react-dom": "^18"
  }
}
```

- [ ] **Step 2: Create the server tsconfig**

Create `dashboard/tsconfig.json` (covers the server + shared imports; the web app gets its own config in Task 5):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["server/**/*"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd dashboard && npm install`
Expected: completes with exit code 0, creates `dashboard/node_modules`.

- [ ] **Step 4: Write the failing test for the app factory + health route**

Create `dashboard/server/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from './app.js';

describe('createApp', () => {
  it('returns 200 and { ok: true } for GET /api/health', async () => {
    const app = createApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run server/app.test.ts`
Expected: FAIL — cannot resolve `./app.js` (module not found).

- [ ] **Step 6: Implement the app factory**

Create `dashboard/server/app.ts`:

```ts
import { Hono } from 'hono';

/**
 * Build the SpecGuard dashboard Hono app with all routes mounted.
 * Exported separately from the server bootstrap so tests can call
 * `app.request(...)` without binding a port.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  return app;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run server/app.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Create the server bootstrap**

Create `dashboard/server/index.ts`:

```ts
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const PORT = 4317;
const HOST = '127.0.0.1';

const app = createApp();

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`SpecGuard dashboard on http://${HOST}:${info.port}`);
});
```

- [ ] **Step 9: Create the vitest config**

Create `dashboard/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'web/src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 10: Add the root launch script**

Modify root `package.json` — add ONE line to the `scripts` object (leave everything else untouched):

```json
    "dashboard": "npm --prefix dashboard install && npm --prefix dashboard run dev"
```

- [ ] **Step 11: Verify the server boots and health responds**

Run: `cd dashboard && (npm run dev &) && sleep 2 && curl -s http://127.0.0.1:4317/api/health && kill %1`
Expected: prints `{"ok":true}`.

- [ ] **Step 12: Verify the CLI build still works (no regression)**

Run (from repo root): `npm run build`
Expected: `tsc` succeeds — the root tsconfig excludes `dashboard/`, so the dashboard does not affect the CLI build.

- [ ] **Step 13: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/tsconfig.json dashboard/vitest.config.ts dashboard/server/app.ts dashboard/server/index.ts dashboard/server/app.test.ts package.json
git commit -m "feat(dashboard): scaffold Hono server package + health endpoint"
```

---

### Task 2: Config loader bridge + `/api/config`

**Files:**
- Create: `dashboard/server/specguard.ts`
- Create: `dashboard/server/routes/config.ts`
- Modify: `dashboard/server/app.ts`
- Test: `dashboard/server/routes/config.test.ts`

**Interfaces:**
- Consumes: `loadConfig(cwd?: string): Promise<SpecGuardConfig>` from `../../src/core/config.js`; type `SpecGuardConfig` from `../../src/core/types.js`.
- Produces: `loadDashboardConfig(): Promise<SpecGuardConfig>` (in `dashboard/server/specguard.ts`) — loads config from the repo root (`process.cwd()`), the single place the server resolves config.
- Produces: route `GET /api/config` returning `{ apps: AppConfig[] }` (names + dirs only; no `llm.apiKeyEnv` value, no secrets).
- Produces: `mountConfigRoute(app: Hono): void`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/server/routes/config.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../specguard.js', () => ({
  loadDashboardConfig: vi.fn(async () => ({
    apps: [
      { name: 'specguard-core', repo: '.', specDir: 'specs/core', sources: {}, framework: 'vitest', testOutput: 'tests/core/' },
    ],
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  })),
}));

import { createApp } from '../app.js';

describe('GET /api/config', () => {
  it('returns app summaries without leaking llm secrets config', async () => {
    const res = await createApp().request('/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0].name).toBe('specguard-core');
    expect(JSON.stringify(body)).not.toContain('apiKeyEnv');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run server/routes/config.test.ts`
Expected: FAIL — `/api/config` returns 404 (route not mounted).

- [ ] **Step 3: Create the specguard bridge**

Create `dashboard/server/specguard.ts`:

```ts
import { loadConfig } from '../../src/core/config.js';
import type { SpecGuardConfig } from '../../src/core/types.js';

/**
 * Load `.specguard/config.json` from the repo root the dashboard runs in.
 * Single source of config for every route.
 */
export async function loadDashboardConfig(): Promise<SpecGuardConfig> {
  return loadConfig(process.cwd());
}
```

- [ ] **Step 4: Create the config route**

Create `dashboard/server/routes/config.ts`:

```ts
import type { Hono } from 'hono';
import { loadDashboardConfig } from '../specguard.js';

export function mountConfigRoute(app: Hono): void {
  app.get('/api/config', async (c) => {
    const config = await loadDashboardConfig();
    const apps = config.apps.map((a) => ({
      name: a.name,
      repo: a.repo,
      specDir: a.specDir,
      framework: a.framework,
      testOutput: a.testOutput,
      sources: a.sources,
    }));
    return c.json({ apps });
  });
}
```

- [ ] **Step 5: Mount the route in the app factory**

Modify `dashboard/server/app.ts`:

```ts
import { Hono } from 'hono';
import { mountConfigRoute } from './routes/config.js';

export function createApp(): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));
  mountConfigRoute(app);

  return app;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run server/routes/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify against the real repo config**

Run: `cd dashboard && (npm run dev &) && sleep 2 && curl -s http://127.0.0.1:4317/api/config && kill %1`
Expected: JSON listing `specguard-core`, `specguard-pipelines`, `specguard-adapters`.

- [ ] **Step 8: Commit**

```bash
git add dashboard/server/specguard.ts dashboard/server/routes/config.ts dashboard/server/app.ts dashboard/server/routes/config.test.ts
git commit -m "feat(dashboard): config bridge + GET /api/config"
```

---

### Task 3: Read endpoints — `/api/status`, `/api/drift`, `/api/specs`

**Files:**
- Create: `dashboard/server/routes/reads.ts`
- Modify: `dashboard/server/app.ts`
- Test: `dashboard/server/routes/reads.test.ts`

**Interfaces:**
- Consumes: `runStatus(config)`, `runDrift(config, { since?, spec? })` returning `PipelineResult`; `loadAllSpecs(dir): ParsedSpec[]`; `loadDashboardConfig()` from Task 2.
- Produces: routes `GET /api/status` → `PipelineResult`; `GET /api/drift?since=<ref>` → `PipelineResult`; `GET /api/specs` → `ParsedSpec[]` (loaded from each app's `specDir`).
- Produces: `mountReadRoutes(app: Hono): void`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/server/routes/reads.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const fakeConfig = {
  apps: [{ name: 'a', repo: '.', specDir: 'specs/core', sources: {}, framework: 'vitest', testOutput: 't/' }],
  llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' },
};

vi.mock('../specguard.js', () => ({ loadDashboardConfig: vi.fn(async () => fakeConfig) }));
vi.mock('../../src/pipelines/status.js', () => ({
  runStatus: vi.fn(async () => ({ pipeline: 'status', created: 0, updated: 0, skipped: 0, failed: 0, items: [], exitCode: 0, messages: ['ok'] })),
}));
vi.mock('../../src/pipelines/drift.js', () => ({
  runDrift: vi.fn(async (_cfg: unknown, opts: { since?: string }) => ({ pipeline: 'drift', created: 0, updated: 0, skipped: 0, failed: 0, items: [{ key: 'core/x', status: 'ok', message: opts.since ?? 'HEAD~1' }], exitCode: 0, messages: [] })),
}));
vi.mock('../../src/core/spec-parser.js', () => ({
  loadAllSpecs: vi.fn(() => [{ title: 'X', specKey: 'core/x', filePath: 'specs/core/x.md', meta: { extra: {} }, overview: '', acceptanceCriteria: '', scenarios: [], securityNotes: '', dependencies: '', sections: {} }]),
}));

import { createApp } from '../app.js';

describe('read endpoints', () => {
  it('GET /api/status returns the PipelineResult', async () => {
    const res = await createApp().request('/api/status');
    expect(res.status).toBe(200);
    expect((await res.json()).pipeline).toBe('status');
  });

  it('GET /api/drift forwards the since query to runDrift', async () => {
    const res = await createApp().request('/api/drift?since=main');
    const body = await res.json();
    expect(body.items[0].message).toBe('main');
  });

  it('GET /api/specs returns parsed specs', async () => {
    const res = await createApp().request('/api/specs');
    const body = await res.json();
    expect(body[0].specKey).toBe('core/x');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run server/routes/reads.test.ts`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Implement the read routes**

Create `dashboard/server/routes/reads.ts`:

```ts
import type { Hono } from 'hono';
import { loadDashboardConfig } from '../specguard.js';
import { runStatus } from '../../src/pipelines/status.js';
import { runDrift } from '../../src/pipelines/drift.js';
import { loadAllSpecs } from '../../src/core/spec-parser.js';
import type { ParsedSpec } from '../../src/core/types.js';
import { resolve } from 'node:path';

export function mountReadRoutes(app: Hono): void {
  app.get('/api/status', async (c) => {
    const config = await loadDashboardConfig();
    return c.json(await runStatus(config));
  });

  app.get('/api/drift', async (c) => {
    const config = await loadDashboardConfig();
    const since = c.req.query('since') || undefined;
    return c.json(await runDrift(config, { since }));
  });

  app.get('/api/specs', async (c) => {
    const config = await loadDashboardConfig();
    const root = config.rootDir ?? process.cwd();
    const seen = new Set<string>();
    const specs: ParsedSpec[] = [];
    for (const appCfg of config.apps) {
      for (const spec of loadAllSpecs(resolve(root, appCfg.specDir))) {
        if (seen.has(spec.specKey)) continue;
        seen.add(spec.specKey);
        specs.push(spec);
      }
    }
    return c.json(specs);
  });
}
```

- [ ] **Step 4: Mount the read routes**

Modify `dashboard/server/app.ts` — add the import and call after `mountConfigRoute(app);`:

```ts
import { mountReadRoutes } from './routes/reads.js';
// ...inside createApp, after mountConfigRoute(app):
  mountReadRoutes(app);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run server/routes/reads.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify against the real repo**

Run: `cd dashboard && (npm run dev &) && sleep 2 && curl -s http://127.0.0.1:4317/api/status | head -c 200 && echo && curl -s "http://127.0.0.1:4317/api/specs" | head -c 200 && kill %1`
Expected: real `PipelineResult` JSON and a specs array.

- [ ] **Step 7: Commit**

```bash
git add dashboard/server/routes/reads.ts dashboard/server/app.ts dashboard/server/routes/reads.test.ts
git commit -m "feat(dashboard): read endpoints for status, drift, specs"
```

---

### Task 4: Run endpoint with post-hoc SSE — `POST /api/run/:pipeline`

**Files:**
- Create: `dashboard/server/run-registry.ts`
- Create: `dashboard/server/routes/run.ts`
- Modify: `dashboard/server/app.ts`
- Test: `dashboard/server/routes/run.test.ts`

**Interfaces:**
- Consumes: all `run*` functions; `SpecGuardError` from `../../src/core/errors.js`; `loadDashboardConfig()`.
- Produces: `PIPELINES: Record<string, { run: (cfg, opts) => Promise<PipelineResult>; destructive: boolean }>` (in `run-registry.ts`) — the allowlist of runnable pipelines.
- Produces: route `POST /api/run/:pipeline` (JSON body = opts) → SSE stream of `event: log` lines then `event: result` with the `PipelineResult`; `event: error` with `{ message, exitCode }` on failure. Unknown/stub pipeline → 404 JSON `{ error }`.
- Produces: `mountRunRoute(app: Hono): void`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/server/routes/run.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../specguard.js', () => ({
  loadDashboardConfig: vi.fn(async () => ({ apps: [], llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'K' } })),
}));
vi.mock('../../src/pipelines/drift.js', () => ({
  runDrift: vi.fn(async () => ({ pipeline: 'drift', created: 0, updated: 0, skipped: 0, failed: 0, items: [], exitCode: 0, messages: ['line one', 'line two'] })),
}));

import { createApp } from '../app.js';

describe('POST /api/run/:pipeline', () => {
  it('streams log events then a result event', async () => {
    const res = await createApp().request('/api/run/drift', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: log');
    expect(text).toContain('line one');
    expect(text).toContain('event: result');
    expect(text).toContain('"pipeline":"drift"');
  });

  it('returns 404 for a stub/unknown pipeline', async () => {
    const res = await createApp().request('/api/run/validate', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('validate');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run server/routes/run.test.ts`
Expected: FAIL — route 404 for both cases.

- [ ] **Step 3: Create the pipeline registry**

Create `dashboard/server/run-registry.ts`:

```ts
import type { SpecGuardConfig, PipelineResult } from '../../src/core/types.js';
import { runReverseGenerate } from '../../src/pipelines/reverse-generate.js';
import { runForwardGenerate } from '../../src/pipelines/forward-generate.js';
import { runHeal } from '../../src/pipelines/heal.js';
import { runSecurity } from '../../src/pipelines/security.js';
import { runDocGenerate } from '../../src/pipelines/doc-generate.js';
import { runDrift } from '../../src/pipelines/drift.js';
import { runStatus } from '../../src/pipelines/status.js';

export interface PipelineEntry {
  run: (config: SpecGuardConfig, opts: any) => Promise<PipelineResult>;
  /** Requires a UI confirm step (LLM calls and/or file writes). */
  destructive: boolean;
}

/** Allowlist of pipelines the dashboard can run. Stubs are intentionally absent. */
export const PIPELINES: Record<string, PipelineEntry> = {
  reverse: { run: runReverseGenerate, destructive: true },
  generate: { run: runForwardGenerate, destructive: true },
  heal: { run: runHeal, destructive: true },
  security: { run: runSecurity, destructive: true },
  docs: { run: runDocGenerate, destructive: true },
  drift: { run: runDrift, destructive: false },
  status: { run: runStatus, destructive: false },
};
```

- [ ] **Step 4: Implement the run route**

Create `dashboard/server/routes/run.ts`:

```ts
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { loadDashboardConfig } from '../specguard.js';
import { PIPELINES } from '../run-registry.js';
import { SpecGuardError } from '../../src/core/errors.js';

export function mountRunRoute(app: Hono): void {
  app.post('/api/run/:pipeline', async (c) => {
    const name = c.req.param('pipeline');
    const entry = PIPELINES[name];
    if (!entry) {
      return c.json({ error: `Pipeline \`${name}\` is not runnable from the dashboard.` }, 404);
    }

    const opts = await c.req.json().catch(() => ({}));
    const config = await loadDashboardConfig();

    return streamSSE(c, async (stream) => {
      try {
        const result = await entry.run(config, opts);
        for (const line of result.messages) {
          await stream.writeSSE({ event: 'log', data: line });
        }
        await stream.writeSSE({ event: 'result', data: JSON.stringify(result) });
      } catch (err) {
        const exitCode = err instanceof SpecGuardError ? err.exitCode : 1;
        const message = (err as Error).message ?? String(err);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message, exitCode }) });
      }
    });
  });
}
```

- [ ] **Step 5: Mount the run route**

Modify `dashboard/server/app.ts` — add import and `mountRunRoute(app);` after `mountReadRoutes(app);`:

```ts
import { mountRunRoute } from './routes/run.js';
// ...inside createApp, after mountReadRoutes(app):
  mountRunRoute(app);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run server/routes/run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Verify `SpecGuardError.exitCode` exists**

Run: `cd dashboard && grep -n "exitCode" ../src/core/errors.ts`
Expected: shows `exitCode` on `SpecGuardError`. If the property differs, adjust `run.ts` to match the real field name before continuing.

- [ ] **Step 8: Commit**

```bash
git add dashboard/server/run-registry.ts dashboard/server/routes/run.ts dashboard/server/app.ts dashboard/server/routes/run.test.ts
git commit -m "feat(dashboard): POST /api/run/:pipeline with post-hoc SSE streaming"
```

---

### Task 5: Frontend scaffold + shared types + typed API client

**Files:**
- Create: `dashboard/web/index.html`
- Create: `dashboard/web/vite.config.ts`
- Create: `dashboard/web/tsconfig.json`
- Create: `dashboard/web/src/main.tsx`
- Create: `dashboard/web/src/App.tsx`
- Create: `dashboard/web/src/types.ts`
- Create: `dashboard/web/src/api.ts`
- Create: `dashboard/web/src/api.test.ts`
- Modify: `dashboard/server/app.ts` (serve built web assets in non-dev)

**Interfaces:**
- Produces: `dashboard/web/src/types.ts` re-exporting `ParsedSpec`, `PipelineResult`, `PipelineItem`, `AppConfig` (type-only) from `../../../src/core/types.js`.
- Produces typed client functions in `dashboard/web/src/api.ts`:
  - `getConfig(): Promise<{ apps: AppConfig[] }>`
  - `getStatus(): Promise<PipelineResult>`
  - `getDrift(since?: string): Promise<PipelineResult>`
  - `getSpecs(): Promise<ParsedSpec[]>`
  - `runPipeline(name: string, opts: unknown, handlers: { onLog: (l: string) => void; onResult: (r: PipelineResult) => void; onError: (e: { message: string; exitCode: number }) => void }): Promise<void>` — consumes the SSE stream.

- [ ] **Step 1: Create the Vite config (allow importing CLI source above web root)**

Create `dashboard/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5317,
    proxy: { '/api': 'http://127.0.0.1:4317' },
    fs: { allow: [resolve(__dirname, '..', '..')] },
  },
  build: { outDir: 'dist' },
});
```

- [ ] **Step 2: Create the web tsconfig**

Create `dashboard/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: Create the HTML entry and React bootstrap**

Create `dashboard/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SpecGuard Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `dashboard/web/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 4: Create the shared types re-export**

Create `dashboard/web/src/types.ts`:

```ts
export type {
  ParsedSpec,
  PipelineResult,
  PipelineItem,
  AppConfig,
  SpecScenario,
} from '../../../src/core/types.js';
```

- [ ] **Step 5: Write the failing test for the API client**

Create `dashboard/web/src/api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStatus } from './api.js';

describe('getStatus', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ pipeline: 'status', created: 0, updated: 0, skipped: 0, failed: 0, items: [], exitCode: 0, messages: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
  });

  it('fetches /api/status and returns the parsed PipelineResult', async () => {
    const result = await getStatus();
    expect(result.pipeline).toBe('status');
    expect(fetch).toHaveBeenCalledWith('/api/status');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run web/src/api.test.ts`
Expected: FAIL — cannot resolve `./api.js`.

- [ ] **Step 7: Implement the API client**

Create `dashboard/web/src/api.ts`:

```ts
import type { ParsedSpec, PipelineResult, AppConfig } from './types.js';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export const getConfig = () => getJson<{ apps: AppConfig[] }>('/api/config');
export const getStatus = () => getJson<PipelineResult>('/api/status');
export const getDrift = (since?: string) =>
  getJson<PipelineResult>(`/api/drift${since ? `?since=${encodeURIComponent(since)}` : ''}`);
export const getSpecs = () => getJson<ParsedSpec[]>('/api/specs');

interface RunHandlers {
  onLog: (line: string) => void;
  onResult: (result: PipelineResult) => void;
  onError: (err: { message: string; exitCode: number }) => void;
}

/** POST to the SSE run endpoint and dispatch parsed events. */
export async function runPipeline(name: string, opts: unknown, h: RunHandlers): Promise<void> {
  const res = await fetch(`/api/run/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok || !res.body) {
    h.onError({ message: `run ${name} → ${res.status}`, exitCode: 1 });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const ev = /event:\s*(\w+)/.exec(chunk)?.[1];
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (ev === 'log') h.onLog(data);
      else if (ev === 'result') h.onResult(JSON.parse(data) as PipelineResult);
      else if (ev === 'error') h.onError(JSON.parse(data));
    }
  }
}
```

- [ ] **Step 8: Create a minimal App shell with tab navigation**

Create `dashboard/web/src/App.tsx`:

```tsx
import { useState } from 'react';

type Tab = 'drift' | 'coverage' | 'specs' | 'runner';

export function App() {
  const [tab, setTab] = useState<Tab>('drift');
  const tabs: Tab[] = ['drift', 'coverage', 'specs', 'runner'];
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>SpecGuard Dashboard</h1>
      <nav style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ fontWeight: tab === t ? 700 : 400 }}>
            {t}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'drift' && <p>Drift view (Task 7)</p>}
        {tab === 'coverage' && <p>Coverage view (Task 6)</p>}
        {tab === 'specs' && <p>Spec explorer (Task 6)</p>}
        {tab === 'runner' && <p>Runner view (Task 8)</p>}
      </main>
    </div>
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run web/src/api.test.ts`
Expected: PASS.

- [ ] **Step 10: Serve built web assets from the server (production mode)**

Modify `dashboard/server/app.ts` — add static serving for the built web app as a fallback after the API routes:

```ts
import { serveStatic } from '@hono/node-server/serve-static';
// ...inside createApp, AFTER all mount* calls, before `return app;`:
  app.use('/*', serveStatic({ root: './web/dist' }));
```

- [ ] **Step 11: Verify the web dev server builds and renders**

Run: `cd dashboard && npx vite build web`
Expected: build succeeds, emits `dashboard/web/dist/index.html`.

- [ ] **Step 12: Commit**

```bash
git add dashboard/web dashboard/server/app.ts
git commit -m "feat(dashboard): web scaffold, shared types, typed API client + SSE consumer"
```

---

### Task 6: Coverage view + Spec explorer + shared SpecPanel

**Files:**
- Create: `dashboard/web/src/components/SpecPanel.tsx`
- Create: `dashboard/web/src/views/CoverageView.tsx`
- Create: `dashboard/web/src/views/SpecExplorer.tsx`
- Modify: `dashboard/web/src/App.tsx`

**Interfaces:**
- Consumes: `getStatus`, `getSpecs` from `../api.js`; `ParsedSpec`, `PipelineResult` from `../types.js`.
- Produces: `<SpecPanel spec={ParsedSpec} />` — renders overview, acceptance criteria, scenarios. Reused by the drift drilldown in Task 7.
- Produces: `<CoverageView />`, `<SpecExplorer />`.

- [ ] **Step 1: Create the shared SpecPanel component**

Create `dashboard/web/src/components/SpecPanel.tsx`:

```tsx
import type { ParsedSpec } from '../types.js';

export function SpecPanel({ spec }: { spec: ParsedSpec }) {
  return (
    <div>
      <h3>{spec.title} <small style={{ color: '#888' }}>{spec.meta.status ?? ''}</small></h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>{spec.overview}</p>
      <h4>Acceptance Criteria</h4>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{spec.acceptanceCriteria}</pre>
      <h4>Scenarios ({spec.scenarios.length})</h4>
      <ol>
        {spec.scenarios.map((s, i) => (
          <li key={i}><strong>{s.name}</strong> — {s.steps.length} steps, {s.expectedResults.length} expected</li>
        ))}
      </ol>
    </div>
  );
}
```

- [ ] **Step 2: Create the CoverageView**

Create `dashboard/web/src/views/CoverageView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { PipelineResult } from '../types.js';
import { getStatus } from '../api.js';

export function CoverageView() {
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStatus().then(setResult).catch((e) => setError(String(e)));
  }, []);

  if (error) return <p style={{ color: 'crimson' }}>{error}</p>;
  if (!result) return <p>Loading coverage…</p>;
  return (
    <div>
      <h2>Coverage</h2>
      <ul>{result.messages.map((m, i) => <li key={i} style={{ fontFamily: 'monospace' }}>{m}</li>)}</ul>
      <p>created {result.created} · updated {result.updated} · skipped {result.skipped} · failed {result.failed}</p>
    </div>
  );
}
```

- [ ] **Step 3: Create the SpecExplorer**

Create `dashboard/web/src/views/SpecExplorer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { ParsedSpec } from '../types.js';
import { getSpecs } from '../api.js';
import { SpecPanel } from '../components/SpecPanel.js';

export function SpecExplorer() {
  const [specs, setSpecs] = useState<ParsedSpec[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => { getSpecs().then(setSpecs).catch(() => setSpecs([])); }, []);
  const current = specs.find((s) => s.specKey === selected);

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <ul style={{ minWidth: 240 }}>
        {specs.map((s) => (
          <li key={s.specKey}>
            <button onClick={() => setSelected(s.specKey)} style={{ fontWeight: selected === s.specKey ? 700 : 400 }}>
              {s.specKey}
            </button>
          </li>
        ))}
      </ul>
      <div style={{ flex: 1 }}>{current ? <SpecPanel spec={current} /> : <p>Select a spec.</p>}</div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the two views into App**

Modify `dashboard/web/src/App.tsx` — import and replace the placeholder lines:

```tsx
import { CoverageView } from './views/CoverageView.js';
import { SpecExplorer } from './views/SpecExplorer.js';
// replace the placeholders:
        {tab === 'coverage' && <CoverageView />}
        {tab === 'specs' && <SpecExplorer />}
```

- [ ] **Step 5: Verify the build still compiles**

Run: `cd dashboard && npx vite build web && npx tsc --noEmit -p web/tsconfig.json`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add dashboard/web/src/components dashboard/web/src/views/CoverageView.tsx dashboard/web/src/views/SpecExplorer.tsx dashboard/web/src/App.tsx
git commit -m "feat(dashboard): coverage view, spec explorer, shared SpecPanel"
```

---

### Task 7: Drift view (headline) with drilldown + regenerate action

**Files:**
- Create: `dashboard/web/src/views/drift-rows.ts`
- Create: `dashboard/web/src/views/drift-rows.test.ts`
- Create: `dashboard/web/src/views/DriftView.tsx`
- Modify: `dashboard/web/src/App.tsx`

**Interfaces:**
- Consumes: `getDrift`, `getSpecs`, `runPipeline` from `../api.js`; `PipelineResult`, `ParsedSpec` from `../types.js`.
- Produces: pure transform `toDriftRows(result: PipelineResult): DriftRow[]` where `DriftRow = { key: string; state: 'source-newer' | 'no-spec'; message: string; specPath?: string }`. `runDrift` only ever emits `failed` items in these two flavors (classified by message text); in-sync specs are absent from the report, so an empty `items` array means "no drift". This is the unit-tested core; the component renders it.
- Produces: `<DriftView />` — table of drifted rows, empty-state message when none, best-effort drilldown (reuses `SpecPanel`), and a confirm-guarded "Regenerate" button calling `runPipeline('reverse', { app, force: true }, …)`.

- [ ] **Step 1: Write the failing test for the row transform**

Create `dashboard/web/src/views/drift-rows.test.ts` (messages copied verbatim from `src/pipelines/drift.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { toDriftRows } from './drift-rows.js';

const make = (items: { key: string; status: string; message?: string; path?: string }[]) =>
  ({ pipeline: 'drift', created: 0, updated: 0, skipped: 0, failed: items.length, items, exitCode: 3, messages: [] }) as any;

describe('toDriftRows', () => {
  it('returns no rows for an empty (healthy) report', () => {
    expect(toDriftRows(make([]))).toEqual([]);
  });

  it('classifies a stale-spec item as source-newer', () => {
    const rows = toDriftRows(make([{ key: 'specguard-core/config', status: 'failed', message: 'source modified after spec — spec is stale', path: 'specs/core/config.md' }]));
    expect(rows[0]).toMatchObject({ key: 'specguard-core/config', state: 'source-newer', specPath: 'specs/core/config.md' });
  });

  it('classifies a missing-spec item as no-spec', () => {
    const rows = toDriftRows(make([{ key: 'specguard-core/new', status: 'failed', message: 'no spec for changed source — expected specs/core/new.md' }]));
    expect(rows[0].state).toBe('no-spec');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run web/src/views/drift-rows.test.ts`
Expected: FAIL — cannot resolve `./drift-rows.js`.

- [ ] **Step 3: Implement the transform**

Create `dashboard/web/src/views/drift-rows.ts`:

```ts
import type { PipelineResult } from '../types.js';

export type DriftState = 'source-newer' | 'no-spec';
export interface DriftRow {
  key: string;
  state: DriftState;
  message: string;
  specPath?: string;
}

/**
 * Classify each drift item. `runDrift` only emits `failed` items in two
 * flavors, distinguished by message text:
 *   - "no spec for changed source — expected …"  → no-spec
 *   - "source modified after spec — spec is stale" → source-newer
 */
export function toDriftRows(result: PipelineResult): DriftRow[] {
  return result.items.map((item) => {
    const msg = (item.message ?? '').toLowerCase();
    const state: DriftState = msg.includes('no spec') ? 'no-spec' : 'source-newer';
    return { key: item.key, state, message: item.message ?? '', specPath: item.path };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run web/src/views/drift-rows.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the DriftView**

Create `dashboard/web/src/views/DriftView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { ParsedSpec } from '../types.js';
import { getDrift, getSpecs, runPipeline } from '../api.js';
import { toDriftRows, type DriftRow } from './drift-rows.js';
import { SpecPanel } from '../components/SpecPanel.js';

const COLOR: Record<DriftRow['state'], string> = {
  'source-newer': '#b8860b', 'no-spec': '#b00020',
};

/** Best-effort: match a drift key `<app>/<feature>` to a parsed spec by feature suffix. */
function matchSpec(key: string, specs: ParsedSpec[]): ParsedSpec | undefined {
  const feature = key.split('/').slice(1).join('/');
  return specs.find((s) => s.specKey === feature || s.specKey.endsWith(`/${feature}`));
}

export function DriftView() {
  const [since, setSince] = useState('HEAD~1');
  const [rows, setRows] = useState<DriftRow[]>([]);
  const [specs, setSpecs] = useState<ParsedSpec[]>([]);
  const [selected, setSelected] = useState<DriftRow | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    getDrift(since).then((r) => setRows(toDriftRows(r))).catch(() => setRows([])).finally(() => setLoading(false));
  };
  useEffect(refresh, [since]);
  useEffect(() => { getSpecs().then(setSpecs).catch(() => setSpecs([])); }, []);

  const current = selected ? matchSpec(selected.key, specs) : undefined;

  const regenerate = (key: string) => {
    const app = key.split('/')[0];
    if (!confirm(`Regenerate specs for "${app}"? This calls the LLM and overwrites spec files.`)) return;
    setLog([`Regenerating ${app}…`]);
    runPipeline('reverse', { app, force: true }, {
      onLog: (l) => setLog((p) => [...p, l]),
      onResult: () => { setLog((p) => [...p, '✓ done']); refresh(); },
      onError: (e) => setLog((p) => [...p, `error (${e.exitCode}): ${e.message}`]),
    });
  };

  return (
    <div>
      <h2>Drift</h2>
      <label>Changed since: <input value={since} onChange={(e) => setSince(e.target.value)} /></label>
      <button onClick={refresh}>Refresh</button>
      {loading ? <p>Checking drift…</p> : rows.length === 0 ? (
        <p style={{ color: '#177245' }}>✓ No drift since <code>{since}</code>.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', marginTop: 12, width: '100%' }}>
          <thead><tr><th align="left">Item</th><th align="left">State</th><th align="left">Detail</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ borderTop: '1px solid #eee' }}>
                <td><button onClick={() => setSelected(r)}>{r.key}</button></td>
                <td style={{ color: COLOR[r.state], fontWeight: 600 }}>{r.state}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.message}</td>
                <td><button onClick={() => regenerate(r.key)}>Regenerate</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && (
        <div style={{ marginTop: 16, borderTop: '2px solid #ddd', paddingTop: 12 }}>
          {current ? <SpecPanel spec={current} />
            : <p style={{ fontFamily: 'monospace' }}>No matching spec — {selected.message}</p>}
        </div>
      )}
      {log.length > 0 && <pre style={{ background: '#111', color: '#0f0', padding: 8, marginTop: 12 }}>{log.join('\n')}</pre>}
    </div>
  );
}
```

- [ ] **Step 6: Wire DriftView into App**

Modify `dashboard/web/src/App.tsx` — import and replace the drift placeholder:

```tsx
import { DriftView } from './views/DriftView.js';
// replace:
        {tab === 'drift' && <DriftView />}
```

- [ ] **Step 7: Verify build + types**

Run: `cd dashboard && npx vitest run web/src/views/drift-rows.test.ts && npx tsc --noEmit -p web/tsconfig.json && npx vite build web`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add dashboard/web/src/views/drift-rows.ts dashboard/web/src/views/drift-rows.test.ts dashboard/web/src/views/DriftView.tsx dashboard/web/src/App.tsx
git commit -m "feat(dashboard): drift view with drilldown and regenerate action"
```

---

### Task 8: Runner view with pipeline picker, confirm guards, live log

**Files:**
- Create: `dashboard/web/src/views/RunnerView.tsx`
- Modify: `dashboard/web/src/App.tsx`

**Interfaces:**
- Consumes: `runPipeline` from `../api.js`; `PipelineResult` from `../types.js`.
- Produces: `<RunnerView />` — pipeline dropdown (only implemented ones enabled; `validate`/`matrix`/`import` shown disabled), an opts JSON textarea, a Run button that confirms for destructive pipelines, a streamed log pane, and the final `PipelineResult` summary.

- [ ] **Step 1: Implement the RunnerView**

Create `dashboard/web/src/views/RunnerView.tsx`:

```tsx
import { useState } from 'react';
import type { PipelineResult } from '../types.js';
import { runPipeline } from '../api.js';

const RUNNABLE = ['status', 'drift', 'reverse', 'generate', 'heal', 'security', 'docs'] as const;
const DESTRUCTIVE = new Set(['reverse', 'generate', 'heal', 'security', 'docs']);
const STUBS = ['validate', 'matrix', 'import'];

export function RunnerView() {
  const [name, setName] = useState<string>('status');
  const [optsText, setOptsText] = useState('{}');
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    let opts: unknown;
    try { opts = JSON.parse(optsText || '{}'); }
    catch { setLog(['Invalid JSON in opts']); return; }
    if (DESTRUCTIVE.has(name) && !confirm(`Run "${name}"? It calls the LLM and/or writes files.`)) return;
    setRunning(true); setLog([]); setResult(null);
    await runPipeline(name, opts, {
      onLog: (l) => setLog((p) => [...p, l]),
      onResult: (r) => { setResult(r); setRunning(false); },
      onError: (e) => { setLog((p) => [...p, `error (${e.exitCode}): ${e.message}`]); setRunning(false); },
    });
  };

  return (
    <div>
      <h2>Pipeline Runner</h2>
      <select value={name} onChange={(e) => setName(e.target.value)}>
        {RUNNABLE.map((p) => <option key={p} value={p}>{p}{DESTRUCTIVE.has(p) ? ' ⚠' : ''}</option>)}
        {STUBS.map((p) => <option key={p} value={p} disabled>{p} (not implemented)</option>)}
      </select>
      <div><textarea value={optsText} onChange={(e) => setOptsText(e.target.value)} rows={3} cols={50} placeholder='{"app":"specguard-core"}' /></div>
      <button onClick={run} disabled={running}>{running ? 'Running…' : 'Run'}</button>
      {log.length > 0 && <pre style={{ background: '#111', color: '#0f0', padding: 8 }}>{log.join('\n')}</pre>}
      {result && <p>created {result.created} · updated {result.updated} · skipped {result.skipped} · failed {result.failed} · exit {result.exitCode}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Wire RunnerView into App**

Modify `dashboard/web/src/App.tsx` — import and replace the runner placeholder:

```tsx
import { RunnerView } from './views/RunnerView.js';
// replace:
        {tab === 'runner' && <RunnerView />}
```

- [ ] **Step 3: Verify build + types**

Run: `cd dashboard && npx tsc --noEmit -p web/tsconfig.json && npx vite build web`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add dashboard/web/src/views/RunnerView.tsx dashboard/web/src/App.tsx
git commit -m "feat(dashboard): pipeline runner view with confirm guards and streamed log"
```

---

### Task 9: Production launch script, README, full verification

**Files:**
- Create: `dashboard/README.md`
- Modify: `dashboard/package.json` (add `start` that builds web then serves)
- Modify: root `package.json` (point `dashboard` script at the full experience — optional polish)

**Interfaces:**
- Produces: `npm run dashboard` (root) → installs dashboard deps, builds the web app, starts the server serving the built assets + API on `127.0.0.1:4317`.

- [ ] **Step 1: Update the dashboard start script to build then serve**

Modify `dashboard/package.json` `scripts` — set:

```json
    "start": "vite build web && tsx server/index.ts",
    "dev": "tsx watch server/index.ts"
```

- [ ] **Step 2: Point the root script at the full experience**

Modify root `package.json` `dashboard` script:

```json
    "dashboard": "npm --prefix dashboard install && npm --prefix dashboard start"
```

- [ ] **Step 3: Write the dashboard README**

Create `dashboard/README.md`:

```markdown
# SpecGuard Dashboard

Local developer control panel for SpecGuard. Wraps the existing pipeline
functions — no changes to `src/`.

## Run

From the repo root:

    npm run dashboard

Opens the API + UI on http://127.0.0.1:4317 (local only).

## Dev (hot reload)

    cd dashboard
    npm run dev:server   # Hono on :4317 (tsx watch)
    npm run dev:web      # Vite on :5317, proxies /api to :4317

## Views

- **Drift** — stale specs vs. source; drilldown + regenerate.
- **Coverage** — `status` pipeline output per app.
- **Specs** — browse parsed Living Specifications.
- **Runner** — run any implemented pipeline; streamed output.

## Tests

    cd dashboard && npm test
```

- [ ] **Step 4: Run the full dashboard test suite**

Run: `cd dashboard && npx vitest run`
Expected: all server + web unit tests pass.

- [ ] **Step 5: Verify the CLI is still intact (no regression)**

Run (repo root): `npm run build && npm test`
Expected: CLI `tsc` build succeeds and the existing 83 tests still pass — the dashboard never touched `src/` or root test config.

- [ ] **Step 6: End-to-end smoke test**

Run: `cd dashboard && (npm start &) && sleep 5 && curl -s http://127.0.0.1:4317/api/health && curl -s http://127.0.0.1:4317/ | grep -q "SpecGuard Dashboard" && echo "UI served OK" && kill %1`
Expected: `{"ok":true}` and `UI served OK`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/package.json dashboard/README.md package.json
git commit -m "feat(dashboard): production launch script + README + verification"
```

- [ ] **Step 8: Open a draft PR**

```bash
git push -u origin feat/dashboard
gh pr create --draft --base build/specguard-impl --title "feat(dashboard): SpecGuard developer control panel" --body "Implements docs/superpowers/specs/2026-06-28-specguard-dashboard-design.md. Drift-first control panel wrapping existing pipelines; zero edits to src/. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review Notes

- **Spec coverage:** Drift view (Task 7), Coverage (Task 6), Spec explorer (Task 6), Pipeline runner (Task 8), Hono server wrapping real functions (Tasks 2–4), post-hoc SSE (Task 4), shared types (Task 5), error handling via `SpecGuardError.exitCode` (Task 4), local-only bind (Task 1), isolated package + one root script (Tasks 1 & 9), draft PR workflow (Task 9). Non-goals (matrix, artifact viewer) intentionally absent.
- **Type consistency:** `toDriftRows`/`DriftRow`/`DriftState` (two states: `source-newer`, `no-spec`) consistent between Task 7 test, impl, `COLOR` map, and DriftView. `runPipeline` handler shape (`onLog`/`onResult`/`onError`) identical in api.ts (Task 5), DriftView (Task 7), RunnerView (Task 8). `PIPELINES` keys (Task 4) match `RUNNABLE` (Task 8).
- **Drift model verified against source:** `runDrift` emits only `failed` items with messages `"no spec for changed source — expected …"` and `"source modified after spec — spec is stale"`; in-sync specs are absent (empty report = healthy). `SpecGuardError.exitCode` confirmed to exist (`src/core/errors.ts`). The Task 4 Step 7 grep is a belt-and-suspenders sanity check, not an open question.
- **Known v1 caveat (documented in spec):** Regenerate runs `reverse` for the whole app (drift items carry the spec path, not the source file), so it is confirm-guarded. In-sync/orphan enumeration and a merged spec inventory are deferred — drift keys (`<app>/<feature>`) and `loadAllSpecs` specKeys (`<area>/<name>`) are different namespaces; the drilldown does a documented best-effort suffix match.
