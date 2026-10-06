// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'extension/dist/**',
      'extension/node_modules/**',
      'extension/webview/**',
      'extension/media/**',
      'extension/resources/**',
      'node_modules/**',
      'coverage/**',
      '.specguard/**',
      // Generated and archived test stubs are not maintained by hand.
      'tests/security/**',
      'docs/**',
      // Truncated generated stub (does not parse); kept out of lint until it is repaired or removed.
      'tests/core/extension.test.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Unused values are almost always mistakes; a leading underscore opts out.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // The CLI and pipelines print on purpose; an empty catch with a comment is intentional.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-require-imports': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      // `let x = default; try { x = ... }` is a deliberate pattern in this codebase.
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', 'action/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
