import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';

export default tseslint.config(
  {
    ignores: ['dist', 'public/vendor', 'public/models', 'node_modules'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'security/detect-object-injection': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', 'playwright.config.ts', 'vitest.config.ts', 'vite.config.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['scripts/**/*.{mjs,js,ts}', 'tests/e2e/server.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
);
