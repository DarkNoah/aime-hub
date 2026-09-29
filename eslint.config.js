import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.aime-chat/**', 'memory/**'],
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
);
