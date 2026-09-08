module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['out', 'out-webview', 'dist', 'node_modules', 'src/webview/**'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/ban-ts-comment': 'off',
  },
  overrides: [
    {
      // Task 19-a: src/types/index.ts (orchestrator-owned) widens AgentMode
      // with the canonical open-string-union idiom `(string & {})`, which the
      // blanket ban-types rule flags. The rule stays ON everywhere else.
      files: ['src/types/index.ts'],
      rules: {
        '@typescript-eslint/ban-types': 'off',
      },
    },
  ],
};
