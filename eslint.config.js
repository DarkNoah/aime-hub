import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.aime-chat/**',
      'workspaces/**',
      'memory/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Official compound components expose their context hooks alongside UI exports.
    files: [
      'apps/web/src/components/ai-elements/prompt-input.tsx',
      'apps/web/src/components/ai-elements/reasoning.tsx',
      'apps/web/src/components/ui/button-group.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': [
        'warn',
        {
          allowConstantExport: true,
          allowExportNames: [
            'usePromptInputController',
            'useProviderAttachments',
            'usePromptInputAttachments',
            'useReasoning',
            'buttonGroupVariants',
          ],
        },
      ],
    },
  },
  // Keep upstream registry sources intact; these patterns are not React Compiler compatible.
  {
    files: [
      'apps/web/src/components/ai-elements/code-block.tsx',
      'apps/web/src/components/ai-elements/jsx-preview.tsx',
      'apps/web/src/components/ai-elements/speech-input.tsx',
    ],
    rules: { 'react-hooks/refs': 'off' },
  },
  {
    files: [
      'apps/web/src/components/ai-elements/commit.tsx',
      'apps/web/src/components/ai-elements/inline-citation.tsx',
      'apps/web/src/components/ai-elements/jsx-preview.tsx',
      'apps/web/src/components/ai-elements/mic-selector.tsx',
      'apps/web/src/components/ai-elements/speech-input.tsx',
      'apps/web/src/components/ui/carousel.tsx',
    ],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
  {
    files: ['apps/web/src/components/ai-elements/persona.tsx'],
    rules: { 'react-hooks/immutability': 'off' },
  },
  {
    files: ['apps/web/src/components/ai-elements/shimmer.tsx'],
    rules: { 'react-hooks/static-components': 'off' },
  },
  {
    files: [
      'apps/web/src/components/ai-elements/image.tsx',
      'apps/web/src/components/ai-elements/jsx-preview.tsx',
      'apps/web/src/components/ai-elements/prompt-input.tsx',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
);
