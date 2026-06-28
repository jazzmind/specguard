# Final Review Fixes Report

## Fix 1 — Host-side modal confirm for destructive pipelines

**Files changed:**
- `extension/src/dashboard/host.ts`
- `extension/webview/src/views/ActivityView.tsx`

**host.ts changes:**
- Added `import { RUNNABLE_PIPELINES } from './protocol.js';` (value import alongside the existing `import type` line).
- Inserted destructive-confirm gate at the top of `run(pipeline, extra)` BEFORE `pipeline:start`:
  ```ts
  const entry = RUNNABLE_PIPELINES.find((p) => p.id === pipeline);
  if (entry?.destructive) {
    const choice = await vscode.window.showWarningMessage(
      `Run "${pipeline}"? It may call the LLM and write files.`,
      { modal: true },
      'Run',
    );
    if (choice !== 'Run') {
      this.post({ type: 'pipeline:log', pipeline, line: 'cancelled by user' });
      return;
    }
  }
  ```

**ActivityView.tsx changes:**
- Removed the `entry` lookup line and the `window.confirm()` gate.
- Simplified `run` handler to just `vscodeApi.postMessage({ type: 'run', pipeline })`.
- Kept `RUNNABLE_PIPELINES` import (used by the `<select>` ` ⚠` markers).
- `FlowView.tsx` left unchanged — the host gate covers its runs too.

---

## Fix 2 — Reconcile coverage flag in sidebar.ts

**File changed:** `extension/src/sidebar.ts`

Changed line 97:
```diff
- const raw = await runCli(cli, ['status', '--json'], workspaceRoot);
+ const raw = await runCli(cli, ['status'], workspaceRoot);
```
The sidebar uses `parseCoverageText` (a text parser), so `--json` was incorrect and inconsistent with the host's `['status']` call.

---

## Fix 3 — Error message clarity in host.ts

**File changed:** `extension/src/dashboard/host.ts`

Replaced all three occurrences of:
```ts
(err as Error).message ?? String(err)
```
with:
```ts
err instanceof Error ? err.message : String(err)
```
`??` on `.message` doesn't narrow correctly because `.message` is always a string (never nullish) on Error objects; the ternary is correct and clear.

---

## Fix 4 — Test title accuracy in reducer.test.ts

**File changed:** `extension/webview/src/reducer.test.ts`

Renamed test:
```diff
- it('appends logs and records artifacts/coverage/matrix', () => {
+ it('appends logs and records artifacts', () => {
```
Assertions left unchanged.

---

## Verification

### Command: `cd extension && npm run lint`
```
> specguard@0.1.0 lint
> tsc --noEmit
```
Exit 0 — tsc clean, 0 errors.

### Command: `cd extension && npm run build`
```
> specguard@0.1.0 build:webview
  ✓ 35 modules transformed.
  ../media/main.js  149.98 kB │ gzip: 48.20 kB
  ✓ built in 775ms

> specguard@0.1.0 build:host
  dist/extension.js      22.7kb
  dist/extension.js.map  46.2kb
  Done in 11ms
```

### Command: `cd extension && npx vitest run`
```
✓ src/dashboard/coverage-parse.test.ts (1 test)
✓ src/dashboard/flow-events.test.ts (4 tests)
✓ src/dashboard/matrix-model.test.ts (2 tests)
✓ src/dashboard/protocol.test.ts (3 tests)

Test Files  4 passed (4)
      Tests  10 passed (10)
```

### Command: `cd extension/webview && npm run build && npx vitest run`
```
vite build: ✓ 35 modules → media/main.js 149.98 kB ✓ built in 625ms

✓ src/reducer.test.ts (4 tests)

Test Files  1 passed (1)
      Tests  4 passed (4)
```

All checks green.
