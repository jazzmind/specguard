import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Some tests import via bare `src/...` specifiers; vitest >=4 no longer resolves these root-relative.
    alias: [
      { find: /^specguard-core\//, replacement: fileURLToPath(new URL('./src/core/', import.meta.url)) },
      { find: /^src\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/security/* are legacy LLM-generated stubs (truncated files, wrong import paths) that
    // never parsed; excluded until regenerated via `specguard security`.
    exclude: ['node_modules/**', 'dist/**', 'tests/security/auth-state-machine.test.ts', 'tests/security/cli.test.ts', 'tests/security/config.test.ts', 'tests/security/doc-generate.test.ts', 'tests/security/docker.test.ts', 'tests/security/drift-registry.test.ts', 'tests/security/drift.test.ts', 'tests/security/extension.test.ts', 'tests/security/forward-generate.test.ts', 'tests/security/guardrails.test.ts', 'tests/security/heal.test.ts', 'tests/security/import.test.ts', 'tests/security/llm.test.ts', 'tests/security/matrix.test.ts', 'tests/security/mcp-server.test.ts', 'tests/security/npm-audit.test.ts', 'tests/security/playwright.test.ts', 'tests/security/reverse-generate.test.ts', 'tests/security/security.test.ts', 'tests/security/spec-parser.test.ts', 'tests/security/status.test.ts', 'tests/security/validate.test.ts', 'tests/security/writer.test.ts'],
    environment: 'node',
    globals: false,
    passWithNoTests: true,
  },
});
