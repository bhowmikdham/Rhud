// Flat config for @rhud/api (ESLint 9).
//
// Load-bearing rule: `no-restricted-imports` on `@prisma/client`. Only files
// under `src/db/` may import the raw Prisma client. Everywhere else must go
// through `TenantDb.run(...)` — or, for enumerated auth-boundary cases,
// `UnscopedDb`. This is the enforcement mechanism for the tenant-isolation
// contract documented in src/db/with-tenant.ts.

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', '**/*.d.ts'] },

  js.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'prisma/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        NodeJS: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Import Prisma only from src/db/*. Application code must use TenantDb (or UnscopedDb for the whitelisted auth-boundary operations). See src/db/with-tenant.ts.',
            },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-unused-vars': 'off', // handled by @typescript-eslint/no-unused-vars
    },
  },

  // Inside src/db/ we're allowed to pick up the raw Prisma client.
  {
    files: ['src/db/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Seed script legitimately bootstraps the DB before any tenant exists.
  {
    files: ['prisma/seed.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Tests assert RLS behavior and need raw Prisma access.
  {
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
