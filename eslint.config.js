import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Method rules from the master prompt: short files, short functions.
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/sk-ant-[A-Za-z0-9]/]',
          message: 'Never hard-code API keys.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/test-helpers/**'],
    rules: { 'max-lines-per-function': 'off' },
  },
);
