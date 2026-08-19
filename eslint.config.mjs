import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      'target/**',
      // Emitted by openapi-typescript from openapi/depsis.yaml. Committed so CI can
      // detect drift; linting it would be linting a build artifact.
      '**/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // DEPSIS-specific hardening. These are errors, not warnings, because each one maps to a
      // failure mode an ADR calls out by name.

      // ADR-0001: TypeScript types vanish at runtime, so `any` at a boundary is an unchecked
      // input pretending to be a checked one. Validation happens with zod or not at all.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // A dropped promise in a file-operation or job path is a silently lost write.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // ADR-0004/0005: permission and identity code must not paper over nullability.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        { allowNullableBoolean: false, allowNullableString: false, allowNumber: false },
      ],

      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // ADR-0006 forbids shell execution from the application layer entirely; privileged work
      // goes through the typed agent IPC. eval() is in the same family of "arbitrary code from
      // a string" hazards, so it is banned here rather than left to review.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Tests may assert on deliberately malformed input.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  prettier,
);
