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
    environment: 'node',
    globals: false,
    passWithNoTests: true,
  },
});
